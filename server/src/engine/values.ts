import { evalMacro, type MacroEnv } from './query/macros.js';
import type { ColumnMeta, Internal } from './types.js';
import {
  durationToValue,
  formatDuration,
  isSysId,
  normalizeDate,
  normalizeDateTime,
  parseDuration,
  parseGlideDateTime,
} from './util.js';

export class ValueError extends Error {}

/**
 * Converts an externally supplied value (REST JSON, script, UI) to the stored representation.
 * Reference/choice display-value resolution is done by the caller (it needs DB access).
 */
export function toInternal(col: ColumnMeta, value: unknown): Internal {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    // Accept REST shapes like {"value": "...", "display_value": "..."} or {"link":..., "value":...}
    const v = value as Record<string, unknown>;
    if ('value' in v) return toInternal(col, v.value);
    if ('sys_id' in v) return toInternal(col, v.sys_id);
    return JSON.stringify(value);
  }
  switch (col.type) {
    case 'boolean': {
      if (typeof value === 'boolean') return value ? 1 : 0;
      const s = String(value).trim().toLowerCase();
      if (s === '') return null;
      return ['true', '1', 'yes', 'y', 'on'].includes(s) ? 1 : 0;
    }
    case 'integer': {
      if (typeof value === 'number') return Math.trunc(value);
      const s = String(value).trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? Math.trunc(n) : s; // non-numeric kept for choice-label resolution
    }
    case 'decimal':
    case 'float':
    case 'currency':
    case 'price':
    case 'percent_complete': {
      if (typeof value === 'number') return value;
      const s = String(value).replace(/[^0-9.+-eE]/g, '').trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case 'glide_duration':
      return parseDuration(value);
    case 'glide_date_time':
    case 'due_date': {
      const s = String(value).trim();
      if (s === '') return null;
      return normalizeDateTime(s) ?? s;
    }
    case 'glide_date': {
      const s = String(value).trim();
      if (s === '') return null;
      return normalizeDate(s) ?? s;
    }
    case 'glide_list':
      if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean).join(',');
      return String(value)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .join(',');
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default: {
      let s = typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : String(value);
      if (col.maxLength && col.maxLength > 0 && s.length > col.maxLength && col.type === 'string') {
        s = s.slice(0, col.maxLength);
      }
      return s;
    }
  }
}

/** The REST "value" representation (everything is a string, like the platform's Table API). */
export function toApiValue(col: ColumnMeta, v: Internal): string {
  if (v === null || v === undefined) return '';
  switch (col.type) {
    case 'boolean':
      return v === 1 || v === '1' || v === 'true' ? 'true' : 'false';
    case 'glide_duration':
      return durationToValue(typeof v === 'number' ? v : parseDuration(v));
    case 'password2':
      return '';
    default:
      return String(v);
  }
}

export interface DisplayOptions {
  timeZone?: string | null;
  /** Resolves a choice label for a value. */
  choiceLabel?: (value: string) => string | undefined;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function formatDateTimeInZone(glide: string, tz: string | null | undefined): string {
  const d = parseGlideDateTime(glide);
  if (!d) return glide;
  if (!tz || tz === 'UTC' || tz === 'GMT') return glide;
  try {
    const parts = Object.fromEntries(dtf(tz).formatToParts(d).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return glide;
  }
}

/** Display value for non-reference fields. References are resolved by the record layer. */
export function toDisplayValue(col: ColumnMeta, v: Internal, opts: DisplayOptions = {}): string {
  if (v === null || v === undefined || v === '') {
    return col.type === 'boolean' ? 'false' : '';
  }
  if (opts.choiceLabel) {
    const label = opts.choiceLabel(String(v));
    if (label !== undefined) return label;
  }
  switch (col.type) {
    case 'boolean':
      return v === 1 || v === '1' || v === 'true' ? 'true' : 'false';
    case 'glide_duration':
      return formatDuration(typeof v === 'number' ? v : parseDuration(v));
    case 'glide_date_time':
    case 'due_date':
      return formatDateTimeInZone(String(v), opts.timeZone);
    case 'password2':
      return '********';
    case 'decimal':
    case 'float':
    case 'currency':
    case 'price':
      return typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(2) : String(v)) : String(v);
    default:
      return String(v);
  }
}

/** Evaluates a dictionary default value to its stored representation. */
export function evaluateDefault(col: ColumnMeta, env: MacroEnv & { now: string; table: string }): Internal {
  const d = col.defaultValue;
  if (d === undefined || d === null || d === '') return null;
  if (typeof d === 'function') {
    return toInternal(col, d({ userId: env.userId, now: env.now, table: env.table }));
  }
  if (typeof d === 'string' && /^javascript:/i.test(d)) {
    const r = evalMacro(d, env);
    return r === null ? null : toInternal(col, r);
  }
  return toInternal(col, d);
}

export function looksLikeSysId(v: unknown): boolean {
  return isSysId(v);
}
