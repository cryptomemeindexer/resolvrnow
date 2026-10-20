import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { JOURNAL_TYPES } from '../../engine/types.js';
import { clock, parseGlideDateTime } from '../../engine/util.js';
import { formatDateTimeInZone } from '../../engine/values.js';
import { type Address, escapeHtml, resolvePath, sanitizeHtml, textToHtml } from './util.js';

/** Minimal view of an event used while rendering (`${event.parm1}`...). */
export interface EventLike {
  sys_id?: string | null;
  name: string;
  parm1: string | null;
  parm2: string | null;
  user_id?: string | null;
  table?: string | null;
  instance?: string | null;
}

/** Outbound email being composed; mail scripts may add addresses or override headers. */
export interface MailDraft {
  cc: Address[];
  bcc: Address[];
  from?: string;
  replyTo?: string;
  subject?: string;
}

export interface RenderOptions {
  /** HTML output: values are escaped, links are anchors. */
  html: boolean;
  event?: EventLike | null;
  notification?: Rec | null;
  /** Extra variables, inserted as-is (they take precedence over record fields). */
  extra?: Record<string, string>;
  draft?: MailDraft;
}

export interface RenderEnv {
  ctx: Context;
  rec: Rec | null;
  opts: RenderOptions;
  renderer: TemplateRenderer;
  /** The variable sits inside an href/src attribute: links render as a bare URL. */
  attr?: boolean;
}

/** Services the renderer needs from the notification engine. */
export interface RenderHost {
  readonly platform: Platform;
  baseUrl(): string;
  instanceAddress(): string;
  instanceId(): string;
  /** Output of a mail script, or null when no script has that name. */
  runMailScript(name: string, env: RenderEnv): string | null;
  /** Inline `<mail_script>` blocks (only with the scripts module). */
  runInlineScript(code: string, env: RenderEnv): string;
}

const TOKEN_RE = /\$\{\{([^{}]+)\}\}|\$\{([^{}]+)\}/g;
/** Text before a variable that places it inside an href or src attribute value. */
const ATTRIBUTE_RE = /\b(?:href|src)\s*=\s*(?:"[^"<>]*|'[^'<>]*|)$/i;
const LINK_STYLE = 'color:#1f5fbf;text-decoration:underline;';

/**
 * Expands notification variables: `${field}`, `${ref.field}` dot-walks, `${URI}`,
 * `${URI_REF}`, `${ref.URI_REF}`, `${URI+params}`, `${CMS_URI+path}`, journal variables
 * (`${comments}`, `${comments:2}`, `${comments_and_work_notes}`), `${event.parm1}`,
 * `${mail_script:name}`, `${NOTIF_UNSUB}` and `${NOTIF_PREFS}`. Substituted values are not
 * expanded again, so record content can never inject variables.
 */
export class TemplateRenderer {
  constructor(readonly host: RenderHost) {}

