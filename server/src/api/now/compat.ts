import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorBody, HttpError, routeCompat } from '../http.js';
import { JsonSyntaxError, parseLenientJson } from './lenient-json.js';
import { toXmlResponse, XmlSyntaxError, xmlToObject } from './xml.js';

/**
 * Cross-cutting HTTP contract of the platform-compatible REST APIs (rest-api.md section 1):
 * Accept negotiation with XML responses, 406 / 415 handling, lenient request bodies,
 * `application/json;charset=UTF-8` responses, session debug logs, method override and
 * 405 for known paths with an unsupported method.
 */

export type ResponseFormat = 'json' | 'xml' | 'other';

interface MediaRange {
  type: string;
  sub: string;
  q: number;
  order: number;
}

function parseAccept(accept: string): MediaRange[] {
  return accept
    .split(',')
    .map((part, order) => {
      const [range, ...params] = part.trim().split(';');
      const [type = '', sub = ''] = range.trim().toLowerCase().split('/');
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p);
        if (m) q = Number(m[1]);
      }
      return { type, sub, q: Number.isFinite(q) ? q : 1, order };
    })
    .filter((r) => r.type)
    .sort((a, b) => b.q - a.q || a.order - b.order);
}

function matchesRange(r: MediaRange, media: string): boolean {
  const [type, sub] = media.toLowerCase().split('/');
  if (r.type === '*') return true;
  if (r.type !== type) return false;
  return r.sub === '*' || r.sub === sub;
}

/**
 * Picks the response format for an Accept header. JSON is the default (missing header or
 * `*\/*`); `application/xml` or `text/xml` select XML; `extra` lists route-specific media
 * types (such as an attachment's own type). Returns null when nothing acceptable remains.
 */
export function negotiate(accept: string | undefined, extra: string[] = []): ResponseFormat | null {
  if (!accept || !accept.trim()) return 'json';
  for (const r of parseAccept(accept)) {
    if (r.q <= 0) continue;
    if (r.type === '*' || (r.type === 'application' && r.sub === '*')) return 'json';
    if (matchesRange(r, 'application/json') || r.sub.endsWith('+json')) return 'json';
    if (matchesRange(r, 'application/xml') || matchesRange(r, 'text/xml') || r.sub.endsWith('+xml'))
      return 'xml';
    if (extra.some((m) => m === '*' || matchesRange(r, m))) return 'other';
  }
  return null;
}

/** True when the Accept header allows `media` (used by binary downloads). */
export function accepts(accept: string | undefined, media: string): boolean {
  if (!accept || !accept.trim()) return true;
  return parseAccept(accept).some((r) => r.q > 0 && matchesRange(r, media));
}

/** URLs that follow the platform contract: every /api route except the product's own UI API. */
function isPlatformApi(url: string): boolean {
  return url.startsWith('/api/') && !url.startsWith('/api/app/');
}

function contentTypeOf(req: FastifyRequest): string {
  return String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function bodyText(body: unknown): string | null {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return null;
}

/** Parses a JSON body leniently; malformed input is a 400 with the platform's message. */
export function parseJsonBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return parseLenientJson(text);
  } catch (e) {
    throw new HttpError(
      400,
      'Exception while reading request',
      e instanceof JsonSyntaxError ? e.message : 'The payload is not valid JSON.',
    );
  }
}

/** Parses an XML body into a field map; malformed input is a 400. */
export function parseXmlBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return xmlToObject(text);
  } catch (e) {
    throw new HttpError(
      400,
      'Exception while reading request',
      e instanceof XmlSyntaxError ? e.message : 'The payload is not valid XML.',
    );
  }
}

/**
 * Normalises a write request's body to a parsed value. JSON and XML are supported; a body
 * without Content-Type is accepted when it parses as JSON (several official samples omit
 * the header). Other content types are rejected with 415.
 */
