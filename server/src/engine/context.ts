import type { SqlParam } from './db.js';
import { AbortError, AccessError, InvalidError, NotFoundError } from './errors.js';
import type { Platform } from './platform.js';
import { QueryCompiler } from './query/compiler.js';
import type { MacroEnv } from './query/macros.js';
import { type OrderSpec, type ParsedQuery, stringifyQuery } from './query/parser.js';
import { QueryBuilder } from './querybuilder.js';
import { Rec, type RecordHost } from './record.js';
import type { SchemaRegistry } from './registry.js';
import type { AclOperation } from './services/acl.js';
import { SYSTEM_USER, type SessionUser } from './services/users.js';
import type { ColumnMeta, Internal, RowData, TableMeta } from './types.js';
import { isSysId, newSysId, nowGlide, quoteIdent } from './util.js';
import { evaluateDefault } from './values.js';

export interface QueryOptions {
  query?: string | ParsedQuery | null;
  orderBy?: OrderSpec[];
  limit?: number;
  offset?: number;
  /** Override the context's ACL enforcement for this query. */
  acl?: boolean;
}

export interface WriteOptions {
  /** Treat reference/choice inputs as display values. */
  displayValue?: boolean;
  /** Skip sys_created/sys_updated maintenance (imports). */
  autoSysFields?: boolean;
}

export interface Message {
  type: 'info' | 'error';
  text: string;
}

const MAX_DEPTH = 16;

/**
 * An execution context: who is acting and with which switches (ACL enforcement,
 * business rules, auditing). All data access goes through a context.
 */
export class Context implements RecordHost {
  enforceAcl: boolean;
  workflow = true;
  auditEnabled = true;
  messages: Message[];
  readonly env: MacroEnv;
  private depth: { n: number };
  private recCache = new Map<string, Rec | null>();
  private displayCache = new Map<string, string>();

  constructor(
    readonly platform: Platform,
    readonly user: SessionUser,
    shared?: { messages: Message[]; depth: { n: number } },
  ) {
    this.enforceAcl = !user.isSystem;
    this.messages = shared?.messages ?? [];
    this.depth = shared?.depth ?? { n: 0 };
    this.env = {
      userId: user.sysId,
      userName: user.userName,
      myGroups: () => user.groups,
      managerId: () => user.managerId,
      timeZone: user.timeZone,
    };
  }

  get registry(): SchemaRegistry {
    return this.platform.registry;
  }

  /** Same user, different switches; shares messages and recursion depth. */
  derive(opts: { acl?: boolean; workflow?: boolean; audit?: boolean; user?: SessionUser } = {}): Context {
    const c = new Context(this.platform, opts.user ?? this.user, { messages: this.messages, depth: this.depth });
    c.enforceAcl = opts.acl ?? (opts.user ? !opts.user.isSystem : this.enforceAcl);
    c.workflow = opts.workflow ?? this.workflow;
    c.auditEnabled = opts.audit ?? this.auditEnabled;
    return c;
  }

  /** System context (no ACLs), keeping the caller's identity for audit fields. */
  elevated(): Context {
    return this.derive({ acl: false });
  }

  asSystem(): Context {
    return this.derive({ user: SYSTEM_USER, acl: false });
  }

  /** Admins implicitly hold every role except elevated (privileged) roles, which must be granted explicitly. */
  hasRole(role: string): boolean {
    if (this.user.roles.has(role)) return true;
    return this.user.isAdmin && !this.platform.elevatedRoles.has(role);
  }

  hasAnyRole(roles: string[]): boolean {
    return roles.length === 0 || roles.some((r) => this.hasRole(r));
  }

  addInfoMessage(text: string): void {
    this.messages.push({ type: 'info', text });
  }

  addErrorMessage(text: string): void {
    this.messages.push({ type: 'error', text });
  }

  // ---------------------------------------------------------------- RecordHost

