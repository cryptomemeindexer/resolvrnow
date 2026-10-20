import type { Context } from '../context.js';
import type { Database } from '../db.js';
import { matches } from '../query/matcher.js';
import type { Rec } from '../record.js';
import type { SchemaRegistry } from '../registry.js';
import { recSubject } from '../rules.js';

export type AclOperation = 'read' | 'write' | 'create' | 'delete' | 'report_view' | 'execute';

export interface AclDef {
  /** `table`, `table.field`, `table.*`, `*`, `*.*` or `*.field`. */
  name: string;
  operation: AclOperation;
  /** User needs at least one of these roles (empty = any authenticated user). */
  roles?: string[];
  /** Encoded query the record must match. */
  condition?: string;
  /** Native check; combined with roles and condition using AND. */
  script?: (rec: Rec | null, ctx: Context) => boolean;
  /** Admins pass without evaluation (default true). */
  adminOverrides?: boolean;
  description?: string;
  module?: string;
}

interface Acl {
  id: string;
  name: string;
  operation: string;
  roles: string[];
  condition: string | null;
  script: ((rec: Rec | null, ctx: Context) => boolean) | null;
  scriptSource: string | null;
  adminOverrides: boolean;
}

export interface AclDecision {
  allowed: boolean;
  /** ACL name level that decided, or null when the default decision applied. */
  matched: string | null;
}

/**
 * Access control evaluation. For an object, ACLs are searched from the most specific
 * name to the most generic; the first name level that has ACLs for the operation
 * decides, and any single ACL at that level passing grants access (roles AND
 * condition AND script). With no matching ACL the configured default applies (deny).
 */
export class AclService {
  private native = new Map<string, AclDef>();
  private cache: Map<string, Acl[]> | null = null;
  defaultAllow = false;
  /** Executes sandboxed ACL scripts stored in sys_security_acl.script. */
  scriptRunner: ((script: string, rec: Rec | null, ctx: Context) => boolean) | null = null;

  constructor(
    private db: Database,
    private registry: SchemaRegistry,
  ) {}

  defineNative(def: AclDef): string {
    const id = `native:${def.operation}:${def.name}:${this.native.size}`;
    this.native.set(id, def);
    this.cache = null;
    return id;
  }

  nativeDefs(): [string, AclDef][] {
    return [...this.native.entries()];
  }

  invalidate(): void {
    this.cache = null;
  }

  private load(): Map<string, Acl[]> {
    if (this.cache) return this.cache;
    const map = new Map<string, Acl[]>();
    const push = (a: Acl) => {
      const key = `${a.operation}|${a.name}`;
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    };
    const dbNative = new Set<string>();
    if (this.registry.has('sys_security_acl')) {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT "sys_id","name","operation","active","condition","script","admin_overrides","native_id" FROM "sys_security_acl" WHERE "active" IS NULL OR "active" = 1`,
      );
      const roleRows = this.registry.has('sys_security_acl_role')
        ? this.db.all<{ acl: string; role: string }>(
            `SELECT ar."sys_security_acl" AS acl, r."name" AS role FROM "sys_security_acl_role" ar JOIN "sys_user_role" r ON r."sys_id" = ar."sys_user_role"`,
          )
        : [];
      const rolesByAcl = new Map<string, string[]>();
      for (const rr of roleRows) {
        const l = rolesByAcl.get(rr.acl) ?? [];
        l.push(rr.role);
        rolesByAcl.set(rr.acl, l);
      }
      for (const r of rows) {
        const nativeId = (r.native_id as string) || null;
        const nat = nativeId ? this.native.get(nativeId) : undefined;
        if (nativeId) dbNative.add(nativeId);
        push({
          id: String(r.sys_id),
          name: String(r.name),
          operation: String(r.operation),
          roles: rolesByAcl.get(String(r.sys_id)) ?? [],
          condition: (r.condition as string) || null,
          script: nat?.script ?? null,
          scriptSource: nat ? null : ((r.script as string) || null),
          adminOverrides: r.admin_overrides === null || r.admin_overrides === undefined ? true : r.admin_overrides === 1,
        });
      }
    }
    // Native ACLs not (yet) mirrored to the database.
    for (const [id, def] of this.native) {
      if (dbNative.has(id)) continue;
      push({
        id,
        name: def.name,
        operation: def.operation,
        roles: def.roles ?? [],
        condition: def.condition ?? null,
        script: def.script ?? null,
        scriptSource: null,
        adminOverrides: def.adminOverrides ?? true,
      });
    }
    this.cache = map;
    return map;
  }

  private pass(acl: Acl, rec: Rec | null, ctx: Context): boolean {
    const user = ctx.user;
    if (acl.adminOverrides && user.isAdmin) return true;
    if (acl.roles.length && !acl.roles.some((r) => ctx.hasRole(r))) return false;
    if (acl.condition && rec) {
      if (!matches(acl.condition, recSubject(rec, null, this.registry), ctx.env)) return false;
    }
    if (acl.script && !acl.script(rec, ctx)) return false;
    if (acl.scriptSource && this.scriptRunner && !this.scriptRunner(acl.scriptSource, rec, ctx)) return false;
    return true;
  }

  private decide(names: string[], operation: string, rec: Rec | null, ctx: Context): AclDecision {
    const map = this.load();
    for (const name of names) {
      const acls = map.get(`${operation}|${name}`);
      if (acls?.length) {
        return { allowed: acls.some((a) => this.pass(a, rec, ctx)), matched: name };
      }
    }
    return { allowed: this.defaultAllow || ctx.user.isAdmin, matched: null };
  }

  /** Table (row) level check. */
  canTable(ctx: Context, table: string, operation: AclOperation, rec: Rec | null = null): AclDecision {
    if (ctx.user.isSystem || !ctx.enforceAcl) return { allowed: true, matched: null };
    const meta = this.registry.tryTable(table);
    const names = [...(meta?.ancestors ?? [table]), '*'];
    return this.decide(names, operation, rec, ctx);
  }

  /** Field level check (table-level access must also pass). */
  canField(ctx: Context, table: string, field: string, operation: AclOperation, rec: Rec | null = null): boolean {
    if (ctx.user.isSystem || !ctx.enforceAcl) return true;
    const meta = this.registry.tryTable(table);
    const chain = meta?.ancestors ?? [table];
    const names = [...chain.map((t) => `${t}.${field}`), `*.${field}`, ...chain.map((t) => `${t}.*`), '*.*'];
    const map = this.load();
    for (const name of names) {
      const acls = map.get(`${operation}|${name}`);
      if (acls?.length) return acls.some((a) => this.pass(a, rec, ctx));
    }
    // No field ACL: field access follows table access.
    return true;
  }
}
