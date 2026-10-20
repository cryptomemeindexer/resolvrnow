import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../engine/errors.js';
import type { Platform } from '../engine/platform.js';
import type { SessionUser } from '../engine/services/users.js';
import { addMs, newSysId, nowGlide, parseGlideDateTime } from '../engine/util.js';

export const SESSION_COOKIE = 'resolvr_session';
/** Header carrying the CSRF token for cookie-authenticated writes (same name the platform's UI uses). */
export const CSRF_HEADER = 'x-usertoken';

export interface AuthInfo {
  user: SessionUser;
  method: 'session' | 'basic' | 'bearer';
  sessionId?: string;
  csrfToken?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Authentication: HTTP Basic (platform-compatible REST clients), bearer API tokens
 * and cookie sessions for the web UI. Successful Basic logins are cached briefly so
 * that the deliberately slow password hash is not recomputed on every request.
 */
export class AuthService {
  private basicCache = new Map<string, { userId: string; until: number }>();

  constructor(private platform: Platform) {}

  sessionTtlMs(): number {
    return this.platform.properties.getNumber('glide.ui.session_timeout', 480) * 60_000;
  }

  createSession(user: SessionUser, req: FastifyRequest): { token: string; csrf: string } {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const now = nowGlide();
    this.platform.db.run(
      `INSERT INTO "sys_user_session" ("sys_id","sys_class_name","user","token_hash","csrf_token","expires","last_seen","ip_address","user_agent","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        newSysId(),
        'sys_user_session',
        user.sysId,
        sha256(token),
        csrf,
        addMs(now, this.sessionTtlMs()),
        now,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        now,
        user.userName,
        now,
        user.userName,
      ],
    );
    return { token, csrf };
  }

  destroySession(token: string): void {
    this.platform.db.run(`DELETE FROM "sys_user_session" WHERE "token_hash" = ?`, [sha256(token)]);
  }

  fromSession(token: string): AuthInfo | null {
    const row = this.platform.db.get<{ sys_id: string; user: string; csrf_token: string; expires: string; last_seen: string }>(
      `SELECT "sys_id","user","csrf_token","expires","last_seen" FROM "sys_user_session" WHERE "token_hash" = ?`,
      [sha256(token)],
    );
    if (!row) return null;
    const expires = parseGlideDateTime(row.expires);
    if (!expires || expires.getTime() < Date.now()) {
      this.platform.db.run(`DELETE FROM "sys_user_session" WHERE "sys_id" = ?`, [row.sys_id]);
      return null;
    }
    const user = this.platform.users.session(row.user);
    if (!user) return null;
    // Sliding expiration, written at most once a minute.
    const last = parseGlideDateTime(row.last_seen)?.getTime() ?? 0;
    if (Date.now() - last > 60_000) {
      const now = nowGlide();
      this.platform.db.run(`UPDATE "sys_user_session" SET "last_seen" = ?, "expires" = ? WHERE "sys_id" = ?`, [
        now,
        addMs(now, this.sessionTtlMs()),
        row.sys_id,
      ]);
    }
    return { user, method: 'session', sessionId: row.sys_id, csrfToken: row.csrf_token };
  }

  fromBasic(header: string): AuthInfo | null {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const userName = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    const key = sha256(decoded);
    const cached = this.basicCache.get(key);
    if (cached && cached.until > Date.now()) {
      const u = this.platform.users.session(cached.userId);
      if (u) return { user: u, method: 'basic' };
    }
    const user = this.platform.authenticate(userName, password);
    if (!user?.sysId) return null;
    this.basicCache.set(key, { userId: user.sysId, until: Date.now() + 60_000 });
    if (this.basicCache.size > 5000) this.basicCache.clear();
    return { user, method: 'basic' };
  }

  fromBearer(token: string): AuthInfo | null {
    if (!this.platform.registry.has('sys_api_token')) return null;
    const row = this.platform.db.get<{ sys_id: string; user: string; expires: string | null; active: number }>(
      `SELECT "sys_id","user","expires","active" FROM "sys_api_token" WHERE "token_hash" = ?`,
      [sha256(token)],
    );
    if (!row || row.active === 0) return null;
    if (row.expires && (parseGlideDateTime(row.expires)?.getTime() ?? 0) < Date.now()) return null;
    const user = this.platform.users.session(row.user);
    if (!user) return null;
    this.platform.db.run(`UPDATE "sys_api_token" SET "last_used" = ? WHERE "sys_id" = ?`, [nowGlide(), row.sys_id]);
    return { user, method: 'bearer' };
  }

  /** Creates an API token for a user and returns the clear-text value once. */
  issueToken(userId: string, name: string, expires?: string): string {
    const token = `resolvr_${randomBytes(24).toString('base64url')}`;
    const ctx = this.platform.systemContext();
    ctx.insert('sys_api_token', {
      name,
      user: userId,
      token_hash: sha256(token),
      token_prefix: token.slice(0, 10),
      expires: expires ?? null,
      active: true,
    });
    return token;
  }

  authenticate(req: FastifyRequest): AuthInfo | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) return this.fromBasic(header);
    if (header?.startsWith('Bearer ')) return this.fromBearer(header.slice(7).trim());
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) return this.fromSession(cookie);
    return null;
  }

  /** Throws when the request is not authenticated or fails the CSRF check. */
  require(req: FastifyRequest, _reply: FastifyReply): AuthInfo {
    const auth = req.auth;
    if (!auth) throw new AuthError();
    if (auth.method === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = req.headers[CSRF_HEADER];
      if (!token || token !== auth.csrfToken) throw new AuthError('Invalid or missing X-UserToken', 'CSRF token required');
    }
    return auth;
  }
}
