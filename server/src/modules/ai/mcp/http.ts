/**
 * Streamable HTTP transport for the MCP server at /api/app/mcp (stateless: one MCP
 * server per request, JSON responses). Requires resolvr.mcp.enabled=true and an
 * authenticated caller, normally `Authorization: Bearer <API token>`.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, baseUrl, errorBody, HttpError } from '../../../api/http.js';
import { normalizeDateTime } from '../../../engine/util.js';
import { PROP } from '../config.js';
import { createMcpServer, mayUseMcp } from './server.js';

export const MCP_PATH = '/api/app/mcp';

const SKIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'cookie',
  'authorization',
]);

function originAllowed(origin: string, req: FastifyRequest, deps: ApiDeps): boolean {
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const reqHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toLowerCase();
  if (reqHost) allowed.add(reqHost);
  if (deps.config.publicUrl) {
    try {
      allowed.add(new URL(deps.config.publicUrl).host.toLowerCase());
    } catch {
      /* ignore malformed public URL */
    }
  }
  return allowed.has(host) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

export function registerMcpHttp(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!platform.properties.getBool(PROP.mcpEnabled, false)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'The MCP server is disabled',
            'An administrator can enable it with the property resolvr.mcp.enabled',
          ),
        );
    }
    const origin = req.headers.origin;
    if (origin && !originAllowed(String(origin), req, deps))
      return reply.code(403).send(errorBody('Origin not allowed'));
    if (!req.auth) {
      reply.header('WWW-Authenticate', 'Bearer realm="ResolvrNow", error="invalid_token"');
      return reply
        .code(401)
        .send(errorBody('User Not Authenticated', 'Send an API token as Authorization: Bearer <token>'));
    }
    // Cookie sessions must pass the CSRF check like every other write.
    const auth = deps.auth.require(req, reply);
    if (!mayUseMcp(platform, auth.user)) {
      const role = platform.properties.get(PROP.mcpRequiredRole) ?? 'mcp_user';
      return reply
        .code(403)
        .send(errorBody('Insufficient rights', `The MCP server requires the ${role} role`));
    }
    if (req.method !== 'POST') {
      reply.header('Allow', 'POST');
      return reply
        .code(405)
        .send(rpcError(-32000, 'Method not allowed: this server is stateless and only accepts POST'));
    }

    const server = createMcpServer(platform, auth.user, {
      transport: 'http',
      client: String(req.headers['user-agent'] ?? ''),
      baseUrl: baseUrl(req, deps),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || SKIP_HEADERS.has(k.toLowerCase())) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
      const body = req.body ?? null;
      const webReq = new Request(`${baseUrl(req, deps)}${req.url}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const res = await transport.handleRequest(webReq, { parsedBody: body });
      const text = await res.text();
      reply.code(res.status);
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-length') reply.header(key, value);
      });
      return reply.send(text);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };

  app.post(MCP_PATH, handler);
  app.get(MCP_PATH, handler);
  app.delete(MCP_PATH, handler);

  /** Self-service: a signed-in user with the MCP role creates an API token for their MCP client. */
  app.post(`${MCP_PATH}/tokens`, async (req, reply) => {
    const auth = deps.auth.require(req, reply);
    if (auth.method === 'bearer')
      throw new HttpError(403, 'Sign in with a password or session to create tokens');
    if (!auth.user.sysId || !mayUseMcp(platform, auth.user)) {
      throw new HttpError(
        403,
        'Insufficient rights',
        `Creating MCP tokens requires the ${platform.properties.get(PROP.mcpRequiredRole) ?? 'mcp_user'} role`,
      );
    }
    const body = (req.body ?? {}) as { name?: unknown; expires?: unknown };
    const name =
      String(body.name ?? 'MCP client')
        .trim()
        .slice(0, 100) || 'MCP client';
    let expires: string | undefined;
    if (body.expires !== undefined && body.expires !== null && body.expires !== '') {
      expires = normalizeDateTime(body.expires) ?? undefined;
      if (!expires) throw new HttpError(400, 'expires must be a date-time');
    }
    const token = deps.auth.issueToken(auth.user.sysId, name, expires);
    const row = platform
      .systemContext()
      .first('sys_api_token', `user=${auth.user.sysId}^token_prefix=${token.slice(0, 10)}`, [
        { field: 'sys_created_on', desc: true },
      ]);
    reply.code(201);
    return {
      result: {
        token,
        name,
        prefix: token.slice(0, 10),
        sys_id: row?.sysId ?? null,
        expires: expires ?? null,
      },
    };
  });
}