  loadRaw(table: string, sysId: string): Rec | null {
    if (!isSysId(sysId)) return null;
    const key = `${table}:${sysId}`;
    if (this.recCache.has(key)) return this.recCache.get(key)!;
    const meta = this.registry.tryTable(table);
    let rec: Rec | null = null;
    if (meta) {
      const row = this.platform.db.get<Record<string, unknown>>(
        `SELECT * FROM ${quoteIdent(meta.physical)} WHERE "sys_id" = ?`,
        [sysId],
      );
      if (row) {
        const cls = String(row.sys_class_name ?? meta.name);
        if (meta.descendants.includes(cls) || cls === meta.name || !this.registry.has(cls)) {
          rec = this.rowToRec(row, meta);
        }
      }
    }
    this.recCache.set(key, rec);
    return rec;
  }

  displayOf(table: string, sysId: string): string {
    const key = `${table}:${sysId}`;
    const hit = this.displayCache.get(key);
    if (hit !== undefined) return hit;
    const rec = this.loadRaw(table, sysId);
    const v = rec ? rec.displayValue() : '';
    this.displayCache.set(key, v);
    return v;
  }

  choiceLabel(table: string, field: string, value: string): string | undefined {
    return this.platform.choices.label(table, field, value);
  }

  timeZone(): string | null {
    return this.user.timeZone;
  }

  resolveInput(table: TableMeta, col: ColumnMeta, value: string): Internal | undefined {
    if (col.type === 'reference' && col.reference) {
      const target = this.registry.tryTable(col.reference);
      if (!target) return undefined;
      if (isSysId(value)) return value;
      const disp = target.columns.get(target.displayField);
      if (!disp?.storage) return undefined;
      const row = this.platform.db.get<{ sys_id: string }>(
        `SELECT "sys_id" FROM ${quoteIdent(target.physical)} WHERE ${quoteIdent(disp.physical)} = ? COLLATE NOCASE${
          target.name !== target.root ? ` AND "sys_class_name" IN (${target.descendants.map(() => '?').join(',')})` : ''
        } LIMIT 1`,
        target.name !== target.root ? [value, ...target.descendants] : [value],
      );
      if (row) return row.sys_id;
      // user_name / email are common alternate keys for users
      if (target.root === 'sys_user') {
        const u = this.platform.db.get<{ sys_id: string }>(
          `SELECT "sys_id" FROM "sys_user" WHERE "user_name" = ? COLLATE NOCASE OR "email" = ? COLLATE NOCASE LIMIT 1`,
          [value, value],
        );
        if (u) return u.sys_id;
      }
      return undefined;
    }
    const choice = this.platform.choices.resolve(table.name, col.name, value);
    return choice;
  }

  // ---------------------------------------------------------------- reading

  rowToRec(row: Record<string, unknown>, fallback: TableMeta): Rec {
    const cls = String(row.sys_class_name ?? fallback.name);
    const meta = this.registry.tryTable(cls) ?? fallback;
    const data: RowData = {};
    for (const [name, col] of meta.columns) {
      if (!col.storage) continue;
      const v = row[col.physical];
      data[name] = v === undefined ? null : (v as Internal);
    }
    return new Rec(this, meta, data, { ...data });
  }

  newQuery(table: string): QueryBuilder {
    return new QueryBuilder(table);
  }

  private compile(table: TableMeta, q: QueryBuilder | ParsedQuery | string | null | undefined, orderBy: OrderSpec[] = []) {
    let parsed: ParsedQuery | string | null | undefined;
    if (q instanceof QueryBuilder) parsed = q.parsed();
    else parsed = q;
    return QueryCompiler.compile(this.registry, table.name, parsed ?? null, this.env, orderBy);
  }

  private applyQueryRules(qb: QueryBuilder): void {
    if (!this.workflow || this.user.isSystem) return;
    for (const rule of this.platform.rules.select(qb.table, 'before', 'query')) {
      try {
        rule.query?.(qb, this);
      } catch (e) {
        this.platform.reportError(`query rule ${rule.id}`, e);
      }
    }
  }

