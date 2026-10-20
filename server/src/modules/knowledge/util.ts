import type { Platform } from '../../engine/platform.js';
import { clock, quoteIdent, toGlideDate } from '../../engine/util.js';

export const ARTICLE = 'kb_knowledge';

/** States in which an article is live for readers. */
export const READABLE_STATES = ['published', 'outdated', 'pending_retirement'];
/** States of a version that is being worked on (a "checked out" version). */
export const WORKING_STATES = ['draft', 'review', 'scheduled_publish'];
/** Moving into or out of these states never changes the version number. */
export const NO_BUMP_STATES = new Set(['pending_retirement', 'retired', 'outdated']);

/** Versions are kept as integer hundredths: 0.01 -> 1, 1.0 -> 100, 2.03 -> 203. */
export function parseVersion(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number.parseFloat(String(s));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function formatVersion(n: number): string {
  const major = Math.floor(n / 100);
  const minor = n % 100;
  return minor === 0 ? `${major}.0` : `${major}.${String(minor).padStart(2, '0')}`;
}

/** Next whole version: 0.07 -> 1.0, 1.03 -> 2.0. */
export function nextMajor(n: number): number {
  return Math.floor(n / 100) * 100 + 100;
}

export function splitList(v: unknown): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text from HTML: drops scripts and styles, keeps block boundaries as new lines. */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  const text = String(input)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|pre|blockquote|table|ul|ol|section|article)(\s[^>]*)?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Converts plain text (task notes) to simple HTML paragraphs. */
export function textToHtml(s: string | null | undefined): string {
  const t = String(s ?? '').trim();
  if (!t) return '';
  return t
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Treats a value as HTML when it already contains markup, otherwise converts it. */
export function asHtml(s: string | null | undefined): string {
  const t = String(s ?? '');
  return /<[a-z][\s\S]*>/i.test(t) ? t : textToHtml(t);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3)).trimEnd()}...`;
}

/** Today as a glide date (UTC). */
export function today(): string {
  return toGlideDate(clock.now());
}

export function addDaysToDate(days: number, from: Date = clock.now()): string {
  return toGlideDate(new Date(from.getTime() + days * 86_400_000));
}

/** Physical (quoted) column of the article table, resolved through the dictionary. */
export function articleCol(platform: Platform, field: string): string {
  const col = platform.registry.column(ARTICLE, field);
  return quoteIdent(col?.physical ?? field);
}

/** Physical (quoted) column of any table. */
export function physCol(platform: Platform, table: string, field: string): string {
  const col = platform.registry.column(table, field);
  return quoteIdent(col?.physical ?? field);
}

export function physTable(platform: Platform, table: string): string {
  return quoteIdent(platform.registry.table(table).physical);
}

export function props(platform: Platform) {
  const p = platform.properties;
  return {
    bool: (name: string, fallback = false) => p.getBool(name, fallback),
    num: (name: string, fallback: number) => p.getNumber(name, fallback),
    str: (name: string, fallback = '') => p.get(name, fallback) ?? fallback,
  };
}
