import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Context } from '../engine/context.js';
import { AbortError, AccessError, AuthError, InvalidError, NotFoundError } from '../engine/errors.js';
import type { Platform } from '../engine/platform.js';
import { SchemaError } from '../engine/registry.js';
import type { AuthService } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Lines returned in `session.debug_logs` when the client sends X-WantSessionDebugMessages. */
    resolvrDebug?: string[];
    /** Response format negotiated from the Accept header (platform-compatible APIs). */
    resolvrFormat?: 'json' | 'xml';
  }
  interface FastifyContextConfig {
    /** Set by `nowRoute` / `versionedRoute`: the route follows the platform HTTP contract. */
    resolvrCompat?: NowRouteOptions;
  }
}

/** Per-route options of the platform-compatible HTTP contract (see api/now/compat.ts). */
export interface NowRouteOptions {
  /** Media types the route produces besides JSON and XML; `*` disables the Accept (406) check. */
  produces?: string[];
  /** The handler reads a raw or multipart body itself, so no Content-Type (415) check applies. */
  rawBody?: boolean;
}

export interface ApiDeps {
  platform: Platform;
  auth: AuthService;
  config: ServerConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  attachmentDir: string;
  publicUrl: string | null;
  webDir: string | null;
  demo: boolean;
  secureCookies: boolean;
}

/** Platform-style error body. */
export function errorBody(message: string, detail: string | null = null) {
  return { error: { message, detail }, status: 'failure' };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

/** Browser app requests must not receive a Basic challenge, or the browser shows its native login dialog. */
function wantsBasicChallenge(req?: FastifyRequest): boolean {
  if (!req) return true;
  if (req.headers['x-requested-with']) return false;
  return !req.url.startsWith('/api/app/');
}

export function sendError(reply: FastifyReply, e: unknown, platform: Platform, req?: FastifyRequest): FastifyReply {
  if (e instanceof HttpError) return reply.code(e.status).send(errorBody(e.message, e.detail));
  if (e instanceof AuthError) {
    if (wantsBasicChallenge(req)) reply.header('WWW-Authenticate', 'Basic realm="ResolvrNow"');
    return reply.code(401).send(errorBody(e.message, e.detail));
  }
  if (e instanceof AccessError) return reply.code(403).send(errorBody(e.message, e.detail));
  if (e instanceof AbortError) return reply.code(403).send(errorBody('Operation Failed', e.message));
  if (e instanceof NotFoundError) return reply.code(404).send(errorBody(e.message, e.detail));
  if (e instanceof InvalidError) return reply.code(400).send(errorBody(e.message, e.detail ?? null));
  if (e instanceof SchemaError) return reply.code(400).send(errorBody(e.message, null));
  const err = e as { statusCode?: number; message?: string; validation?: unknown };
  if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send(errorBody(err.message ?? 'Bad Request'));
  platform.reportError('http', e);
  return reply.code(500).send(errorBody('Internal server error', e instanceof Error ? e.message : String(e)));
}

/** Context for the authenticated caller (throws 401 when anonymous). */
export function ctxOf(req: FastifyRequest, deps: ApiDeps): Context {
  const auth = deps.auth.require(req, undefined as unknown as FastifyReply);
  return deps.platform.contextFor(auth.user);
}

export function baseUrl(req: FastifyRequest, deps: ApiDeps): string {
  if (deps.config.publicUrl) return deps.config.publicUrl.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http';
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

/**
 * Registers the same handler for unversioned, v1 and v2 paths under /api/now. Routes get
 * the platform HTTP contract: Accept negotiation (JSON or XML, else 406), Content-Type
 * checks on writes (415) and lenient body parsing.
 */
export function nowRoute(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  handler: Handler,
  opts: NowRouteOptions = {},
): void {
  versionedRoute(app, method, '/api/now', path, handler, opts);
}

/** Same as `nowRoute` for another namespace, e.g. `/api/global` (`/api/global/v1/...`). */
export function versionedRoute(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  namespace: string,
  path: string,
  handler: Handler,
  opts: NowRouteOptions = {},
): void {
  for (const prefix of [namespace, `${namespace}/v1`, `${namespace}/v2`]) {
    app.route({ method, url: `${prefix}${path}`, handler, config: { resolvrCompat: opts } });
  }
}

/** Compatibility options of the matched route, or undefined for routes outside the contract. */
export function routeCompat(req: FastifyRequest): NowRouteOptions | undefined {
  const config = req.routeOptions?.config as { resolvrCompat?: NowRouteOptions } | undefined;
  return config?.resolvrCompat;
}

/** API version segment of the request path (`v1`, `v2`), or null for the default (unversioned) path. */
export function apiVersion(req: FastifyRequest): string | null {
  const m = /^\/api\/[a-z_]+\/(v\d+)\//.exec(req.url);
  return m ? m[1] : null;
}

/** Adds a line to the response's `session.debug_logs` (only sent when the client asks for it). */
export function debugLog(req: FastifyRequest, line: string): void {
  (req.resolvrDebug ??= []).push(line);
}

/** First value of a query parameter that may have been repeated. */
export function queryParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return v === undefined || v === null ? undefined : String(v);
}

export function intParam(v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
