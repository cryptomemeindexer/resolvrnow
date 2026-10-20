import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService } from './api/auth.js';
import { registerUiApi } from './api/app/ui.js';
import { type ApiDeps, errorBody, sendError, type ServerConfig } from './api/http.js';
import { registerAttachmentApi } from './api/now/attachment.js';
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
    routerOptions: { caseSensitive: true },
  });
  const auth = new AuthService(platform);
  const deps: ApiDeps = { platform, auth, config };

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10 } });

  // Raw bodies for binary attachment uploads.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // Lenient JSON: empty bodies are allowed on PATCH/PUT/POST without content.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body ?? '').trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('The payload is not valid JSON.') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
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

  app.setErrorHandler((err, req, reply) => sendError(reply, err, platform, req));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(400).send(errorBody('Requested URI does not represent any resource', req.url));
    const index = config.webDir ? join(config.webDir, 'index.html') : null;
    if (index && existsSync(index)) return reply.type('text/html').send(readFileSync(index));
    return reply.code(404).send('Not found');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  registerTableApi(app, deps);
  registerStatsApi(app, deps);
  registerAttachmentApi(app, deps);
  registerUiApi(app, deps);
  for (const m of platform.modules) m.http?.(app, deps);

  if (config.webDir) {
    await app.register(fastifyStatic, { root: config.webDir, prefix: '/', wildcard: true, index: false });
  }

  return app;
}
