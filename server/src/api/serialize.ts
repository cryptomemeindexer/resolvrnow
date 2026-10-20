import type { Context } from '../engine/context.js';
import type { Platform } from '../engine/platform.js';
import type { Rec } from '../engine/record.js';
import type { SchemaRegistry } from '../engine/registry.js';
import { type ColumnMeta, JOURNAL_TYPES, type TableMeta } from '../engine/types.js';
import { toApiValue } from '../engine/values.js';
import { sdkColumn } from '../schema/sdk.js';

export type DisplayMode = 'false' | 'true' | 'all';

export interface SerializeOptions {
  displayValue: DisplayMode;
  excludeReferenceLink: boolean;
  /** Requested field paths (dot-walking allowed). Empty = all fields of the table. */
  fields: string[];
  /** Base URL used to build reference links, e.g. https://host. */
  baseUrl: string;
  /**
   * Table whose fields are rendered (the table named in the URL). Querying `task` renders
   * only task fields, even for incident rows. Defaults to the record's own class.
   */
  table?: TableMeta;
  /** Fields of a UI view (`sysparm_view`), used when `fields` is empty. */
  viewFields?: string[] | null;
  /**
   * REST mode: requested names that are not fields are dropped, fields the caller cannot
   * read are omitted (instead of rendered empty) and the domain reference is included.
   */
  strict?: boolean;
}

export function parseDisplayMode(v: unknown): DisplayMode {
  const s = String(v ?? 'false')
    .trim()
    .toLowerCase();
  return s === 'true' ? 'true' : s === 'all' ? 'all' : 'false';
}

/** Booleans parse case-insensitively; anything other than true (or 1 / yes) counts as false. */
export function parseBool(v: unknown, fallback = false): boolean {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null || v === '') return fallback;
  return ['true', '1', 'yes'].includes(String(v).trim().toLowerCase());
}

export function parseFields(v: unknown): string[] {
  if (Array.isArray(v)) v = v.join(',');
  if (!v) return [];
  const seen = new Set<string>();
  for (const f of String(v).split(',')) {
    const t = f.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

const OMIT = Symbol('omit');

function resolvePath(
  rec: Rec,
  path: string,
): { rec: Rec | null; col: ColumnMeta | undefined; field: string } {
  const parts = path.split('.');
  let cur: Rec | null = rec;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur) break;
    cur = cur.ref(parts[i]);
  }
  const field = parts[parts.length - 1];
  return { rec: cur, col: cur?.column(field), field };
}

/** True when a (dot-walked) path names a field of `table`; every hop must be a reference. */
export function fieldPathExists(registry: SchemaRegistry, table: TableMeta, path: string): boolean {
  const parts = path.split('.');
  let t: TableMeta | undefined = table;
  for (let i = 0; i < parts.length; i++) {
    const col: ColumnMeta | undefined = t?.columns.get(parts[i]);
    if (!col) return false;
    if (i === parts.length - 1) return true;
    if (col.type === 'document_id') return true; // the target table is only known per record
    if (col.type !== 'reference' || !col.reference) return false;
    t = registry.tryTable(col.reference);
  }
  return false;
}

/** Tables that carry the platform's domain reference (`sys_domain`) in the published schema. */
function hasDomain(table: TableMeta): boolean {
  return table.ancestors.some((t) => !!sdkColumn(t, 'sys_domain'));
}

function domainValue(opts: SerializeOptions): unknown {
  const link = `${opts.baseUrl}/api/now/table/sys_user_group/global`;
  if (opts.displayValue === 'all') {
    return opts.excludeReferenceLink
      ? { display_value: 'global', value: 'global' }
      : { display_value: 'global', link, value: 'global' };
  }
  if (opts.displayValue === 'true')
    return opts.excludeReferenceLink ? 'global' : { display_value: 'global', link };
  return opts.excludeReferenceLink ? 'global' : { link, value: 'global' };
}

function emptyValue(opts: SerializeOptions): unknown {
  return opts.displayValue === 'all' ? { display_value: '', value: '' } : '';
}

function journalDisplay(ctx: Context, rec: Rec, field: string): string {
  const entries = ctx.platform.history.journal(rec.className, rec.sysId, [field]);
  if (!entries.length) return '';
  return ctx.platform.history.formatJournal(
    entries,
    (f) => rec.column(f)?.label ?? f,
    (u) => {
      const user = ctx.platform.db.get<{ name: string }>(
        `SELECT "name" FROM "sys_user" WHERE "user_name" = ?`,
        [u],
      );
      return user?.name || u;
    },
  );
}

function displayOf(ctx: Context, target: Rec, field: string, col: ColumnMeta): string {
  if (col.type === 'sys_class_name') {
    const v = target.str(field);
    return ctx.registry.tryTable(v)?.label ?? v;
  }
  return target.display(field);
}

