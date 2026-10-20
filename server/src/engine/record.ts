import type { SchemaRegistry } from './registry.js';
import { type ColumnMeta, type Internal, JOURNAL_TYPES, type RowData, type TableMeta } from './types.js';
import { toDisplayValue, toInternal } from './values.js';

/** What a record needs from its execution context. Implemented by `Context`. */
export interface RecordHost {
  readonly registry: SchemaRegistry;
  /** Loads a record without ACL checks (used for dot-walking). */
  loadRaw(table: string, sysId: string): Rec | null;
  /** Display value of a referenced record. */
  displayOf(table: string, sysId: string): string;
  choiceLabel(table: string, field: string, value: string): string | undefined;
  /** Maps a display value (or choice label) to the stored value; null when no match. */
  resolveInput(table: TableMeta, col: ColumnMeta, value: string): Internal | undefined;
  timeZone(): string | null;
}

export interface JournalEntry {
  field: string;
  value: string;
}

export type Operation = 'insert' | 'update' | 'delete';

/**
 * A single record, comparable to a server-side GlideRecord positioned on a row.
 * Values are kept in their stored representation; use `display()` for labels.
 */
export class Rec {
  table: TableMeta;
  data: RowData;
  original: RowData | null;
  journal: JournalEntry[] = [];
  abortMessage: string | null = null;
  operation: Operation | null = null;
  /** Fields explicitly written during the current operation (even if unchanged). */
  touched = new Set<string>();
  private refCache = new Map<string, Rec | null>();

  constructor(
    readonly host: RecordHost,
    table: TableMeta,
    data: RowData,
    original: RowData | null,
  ) {
    this.table = table;
    this.data = data;
    this.original = original;
  }

  get sysId(): string {
    return String(this.data.sys_id ?? '');
  }

  get className(): string {
    return this.table.name;
  }

  isNew(): boolean {
    return this.original === null;
  }

  column(field: string): ColumnMeta | undefined {
    return this.table.columns.get(field);
  }

  has(field: string): boolean {
    return this.table.columns.has(field);
  }

  /** Stored value; supports dot-walking (`caller_id.department.name`). */
  get(path: string): Internal {
    const dot = path.indexOf('.');
    if (dot < 0) return this.data[path] ?? null;
    const head = path.slice(0, dot);
    const ref = this.ref(head);
    return ref ? ref.get(path.slice(dot + 1)) : null;
  }

  str(path: string): string {
    const v = this.get(path);
    return v === null || v === undefined ? '' : String(v);
  }

