import { randomBytes } from 'node:crypto';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { ColumnMeta } from '../../engine/types.js';

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** Plain text to HTML: escaped, with line breaks kept. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>\n');
}

/**
 * Conservative HTML clean-up for values that are allowed to carry markup (html fields,
 * custom mail script output): drops active content, event handlers and script URLs.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(
      /<\s*(script|style|iframe|object|embed|frame|frameset|meta|link|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
      '',
    )
    .replace(
      /<\s*(script|style|iframe|object|embed|frame|frameset|meta|link|base|form|input|button|textarea|select)\b[^>]*>/gi,
      '',
    )
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|(?:javascript|vbscript|data):[^\s>]+)/gi,
      '',
    );
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Decodes HTML character references (`&amp;`, `&#39;`, `&#x2F;`...). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e: string) => {
    if (ENTITIES[e]) return ENTITIES[e];
    const code = /^#x/i.test(e)
      ? Number.parseInt(e.slice(2), 16)
      : e.startsWith('#')
        ? Number(e.slice(1))
        : Number.NaN;
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Readable plain text rendition of an HTML fragment or document. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<\s*(head|style|script|title)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, '').trim();
      if (!href || href.startsWith('mailto:') || label === href) return label || href;
      return label ? `${label} (${href})` : href;
    })
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|li|table|blockquote|pre)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<\s*\/\s*t[dh]\s*>/gi, '  ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Address {
  address: string;
  name: string;
}

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** Parses `"Name" <a@b.c>`, `Name <a@b.c>` or `a@b.c`. */
export function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(.*?)<\s*([^<>\s]+)\s*>\s*$/.exec(s);
  if (m) {
    const address = m[2].trim();
    if (!isEmail(address)) return null;
    const name = m[1]
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/\\"/g, '"')
      .trim();
    return { address, name };
  }
  const bare = s.replace(/^mailto:/i, '');
  return isEmail(bare) ? { address: bare, name: '' } : null;
}

/** Splits an address list on commas/semicolons that are not inside quotes or angle brackets. */
export function parseAddressList(raw: string | string[] | null | undefined): Address[] {
  if (raw === null || raw === undefined) return [];
  const parts: string[] = [];
  for (const chunk of Array.isArray(raw) ? raw : [raw]) {
    let cur = '';
    let quoted = false;
    let angle = 0;
    for (const ch of String(chunk)) {
      if (ch === '"') quoted = !quoted;
      else if (ch === '<' && !quoted) angle++;
      else if (ch === '>' && !quoted && angle > 0) angle--;
      if ((ch === ',' || ch === ';') && !quoted && angle === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
  }
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const a = parseAddress(p);
    if (!a) continue;
    const key = a.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** `"Display Name" <address>` (or the bare address when there is no name). */
export function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  return `"${a.name.replace(/["\\]/g, '')}" <${a.address}>`;
}

/** Splits a comma separated address column into bare addresses. */
export function addressColumn(value: string): string[] {
  return parseAddressList(value).map((a) => a.address);
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Random [A-Za-z0-9] string. */
export function randomAlnum(n: number): string {
  const bytes = randomBytes(n * 2);
  let out = '';
  for (let i = 0; out.length < n && i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 248) out += ALNUM[b % 62];
  }
  while (out.length < n) out += ALNUM[randomBytes(1)[0] % 62];
  return out;
}

/** Comma separated property value as a trimmed list (falls back to the default when empty). */
export function propertyList(platform: Platform, name: string, fallback: string): string[] {
  const raw = platform.properties.get(name) || fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolves a dot-walk path to the record holding the last field and that field's column. */
export function resolvePath(
  rec: Rec,
  path: string,
): { target: Rec | null; col: ColumnMeta | undefined; field: string } {
  const parts = path.split('.');
  let cur: Rec | null = rec;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur) break;
    cur = cur.ref(parts[i]);
  }
  const field = parts[parts.length - 1];
  return { target: cur, col: cur?.column(field), field };
}

/** Lower-cased header map; array values are joined. */
export function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return out;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && typeof h === 'object' && 'name' in h) {
        const rec = h as { name: unknown; value?: unknown };
        out[String(rec.name).toLowerCase()] = String(rec.value ?? '');
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
  }
  return out;
}

/** Serializes headers to the `Name: value` lines stored in sys_email.headers. */
export function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v.replace(/\r?\n/g, ' ')}`)
    .join('\n');
}

/** Parses `Name: value` lines (as stored in sys_email.headers). */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Message identifiers (`<id@host>`) found in a header value. */
export function messageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids?.length) return ids;
  const bare = value.trim();
  return bare ? [`<${bare.replace(/^<|>$/g, '')}>`] : [];
}

/** Plain-text single line, as used for subjects. */
export function oneLine(s: string, max = 160): string {
  return s
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}
