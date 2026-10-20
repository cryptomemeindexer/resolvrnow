import type { ChoiceDef, ColumnDef, FieldType, TableDef } from '../../engine/types.js';

/** Small builders for hand-written table definitions. */
type Extra = Partial<Omit<ColumnDef, 'name' | 'label' | 'type'>>;

export const col = (name: string, label: string, type: FieldType, extra: Extra = {}): ColumnDef => ({
  name,
  label,
  type,
  ...extra,
});
export const str = (name: string, label: string, maxLength = 255, extra: Extra = {}): ColumnDef =>
  col(name, label, 'string', { maxLength, ...extra });
export const int = (name: string, label: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'integer', extra);
export const dec = (name: string, label: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'decimal', extra);
export const bool = (
  name: string,
  label: string,
  defaultValue: boolean | null = false,
  extra: Extra = {},
): ColumnDef =>
  col(
    name,
    label,
    'boolean',
    defaultValue === null ? extra : { defaultValue: String(defaultValue), ...extra },
  );
export const ref = (name: string, label: string, reference: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'reference', { reference, ...extra });
export const dt = (name: string, label: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'glide_date_time', extra);
export const date = (name: string, label: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'glide_date', extra);
export const tableName = (name: string, label: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'table_name', { maxLength: 80, ...extra });
export const cond = (name: string, label: string, extra: Extra = {}): ColumnDef =>
  col(name, label, 'conditions', { maxLength: 4000, ...extra });
export const choice = (name: string, label: string, choices: ChoiceDef[], extra: Extra = {}): ColumnDef =>
  col(name, label, 'choice', { maxLength: 40, choices, ...extra });
/** A string column with a choice list (the platform stores several lists in plain string columns). */
export const strChoice = (name: string, label: string, choices: ChoiceDef[], extra: Extra = {}): ColumnDef =>
  col(name, label, 'string', { maxLength: 40, choices, ...extra });

/** A class (table) extending another one. */
export function cls(
  name: string,
  label: string,
  parent: string,
  columns: ColumnDef[] = [],
  extra: Partial<TableDef> = {},
): TableDef {
  return { name, label, extends: parent, columns, ...extra };
}

/** Removes script-only defaults and reference qualifiers that the engine cannot evaluate. */
export function withoutScripts(def: TableDef): TableDef {
  const isScript = (v: unknown) => typeof v === 'string' && /^javascript:/i.test(v);
  return {
    ...def,
    columns: def.columns.map((c) => {
      const out = { ...c };
      if (isScript(out.defaultValue)) delete out.defaultValue;
      if (isScript(out.referenceQual)) delete out.referenceQual;
      return out;
    }),
  };
}