  num(path: string): number | null {
    const v = this.get(path);
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  bool(path: string): boolean {
    const v = this.get(path);
    return v === 1 || v === '1' || v === 'true';
  }

  /** Previous stored value (before the current operation). */
  prev(field: string): Internal {
    return this.original ? (this.original[field] ?? null) : null;
  }

  /**
   * Sets a field. Journal fields (comments, work_notes) queue a journal entry.
   * Unknown fields are ignored, matching the platform's lenient setValue behaviour.
   */
  set(field: string, value: unknown, opts: { displayValue?: boolean } = {}): this {
    const col = this.table.columns.get(field);
    if (!col) return this;
    if (JOURNAL_TYPES.has(col.type)) {
      const text = value === null || value === undefined ? '' : String(value);
      if (text.trim()) this.journal.push({ field, value: text });
      return this;
    }
    if (!col.storage) return this;
    let internal = toInternal(col, value);
    if (internal !== null && typeof internal === 'string') {
      const needsResolve =
        opts.displayValue ||
        ((col.type === 'reference' || col.type === 'document_id') && !/^[0-9a-f]{32}$/.test(internal)) ||
        (col.type === 'integer' && !/^-?\d+$/.test(internal));
      if (needsResolve) {
        const resolved = this.host.resolveInput(this.table, col, internal);
        if (resolved !== undefined) internal = resolved;
        else if (col.type === 'integer') internal = null;
      }
    }
    this.data[field] = internal;
    this.touched.add(field);
    this.refCache.delete(field);
    return this;
  }

  setMany(values: Record<string, unknown>, opts: { displayValue?: boolean } = {}): this {
    for (const [k, v] of Object.entries(values)) this.set(k, v, opts);
    return this;
  }

  /** Writes a stored value directly without coercion (internal use). */
  setRaw(field: string, value: Internal): this {
    this.data[field] = value;
    this.touched.add(field);
    this.refCache.delete(field);
    return this;
  }

  changed(field: string): boolean {
    const col = this.table.columns.get(field);
    if (col && JOURNAL_TYPES.has(col.type)) return this.journal.some((j) => j.field === field);
    const cur = this.data[field] ?? null;
    if (this.original === null) return cur !== null && cur !== '';
    const prev = this.original[field] ?? null;
    return normalizeCmp(cur) !== normalizeCmp(prev);
  }

  changedFrom(field: string, value: Internal): boolean {
    return this.changed(field) && normalizeCmp(this.prev(field)) === normalizeCmp(value);
  }

  changedTo(field: string, value: Internal): boolean {
    return this.changed(field) && normalizeCmp(this.get(field)) === normalizeCmp(value);
  }

  changes(): string[] {
    const out: string[] = [];
    for (const [name, col] of this.table.columns) {
      if (!col.storage) continue;
      if (this.changed(name)) out.push(name);
    }
    for (const j of this.journal) if (!out.includes(j.field)) out.push(j.field);
    return out;
  }

  /** Referenced record for a reference field (cached, no ACL). */
  ref(field: string): Rec | null {
    if (this.refCache.has(field)) return this.refCache.get(field)!;
    const col = this.table.columns.get(field);
    const id = this.data[field];
    let out: Rec | null = null;
    if (col && id && typeof id === 'string') {
      let target = col.reference;
      if (col.type === 'document_id') {
        const tableField = (col.attributes?.document_table as string) ?? (col.dependentOn as string) ?? 'table_name';
        target = this.str(tableField) || target;
      }
      if (target && this.host.registry.has(target)) out = this.host.loadRaw(target, id);
    }
    this.refCache.set(field, out);
    return out;
  }

  /** Display value of a field (choice label, reference display value, formatted date...). */
  display(path: string): string {
    const dot = path.indexOf('.');
    if (dot >= 0) {
      const ref = this.ref(path.slice(0, dot));
      return ref ? ref.display(path.slice(dot + 1)) : '';
    }
    const col = this.table.columns.get(path);
    if (!col) return '';
    const v = this.data[path] ?? null;
    if (v === null || v === '') return col.type === 'boolean' ? 'false' : '';
    if ((col.type === 'reference' || col.type === 'document_id') && typeof v === 'string') {
      let target = col.reference;
      if (col.type === 'document_id') {
        const tableField = (col.attributes?.document_table as string) ?? (col.dependentOn as string) ?? 'table_name';
        target = this.str(tableField) || target;
      }
      return target && this.host.registry.has(target) ? this.host.displayOf(target, v) : v;
    }
    if (col.type === 'sys_class_name' || col.type === 'table_name') {
      return this.host.registry.tryTable(String(v))?.label ?? String(v);
    }
    if (col.type === 'glide_list' && col.reference && this.host.registry.has(col.reference)) {
      return String(v)
        .split(',')
        .filter(Boolean)
        .map((id) => (/^[0-9a-f]{32}$/.test(id) ? this.host.displayOf(col.reference!, id) : id))
        .join(', ');
    }
    return toDisplayValue(col, v, {
      timeZone: this.host.timeZone(),
      choiceLabel: (val) => this.host.choiceLabel(this.table.name, path, val),
    });
  }

  /** The record's display value (its display field). */
  displayValue(): string {
    return this.display(this.table.displayField);
  }

  abort(message?: string): void {
    this.abortMessage = message ?? 'Operation against record aborted by a business rule';
  }

  /** Copy representing the state before the current operation (`previous` in business rules). */
  snapshot(): Rec {
    const r = new Rec(this.host, this.table, { ...(this.original ?? {}) }, this.original ? { ...this.original } : null);
    return r;
  }

  /** Marks the current values as persisted. */
  commit(): void {
    this.original = { ...this.data };
    this.journal = [];
    this.touched.clear();
    this.operation = null;
    this.abortMessage = null;
  }

  toObject(): RowData {
    return { ...this.data };
  }
}

function normalizeCmp(v: Internal | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v);
}
