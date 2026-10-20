import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/api/auth.js';
import { Platform } from '../src/engine/platform.js';
import { aiModule } from '../src/modules/ai/index.js';
import { platformModule } from '../src/modules/platform/index.js';
import { taskModule } from '../src/modules/task/index.js';
import { makeUser } from './helpers.js';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let dbFile: string;
let token: string;
let client: Client;

const env = () => ({
  ...(process.env as Record<string, string>),
  RESOLVRNOW_MODULES: 'ai',
  RESOLVRNOW_ADMIN_PASSWORD: 'stdio-test-pw',
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-stdio-'));
  dbFile = join(dir, 'resolvrnow.sqlite');
  process.env.RESOLVRNOW_ADMIN_PASSWORD = 'stdio-test-pw';
  const p = new Platform({ dbFile, modules: [platformModule, taskModule, aiModule], logger: silent }).boot();
  const userId = makeUser(p, 'sam.stdio', ['itil', 'mcp_user']);
  token = new AuthService(p).issueToken(userId, 'stdio test');
  p.close();
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP over stdio', () => {
  it('serves tools as the token owner', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, 'src/modules/ai/mcp-stdio.ts', '--token', token, '--db', dbFile],
      cwd: serverDir,
      env: env(),
      stderr: 'pipe',
    });
    client = new Client({ name: 'vitest-stdio', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['lookup_users', 'get_session_timezone', 'task_add_note']));
    // Incident tools only appear when the incident application is installed.
    expect(tools).not.toContain('incident_get_details');
    const res = (await client.callTool({
      name: 'lookup_users',
      arguments: { role: 'itil' },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(
      (res.structuredContent as { results: { user_name: string }[] }).results.map((u) => u.user_name),
    ).toContain('sam.stdio');
  }, 60_000);

  it('refuses an invalid token', () => {
    const r = spawnSync(
      process.execPath,
      [tsxCli, 'src/modules/ai/mcp-stdio.ts', '--token', 'resolvr_not-a-real-token', '--db', dbFile],
      {
        cwd: serverDir,
        env: env(),
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The API token is invalid, inactive or expired.');
    expect(r.stdout).toBe('');
  }, 60_000);
});
