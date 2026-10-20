/**
 * Adapter over table schemas derived from ServiceNow's MIT-licensed SDK
 * (@servicenow/sdk-core, see THIRD_PARTY_NOTICES.md). Using the same table and
 * column names as the platform keeps the REST API compatible with existing clients.
 */
import data from './sdk/sdk-tables.json' with { type: 'json' };
import type { ChoiceDef, ColumnDef, FieldType, TableDef } from '../engine/types.js';

interface SdkColumn {
  type: string;
  label?: string;
  hint?: string;
  reference?: string;
  maxLength?: number;
  default?: string;
  mandatory?: boolean;
  readOnly?: boolean;
  dependent?: string;
  choiceMode?: string;
  referenceQual?: string;
  unique?: boolean;
  cascade?: string;
  choices?: { value: string; label: string; sequence?: number | null }[];
}

interface SdkTable {
  label?: string | { label?: string }[];
  extends?: string | null;
  audit?: boolean;
  number?: { prefix: string; number: number };
  displayField?: string;
  columns: Record<string, SdkColumn>;
  overrides?: Record<string, Record<string, unknown>>;
}

const TABLES = (data as unknown as { tables: Record<string, SdkTable> }).tables;

const SKIP = new Set([
  'sys_id',
  'sys_class_name',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
  'sys_mod_count',
  'sys_domain',
  'sys_domain_path',
  'sys_tags',
  'sys_overrides',
]);

/** Parents we deliberately flatten so that each system table gets its own physical table. */
const FLATTEN = new Set(['sys_metadata', 'business_calendar', 'business_calendar_span', 'sys_package', 'sys_scope']);

const VALID_TYPES = new Set<FieldType>([
  'string', 'choice', 'integer', 'decimal', 'float', 'boolean', 'glide_date_time', 'glide_date', 'glide_time',
  'glide_duration', 'due_date', 'reference', 'journal', 'journal_input', 'journal_list', 'html', 'multi_two_lines',
  'glide_list', 'sys_class_name', 'GUID', 'email', 'url', 'currency', 'price', 'percent_complete', 'conditions',
  'document_id', 'table_name', 'field_name', 'field_list', 'script', 'json', 'user_roles', 'password2', 'image',
  'phone_number', 'ip_address', 'variables', 'translated_text', 'domain_id', 'days_of_week', 'name_values',
]);

export function hasSdkTable(name: string): boolean {
  return name in TABLES;
}

export function sdkColumnNames(name: string): string[] {
  return Object.keys(TABLES[name]?.columns ?? {}).filter((c) => !SKIP.has(c));
}

export function sdkColumn(table: string, name: string): ColumnDef | undefined {
  const c = TABLES[table]?.columns[name];
  return c ? toColumn(name, c) : undefined;
}

function toColumn(name: string, c: SdkColumn): ColumnDef {
  let type = (VALID_TYPES.has(c.type as FieldType) ? c.type : 'string') as FieldType;
  if (type === 'domain_id' || type === 'translated_text') type = 'string';
  const col: ColumnDef = { name, label: c.label && c.label !== name ? c.label : titleCaseLabel(name), type };
  if (c.hint) col.hint = c.hint;
  if (c.reference) col.reference = c.reference;
  if (type === 'glide_list' && !c.reference && name.endsWith('watch_list')) col.reference = 'sys_user';
  if (c.maxLength) col.maxLength = c.maxLength;
  if (c.default !== undefined && c.default !== '' && !/getNextObjNumber/.test(c.default)) col.defaultValue = c.default;
  if (c.mandatory) col.mandatory = true;
  if (c.readOnly) col.readOnly = true;
  if (c.dependent) col.dependentOn = c.dependent;
  if (c.choiceMode === 'dropdown_with_none' || c.choiceMode === 'dropdown_without_none' || c.choiceMode === 'suggestion')
    col.choiceMode = c.choiceMode;
  if (c.referenceQual) col.referenceQual = c.referenceQual;
  if (c.unique) col.unique = true;
  if (c.choices?.length) {
    col.choices = c.choices.map(
      (ch, i): ChoiceDef => ({ value: String(ch.value), label: ch.label, sequence: ch.sequence ?? i + 1 }),
    );
  }
  return col;
}

function tableLabel(t: SdkTable, name: string): string {
  if (typeof t.label === 'string' && t.label) return t.label;
  if (Array.isArray(t.label) && t.label[0]?.label) return t.label[0].label;
  return titleCaseLabel(name);
}

function titleCaseLabel(name: string): string {
  const s = name.replace(/^u_/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface SdkTableOptions {
  /** Only keep these SDK columns (default: all). */
  include?: string[];
  exclude?: string[];
  /** Additional or replacement columns. */
  columns?: ColumnDef[];
  /** Patches applied to SDK columns by name. */
  patch?: Record<string, Partial<ColumnDef>>;
  label?: string;
  plural?: string;
  extends?: string | null;
  displayField?: string;
  number?: { prefix: string; start?: number; digits?: number } | null;
  audit?: boolean;
  textIndex?: string[];
  indexes?: string[][];
  overrides?: TableDef['overrides'];
  extensible?: boolean;
  system?: boolean;
  description?: string;
}

/** Builds a TableDef from the SDK-derived schema, with local adjustments. */
export function sdkTable(name: string, opts: SdkTableOptions = {}): TableDef {
  const t = TABLES[name];
  if (!t) throw new Error(`No SDK schema for table ${name}`);
  const include = opts.include ? new Set(opts.include) : null;
  const exclude = new Set(opts.exclude ?? []);
  const own = new Set((opts.columns ?? []).map((c) => c.name));
  const columns: ColumnDef[] = [];
  for (const [cname, c] of Object.entries(t.columns)) {
    if (SKIP.has(cname) || exclude.has(cname) || own.has(cname)) continue;
    if (include && !include.has(cname)) continue;
    const col = toColumn(cname, c);
    columns.push(opts.patch?.[cname] ? { ...col, ...opts.patch[cname] } : col);
  }
  columns.push(...(opts.columns ?? []));
  let parent = opts.extends === undefined ? (t.extends ?? undefined) : (opts.extends ?? undefined);
  if (parent && FLATTEN.has(parent)) parent = undefined;
  const number =
    opts.number === null
      ? undefined
      : (opts.number ?? (t.number ? { prefix: t.number.prefix, start: t.number.number, digits: 7 } : undefined));
  const overrides: TableDef['overrides'] = { ...(opts.overrides ?? {}) };
  for (const [field, ov] of Object.entries(t.overrides ?? {})) {
    if (overrides[field]) continue;
    const o: Partial<ColumnDef> = {};
    if (typeof ov.default === 'string') o.defaultValue = ov.default;
    if (ov.mandatory === true) o.mandatory = true;
    if (ov.readOnly === true || ov.read_only === true) o.readOnly = true;
    if (typeof ov.referenceQualifier === 'string') o.referenceQual = ov.referenceQualifier;
    if (Object.keys(o).length) overrides[field] = o;
  }
  return {
    name,
    label: opts.label ?? tableLabel(t, name),
    plural: opts.plural,
    extends: parent,
    displayField: opts.displayField ?? t.displayField,
    number,
    audit: opts.audit ?? t.audit ?? false,
    columns,
    overrides: Object.keys(overrides).length ? overrides : undefined,
    textIndex: opts.textIndex,
    indexes: opts.indexes,
    extensible: opts.extensible,
    system: opts.system,
    description: opts.description,
  };
}
