/**
 * MCP server over stdio for desktop assistants and local agents.
 *
 *   npx tsx server/src/modules/ai/mcp-stdio.ts --token <api token> [--db <sqlite file>]
 *
 * Boots the platform from the configured database (RESOLVRNOW_DB_FILE or
 * RESOLVRNOW_DATA_DIR, as the server does) and acts as the user who owns the token.
 * The token may also come from RESOLVRNOW_TOKEN. stdout carries the protocol, so all
 * logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthService } from '../../api/auth.js';
import { loadConfig } from '../../config.js';
import { Platform } from '../../engine/platform.js';
import { selectModules } from '../index.js';
import { createMcpServer, mayUseMcp } from './mcp/server.js';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const stderr = {
  info: (...a: unknown[]) => console.error(...a),
  warn: (...a: unknown[]) => console.error(...a),
  error: (...a: unknown[]) => console.error(...a),
};

async function main(): Promise<void> {
  const token = arg('token') ?? process.env.RESOLVRNOW_TOKEN;
  if (!token) {
    console.error('Usage: mcp-stdio --token <api token> [--db <sqlite file>]  (or set RESOLVRNOW_TOKEN)');
    process.exit(2);
  }
  const config = loadConfig();
  const platform = new Platform({
    dbFile: arg('db') ?? config.dbFile,
    modules: selectModules(),
    autoProcess: true,
    logger: stderr,
  }).boot();
  const auth = new AuthService(platform).fromBearer(token);
  if (!auth) {
    console.error('The API token is invalid, inactive or expired.');
    platform.close();
    process.exit(1);
  }
  if (!mayUseMcp(platform, auth.user)) {
    console.error(
      `User ${auth.user.userName} does not have the role required for MCP (resolvr.mcp.required_role).`,
    );
    platform.close();
    process.exit(1);
  }
  const server = createMcpServer(platform, auth.user, {
    transport: 'stdio',
    client: 'stdio',
    baseUrl: (config.publicUrl ?? '').replace(/\/$/, ''),
  });
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    platform.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
  console.error(`ResolvrNow MCP server (stdio) ready as ${auth.user.userName}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
