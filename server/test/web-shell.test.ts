import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Platform } from '../src/engine/platform.js';
import { bootPlatform } from './helpers.js';

let p: Platform;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  p = bootPlatform();
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ResolvrNow</title><div id="root"></div>');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbFile: ':memory:',
    attachmentDir: join(dir, 'att'),
    publicUrl: 'https://resolvrnow.test',
    webDir: dir,
    demo: false,
    secureCookies: false,
  };
  app = await buildApp(p, config);
});

afterAll(async () => {
  await app.close();
  p.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('web app shell', () => {
  it.each(['/', '/login', '/workspace/list/incident', '/portal/tickets'])('serves the app shell at %s', async (url) => {
    const r = await app.inject({ method: 'GET', url });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<div id="root">');
  });

  it('serves static files and keeps API errors as JSON', async () => {
    expect((await app.inject({ method: 'GET', url: '/favicon.svg' })).statusCode).toBe(200);
    const api = await app.inject({ method: 'GET', url: '/api/now/nothing-here' });
    expect(api.statusCode).toBe(400);
    expect(api.headers['content-type']).toContain('json');
  });
});