  private toBuilder(table: string, opts: QueryOptions | QueryBuilder | string | undefined): QueryBuilder {
    if (opts instanceof QueryBuilder) return opts;
    const qb = new QueryBuilder(table);
    if (typeof opts === 'string') {
      qb.addEncodedQuery(opts);
      return qb;
    }
    if (opts?.query) {
      if (typeof opts.query === 'string') qb.addEncodedQuery(opts.query);
      else qb.addEncodedQuery(stringifyQuery(opts.query));
    }
    if (opts?.orderBy) qb.orderBy.push(...opts.orderBy);
    if (opts?.limit !== undefined) qb.limit = opts.limit;
    if (opts?.offset !== undefined) qb.offset = opts.offset;
    return qb;
  }

  /** Runs a query; returns matching records the user may read. */
  query(table: string, opts?: QueryOptions | QueryBuilder | string): Rec[] {
    const meta = this.registry.table(table);
    const qb = this.toBuilder(table, opts);
    const enforce = (typeof opts === 'object' && !(opts instanceof QueryBuilder) && opts?.acl !== undefined
      ? opts.acl
      : this.enforceAcl) && !this.user.isSystem;
    if (enforce) this.assertTable(meta, 'read');
    this.applyQueryRules(qb);
    const c = this.compile(meta, qb);
    const order = c.orderBy ? c.orderBy : 't0.rowid ASC';
    let sql = `SELECT t0.* FROM ${c.from} ${c.joins.join(' ')} WHERE ${c.where} ORDER BY ${order}`;
    const params: SqlParam[] = [...c.params];
    if (qb.limit !== undefined) {
      sql += ` LIMIT ? OFFSET ?`;
      params.push(qb.limit, qb.offset ?? 0);
    } else if (qb.offset) {
      sql += ` LIMIT -1 OFFSET ?`;
      params.push(qb.offset);
    }
    const rows = this.platform.db.all<Record<string, unknown>>(sql, params);
    const recs = rows.map((r) => this.rowToRec(r, meta));
    if (!enforce) return recs;
    return recs.filter((r) => this.platform.acl.canTable(this, r.className, 'read', r).allowed);
  }

