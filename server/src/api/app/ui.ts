import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { FormLayoutDef, ListLayoutDef, NavApplicationDef, UiActionDef } from '../../engine/module.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { JOURNAL_TYPES, type TableMeta } from '../../engine/types.js';
import { SESSION_COOKIE } from '../auth.js';
import { type ApiDeps, ctxOf, HttpError } from '../http.js';
import { serializeRecord } from '../serialize.js';

function visibleNav(ctx: Context, apps: NavApplicationDef[]): NavApplicationDef[] {
  return apps
    .filter((a) => !a.roles?.length || ctx.hasAnyRole(a.roles))
    .map((a) => ({ ...a, modules: a.modules.filter((m) => !m.roles?.length || ctx.hasAnyRole(m.roles)) }))
    .filter((a) => a.modules.length > 0)
    .sort((a, b) => (a.order ?? 500) - (b.order ?? 500));
}

/** Resolves the form layout for a table, walking up the hierarchy, or generates one. */
export function formLayout(deps: ApiDeps, table: TableMeta, view = 'default'): FormLayoutDef {
  for (const t of table.ancestors) {
    const f = deps.platform.forms.get(`${t}:${view}`) ?? deps.platform.forms.get(`${t}:default`);
    if (f) return f;
  }
  const fields = [...table.columns.values()]
    .filter((c) => !c.system && !c.internal && (c.storage || JOURNAL_TYPES.has(c.type)))
    .map((c) => c.name);
  const half = Math.ceil(fields.length / 2);
  return { table: table.name, sections: [{ left: fields.slice(0, half), right: fields.slice(half) }] };
}

export function listLayout(deps: ApiDeps, table: TableMeta, view = 'default'): ListLayoutDef {
  for (const t of table.ancestors) {
    const l = deps.platform.lists.get(`${t}:${view}`) ?? deps.platform.lists.get(`${t}:default`);
    if (l) return l;
  }
  const cols = [table.displayField, ...[...table.columns.values()].filter((c) => !c.system && !c.internal && c.storage).map((c) => c.name)];
  return { table: table.name, columns: [...new Set(cols)].slice(0, 7) };
}

function columnMeta(ctx: Context, table: TableMeta, deps: ApiDeps) {
  const out: Record<string, unknown> = {};
  for (const [name, c] of table.columns) {
    const choices = deps.platform.choices.list(table.name, name, { includeInactive: false });
    out[name] = {
      name,
      label: c.label,
      type: c.type,
      maxLength: c.maxLength ?? null,
      mandatory: !!c.mandatory,
      readOnly: !!c.readOnly || !!c.system,
      reference: c.reference ?? null,
      referenceQual: c.referenceQual ?? null,
      dependentOn: c.dependentOn ?? null,
      choiceMode: c.choiceMode ?? (choices.length ? 'dropdown_with_none' : null),
      choices: choices.length ? choices : undefined,
      hint: c.hint ?? null,
      definedOn: c.definedOn,
      canRead: deps.platform.acl.canField(ctx, table.name, name, 'read'),
      canWrite: !c.system && deps.platform.acl.canField(ctx, table.name, name, 'write'),
    };
  }
  return out;
}

export function actionVisible(a: UiActionDef, rec: Rec, ctx: Context): boolean {
  if (a.roles?.length && !ctx.hasAnyRole(a.roles)) return false;
  if (!a.condition) return true;
  if (typeof a.condition === 'function') return a.condition(rec, ctx);
  return matches(a.condition, recSubject(rec, null, ctx.registry), ctx.env);
}