export function normalizeBody(req: FastifyRequest): unknown {
  const ct = contentTypeOf(req);
  const body = req.body;
  const text = bodyText(body);
  if (ct === 'application/json' || ct.endsWith('+json'))
    return text === null ? (body ?? {}) : parseJsonBody(text);
  if (ct === 'application/xml' || ct === 'text/xml' || ct.endsWith('+xml'))
    return text === null ? (body ?? {}) : parseXmlBody(text);
  if (body === undefined || body === null) return {};
  if (text !== null && !text.trim()) return {};
  if (!ct) {
    if (text === null) return body;
    const t = text.trim();
    if (t.startsWith('<')) return parseXmlBody(t);
    return parseJsonBody(t);
  }
  throw new HttpError(
    415,
    'Unsupported Media Type',
    `Content-Type ${ct} is not supported; use application/json or application/xml`,
  );
}

/** Honours `X-HTTP-Method-Override` on POST requests (called before routing). */
export function applyMethodOverride(raw: IncomingMessage): void {
  if (raw.method !== 'POST') return;
  const o = raw.headers['x-http-method-override'];
  const m = (Array.isArray(o) ? o[0] : o)?.trim().toUpperCase();
  if (m && ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) raw.method = m;
}

function hasRoute(app: FastifyInstance, method: string, url: string): boolean {
  try {
    const r = app.findRoute({ method: method as 'GET', url });
    return !!r && !('*' in ((r.params ?? {}) as Record<string, unknown>));
  } catch {
    return false;
  }
}

/** Not-found handling for /api URLs: 405 when the path exists for another method, else 400. */
export function sendApiNotFound(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const path = req.url.split('?')[0];
  const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter(
    (m) => m !== req.method && hasRoute(app, m, path),
  );
  if (allowed.length) {
    reply.header('Allow', [...allowed, ...(allowed.includes('GET') ? ['HEAD'] : [])].join(', '));
    return reply
      .code(405)
      .send(errorBody('Method not Supported', `${req.method} is not supported for this resource`));
  }
  return reply.code(400).send(errorBody('Requested URI does not represent any resource', null));
}

/** Installs the request and response hooks of the contract. */
export function registerCompatLayer(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    if (!isPlatformApi(req.url)) return;
    const compat = routeCompat(req);
    const format = negotiate(req.headers.accept, compat?.produces);
    req.resolvrFormat = format === 'xml' ? 'xml' : 'json';
    if (format === null && compat && !compat.produces?.includes('*')) {
      throw new HttpError(
        406,
        'Not Acceptable',
        `None of the requested media types (${req.headers.accept}) can be produced`,
      );
    }
  });

  app.addHook('preValidation', async (req) => {
    const compat = routeCompat(req);
    if (!compat || compat.rawBody) return;
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return;
    req.body = normalizeBody(req);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!isPlatformApi(req.url) || typeof payload !== 'string') return payload;
    const ct = String(reply.getHeader('content-type') ?? '');
    if (!ct.startsWith('application/json')) return payload;
    const debug = String(req.headers['x-wantsessiondebugmessages'] ?? '').toLowerCase() === 'true';
    const xml = req.resolvrFormat === 'xml';
    let out = payload;
    if ((debug || xml) && payload) {
      let body: unknown;
      try {
        body = JSON.parse(payload);
      } catch {
        body = undefined;
      }
      if (body !== undefined) {
        if (debug && body && typeof body === 'object' && !Array.isArray(body)) {
          (body as Record<string, unknown>).session = {
            debug_logs: (req.resolvrDebug ?? []).map((line) => ({
              type: 'log',
              customerUpdate: false,
              line,
              debugClassSet: false,
            })),
          };
        }
        if (xml) {
          reply.header('content-type', 'application/xml;charset=UTF-8');
          return toXmlResponse(body);
        }
        out = JSON.stringify(body);
      }
    }
    reply.header('content-type', 'application/json;charset=UTF-8');
    return out;
  });
}