  /** Count of rows matching the query (row-level ACL conditions are not applied, matching the platform's total count). */
  count(table: string, query?: string | QueryBuilder | null): number {
    const meta = this.registry.table(table);
    const qb = query instanceof QueryBuilder ? query : this.toBuilder(table, query ?? undefined);
    this.applyQueryRules(qb);
    const c = this.compile(meta, qb);
    const row = this.platform.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${c.from} ${c.joins.join(' ')} WHERE ${c.where}`,
      c.params,
    );
    return row?.n ?? 0;
  }

  first(table: string, query?: string | null, orderBy?: OrderSpec[]): Rec | null {
    return this.query(table, { query: query ?? null, limit: 1, orderBy })[0] ?? null;
  }

  /** Fetch by sys_id, honouring ACLs. Returns null when missing or not readable. */
  get(table: string, sysId: string): Rec | null {
    const meta = this.registry.table(table);
    if (!isSysId(sysId)) return null;
    const row = this.platform.db.get<Record<string, unknown>>(
      `SELECT * FROM ${quoteIdent(meta.physical)} WHERE "sys_id" = ?`,
      [sysId],
    );
    if (!row) return null;
    const cls = String(row.sys_class_name ?? meta.name);
    if (!meta.descendants.includes(cls) && this.registry.has(cls)) return null;
    const rec = this.rowToRec(row, meta);
    if (this.enforceAcl && !this.user.isSystem) {
      if (!this.platform.acl.canTable(this, rec.className, 'read', rec).allowed) return null;
    }
    return rec;
  }

  getBy(table: string, field: string, value: string | number): Rec | null {
    const qb = new QueryBuilder(table).addQuery(field, value as string);
    qb.limit = 1;
    return this.query(table, qb)[0] ?? null;
  }

  mustGet(table: string, sysId: string): Rec {
    const r = this.get(table, sysId);
    if (!r) throw new NotFoundError();
    return r;
  }

  // ---------------------------------------------------------------- writing

  private assertTable(meta: TableMeta, op: AclOperation, rec: Rec | null = null): void {
    if (!this.enforceAcl || this.user.isSystem) return;
    const d = this.platform.acl.canTable(this, meta.name, op, rec);
    if (!d.allowed) {
      throw new AccessError(
        op === 'read' ? 'Insufficient rights to query records' : `Insufficient rights to ${op} record`,
        `ACL denied ${op} on ${meta.name}`,
      );
    }
  }

  /** A new, unsaved record with dictionary defaults applied. */
  newRecord(table: string): Rec {
    const meta = this.registry.table(table);
    const data: RowData = {};
    const now = nowGlide();
    for (const [name, col] of meta.columns) {
      if (!col.storage) continue;
      data[name] = null;
      if (col.defaultValue !== undefined && name !== 'number') {
        try {
          data[name] = evaluateDefault(col, { ...this.env, now, table: meta.name });
        } catch {
          data[name] = null;
        }
      }
    }
    data.sys_id = newSysId();
    data.sys_class_name = meta.name;
    return new Rec(this, meta, data, null);
  }

  /** Inserts a record built from `values` (or a prepared Rec). */
  insert(tableOrRec: string | Rec, values: Record<string, unknown> = {}, opts: WriteOptions = {}): Rec {
    const rec = typeof tableOrRec === 'string' ? this.newRecord(tableOrRec) : tableOrRec;
    if (!rec.isNew()) throw new InvalidError('Record already exists');
    // Allow callers to choose the class of a hierarchy table (e.g. POST to cmdb_ci with sys_class_name).
    if (typeof tableOrRec === 'string' && typeof values.sys_class_name === 'string' && values.sys_class_name !== rec.table.name) {
      const cls = this.registry.tryTable(values.sys_class_name);
      if (cls && cls.ancestors.includes(rec.table.name)) {
        const keep = rec.data.sys_id;
        const fresh = this.newRecord(cls.name);
        fresh.data.sys_id = keep;
        return this.insert(fresh, values, opts);
      }
    }
    if (values.sys_id && isSysId(values.sys_id)) rec.data.sys_id = values.sys_id as string;
    const { sys_id: _ignored, sys_class_name: _cls, ...rest } = values;
    rec.setMany(rest, { displayValue: opts.displayValue });
    return this.persistInsert(rec, opts);
  }

  private enter(): void {
    if (++this.depth.n > MAX_DEPTH) {
      this.depth.n = 0;
      throw new InvalidError('Maximum business rule recursion depth exceeded');
    }
  }

  private leave(): void {
    this.depth.n = Math.max(0, this.depth.n - 1);
  }

  private runRules(when: 'before' | 'after', action: 'insert' | 'update' | 'delete', rec: Rec, prev: Rec | null): void {
    if (!this.workflow) return;
    for (const rule of this.platform.rules.select(rec.className, when, action)) {
      if (!this.platform.rules.conditionMatches(rule, rec, prev, this, this.env)) continue;
      try {
        rule.run?.(rec, prev, this);
      } catch (e) {
        if (e instanceof AbortError || e instanceof AccessError || e instanceof InvalidError) throw e;
        this.platform.reportError(`business rule ${rule.id}`, e);
      }
      if (rec.abortMessage) return;
    }
  }

  private queueAsync(action: 'insert' | 'update' | 'delete', rec: Rec, prev: Rec | null): void {
    if (!this.workflow) return;
    const rules = this.platform.rules.select(rec.className, 'async', action);
    if (!rules.length) return;
    const table = rec.className;
    const sysId = rec.sysId;
    const prevData = prev ? { ...prev.data } : null;
    const user = this.user;
    const snapshot = { ...rec.data };
    for (const rule of rules) {
      this.platform.enqueueAsync(`${rule.id}:${sysId}`, () => {
        const ctx = this.platform.contextFor(user).derive({ acl: false });
        const cur = ctx.loadRaw(table, sysId) ?? new Rec(ctx, this.registry.table(table), snapshot, snapshot);
        const p = prevData ? new Rec(ctx, cur.table, prevData, prevData) : null;
        if (!this.platform.rules.conditionMatches(rule, cur, p, ctx, ctx.env)) return;
        rule.run?.(cur, p, ctx);
      });
    }
  }

  private persistInsert(rec: Rec, opts: WriteOptions): Rec {
    this.assertTable(rec.table, 'create', rec);
    this.enter();
    try {
      return this.platform.db.tx(() => {
        rec.operation = 'insert';
        if (!rec.str('number') && rec.has('number')) {
          const n = this.platform.numbers.next(rec.table);
          if (n) rec.setRaw('number', n);
        }
        this.runRules('before', 'insert', rec, null);
        if (rec.abortMessage) throw new AbortError(rec.abortMessage);
        const now = nowGlide();
        if (opts.autoSysFields !== false || !rec.data.sys_created_on) {
          rec.data.sys_created_on = rec.data.sys_created_on && opts.autoSysFields === false ? rec.data.sys_created_on : now;
          rec.data.sys_created_by = rec.data.sys_created_by && opts.autoSysFields === false ? rec.data.sys_created_by : this.user.userName;
          rec.data.sys_updated_on = rec.data.sys_updated_on && opts.autoSysFields === false ? rec.data.sys_updated_on : now;
          rec.data.sys_updated_by = rec.data.sys_updated_by && opts.autoSysFields === false ? rec.data.sys_updated_by : this.user.userName;
        }
        rec.data.sys_mod_count = 0;
        rec.data.sys_class_name = rec.table.name;
        this.writeInsert(rec);
        if (this.auditEnabled) this.platform.history.auditInsert(rec, this.user.userName);
        this.platform.history.writeJournal(rec, this.user.userName);
        this.recCache.delete(`${rec.table.name}:${rec.sysId}`);
        this.runRules('after', 'insert', rec, null);
        const journal = rec.journal;
        rec.commit();
        rec.journal = journal;
        this.platform.hooks.emit('insert', rec, null, this, (n, e) => this.platform.reportError(n, e));
        rec.journal = [];
        this.queueAsync('insert', rec, null);
        return rec;
      });
    } finally {
      this.leave();
    }
  }

  private writeInsert(rec: Rec): void {
    const cols: string[] = [];
    const vals: SqlParam[] = [];
    for (const [name, col] of rec.table.columns) {
      if (!col.storage) continue;
      cols.push(quoteIdent(col.physical));
      const v = rec.data[name];
      vals.push(v === undefined ? null : (v as SqlParam));
    }
    this.platform.db.run(
      `INSERT INTO ${quoteIdent(rec.table.physical)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      vals,
    );
  }

