import type { Database } from '../db.js';
import type { SchemaRegistry } from '../registry.js';

export interface SessionUser {
  /** sys_user sys_id; null for the system user. */
  sysId: string | null;
  userName: string;
  name: string;
  email: string | null;
  /** Effective roles (direct, via groups, expanded through role containment). */
  roles: Set<string>;
  /** Groups the user belongs to (sys_ids). */
  groups: string[];
  timeZone: string | null;
  managerId: string | null;
  isSystem: boolean;
  isAdmin: boolean;
}

export const SYSTEM_USER: SessionUser = Object.freeze({
  sysId: null,
  userName: 'system',
  name: 'System',
  email: null,
  roles: new Set(['admin']),
  groups: [],
  timeZone: null,
  managerId: null,
  isSystem: true,
  isAdmin: true,
}) as SessionUser;

/** Resolves users into sessions with effective roles and groups, with caching. */
export class UserService {
  private cache = new Map<string, SessionUser>();

  constructor(
    private db: Database,
    private registry: SchemaRegistry,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  private ready(): boolean {
    return ['sys_user', 'sys_user_group', 'sys_user_grmember', 'sys_user_role', 'sys_user_has_role'].every((t) =>
      this.registry.has(t),
    );
  }

  byUserName(userName: string): SessionUser | null {
    if (!this.ready()) return null;
    const row = this.db.get<{ sys_id: string }>(`SELECT "sys_id" FROM "sys_user" WHERE "user_name" = ? COLLATE NOCASE`, [
      userName,
    ]);
    return row ? this.session(row.sys_id) : null;
  }

  session(userId: string): SessionUser | null {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    if (!this.ready()) return null;
    const u = this.db.get<Record<string, unknown>>(
      `SELECT "sys_id","user_name","first_name","last_name","name","email","time_zone","manager","active","locked_out" FROM "sys_user" WHERE "sys_id" = ?`,
      [userId],
    );
    if (!u) return null;
    const groups = this.groupsOf(userId);
    const roles = this.effectiveRoles(userId, groups);
    const s: SessionUser = {
      sysId: userId,
      userName: String(u.user_name ?? ''),
      name: String(u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.user_name || ''),
      email: (u.email as string) ?? null,
      roles,
      groups,
      timeZone: (u.time_zone as string) || null,
      managerId: (u.manager as string) || null,
      isSystem: false,
      isAdmin: roles.has('admin'),
    };
    this.cache.set(userId, s);
    return s;
  }

  /** Active groups the user is a member of. */
  groupsOf(userId: string): string[] {
    return this.db
      .all<{ group: string }>(
        `SELECT m."group" AS "group" FROM "sys_user_grmember" m JOIN "sys_user_group" g ON g."sys_id" = m."group" WHERE m."user" = ? AND (g."active" IS NULL OR g."active" = 1)`,
        [userId],
      )
      .map((r) => r.group);
  }

  /** Group plus all ancestor groups (roles granted to a parent group flow down to child group members). */
  private groupLineage(groupIds: string[]): string[] {
    const out = new Set<string>();
    const stack = [...groupIds];
    while (stack.length) {
      const g = stack.pop()!;
      if (out.has(g)) continue;
      out.add(g);
      const row = this.db.get<{ parent: string | null }>(`SELECT "parent" FROM "sys_user_group" WHERE "sys_id" = ?`, [g]);
      if (row?.parent) stack.push(row.parent);
    }
    return [...out];
  }

  effectiveRoles(userId: string, groups: string[]): Set<string> {
    const roleIds = new Set<string>(
      this.db
        .all<{ role: string }>(`SELECT "role" FROM "sys_user_has_role" WHERE "user" = ? AND ("state" IS NULL OR "state" = 'active')`, [
          userId,
        ])
        .map((r) => r.role),
    );
    if (this.registry.has('sys_group_has_role')) {
      const lineage = this.groupLineage(groups);
      if (lineage.length) {
        for (const r of this.db.all<{ role: string }>(
          `SELECT "role" FROM "sys_group_has_role" WHERE "group" IN (${lineage.map(() => '?').join(',')})`,
          lineage,
        ))
          roleIds.add(r.role);
      }
    }
    // Expand containment
    const names = new Set<string>();
    const contains = this.registry.has('sys_user_role_contains');
    const stack = [...roleIds];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = this.db.get<{ name: string }>(`SELECT "name" FROM "sys_user_role" WHERE "sys_id" = ?`, [id]);
      if (r?.name) names.add(r.name);
      if (contains) {
        for (const c of this.db.all<{ contains: string }>(`SELECT "contains" FROM "sys_user_role_contains" WHERE "role" = ?`, [id]))
          stack.push(c.contains);
      }
    }
    // Every internal user implicitly holds snc_internal.
    names.add('snc_internal');
    return names;
  }

  /** Role names that a role grants (itself plus contained roles). */
  roleClosure(roleName: string): string[] {
    const row = this.db.get<{ sys_id: string }>(`SELECT "sys_id" FROM "sys_user_role" WHERE "name" = ?`, [roleName]);
    if (!row) return [roleName];
    const out = new Set<string>();
    const stack = [row.sys_id];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = this.db.get<{ name: string }>(`SELECT "name" FROM "sys_user_role" WHERE "sys_id" = ?`, [id]);
      if (r) out.add(r.name);
      for (const c of this.db.all<{ contains: string }>(`SELECT "contains" FROM "sys_user_role_contains" WHERE "role" = ?`, [id]))
        stack.push(c.contains);
    }
    return [...out];
  }
}