  render(ctx: Context, template: string | null | undefined, rec: Rec | null, opts: RenderOptions): string {
    if (!template) return '';
    const env: RenderEnv = { ctx, rec, opts, renderer: this };
    let src = template;
    if (/<mail_script>/i.test(src)) {
      src = src.replace(/<mail_script>([\s\S]*?)<\/mail_script>/gi, (_m, code: string) =>
        this.host.runInlineScript(code, env),
      );
    }
    return src.replace(
      TOKEN_RE,
      (_m, sanitized: string | undefined, plain: string | undefined, offset: number) => {
        const token = (sanitized ?? plain ?? '').trim();
        try {
          const attr = opts.html && ATTRIBUTE_RE.test(src.slice(Math.max(0, offset - 300), offset));
          const out = this.token(attr ? { ...env, attr } : env, token);
          return sanitized && opts.html ? sanitizeHtml(out) : out;
        } catch (e) {
          ctx.platform.log.warn(
            `[resolvrnow] notification variable \${${token}} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          return '';
        }
      },
    );
  }

  private token(env: RenderEnv, token: string): string {
    const { opts, rec } = env;
    if (opts.extra && Object.hasOwn(opts.extra, token)) return opts.extra[token];
    if (token.startsWith('mail_script:'))
      return this.host.runMailScript(token.slice('mail_script:'.length).trim(), env) ?? '';
    if (token.startsWith('notification:')) return '';
    const plus = token.indexOf('+');
    const name = plus >= 0 ? token.slice(0, plus).trim() : token;
    const params = plus >= 0 ? token.slice(plus + 1) : '';
    switch (name) {
      case 'NOTIF_UNSUB':
        return this.unsubscribeLink(env, params);
      case 'NOTIF_PREFS':
        return this.preferencesLink(env, params);
      case 'URI':
      case 'URI_REF':
        return rec ? this.recordLink(env, rec, name === 'URI_REF', params) : '';
      case 'CMS_URI':
        return rec ? this.portalLink(env, rec, params) : '';
      default:
        break;
    }
    if (name.startsWith('event.')) {
      const ev = opts.event;
      if (!ev) return '';
      const v = (ev as unknown as Record<string, unknown>)[name.slice(6)];
      const s = v === null || v === undefined ? '' : String(v);
      return opts.html ? escapeHtml(s) : s;
    }
    if (!rec) return '';
    const journal = /^([a-z0-9_]+)(?::(-?\d+))?$/.exec(name);
    if (journal) {
      const [, field, count] = journal;
      const n = count === undefined ? undefined : Number(count);
      if (field === 'comments_and_work_notes') return this.journal(env, rec, ['comments', 'work_notes'], n);
      const col = rec.column(field);
      if (col && JOURNAL_TYPES.has(col.type)) return this.journal(env, rec, [field], n);
    }
    const linkMatch = /^(.+)\.(URI|URI_REF)$/.exec(name);
    if (linkMatch) {
      let referenced: Rec | null = rec;
      for (const part of linkMatch[1].split('.')) referenced = referenced ? referenced.ref(part) : null;
      return referenced ? this.recordLink(env, referenced, linkMatch[2] === 'URI_REF', params) : '';
    }
    return this.fieldValue(env, rec, name);
  }

  /** Display value of a (dot-walked) field, escaped for HTML output. */
  fieldValue(env: RenderEnv, rec: Rec, path: string): string {
    const { target, col, field } = resolvePath(rec, path);
    if (!target || !col) return '';
    if (JOURNAL_TYPES.has(col.type)) return this.journal(env, target, [field]);
    if (!col.storage) return '';
    const raw = target.get(field);
    if (raw === null || raw === undefined || raw === '') return col.type === 'boolean' ? 'false' : '';
    let text: string;
    if (col.type === 'glide_date_time' || col.type === 'due_date') text = this.formatDateTime(String(raw));
    else if ((col.type as string) === 'html' || (col.type as string) === 'translated_html') {
      return env.opts.html ? sanitizeHtml(String(raw)) : String(raw).replace(/<[^>]+>/g, '');
    } else text = target.display(field);
    return env.opts.html ? textToHtml(text) : text;
  }

  /** Date-time in the system time zone, optionally followed by the zone abbreviation. */
  formatDateTime(glide: string): string {
    const p = this.host.platform;
    const tz = p.properties.get('glide.sys.default.tz') || 'UTC';
    const local = formatDateTimeInZone(glide, tz);
    if (!p.properties.getBool('glide.email.append.timezone', true)) return local;
    return `${local} ${zoneAbbreviation(tz, parseGlideDateTime(glide) ?? clock.now())}`;
  }

  /** Journal entries, newest first, limited to `n` (or `glide.email.journal.lines`, -1 = all). */
  journal(env: RenderEnv, rec: Rec, fields: string[], n?: number): string {
    const p = this.host.platform;
    let entries = p.history.journal(rec.className, rec.sysId, fields);
    const limit = n !== undefined && n !== 0 ? n : p.properties.getNumber('glide.email.journal.lines', 3);
    if (limit >= 0) entries = entries.slice(0, limit);
    if (!entries.length) return '';
    const names = new Map<string, string>();
    const userName = (u: string) => {
      if (!names.has(u)) {
        const row = p.db.get<{ name: string | null }>(`SELECT "name" FROM "sys_user" WHERE "user_name" = ?`, [
          u,
        ]);
        names.set(u, row?.name || u);
      }
      return names.get(u)!;
    };
    const parts = entries.map((e) => {
      const header = `${this.formatDateTime(e.sys_created_on)} - ${userName(e.sys_created_by)} (${rec.column(e.element)?.label ?? e.element})`;
      if (!env.opts.html) return `${header}\n${e.value}`;
      return `<div style="margin:0 0 12px;"><div style="font-size:12px;color:#52606d;">${escapeHtml(header)}</div><div>${textToHtml(e.value)}</div></div>`;
    });
    return env.opts.html ? parts.join('') : `${parts.join('\n\n')}\n`;
  }

  /** Absolute link to a record in the ResolvrNow workspace. */
  recordUrl(table: string, sysId: string, params = ''): string {
    let url = `${this.host.baseUrl()}/workspace/record/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`;
    const extra = params.trim().replace(/^[?&]+/, '');
    if (extra) url += `?${extra}`;
    return url;
  }

  recordLink(env: RenderEnv, rec: Rec, displayText: boolean, params = ''): string {
    const url = this.recordUrl(rec.className, rec.sysId, params);
    if (env.attr) return escapeHtml(url);
    const text = displayText ? rec.displayValue() || rec.table.label : 'LINK';
    if (!env.opts.html) return displayText ? `${text} (${url})` : url;
    return `<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${escapeHtml(text)}</a>`;
  }

  private portalLink(env: RenderEnv, rec: Rec, params: string): string {
    const path = params.trim().replace(/^\/+/, '');
    const url = `${this.host.baseUrl()}/portal/${path}${path.includes('?') ? '&' : '?'}table=${encodeURIComponent(rec.className)}&sys_id=${rec.sysId}`;
    if (env.attr) return escapeHtml(url);
    if (!env.opts.html) return url;
    return `<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${escapeHtml(rec.displayValue() || 'LINK')}</a>`;
  }

  private unsubscribeLink(env: RenderEnv, params: string): string {
    const n = env.opts.notification;
    if (!n) return '';
    const subject = `Unsubscribe from ${n.str('name')}`;
    const body = JSON.stringify({ notification_id: n.sysId, unsub_token: this.host.instanceId() });
    const href = `mailto:${this.host.instanceAddress()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const text = linkText(params) ?? 'Unsubscribe';
    if (env.attr) return escapeHtml(href);
    if (!env.opts.html) return `${text}: ${href}`;
    return `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${escapeHtml(text)}</a>`;
  }

  private preferencesLink(env: RenderEnv, params: string): string {
    const n = env.opts.notification;
    const query = n
      ? `user=javascript:gs.getUserID()^notification=${n.sysId}`
      : 'user=javascript:gs.getUserID()';
    const url = `${this.host.baseUrl()}/workspace/list/cmn_notif_message?query=${encodeURIComponent(query)}`;
    const text = linkText(params) ?? 'Notification preferences';
    if (env.attr) return escapeHtml(url);
    if (!env.opts.html) return `${text}: ${url}`;
    return `<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${escapeHtml(text)}</a>`;
  }
}

function linkText(params: string): string | null {
  const m = /link_text\s*=\s*"([^"]*)"/.exec(params) ?? /link_text\s*=\s*'([^']*)'/.exec(params);
  return m ? m[1] : null;
}

const abbrevCache = new Map<string, Intl.DateTimeFormat>();

/** Short zone name such as UTC, CET or EST (falls back to the IANA name). */
export function zoneAbbreviation(tz: string, at: Date): string {
  if (tz === 'UTC' || tz === 'GMT') return tz;
  try {
    let f = abbrevCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
      abbrevCache.set(tz, f);
    }
    return f.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}
