import { STATUS_CODES } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clock } from '../../engine/util.js';
import { type ApiDeps, ctxOf, HttpError, nowRoute } from '../http.js';

/**
 * Batch API: POST /api/now/batch runs several REST calls in one request. Items run in
 * order, as the calling user, through the same router as direct calls (so every API and
 * ACL applies). A failing item does not stop the batch; a size or time limit does, and the
 * remaining items are reported in `unserviced_requests`.
 */

const MB = 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'date']);
const NESTED_RE = /^\/api\/now(?:\/v\d+)?\/batch(?:[/?#]|$)/;

interface BatchItem {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: unknown;
  exclude_response_headers?: unknown;
}

type Serviced = Record<string, unknown>;

const canonical = (name: string) =>
  name
    .split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join('-');

function headerList(headers: Record<string, unknown>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.push({ name: canonical(k), value: String(one) });
  }
  return out;
}

function errorMessage(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { error?: { message?: unknown } };
    if (parsed?.error?.message) return String(parsed.error.message);
  } catch {
    /* not JSON */
  }
  return '';
}

function failed(id: string, status: number, message: string): Serviced {
  const body = Buffer.from(JSON.stringify({ error: { message, detail: null }, status: 'failure' })).toString(
    'base64',
  );
  return {
    id,
    status_code: status,
    status_text: STATUS_CODES[status] ?? '',
    headers: [],
    execution_time: 0,
    body,
    error_message: message,
  };
}

/** Relative request target of an item URL (absolute URLs keep only path and query). */
function itemTarget(url: string): string {
  let u = url.trim();
  if (/^https?:\/\//i.test(u)) {
    const parsed = new URL(u);
    u = `${parsed.pathname}${parsed.search}`;
  }
  return u.startsWith('/') ? u : `/${u}`;
}

async function runItem(
  app: FastifyInstance,
  req: FastifyRequest,
  item: BatchItem,
  limits: { input: number; output: number },
): Promise<Serviced | 'limit'> {
  const id = String(item.id ?? '');
  const method = String(item.method ?? '')
    .trim()
    .toUpperCase();
  const rawUrl = typeof item.url === 'string' ? item.url : '';
  if (!id || !method || !rawUrl) return failed(id, 400, 'Each rest_requests item needs id, method and url');
  if (!METHODS.has(method)) return failed(id, 405, `Method ${method} is not supported`);
  let url: string;
  try {
    url = itemTarget(rawUrl);
  } catch {
    return failed(id, 400, `Invalid url ${rawUrl}`);
  }
  if (NESTED_RE.test(url)) return failed(id, 400, 'Nested batch requests are not supported');

  const headers: Record<string, string> = {};
  if (Array.isArray(item.headers)) {
    for (const h of item.headers as { name?: unknown; value?: unknown }[]) {
      if (h && typeof h.name === 'string' && h.name.trim())
        headers[h.name.trim().toLowerCase()] = String(h.value ?? '');
    }
  }
  // Items always run as the caller of the batch.
  delete headers.authorization;
  delete headers.cookie;
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  const csrf = req.headers['x-usertoken'];
  if (typeof csrf === 'string' && !headers['x-usertoken']) headers['x-usertoken'] = csrf;

  let payload: Buffer | undefined;
  if (typeof item.body === 'string' && item.body) {
    payload = Buffer.from(item.body, 'base64');
    if (payload.length > limits.input) return 'limit';
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  const started = clock.now().getTime();
  const res = await app.inject({ method: method as 'GET', url, headers, payload });
  const elapsed = Math.max(0, clock.now().getTime() - started);
  const out = res.rawPayload;
  if (out.length > limits.output) return 'limit';
  const entry: Serviced = {
    id,
    status_code: res.statusCode,
    status_text: STATUS_CODES[res.statusCode] ?? '',
    headers:
      item.exclude_response_headers === true || item.exclude_response_headers === 'true'
        ? []
        : headerList(res.headers),
    execution_time: elapsed,
    body: out.toString('base64'),
  };
  if (res.statusCode >= 400)
    entry.error_message = errorMessage(out) || String(STATUS_CODES[res.statusCode] ?? 'Error');
  const location = res.headers.location;
  if (res.statusCode >= 300 && res.statusCode < 400 && location) entry.redirect_url = String(location);
  return entry;
}

export function registerBatchApi(app: FastifyInstance, deps: ApiDeps): void {
  const props = deps.platform.properties;
  nowRoute(
    app,
    'POST',
    '/batch',
    async (req) => {
      ctxOf(req, deps); // 401 for anonymous callers
      const body = req.body as { batch_request_id?: unknown; rest_requests?: unknown } | null;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.rest_requests)) {
        throw new HttpError(
          400,
          'Exception while reading request',
          'The batch request must contain a rest_requests array',
        );
      }
      const input = Math.min(props.getNumber('glide.rest.batch.max.inputSize', 5 * MB), 10 * MB);
      const maxOutput = props.getNumber('glide.rest.batch.max.outputSize', 10 * MB);
      const asked = Number(req.headers['x-batchrequest-max-output-size']);
      const output = Number.isFinite(asked) && asked > 0 ? Math.min(asked, maxOutput) : maxOutput;
      const timeoutMs = props.getNumber('glide.rest.batch.timeout', 30) * 1000;
      const started = clock.now().getTime();
      const serviced: Serviced[] = [];
      const unserviced: string[] = [];
      let stopped = false;
      for (const raw of body.rest_requests as BatchItem[]) {
        const item = raw && typeof raw === 'object' ? raw : {};
        const id = String(item.id ?? '');
        if (stopped || clock.now().getTime() - started > timeoutMs) {
          stopped = true;
          unserviced.push(id);
          continue;
        }
        const result = await runItem(app, req, item, { input, output });
        if (result === 'limit') {
          stopped = true;
          unserviced.push(id);
          continue;
        }
        serviced.push(result);
      }
      return {
        batch_request_id:
          body.batch_request_id === undefined || body.batch_request_id === null
            ? ''
            : String(body.batch_request_id),
        serviced_requests: serviced,
        unserviced_requests: unserviced,
      };
    },
    { produces: ['multipart/mixed'] },
  );
}
