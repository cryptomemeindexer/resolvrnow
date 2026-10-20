import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from './api/http.js';

const here = dirname(fileURLToPath(import.meta.url));

function findWebDir(): string | null {
  const candidates = [
    process.env.RESOLVRNOW_WEB_DIR && resolve(process.env.RESOLVRNOW_WEB_DIR),
    resolve(here, '../../web/dist'),
    resolve(here, '../web/dist'),
    resolve(process.cwd(), 'web/dist'),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.RESOLVRNOW_DATA_DIR ?? join(process.cwd(), 'data'));
  return {
    port: Number(env.PORT ?? env.RESOLVRNOW_PORT ?? 8080),
    host: env.HOST ?? env.RESOLVRNOW_HOST ?? '0.0.0.0',
    dataDir,
    dbFile: env.RESOLVRNOW_DB_FILE ?? join(dataDir, 'resolvrnow.sqlite'),
    attachmentDir: env.RESOLVRNOW_ATTACHMENT_DIR ?? join(dataDir, 'attachments'),
    publicUrl: env.RESOLVRNOW_PUBLIC_URL ?? null,
    webDir: findWebDir(),
    demo: ['1', 'true', 'yes'].includes(String(env.RESOLVRNOW_DEMO ?? '').toLowerCase()),
    secureCookies: ['1', 'true', 'yes'].includes(String(env.RESOLVRNOW_SECURE_COOKIES ?? '').toLowerCase()),
  };
}
