import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { randomAlnum } from './util.js';

/** Marker that precedes the watermark label in email bodies. */
export const WATERMARK_MARKER = 'Ref:';

/**
 * Placeholder written by templates and mail scripts (for example inside mailto links)
 * before the email's own watermark is known. Only letters, so it survives URL encoding.
 */
export const WATERMARK_PLACEHOLDER = 'RESOLVRWATERMARKPLACEHOLDER';

/** Matches `Ref:<label>`; labels are `<prefix><digits>` with an optional `_<random>` suffix. */
const WATERMARK_RE = /Ref:([A-Za-z0-9.-]*?\d+(?:_[A-Za-z0-9]+)?)(?![A-Za-z0-9_])/g;

/**
 * Allocates a watermark label (prefix and number from Number Maintenance, then `_` and 20
 * random characters) and records which record it points at.
 */
export function createWatermark(ctx: Context, target: Rec, emailId: string | null): string {
  const meta = ctx.registry.table('sys_watermark');
  let base = ctx.platform.numbers.next(meta);
  if (!base) {
    const n = ctx.platform.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "sys_watermark"`)?.n ?? 0;
    base = `MSG${String(n + 1).padStart(7, '0')}`;
  }
  const label = `${base.replace(/:/g, '')}_${randomAlnum(20)}`;
  ctx.elevated().insert('sys_watermark', {
    number: label,
    source_table: target.className,
    source_id: target.sysId,
    email: emailId,
  });
  return label;
}

/** Every watermark label found in a text, in order of appearance. */
export function findWatermarks(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(WATERMARK_RE)) out.push(m[1]);
  return out;
}

export interface WatermarkTarget {
  label: string;
  table: string;
  sysId: string;
  emailId: string | null;
}

/** Resolves a label to the record it was issued for (null when unknown or the record is gone). */
export function lookupWatermark(ctx: Context, label: string): WatermarkTarget | null {
  if (!ctx.registry.has('sys_watermark')) return null;
  const row = ctx.platform.db.get<{
    source_table: string | null;
    source_id: string | null;
    email: string | null;
  }>(`SELECT "source_table","source_id","email" FROM "sys_watermark" WHERE "number" = ? LIMIT 1`, [label]);
  if (!row?.source_table || !row.source_id || !ctx.registry.has(row.source_table)) return null;
  if (!ctx.elevated().loadRaw(row.source_table, row.source_id)) return null;
  return { label, table: row.source_table, sysId: row.source_id, emailId: row.email };
}

/** Appends the watermark to the HTML body (before `</body>` when present) and the text body. */
export function applyWatermark(
  html: string,
  text: string,
  label: string | null,
  visible: boolean,
): { html: string; text: string } {
  const fill = (s: string) => s.split(WATERMARK_PLACEHOLDER).join(label ?? '');
  let outHtml = fill(html);
  let outText = fill(text);
  if (!label) return { html: outHtml, text: outText };
  const mark = `${WATERMARK_MARKER}${label}`;
  if (outHtml) {
    const div = `<div style="display:${visible ? 'inline' : 'none'};font-size:11px;color:#6b7785;">${mark}</div>`;
    const idx = outHtml.search(/<\/body\s*>/i);
    outHtml = idx >= 0 ? `${outHtml.slice(0, idx)}${div}\n${outHtml.slice(idx)}` : `${outHtml}\n${div}`;
  }
  outText = outText ? `${outText.replace(/\s+$/, '')}\n\n${mark}` : mark;
  return { html: outHtml, text: outText };
}

/** Body without watermark labels (used to compare duplicate emails). */
export function stripWatermarks(s: string): string {
  return s
    .replace(/<div[^>]*>\s*Ref:[^<]*<\/div>/gi, '')
    .replace(WATERMARK_RE, '')
    .trim();
}