function fieldValue(ctx: Context, rec: Rec, path: string, opts: SerializeOptions): unknown {
  const { rec: target, col, field } = resolvePath(rec, path);
  if (!target || !col) return emptyValue(opts);
  if (col.type === 'password2') return '';
  if (!ctx.platform.acl.canField(ctx, target.className, field, 'read', target))
    return opts.strict ? OMIT : '';
  if (JOURNAL_TYPES.has(col.type)) {
    if (opts.displayValue === 'false') return '';
    const disp = journalDisplay(ctx, target, field);
    return opts.displayValue === 'all' ? { display_value: disp, value: '' } : disp;
  }
  if (!col.storage) return emptyValue(opts);
  const raw = target.get(field);
  const value = toApiValue(col, raw);
  const isRef = (col.type === 'reference' || col.type === 'document_id') && !!col.reference;
  const display = opts.displayValue === 'false' ? '' : displayOf(ctx, target, field, col);
  if (isRef && value !== '') {
    let refTable = col.reference!;
    if (col.type === 'document_id') {
      const tableField = (col.attributes?.document_table as string) ?? col.dependentOn ?? 'table_name';
      refTable = target.str(tableField) || refTable;
    }
    const link = `${opts.baseUrl}/api/now/table/${refTable}/${value}`;
    if (opts.displayValue === 'all') {
      return opts.excludeReferenceLink
        ? { display_value: display, value }
        : { display_value: display, link, value };
    }
    if (opts.displayValue === 'true') {
      return opts.excludeReferenceLink ? display : { display_value: display, link };
    }
    return opts.excludeReferenceLink ? value : { link, value };
  }
  if (opts.displayValue === 'all') return { display_value: display, value };
  if (opts.displayValue === 'true') return display;
  return value;
}

/** Field list rendered for a record: requested fields, the view's fields, or every field. */
function fieldList(ctx: Context, rec: Rec, opts: SerializeOptions): string[] {
  const base = opts.table ?? rec.table;
  if (opts.fields.length) {
    if (!opts.strict) return opts.fields;
    return opts.fields.filter(
      (f) => fieldPathExists(ctx.registry, base, f) || (f === 'sys_domain' && hasDomain(base)),
    );
  }
  if (opts.viewFields?.length) {
    return opts.viewFields.filter((f) => fieldPathExists(ctx.registry, base, f));
  }
  const all = [...base.columns.values()]
    .filter((c) => c.storage || JOURNAL_TYPES.has(c.type))
    .map((c) => c.name);
  if (opts.strict && hasDomain(base)) all.push('sys_domain');
  return all;
}

/** Serializes a record in the platform's Table API JSON format. */
export function serializeRecord(ctx: Context, rec: Rec, opts: SerializeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const base = opts.table ?? rec.table;
  for (const f of fieldList(ctx, rec, opts)) {
    if (f === 'user_password' || rec.column(f)?.type === 'password2') {
      out[f] = '';
      continue;
    }
    if (f === 'sys_domain' && opts.strict && !base.columns.has('sys_domain')) {
      out[f] = domainValue(opts);
      continue;
    }
    const v = fieldValue(ctx, rec, f, opts);
    if (v !== OMIT) out[f] = v;
  }
  return out;
}

/**
 * Fields of a UI view for `sysparm_view` (`desktop`, `mobile` or `both`), taken from the
 * form and list layouts of the table or its closest ancestor. Null when no layout exists.
 */
export function viewFields(platform: Platform, table: TableMeta, view: string | undefined): string[] | null {
  const v = (view ?? '').trim().toLowerCase();
  if (!v) return null;
  const tryViews = (names: string[]): Set<string> => {
    const out = new Set<string>();
    for (const t of table.ancestors) {
      let found = false;
      for (const n of names) {
        const form = platform.forms.get(`${t}:${n}`);
        if (form) {
          found = true;
          for (const s of form.sections)
            for (const f of [...(s.left ?? []), ...(s.right ?? []), ...(s.fields ?? [])]) out.add(f);
        }
        const list = platform.lists.get(`${t}:${n}`);
        if (list) {
          found = true;
          for (const c of list.columns) out.add(c);
        }
      }
      if (found) break;
    }
    return out;
  };
  const names = v === 'both' ? ['default', 'mobile'] : v === 'desktop' || v === 'default' ? ['default'] : [v];
  let fields = tryViews(names);
  if (!fields.size && v === 'mobile') fields = tryViews(['default']);
  if (!fields.size) return null;
  return ['sys_id', ...[...fields].filter((f) => f !== 'sys_id')];
}