  /** Applies `values` to a record and saves it (or saves pending changes on a Rec). */
  update(rec: Rec, values: Record<string, unknown> = {}, opts: WriteOptions = {}): Rec {
    if (rec.isNew()) return this.insert(rec, values, opts);
    this.assertTable(rec.table, 'write', rec);
    rec.setMany(values, { displayValue: opts.displayValue });
    return this.persistUpdate(rec, opts);
  }

  updateById(table: string, sysId: string, values: Record<string, unknown>, opts: WriteOptions = {}): Rec {
    const rec = this.get(table, sysId);
    if (!rec) throw new NotFoundError();
    return this.update(rec, values, opts);
  }

  private persistUpdate(rec: Rec, opts: WriteOptions): Rec {
    this.enter();
    try {
      return this.platform.db.tx(() => {
        rec.operation = 'update';
        const previous = rec.snapshot();
        this.runRules('before', 'update', rec, previous);
        if (rec.abortMessage) throw new AbortError(rec.abortMessage);
        const changed = rec.changes().filter((f) => rec.column(f)?.storage);
        const hasJournal = rec.journal.length > 0;
        if (changed.length === 0 && !hasJournal) {
          rec.commit();
          return rec;
        }
        if (opts.autoSysFields !== false) {
          rec.data.sys_updated_on = nowGlide();
          rec.data.sys_updated_by = this.user.userName;
          rec.data.sys_mod_count = Number(rec.data.sys_mod_count ?? 0) + 1;
        }
        const fields = new Set([...changed, 'sys_updated_on', 'sys_updated_by', 'sys_mod_count']);
        const sets: string[] = [];
        const vals: SqlParam[] = [];
        for (const f of fields) {
          const col = rec.column(f);
          if (!col?.storage) continue;
          sets.push(`${quoteIdent(col.physical)} = ?`);
          const v = rec.data[f];
          vals.push(v === undefined ? null : (v as SqlParam));
        }
        vals.push(rec.sysId);
        this.platform.db.run(`UPDATE ${quoteIdent(rec.table.physical)} SET ${sets.join(', ')} WHERE "sys_id" = ?`, vals);
        if (this.auditEnabled) this.platform.history.auditUpdate(rec, this.user.userName);
        this.platform.history.writeJournal(rec, this.user.userName);
        this.recCache.delete(`${rec.table.name}:${rec.sysId}`);
        for (const k of this.displayCache.keys()) if (k.endsWith(`:${rec.sysId}`)) this.displayCache.delete(k);
        this.runRules('after', 'update', rec, previous);
        // Hooks see the pre-commit state so they can compare with previous.
        const journal = rec.journal;
        const original = rec.original;
        this.platform.hooks.emit('update', rec, previous, this, (n, e) => this.platform.reportError(n, e));
        rec.original = original;
        rec.journal = journal;
        this.queueAsync('update', rec, previous);
        rec.commit();
        return rec;
      });
    } finally {
      this.leave();
    }
  }

