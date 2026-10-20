import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService } from './api/auth.js';
import { registerUiApi } from './api/app/ui.js';
import { type ApiDeps, sendError, type ServerConfig } from './api/http.js';
import { registerAccountApi, registerRoleInheritanceApi } from './api/now/account.js';
import { registerAttachmentApi } from './api/now/attachment.js';
import { registerBatchApi } from './api/now/batch.js';
import {
  applyMethodOverride,
  parseJsonBody,
  parseXmlBody,
  registerCompatLayer,
  sendApiNotFound,
} from './api/now/compat.js';
import { registerImportSetApi } from './api/now/importset.js';
import { registerStatsApi } from './api/now/stats.js';
import { registerTableApi } from './api/now/table.js';
import type { Platform } from './engine/platform.js';

export interface AppOptions {
  logger?: boolean;
}

/** Builds the HTTP server: platform-compatible REST APIs, ResolvrNow UI APIs and the web app. */
export async function buildApp(platform: Platform, config: ServerConfig, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    bodyLimit: 50 * 1024 * 1024,
    trustProxy: true,
    routerOptions: { caseSensitive: true, ignoreTrailingSlash: true },
    // X-HTTP-Method-Override (POST only) must change the method before routing.
    rewriteUrl(req) {
      applyMethodOverride(req);
      return req.url ?? '/';
    },
  });
  const auth = new AuthService(platform);
  const deps: ApiDeps = { platform, auth, config };

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10 } });

  // Raw bodies for binary attachment uploads.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // Lenient JSON: empty bodies are allowed on PATCH/PUT/POST without content, and the
  // single-quoted / unquoted-key JSON used by official samples is accepted. Malformed
  // bodies get the platform's 400 "Exception while reading request".
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, parseJsonBody(String(body ?? '')));
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  app.addContentTypeParser(['application/xml', 'text/xml'], { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, parseXmlBody(String(body ?? '')));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    try {
      req.auth = auth.authenticate(req) ?? undefined;
    } catch {
      req.auth = undefined;
    }
  });

  // Platform HTTP contract: Accept/Content-Type negotiation, XML, debug logs, response headers.
  registerCompatLayer(app);

  app.setErrorHandler((err, req, reply) => sendError(reply, err, platform, req));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return sendApiNotFound(app, req, reply);
    const index = config.webDir ? join(config.webDir, 'index.html') : null;
    if (index && existsSync(index)) return reply.type('text/html').send(readFileSync(index));
    return reply.code(404).send('Not found');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  registerTableApi(app, deps);
  registerStatsApi(app, deps);
  registerAttachmentApi(app, deps);
  registerBatchApi(app, deps);
  registerImportSetApi(app, deps);
  registerAccountApi(app, deps);
  registerRoleInheritanceApi(app, deps);
  registerUiApi(app, deps);
  for (const m of platform.modules) m.http?.(app, deps);

  if (config.webDir) {
    await app.register(fastifyStatic, { root: config.webDir, prefix: '/', wildcard: true, index: false });
  }

  return app;
}
