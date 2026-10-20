/** Helpers turning platform records into text for the ML and similarity engines. */
import type { Platform } from '../../../engine/platform.js';
import type { Rec } from '../../../engine/record.js';
import type { TableMeta } from '../../../engine/types.js';
import { plainText } from './text.js';

const TEXT_TYPES = new Set(['string', 'multi_two_lines', 'html', 'translated_text', 'email', 'url']);

/** A field's value as text: labels for choices and references, plain text for HTML. */
export function fieldText(rec: Rec, field: string): string {
  const col = rec.column(field);
  if (!col?.storage) return '';
  if (col.type === 'html') return plainText(rec.str(field));
  // display() resolves choice labels and reference display values.
  if (
    col.type === 'reference' ||
    col.type === 'document_id' ||
    col.type === 'choice' ||
    TEXT_TYPES.has(col.type)
  ) {
    return rec.display(field);
  }
  if (col.type === 'integer') {
    const label = rec.display(field);
    return label !== rec.str(field) ? label : '';
  }
  return '';
}

export interface WeightedField {
  field: string;
  weight: number;
}

/** Concatenated text of the given fields; `short_description` counts twice unless weights say otherwise. */
export function recordText(rec: Rec, fields: (string | WeightedField)[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const wf = typeof f === 'string' ? { field: f, weight: f === 'short_description' ? 2 : 1 } : f;
    const t = fieldText(rec, wf.field).trim();
    if (!t) continue;
    for (let i = 0; i < wf.weight; i++) parts.push(t);
  }
  return parts.join('\n');
}

/** Text fields used to compare records of a table (similar records, knowledge suggestions, clusters). */
export function similarityFields(meta: TableMeta): WeightedField[] {
  const has = (f: string) => meta.columns.has(f);
  if (meta.ancestors.includes('kb_knowledge')) {
    return [
      { field: 'short_description', weight: 3 },
      { field: 'meta', weight: 1 },
      { field: 'text', weight: 1 },
    ].filter((f) => has(f.field));
  }
  if (has('short_description')) {
    return [
      { field: 'short_description', weight: 2 },
      { field: 'description', weight: 1 },
    ].filter((f) => has(f.field));
  }
  const out: WeightedField[] = [];
  if (has(meta.displayField)) out.push({ field: meta.displayField, weight: 2 });
  for (const f of ['name', 'title', 'description', 'text']) {
    if (has(f) && f !== meta.displayField) out.push({ field: f, weight: 1 });
  }
  return out;
}

/** Title-like value of a record for result lists. */
export function recordTitle(rec: Rec): string {
  for (const f of ['short_description', 'name', 'title']) {
    if (rec.has(f) && rec.str(f)) return rec.str(f);
  }
  return rec.displayValue();
}

/** Encoded query selecting "open" records: active, not resolved and (for incidents) without a problem. */
export function openRecordsQuery(platform: Platform, meta: TableMeta): string {
  const parts: string[] = [];
  if (meta.columns.has('active')) parts.push('active=true');
  if (meta.columns.has('state')) {
    const resolved = platform.choices
      .list(meta.name, 'state')
      .filter((c) => /resolved/i.test(c.label))
      .map((c) => c.value);
    if (resolved.length) parts.push(`stateNOT IN${resolved.join(',')}`);
  }
  if (meta.ancestors.includes('incident') && meta.columns.has('problem_id')) parts.push('problem_idISEMPTY');
  return parts.join('^');
}

/** Base filter for knowledge articles that may be suggested (published and active). */
export function publishedKnowledgeQuery(meta: TableMeta): string {
  const parts: string[] = [];
  if (meta.columns.has('workflow_state')) parts.push('workflow_state=published');
  if (meta.columns.has('active')) parts.push('active=true');
  return parts.join('^');
}