export function actionsFor(deps: ApiDeps, ctx: Context, rec: Rec, where: 'form' | 'list' = 'form') {
  return [...deps.platform.uiActions.values()]
    .filter((a) => rec.table.ancestors.includes(a.table) && (where === 'form' ? a.form !== false : !!a.list))
    .filter((a) => {
      try {
        return actionVisible(a, rec, ctx);
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map((a) => ({
      id: a.id,
      label: a.label,
      actionName: a.actionName ?? a.id,
      style: a.style ?? 'default',
      confirm: a.confirm ?? null,
      prompt: a.prompt ?? null,
      saveFirst: a.saveFirst !== false,
    }));
}

/** Activity stream: journal entries + field changes + emails, newest first. */
export function activityFor(ctx: Context, rec: Rec) {
  const p = ctx.platform;
  const nameOf = (userName: string) =>
    p.db.get<{ name: string; sys_id: string }>(`SELECT "name","sys_id" FROM "sys_user" WHERE "user_name" = ?`, [userName]);
  const items: Record<string, unknown>[] = [];
  const canWorkNotes = ctx.hasRole('itil') || ctx.user.isSystem;
  for (const j of p.history.journal(rec.className, rec.sysId)) {
    if (j.element === 'work_notes' && !canWorkNotes) continue;
    const u = nameOf(j.sys_created_by);
    items.push({
      type: 'journal',
      field: j.element,
      label: rec.column(j.element)?.label ?? j.element,
      value: j.value,
      created_on: j.sys_created_on,
      created_by: j.sys_created_by,
      user_name: u?.name ?? j.sys_created_by,
      user_id: u?.sys_id ?? null,
    });
  }
  if (canWorkNotes) {
    const groups = new Map<string, Record<string, unknown>>();
    for (const a of p.history.audit(rec.className, rec.sysId)) {
      const col = rec.column(a.fieldname);
      if (!col || col.internal) continue;
      // Initial values equal to the dictionary default add noise to the "created" entry.
      if (a.record_checkpoint === 0 && col.defaultValue !== undefined && typeof col.defaultValue !== 'function') {
        const def = String(col.defaultValue);
        const norm = (v: string | null) => (v === 'true' ? '1' : v === 'false' ? '0' : (v ?? ''));
        if (norm(def) === norm(a.newvalue) || def.startsWith('javascript:')) continue;
      }
      const key = `${a.sys_created_on}|${a.user}|${a.record_checkpoint}`;
      let g = groups.get(key);
      if (!g) {
        const u = nameOf(a.user);
        g = {
          type: a.record_checkpoint === 0 ? 'created' : 'changes',
          created_on: a.sys_created_on,
          created_by: a.user,
          user_name: u?.name ?? a.user,
          user_id: u?.sys_id ?? null,
          changes: [] as unknown[],
        };
        groups.set(key, g);
      }
      const disp = (v: string | null) => {
        if (v === null || v === '') return '';
        const probe = ctx.newRecord(rec.className);
        probe.setRaw(a.fieldname, col.storage === 'INTEGER' && /^-?\d+$/.test(v) ? Number(v) : v);
        return probe.display(a.fieldname);
      };
      (g.changes as unknown[]).push({ field: a.fieldname, label: col.label, old: disp(a.oldvalue), new: disp(a.newvalue) });
    }
    items.push(...groups.values());
  }
  if (p.registry.has('sys_email')) {
    for (const e of p.db.all<Record<string, string>>(
      `SELECT "sys_id","subject","recipients","type","sys_created_on" FROM "sys_email" WHERE "instance" = ? ORDER BY "sys_created_on" DESC LIMIT 50`,
      [rec.sysId],
    )) {
      if (!canWorkNotes) continue;
      items.push({ type: 'email', sys_id: e.sys_id, subject: e.subject, recipients: e.recipients, direction: e.type, created_on: e.sys_created_on });
    }
  }
  if (p.registry.has('sys_attachment')) {
    for (const a of ctx.query('sys_attachment', { query: `table_sys_id=${rec.sysId}` })) {
      items.push({
        type: 'attachment',
        sys_id: a.sysId,
        file_name: a.str('file_name'),
        size_bytes: a.num('size_bytes'),
        content_type: a.str('content_type'),
        created_on: a.str('sys_created_on'),
        created_by: a.str('sys_created_by'),
      });
    }
  }
  items.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
  return items;
}

export function registerUiApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;

  app.post('/api/app/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { user_name?: string; password?: string };
    const user = body.user_name && body.password ? platform.authenticate(body.user_name, body.password) : null;
    if (!user) throw new HttpError(401, 'Invalid user name or password');
    const { token, csrf } = deps.auth.createSession(user, req);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.secureCookies,
      path: '/',
      maxAge: Math.floor(deps.auth.sessionTtlMs() / 1000),
    });
    return { result: { user_name: user.userName, name: user.name, csrf_token: csrf } };
  });

  app.post('/api/app/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) deps.auth.destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { result: { ok: true } };
  });

  app.get('/api/app/me', async (req) => {
    const ctx = ctxOf(req, deps);
    const u = ctx.user;
    const userRec = u.sysId ? ctx.elevated().get('sys_user', u.sysId) : null;
    return {
      result: {
        sys_id: u.sysId,
        user_name: u.userName,
        name: u.name,
        email: u.email,
        roles: [...u.roles].sort(),
        groups: u.groups.map((g) => ({ sys_id: g, name: ctx.displayOf('sys_user_group', g) })),
        is_admin: u.isAdmin,
        is_agent: ctx.hasRole('itil'),
        time_zone: u.timeZone,
        title: userRec?.str('title') ?? '',
        csrf_token: req.auth?.csrfToken ?? null,
        product: platform.properties.get('glide.product.name') ?? 'ResolvrNow',
      },
    };
  });

  app.get('/api/app/navigation', async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: visibleNav(ctx, platform.navigation) };
  });

  app.get('/api/app/meta/:table', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table } = req.params as { table: string };
    const meta = platform.registry.tryTable(table);
    if (!meta) throw new HttpError(400, `Invalid table ${table}`);
    const view = ((req.query as Record<string, string>).view ?? 'default') as string;
    return {
      result: {
        name: meta.name,
        label: meta.label,
        plural: meta.plural,
        parent: meta.parent,
        ancestors: meta.ancestors,
        descendants: meta.descendants,
        displayField: meta.displayField,
        numberPrefix: meta.number?.prefix ?? null,
        canCreate: platform.acl.canTable(ctx, meta.name, 'create').allowed,
        canRead: platform.acl.canTable(ctx, meta.name, 'read').allowed,
        canWrite: platform.acl.canTable(ctx, meta.name, 'write').allowed,
        canDelete: platform.acl.canTable(ctx, meta.name, 'delete').allowed,
        columns: columnMeta(ctx, meta, deps),
        form: formLayout(deps, meta, view),
        list: listLayout(deps, meta, view),
        uiPolicies: platform.uiPolicies.filter((p) => meta.ancestors.includes(p.table)),
      },
    };
  });

  app.get('/api/app/choices/:table/:field', async (req) => {
    ctxOf(req, deps);
    const { table, field } = req.params as { table: string; field: string };
    const dep = (req.query as Record<string, string>).dependent;
    return { result: platform.choices.list(table, field, { dependentValue: dep ?? undefined }) };
  });

  /** Form payload: record values (all display modes), UI actions and related lists. */
  app.get('/api/app/record/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    if (!platform.registry.has(table)) throw new HttpError(400, `Invalid table ${table}`);
    let rec: Rec | null;
    if (sysId === '-1') {
      rec = ctx.newRecord(table);
      const q = req.query as Record<string, string>;
      if (q.sysparm_query) {
        for (const term of q.sysparm_query.split('^')) {
          const m = /^([a-z0-9_]+)=(.*)$/.exec(term);
          if (m) rec.set(m[1], m[2]);
        }
      }
    } else {
      rec = ctx.get(table, sysId);
      if (!rec) throw new NotFoundError();
    }
    const meta = rec.table;
    const values = serializeRecord(ctx, rec, { displayValue: 'all', excludeReferenceLink: true, fields: [], baseUrl: '' });
    const layout = formLayout(deps, meta);
    return {
      result: {
        table: meta.name,
        sys_id: rec.isNew() ? null : rec.sysId,
        is_new: rec.isNew(),
        display_value: rec.isNew() ? `New ${meta.label}` : rec.displayValue(),
        values,
        can_write: rec.isNew()
          ? platform.acl.canTable(ctx, meta.name, 'create', rec).allowed
          : platform.acl.canTable(ctx, meta.name, 'write', rec).allowed,
        can_delete: !rec.isNew() && platform.acl.canTable(ctx, meta.name, 'delete', rec).allowed,
        actions: rec.isNew() ? [] : actionsFor(deps, ctx, rec),
        related: (layout.relatedLists ?? []).map((r) => ({ ...r, label: r.label ?? platform.registry.tryTable(r.table)?.plural ?? r.table })),
      },
    };
  });

  app.get('/api/app/activity/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    const rec = ctx.get(table, sysId);
    if (!rec) throw new NotFoundError();
    return { result: activityFor(ctx, rec) };
  });

  app.post('/api/app/action/:table/:sysId/:actionId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId, actionId } = req.params as { table: string; sysId: string; actionId: string };
    const action = platform.uiActions.get(actionId);
    if (!action) throw new HttpError(404, `Unknown action ${actionId}`);
    const body = (req.body ?? {}) as { values?: Record<string, unknown>; input?: Record<string, unknown> };
    const rec = ctx.get(table, sysId);
    if (!rec) throw new NotFoundError();
    if (!rec.table.ancestors.includes(action.table) || !actionVisible(action, rec, ctx)) {
      throw new HttpError(403, 'Action not available for this record');
    }
    if (body.values && Object.keys(body.values).length && action.saveFirst !== false) {
      ctx.update(rec, body.values);
    }
    const fresh = ctx.get(table, sysId) ?? rec;
    for (const p of action.prompt ?? []) {
      if (p.mandatory && !String(body.input?.[p.field] ?? '').trim()) {
        throw new HttpError(400, `${p.label ?? p.field} is required`);
      }
    }
    const result = action.run(fresh, ctx, body.input ?? {}) ?? {};
    platform.scheduleWork();
    return { result: { ...result, messages: ctx.messages } };
  });

  app.get('/api/app/related/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    const q = req.query as Record<string, string>;
    const parent = ctx.get(table, sysId);
    if (!parent) throw new NotFoundError();
    const childTable = q.child;
    if (!childTable || !platform.registry.has(childTable)) throw new HttpError(400, 'child table required');
    let query = '';
    if (q.via_table) {
      const links = ctx.query(q.via_table, { query: `${q.via_parent}=${sysId}` });
      const ids = links.map((l) => l.str(q.via_child)).filter(Boolean);
      query = `sys_idIN${ids.join(',') || 'none'}`;
    } else if (q.field) {
      query = `${q.field}=${sysId}`;
    }
    if (q.query) query = query ? `${query}^${q.query.replaceAll('{sys_id}', sysId)}` : q.query.replaceAll('{sys_id}', sysId);
    const recs = ctx.query(childTable, { query, limit: 200 });
    const columns = (q.columns ? q.columns.split(',') : listLayout(deps, platform.registry.table(childTable)).columns).filter(Boolean);
    return {
      result: {
        total: ctx.count(childTable, query),
        columns,
        rows: recs.map((r) => ({
          sys_id: r.sysId,
          table: r.className,
          values: serializeRecord(ctx, r, { displayValue: 'all', excludeReferenceLink: true, fields: columns, baseUrl: '' }),
        })),
      },
    };
  });

  /** Global search over text-indexed tables the user can read. */
  app.get('/api/app/search', async (req) => {
    const ctx = ctxOf(req, deps);
    const term = String((req.query as Record<string, string>).q ?? '').trim();
    if (!term) return { result: [] };
    const tables = (String((req.query as Record<string, string>).tables ?? '') || '')
      .split(',')
      .filter(Boolean);
    const candidates = (tables.length ? tables : platform.registry.tables().filter((t) => t.def.textIndex?.length && !t.parent).map((t) => t.name))
      .filter((t) => platform.registry.has(t));
    const groups: unknown[] = [];
    for (const t of candidates) {
      if (!platform.acl.canTable(ctx, t, 'read').allowed) continue;
      const exact = /^[A-Z]+\d{5,}$/i.test(term) ? ctx.query(t, { query: `number=${term.toUpperCase()}`, limit: 5 }) : [];
      const recs = exact.length ? exact : ctx.query(t, { query: `123TEXTQUERY321=${term}^ORDERBYDESCsys_updated_on`, limit: 8 });
      if (!recs.length) continue;
      groups.push({
        table: t,
        label: platform.registry.table(t).plural,
        results: recs.map((r) => ({
          sys_id: r.sysId,
          table: r.className,
          display_value: r.displayValue(),
          short_description: r.has('short_description') ? r.str('short_description') : r.has('name') ? r.str('name') : '',
          state: r.has('state') ? r.display('state') : '',
          updated: r.str('sys_updated_on'),
        })),
      });
    }
    return { result: groups };
  });

  app.get('/api/app/admin/health', async (req) => {
    const ctx = ctxOf(req, deps);
    if (!ctx.hasRole('admin')) throw new HttpError(403, 'Admin only');
    return {
      result: {
        tables: platform.registry.tables().length,
        modules: platform.modules.map((m) => ({ id: m.id, name: m.name })),
        jobs: platform.scheduler.list(),
        errors: platform.errors.slice(-50),
      },
    };
  });
}
