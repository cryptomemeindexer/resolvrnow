import type { Context } from '../engine/context.js';
import type { Rec } from '../engine/record.js';
import { type ColumnMeta, JOURNAL_TYPES } from '../engine/types.js';
import { toApiValue } from '../engine/values.js';

export type DisplayMode = 'false' | 'true' | 'all';

export interface SerializeOptions {
  displayValue: DisplayMode;
  excludeReferenceLink: boolean;
  /** Requested field paths (dot-walking allowed). Empty = all fields of the record's class. */
  fields: string[];
  /** Base URL used to build reference links, e.g. https://host. */
  baseUrl: string;
}

export function parseDisplayMode(v: unknown): DisplayMode {
  const s = String(v ?? 'false').toLowerCase();
  return s === 'true' ? 'true' : s === 'all' ? 'all' : 'false';
}

export function parseBool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  return ['true', '1', 'yes'].includes(String(v).toLowerCase());
}

export function parseFields(v: unknown): string[] {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

function resolvePath(rec: Rec, path: string): { rec: Rec | null; col: ColumnMeta | undefined; field: string } {
  const parts = path.split('.');
  let cur: Rec | null = rec;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur) break;
    cur = cur.ref(parts[i]);
  }
  const field = parts[parts.length - 1];
  return { rec: cur, col: cur?.column(field), field };
}

function journalDisplay(ctx: Context, rec: Rec, field: string): string {
  const entries = ctx.platform.history.journal(rec.className, rec.sysId, [field]);
  if (!entries.length) return '';
  return ctx.platform.history.formatJournal(
    entries,
    (f) => rec.column(f)?.label ?? f,
    (u) => {
      const user = ctx.platform.db.get<{ name: string }>(`SELECT "name" FROM "sys_user" WHERE "user_name" = ?`, [u]);
      return user?.name || u;
    },
  );
}

function fieldValue(ctx: Context, rec: Rec, path: string, opts: SerializeOptions): unknown {
  const { rec: target, col, field } = resolvePath(rec, path);
  if (!target || !col) return '';
  if (!ctx.platform.acl.canField(ctx, target.className, field, 'read', target)) return '';
  if (JOURNAL_TYPES.has(col.type)) {
    if (opts.displayValue === 'false') return '';
    const disp = journalDisplay(ctx, target, field);
    return opts.displayValue === 'all' ? { display_value: disp, value: '' } : disp;
  }
  if (!col.storage) return '';
  const raw = target.get(field);
  const value = toApiValue(col, raw);
  const isRef = (col.type === 'reference' || col.type === 'document_id') && !!col.reference;
  const display = opts.displayValue === 'false' ? '' : target.display(field);
  if (isRef && value !== '') {
    let refTable = col.reference!;
    if (col.type === 'document_id') {
      const tableField = (col.attributes?.document_table as string) ?? col.dependentOn ?? 'table_name';
      refTable = target.str(tableField) || refTable;
    }
    const link = `${opts.baseUrl}/api/now/table/${refTable}/${value}`;
    if (opts.displayValue === 'all') {
      return opts.excludeReferenceLink ? { display_value: display, value } : { display_value: display, link, value };
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

/** Serializes a record in the platform's Table API JSON format. */
export function serializeRecord(ctx: Context, rec: Rec, opts: SerializeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = opts.fields.length
    ? opts.fields
    : [...rec.table.columns.values()].filter((c) => c.storage || JOURNAL_TYPES.has(c.type)).map((c) => c.name);
  for (const f of fields) {
    if (f === 'user_password' || rec.column(f)?.type === 'password2') {
      out[f] = '';
      continue;
    }
    out[f] = fieldValue(ctx, rec, f, opts);
  }
  return out;
}
