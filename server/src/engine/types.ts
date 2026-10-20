/**
 * Core metadata types for the ResolvrNow platform.
 *
 * The model mirrors the publicly documented ServiceNow dictionary concepts
 * (tables that extend other tables, typed columns, choice lists, auto numbering)
 * so that the REST API and encoded queries behave the same way for clients.
 */

export type FieldType =
  | 'string'
  | 'choice'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'glide_date_time'
  | 'glide_date'
  | 'glide_time'
  | 'glide_duration'
  | 'due_date'
  | 'reference'
  | 'journal'
  | 'journal_input'
  | 'journal_list'
  | 'html'
  | 'multi_two_lines'
  | 'glide_list'
  | 'sys_class_name'
  | 'GUID'
  | 'email'
  | 'url'
  | 'currency'
  | 'price'
  | 'percent_complete'
  | 'conditions'
  | 'document_id'
  | 'table_name'
  | 'field_name'
  | 'field_list'
  | 'script'
  | 'json'
  | 'user_roles'
  | 'password2'
  | 'image'
  | 'phone_number'
  | 'ip_address'
  | 'variables'
  | 'translated_text'
  | 'domain_id'
  | 'days_of_week'
  | 'name_values';

export type StorageClass = 'TEXT' | 'INTEGER' | 'REAL';

/** Physical storage class per field type. `null` means the value is not stored on the row. */
export const STORAGE: Record<FieldType, StorageClass | null> = {
  string: 'TEXT',
  choice: 'TEXT',
  integer: 'INTEGER',
  decimal: 'REAL',
  float: 'REAL',
  boolean: 'INTEGER',
  glide_date_time: 'TEXT',
  glide_date: 'TEXT',
  glide_time: 'TEXT',
  glide_duration: 'INTEGER',
  due_date: 'TEXT',
  reference: 'TEXT',
  journal: null,
  journal_input: null,
  journal_list: null,
  html: 'TEXT',
  multi_two_lines: 'TEXT',
  glide_list: 'TEXT',
  sys_class_name: 'TEXT',
  GUID: 'TEXT',
  email: 'TEXT',
  url: 'TEXT',
  currency: 'REAL',
  price: 'REAL',
  percent_complete: 'REAL',
  conditions: 'TEXT',
  document_id: 'TEXT',
  table_name: 'TEXT',
  field_name: 'TEXT',
  field_list: 'TEXT',
  script: 'TEXT',
  json: 'TEXT',
  user_roles: 'TEXT',
  password2: 'TEXT',
  image: 'TEXT',
  phone_number: 'TEXT',
  ip_address: 'TEXT',
  variables: null,
  translated_text: 'TEXT',
  domain_id: 'TEXT',
  days_of_week: 'TEXT',
  name_values: 'TEXT',
};

export const JOURNAL_TYPES: ReadonlySet<FieldType> = new Set(['journal', 'journal_input', 'journal_list']);
export const DATE_TYPES: ReadonlySet<FieldType> = new Set(['glide_date_time', 'glide_date', 'due_date']);
export const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set([
  'integer',
  'decimal',
  'float',
  'currency',
  'price',
  'percent_complete',
  'glide_duration',
]);

export interface ChoiceDef {
  value: string;
  label: string;
  sequence?: number;
  /** Value of the parent field this choice depends on (e.g. subcategory depends on category). */
  dependentValue?: string;
  inactive?: boolean;
  hint?: string;
}

export type ChoiceMode = 'dropdown_with_none' | 'dropdown_without_none' | 'suggestion';

/** Dynamic default evaluated at insert time. */
export type DefaultFn = (ctx: { userId: string | null; now: string; table: string }) => unknown;

export interface ColumnDef {
  name: string;
  label: string;
  type: FieldType;
  maxLength?: number;
  mandatory?: boolean;
  readOnly?: boolean;
  /** Literal default (stored representation) or dynamic default. */
  defaultValue?: string | number | boolean | null | DefaultFn;
  /** Target table for reference, glide_list and document_id columns. */
  reference?: string;
  /** Encoded query applied to reference pickers. */
  referenceQual?: string;
  choices?: ChoiceDef[];
  choiceMode?: ChoiceMode;
  /** Field whose value filters this field's choices (choice dependency). */
  dependentOn?: string;
  hint?: string;
  unique?: boolean;
  indexed?: boolean;
  /** Excluded from the field-level audit trail. */
  noAudit?: boolean;
  /** Hidden from generated default layouts. */
  internal?: boolean;
  attributes?: Record<string, string | number | boolean>;
  /** When the referenced record is deleted. */
  cascade?: 'none' | 'clear' | 'delete' | 'restrict';
}

export interface TableDef {
  name: string;
  label: string;
  plural?: string;
  description?: string;
  extends?: string;
  /** Can other tables extend this one. */
  extensible?: boolean;
  displayField?: string;
  number?: { prefix: string; start?: number; digits?: number };
  /** Record field-level changes in sys_audit. */
  audit?: boolean;
  columns: ColumnDef[];
  /** Dictionary overrides applied to inherited columns for this table and its children. */
  overrides?: Record<string, Partial<Omit<ColumnDef, 'name' | 'type'>>>;
  indexes?: string[][];
  /** Columns included in the global text index. */
  textIndex?: string[];
  /** Owning module id. */
  module?: string;
  /** Table is not exposed through generic REST/UI unless the user is admin. */
  system?: boolean;
}

export interface ColumnMeta extends ColumnDef {
  /** Table that defines the column (may be an ancestor). */
  definedOn: string;
  /** Column name in the physical SQL table. */
  physical: string;
  storage: StorageClass | null;
  system?: boolean;
}

export interface TableMeta {
  name: string;
  label: string;
  plural: string;
  def: TableDef;
  parent: string | null;
  root: string;
  /** Physical SQL table holding rows of the whole hierarchy. */
  physical: string;
  /** Self first, then parent, ... up to root. */
  ancestors: string[];
  /** Direct children. */
  children: string[];
  /** Self plus all descendants. */
  descendants: string[];
  columns: Map<string, ColumnMeta>;
  displayField: string;
  number?: { prefix: string; start: number; digits: number };
  audit: boolean;
  extensible: boolean;
  system: boolean;
}

/** Internal (stored) value of a field. */
export type Internal = string | number | null;
export type RowData = Record<string, Internal>;

export const SYSTEM_COLUMNS: ColumnDef[] = [
  { name: 'sys_id', label: 'Sys ID', type: 'GUID', maxLength: 32, readOnly: true, noAudit: true, internal: true },
  { name: 'sys_class_name', label: 'Class', type: 'sys_class_name', maxLength: 80, readOnly: true, noAudit: true, internal: true },
  { name: 'sys_created_on', label: 'Created', type: 'glide_date_time', readOnly: true, noAudit: true },
  { name: 'sys_created_by', label: 'Created by', type: 'string', maxLength: 40, readOnly: true, noAudit: true },
  { name: 'sys_updated_on', label: 'Updated', type: 'glide_date_time', readOnly: true, noAudit: true },
  { name: 'sys_updated_by', label: 'Updated by', type: 'string', maxLength: 40, readOnly: true, noAudit: true },
  { name: 'sys_mod_count', label: 'Updates', type: 'integer', readOnly: true, noAudit: true },
];
export const SYSTEM_COLUMN_NAMES: ReadonlySet<string> = new Set(SYSTEM_COLUMNS.map((c) => c.name));