  delete(rec: Rec): void {
    this.assertTable(rec.table, 'delete', rec);
    this.enter();
    try {
      this.platform.db.tx(() => {
        rec.operation = 'delete';
        this.runRules('before', 'delete', rec, null);
        if (rec.abortMessage) throw new AbortError(rec.abortMessage);
        this.platform.db.run(`DELETE FROM ${quoteIdent(rec.table.physical)} WHERE "sys_id" = ?`, [rec.sysId]);
        if (this.auditEnabled) this.platform.history.auditDelete(rec, this.user.userName);
        this.recCache.delete(`${rec.table.name}:${rec.sysId}`);
        this.cascadeDelete(rec);
        this.runRules('after', 'delete', rec, null);
        this.platform.hooks.emit('delete', rec, null, this, (n, e) => this.platform.reportError(n, e));
        this.queueAsync('delete', rec, null);
      });
    } finally {
      this.leave();
    }
  }

  deleteById(table: string, sysId: string): void {
    const rec = this.get(table, sysId);
    if (!rec) throw new NotFoundError();
    this.delete(rec);
  }

  /** Applies cascade rules declared on reference columns that point at the deleted record's table. */
  private cascadeDelete(rec: Rec): void {
    for (const t of this.registry.tables()) {
      if (t.parent) continue; // walk each physical table once via its root
      for (const meta of this.registry.tables().filter((m) => m.root === t.name)) {
        for (const col of meta.columns.values()) {
          if (col.definedOn !== meta.name) continue;
          if (col.type !== 'reference' || !col.reference || !col.cascade || col.cascade === 'none') continue;
          if (!rec.table.ancestors.includes(col.reference)) continue;
          if (col.cascade === 'clear') {
            this.platform.db.run(
              `UPDATE ${quoteIdent(meta.physical)} SET ${quoteIdent(col.physical)} = NULL WHERE ${quoteIdent(col.physical)} = ?`,
              [rec.sysId],
            );
          } else if (col.cascade === 'delete') {
            const children = this.derive({ acl: false }).query(meta.name, { query: `${col.name}=${rec.sysId}` });
            for (const ch of children) this.derive({ acl: false }).delete(ch);
          } else if (col.cascade === 'restrict') {
            const n = this.derive({ acl: false }).count(meta.name, `${col.name}=${rec.sysId}`);
            if (n > 0) throw new AbortError(`Cannot delete: referenced by ${n} ${meta.label} record(s)`);
          }
        }
      }
    }
  }

  /** Queues a platform event (sysevent) for notifications and script actions. */
  queueEvent(name: string, rec: Rec | null, parm1?: string | null, parm2?: string | null): void {
    this.platform.events.queue(this, name, rec, parm1 ?? null, parm2 ?? null);
  }
}
