import { saveAttachment } from '../../api/now/attachment.js';
import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { newSysId, nowGlide } from '../../engine/util.js';
import {
  type ApprovalDecision,
  type ApprovalService,
  optionalService,
  type ScriptService,
  SERVICES,
} from '../contracts.js';
import type { NotificationEngine } from './engine.js';
import {
  type Address,
  headerLines,
  htmlToText,
  messageIds,
  normalizeHeaders,
  oneLine,
  parseAddressList,
  parseHeaderLines,
  propertyList,
  sanitizeHtml,
  textToHtml,
} from './util.js';
import { findWatermarks, lookupWatermark } from './watermark.js';

/** JSON accepted by `POST /api/app/email/inbound` (shape used by common mail provider webhooks). */
export interface InboundEmailInput {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  headers?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
  messageId?: unknown;
  /** Optional files: `{ filename, contentType, content }` with base64 content. */
  attachments?: unknown;
}

export interface InboundResult {
  sys_id: string;
  type: string;
  state: string;
  receive_type: string;
  matched_by: string | null;
  target_table: string | null;
  target_sys_id: string | null;
  user_id: string | null;
  sender: string;
  actions: string[];
  log: string[];
}

/** The `email` object visible to inbound actions. */
export interface InboundEmail {
  from: string;
  from_sys_id: string;
  origemail: string;
  to: string;
  direct: string;
  copied: string;
  subject: string;
  body_text: string;
  body_html: string;
  recipients: string;
  recipients_array: string[];
  content_type: string;
  headers: string;
  importance: string;
  /** `name:value` lines of the body (names lower-cased, spaces become underscores). */
  body: Record<string, string>;
}

interface ParsedInbound {
  from: Address;
  to: Address[];
  cc: Address[];
  headers: Record<string, string>;
  subject: string;
  html: string;
  text: string;
  inReplyTo: string;
  references: string;
  messageId: string;
}

interface Sender {
  userId: string | null;
  userName: string;
  guest: boolean;
  address: string;
  name: string;
}

interface Classification {
  type: 'new' | 'reply' | 'forward';
  target: { table: string; sysId: string } | null;
  via: string | null;
}

interface HandlerArgs {
  engine: NotificationEngine;
  action: Rec;
  email: InboundEmail;
  emailRec: Rec;
  target: Rec | null;
  sender: Sender;
  /** Runs as the sender (no ACL checks, attribution to the sender). */
  ctx: Context;
  sys: Context;
  log: (message: string) => void;
}

interface HandlerResult {
  record?: Rec | null;
  stop?: boolean;
}

type Handler = (args: HandlerArgs) => HandlerResult;

/** Built-in inbound behaviours selected with `sysevent_in_email_action.resolvr_handler`. */
export const INBOUND_HANDLERS: Record<string, Handler> = {
  reply_comment(a) {
    if (!a.target) return {};
    const rec = a.ctx.loadRaw(a.target.className, a.target.sysId);
    if (!rec) return {};
    if (!rec.has('comments')) {
      a.log(`${rec.table.label} ${rec.displayValue()} has no comments field; reply not recorded`);
      return {};
    }
    const text = a.email.body_text.trim() || '(empty reply)';
    applyFieldActions(rec, a.action.str('template'), a.email);
    a.ctx.update(rec, { comments: `reply from: ${a.email.origemail}\n\n${text}` });
    a.log(`Added the reply to ${rec.displayValue()} as a comment from ${a.sender.name || a.sender.address}`);
    return { record: rec };
  },

  create_record(a) {
    const table = a.action.str('collection');
    if (!table || !a.ctx.registry.has(table)) return {};
    const rec = a.ctx.newRecord(table);
    const put = (field: string, value: unknown) => {
      if (rec.has(field) && value !== undefined && value !== null && value !== '') rec.set(field, value);
    };
    put('short_description', oneLine(a.email.subject, 160) || '(no subject)');
    put('description', a.email.body_text);
    if (!a.sender.guest && a.sender.userId) {
      put('caller_id', a.sender.userId);
      put('requested_for', a.sender.userId);
    }
    put('opened_by', a.sender.userId);
    if (rec.has('contact_type')) put('contact_type', 'email');
    applyFieldActions(rec, a.action.str('template'), a.email);
    a.ctx.insert(rec);
    a.log(`Created ${rec.table.label} ${rec.displayValue()}`);
    return { record: rec };
  },

  approval_reply(a) {
    if (!a.target) return {};
    const approval = a.sys.loadRaw(a.target.className, a.target.sysId);
    if (!approval) return { stop: true };
    if (approval.str('state') !== 'requested') {
      a.log(`Approval is ${approval.display('state') || approval.str('state')}, not pending; reply ignored`);
      return { stop: true };
    }
    const approver = approval.str('approver');
    if (
      !a.sender.userId ||
      (a.sender.userId !== approver && !isApprovalDelegate(a.sys, a.sender.userId, approver))
    ) {
      a.log(`${a.sender.address} is not authorized to decide this approval`);
      return { stop: true };
    }
    const decision = parseDecision(a.email.subject, a.email.body_text);
    if (!decision) {
      a.log('No approve or reject decision found in the reply');
      return { stop: true };
    }
    const svc = optionalService<Partial<ApprovalService>>(a.engine.platform, SERVICES.approvals);
    if (!svc || typeof svc.decide !== 'function') {
      a.log('The approvals module is not installed; decision not applied');
      return { stop: true };
    }
    const fresh = a.ctx.loadRaw(approval.className, approval.sysId) ?? approval;
    // The fifth argument (decision source) is understood by the ResolvrNow approvals engine and ignored otherwise.
    const decide = svc.decide as (...args: unknown[]) => void;
    decide.call(svc, a.ctx, fresh, decision, a.email.body_text.trim(), { source: 'email' });
    a.log(`Approval ${decision} by ${a.sender.name || a.sender.address} via email`);
    return { record: fresh, stop: true };
  },

  unsubscribe(a) {
    const match = /\{[^{}]*"notification_id"[^{}]*\}/.exec(a.email.body_text);
    let data: { notification_id?: string; unsub_token?: string } | null = null;
    try {
      data = match ? (JSON.parse(match[0]) as { notification_id?: string; unsub_token?: string }) : null;
    } catch {
      data = null;
    }
    if (!data?.notification_id || data.unsub_token !== a.engine.instanceId()) {
      a.log('Unsubscribe request without a valid token');
      return { stop: true };
    }
    if (a.sender.guest || !a.sender.userId) {
      a.log(`Unsubscribe request from unknown sender ${a.sender.address}`);
      return { stop: true };
    }
    const n = a.sys.loadRaw('sysevent_email_action', data.notification_id);
    if (!n) {
      a.log('Unsubscribe request for an unknown notification');
      return { stop: true };
    }
    if (n.bool('mandatory')) {
      a.log(`"${n.str('name')}" is mandatory and cannot be unsubscribed`);
      return { stop: true };
    }
    let sub = a.sys.first('cmn_notif_message', `user=${a.sender.userId}^notification=${n.sysId}`);
    if (sub) sub = a.sys.update(sub, { active: false });
    else
      sub = a.sys.insert('cmn_notif_message', {
        user: a.sender.userId,
        notification: n.sysId,
        active: false,
      });
    a.log(`${a.sender.name || a.sender.address} unsubscribed from "${n.str('name')}"`);
    return { record: sub, stop: true };
  },
};

/** Decision in an approval reply (keywords, `state:approved`, or the subject of a mailto reply). */
export function parseDecision(subject: string, text: string): ApprovalDecision | null {
  if (/\bstate\s*:\s*approved\b/i.test(text)) return 'approved';
  if (/\bstate\s*:\s*rejected\b/i.test(text)) return 'rejected';
  const first = (text.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (/-\s*approve\s*$/i.test(subject) || ['yes', 'approve', 'approved'].includes(first)) return 'approved';
  if (/-\s*reject\s*$/i.test(subject) || ['no', 'reject', 'rejected'].includes(first)) return 'rejected';
  const approve = /\bapprove(d)?\b/i.test(text);
  const reject = /\breject(ed)?\b/i.test(text);
  if (approve && !reject) return 'approved';
  if (reject && !approve) return 'rejected';
  return null;
}

function isApprovalDelegate(ctx: Context, userId: string, approverId: string): boolean {
  if (!approverId || !ctx.registry.has('sys_user_delegate')) return false;
  const now = nowGlide();
  return !!ctx.platform.db.get(
    `SELECT 1 AS x FROM "sys_user_delegate" d JOIN "sys_user" u ON u."sys_id" = d."delegate" WHERE d."user" = ? AND d."delegate" = ? AND (d."approvals" IS NULL OR d."approvals" = 1)
       AND (d."starts" IS NULL OR d."starts" = '' OR d."starts" <= ?) AND (d."ends" IS NULL OR d."ends" = '' OR d."ends" > ?) AND (u."active" IS NULL OR u."active" = 1)`,
    [approverId, userId, now, now],
  );
}

/** Applies `field=value^field=value` field actions; values may reference `${email.*}`. */
export function applyFieldActions(rec: Rec, template: string, email: InboundEmail): void {
  if (!template.trim()) return;
  const terms: string[] = [];
  let cur = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '^') {
      if (template[i + 1] === '^') {
        cur += '^';
        i++;
        continue;
      }
      terms.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  terms.push(cur);
  for (const term of terms) {
    const eq = term.indexOf('=');
    if (eq <= 0) continue;
    const field = term.slice(0, eq).trim();
    if (!rec.has(field) || term.slice(eq + 1).trim() === 'EQ') continue;
    const value = term.slice(eq + 1).replace(/\$\{email\.([a-z0-9_.]+)\}/gi, (_m, key: string) => {
      if (key.startsWith('body.')) return email.body[key.slice(5).toLowerCase()] ?? '';
      const v = (email as unknown as Record<string, unknown>)[key];
      return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(',') : String(v);
    });
    rec.set(field, value);
  }
}

/** `name:value` lines of a text body. */
export function bodyVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w .-]{0,60}?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (!(name in out)) out[name] = m[2];
  }
  return out;
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(asString).join(', ');
  if (typeof v === 'object') {
    const o = v as { address?: unknown; name?: unknown; text?: unknown; value?: unknown };
    if (typeof o.address === 'string') return o.name ? `"${String(o.name)}" <${o.address}>` : o.address;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.value)) return asString(o.value);
  }
  return String(v);
}

/**
 * Inbound email processing: records the message, classifies it (forward, reply by
 * watermark / In-Reply-To / record number, or new), matches the sender to a user, runs
 * the inbound email actions and links the email to the record it produced or updated.
 */
export class InboundProcessor {
  constructor(private readonly engine: NotificationEngine) {}

  /** Records an inbound message (sys_email type `received`) and processes it. */
  receive(input: InboundEmailInput): InboundResult {
    const sys = this.engine.platform.systemContext();
    const from = parseAddressList(asString(input.from))[0];
    if (!from) throw new InvalidError('A valid "from" address is required');
    const headers = normalizeHeaders(input.headers);
    const html = sanitizeHtml(asString(input.html));
    const text = (asString(input.text) || (html ? htmlToText(html) : '')).replace(/\r\n?/g, '\n');
    const msg: ParsedInbound = {
      from,
      to: parseAddressList(asString(input.to)),
      cc: parseAddressList(asString(input.cc)),
      headers,
      subject: asString(input.subject)
        .replace(/\s*\r?\n\s*/g, ' ')
        .trim(),
      html,
      text,
      inReplyTo: asString(input.inReplyTo) || headers['in-reply-to'] || '',
      references: asString(input.references) || headers.references || '',
      messageId: asString(input.messageId) || headers['message-id'] || `<${newSysId()}@inbound.resolvrnow>`,
    };
    const importance = (headers.importance ?? '').toLowerCase();
    const emailRec = sys.insert('sys_email', {
      type: 'received',
      state: 'ready',
      mailbox: this.engine.mailboxId('Inbox'),
      notification_type: 'SMTP',
      subject: oneLine(msg.subject) || '(no subject)',
      body: html || textToHtml(text),
      body_text: text,
      content_type: html ? 'text/html' : 'text/plain',
      recipients: [...msg.to, ...msg.cc].map((a) => a.address).join(', '),
      direct: msg.to.map((a) => a.address).join(', '),
      copied: msg.cc.map((a) => a.address).join(', '),
      user: from.address,
      message_id: msg.messageId.slice(0, 1000),
      headers: headerLines({ ...headers, 'in-reply-to': msg.inReplyTo, references: msg.references }),
      importance: importance === 'high' || importance === 'low' ? importance : null,
      receive_type: 'new',
    });
    return this.process(emailRec, msg, input.attachments);
  }

  /** Runs classification and inbound actions again for a received email. */
  reprocess(emailRec: Rec): InboundResult {
    const from = parseAddressList(emailRec.str('user'))[0];
    if (!from) throw new InvalidError('The email has no sender address');
    const headers = parseHeaderLines(emailRec.str('headers'));
    const html = emailRec.str('content_type') === 'text/html' ? emailRec.str('body') : '';
    return this.process(emailRec, {
      from,
      to: parseAddressList(emailRec.str('direct')),
      cc: parseAddressList(emailRec.str('copied')),
      headers,
      subject: emailRec.str('subject'),
      html,
      text: emailRec.str('body_text') || htmlToText(html),
      inReplyTo: headers['in-reply-to'] ?? '',
      references: headers.references ?? '',
      messageId: emailRec.str('message_id'),
    });
  }

  private process(emailRec: Rec, msg: ParsedInbound, attachments?: unknown): InboundResult {
    const platform = this.engine.platform;
    const sys = platform.systemContext();
    const { from, to, cc, headers, subject, html, text, inReplyTo, references } = msg;
    const log: string[] = [];
    const result: InboundResult = {
      sys_id: emailRec.sysId,
      type: 'received',
      state: 'ready',
      receive_type: 'new',
      matched_by: null,
      target_table: null,
      target_sys_id: null,
      user_id: null,
      sender: from.address,
      actions: [],
      log,
    };
    const junk = this.junkReason(headers, from.address);
    if (junk) {
      sys.update(emailRec, {
        type: 'received-ignored',
        state: 'ignored',
        mailbox: this.engine.mailboxId('Junk'),
        error_string: junk,
      });
      log.push(`Ignored: ${junk}`);
      this.flushLog(sys, emailRec.sysId, log);
      return { ...result, type: 'received-ignored', state: 'ignored' };
    }

    const sender = this.matchSender(sys, from, log);
    result.user_id = sender.userId;
    const importance = (headers.importance ?? '').toLowerCase();
    if (emailRec.str('user_id') !== (sender.userId ?? ''))
      emailRec = sys.update(emailRec, { user_id: sender.userId });

    const cls = this.classify(sys, subject, text, html, inReplyTo, references);
    if (cls.via) log.push(`Classified as ${cls.type} (${cls.via})`);
    const target = cls.target ? sys.loadRaw(cls.target.table, cls.target.sysId) : null;
    const bodyText = cls.type === 'reply' ? this.cutReply(sys, text) : text;
    const email: InboundEmail = {
      from: sender.guest
        ? from.address
        : (platform.db.get<{ email: string }>(`SELECT "email" FROM "sys_user" WHERE "sys_id" = ?`, [
            sender.userId ?? '',
          ])?.email ?? from.address),
      from_sys_id: sender.userId ?? '',
      origemail: from.address,
      to: [...to, ...cc].map((a) => a.address).join(','),
      direct: to.map((a) => a.address).join(','),
      copied: cc.map((a) => a.address).join(','),
      subject,
      body_text: bodyText,
      body_html: html,
      recipients: [...to, ...cc].map((a) => a.address).join(','),
      recipients_array: [...to, ...cc].map((a) => a.address),
      content_type: html ? 'text/html' : 'text/plain',
      headers: headerLines(headers),
      importance,
      body: bodyVariables(bodyText),
    };

    const { ran, record, errors } = this.runActions(sys, emailRec, email, cls, target, sender, log);
    const produced = record ?? target;
    if (produced && ran.length) this.attachFiles(sys, attachments, produced, emailRec, log);
    const fresh = sys.get('sys_email', emailRec.sysId) ?? emailRec;
    sys.update(fresh, {
      state: errors.length ? 'error' : 'processed',
      receive_type: cls.type,
      target_table: produced?.className ?? null,
      instance: produced?.sysId ?? null,
      error_string: errors.join('; ').slice(0, 1000),
    });
    if (!ran.length) log.push('No inbound action matched');
    this.flushLog(sys, emailRec.sysId, log);
    return {
      ...result,
      state: errors.length ? 'error' : 'processed',
      receive_type: cls.type,
      matched_by: cls.via,
      target_table: produced?.className ?? null,
      target_sys_id: produced?.sysId ?? null,
      actions: ran,
    };
  }

  private flushLog(sys: Context, emailId: string, log: string[]): void {
    for (const line of log) this.engine.logEmail(sys, emailId, 'info', line);
  }

  /** Auto-replies, bulk mail and mail from the instance itself are not processed. */
  private junkReason(headers: Record<string, string>, from: string): string | null {
    const auto = (headers['auto-submitted'] ?? '').trim().toLowerCase();
    if (auto && auto !== 'no') return `Auto-Submitted: ${auto}`;
    const precedence = (headers.precedence ?? '').trim().toLowerCase();
    if (['bulk', 'junk', 'list'].includes(precedence)) return `Precedence: ${precedence}`;
    if (headers['x-autoreply'] || headers['x-autorespond']) return 'Automatic reply';
    if (from.toLowerCase() === this.engine.instanceAddress().toLowerCase()) return 'Sent by this instance';
    return null;
  }

  /** Active user with that email (or email device); else auto-created when allowed; else guest. */
  private matchSender(sys: Context, from: Address, log: string[]): Sender {
    const db = sys.platform.db;
    const user = db.get<{ sys_id: string; user_name: string; name: string | null }>(
      `SELECT "sys_id","user_name","name" FROM "sys_user" WHERE "email" = ? COLLATE NOCASE AND ("active" IS NULL OR "active" = 1) ORDER BY "sys_created_on", rowid LIMIT 1`,
      [from.address],
    );
    if (user)
      return {
        userId: user.sys_id,
        userName: user.user_name,
        guest: false,
        address: from.address,
        name: user.name ?? user.user_name,
      };
    if (sys.registry.has('cmn_notif_device')) {
      const dev = db.get<{ sys_id: string; user_name: string; name: string | null }>(
        `SELECT u."sys_id",u."user_name",u."name" FROM "cmn_notif_device" d JOIN "sys_user" u ON u."sys_id" = d."user" WHERE d."email_address" = ? COLLATE NOCASE AND (d."active" IS NULL OR d."active" = 1) AND (u."active" IS NULL OR u."active" = 1) LIMIT 1`,
        [from.address],
      );
      if (dev)
        return {
          userId: dev.sys_id,
          userName: dev.user_name,
          guest: false,
          address: from.address,
          name: dev.name ?? dev.user_name,
        };
    }
    const props = sys.platform.properties;
    if (props.getBool('glide.pop3readerjob.create_caller', false)) {
      const domain = from.address.split('@')[1]?.toLowerCase() ?? '';
      const trusted = propertyList(sys.platform, 'glide.user.trusted_domain', '')
        .map((d) => d.toLowerCase().replace(/^@/, ''))
        .filter((d) => !d.includes('*'));
      if (domain && trusted.includes(domain)) {
        const { first, last } = splitDisplayName(from.name);
        const created = sys.insert('sys_user', {
          user_name: from.address,
          email: from.address,
          first_name: first,
          last_name: last,
          active: true,
        });
        log.push(`Created user ${created.str('name') || from.address} for the sender`);
        return {
          userId: created.sysId,
          userName: created.str('user_name'),
          guest: false,
          address: from.address,
          name: created.str('name'),
        };
      }
    }
    const guest = this.guestUser(sys);
    log.push(`Sender ${from.address} is not a known user; processing as guest`);
    return {
      userId: guest?.sys_id ?? null,
      userName: guest?.user_name ?? 'guest',
      guest: true,
      address: from.address,
      name: from.name,
    };
  }

  private guestUser(sys: Context): { sys_id: string; user_name: string } | null {
    const db = sys.platform.db;
    const row = db.get<{ sys_id: string; user_name: string }>(
      `SELECT "sys_id","user_name" FROM "sys_user" WHERE "user_name" = 'guest' LIMIT 1`,
    );
    if (row) return row;
    const created = sys.insert('sys_user', {
      user_name: 'guest',
      first_name: 'Guest',
      last_name: '',
      active: true,
      notification: 1,
    });
    return { sys_id: created.sysId, user_name: 'guest' };
  }

  /** forward, then reply (watermark, In-Reply-To, record number), else new. */
  private classify(
    sys: Context,
    subject: string,
    text: string,
    html: string,
    inReplyTo: string,
    references: string,
  ): Classification {
    const platform = sys.platform;
    const subj = subject.trim();
    const forwardPrefixes = propertyList(platform, 'glide.email.forward_subject_prefix', 'fw:,fwd:');
    const plain = text || htmlToText(html);
    if (
      forwardPrefixes.some((p) => subj.toLowerCase().startsWith(p.toLowerCase())) &&
      /(^|\n)[ \t>]*(from|von|de)\s*:\s*\S/i.test(plain)
    ) {
      return { type: 'forward', target: null, via: 'forward prefix and quoted header' };
    }
    const bodyMarks = findWatermarks(text);
    const marks = bodyMarks.length ? bodyMarks : findWatermarks(html);
    for (const label of [...marks].reverse()) {
      const t = lookupWatermark(sys, label);
      if (t)
        return { type: 'reply', target: { table: t.table, sysId: t.sysId }, via: `watermark Ref:${label}` };
    }
    for (const label of findWatermarks(subject).reverse()) {
      const t = lookupWatermark(sys, label);
      if (t)
        return { type: 'reply', target: { table: t.table, sysId: t.sysId }, via: `watermark Ref:${label}` };
    }
    const ids = [...messageIds(inReplyTo), ...messageIds(references).reverse()];
    if (ids.length && platform.registry.has('sys_watermark')) {
      for (const id of ids) {
        const row = platform.db.get<{ source_table: string | null; source_id: string | null }>(
          `SELECT w."source_table",w."source_id" FROM "sys_email" e JOIN "sys_watermark" w ON w."email" = e."sys_id" WHERE e."message_id" = ? AND e."type" NOT IN ('received','received-ignored') LIMIT 1`,
          [id],
        );
        if (
          row?.source_table &&
          row.source_id &&
          platform.registry.has(row.source_table) &&
          sys.loadRaw(row.source_table, row.source_id)
        ) {
          return {
            type: 'reply',
            target: { table: row.source_table, sysId: row.source_id },
            via: `In-Reply-To ${id}`,
          };
        }
      }
    }
    const replyPrefixes = propertyList(
      platform,
      'glide.email.reply_subject_prefix',
      're:,aw:,r:,Accepted:,Tentative:,Declined:',
    );
    // Prefixes match case-sensitively as written, or fully upper-cased ("re:" matches "RE:" but not "Re:").
    if (replyPrefixes.some((p) => subj.startsWith(p) || subj.startsWith(p.toUpperCase()))) {
      const found = this.recordNumberIn(sys, subj);
      if (found)
        return {
          type: 'reply',
          target: { table: found.className, sysId: found.sysId },
          via: `record number ${found.str('number')}`,
        };
    }
    return { type: 'new', target: null, via: null };
  }

  /** Left-most whitespace-delimited token that is a known record number. */
  private recordNumberIn(sys: Context, subject: string): Rec | null {
    const platform = sys.platform;
    if (!platform.registry.has('sys_number')) return null;
    const byPrefix = new Map<string, string[]>();
    for (const r of platform.db.all<{ category: string; prefix: string }>(
      `SELECT "category","prefix" FROM "sys_number" WHERE "prefix" IS NOT NULL`,
    )) {
      const list = byPrefix.get(r.prefix.toUpperCase()) ?? [];
      list.push(r.category);
      byPrefix.set(r.prefix.toUpperCase(), list);
    }
    for (const raw of subject.split(/\s+/)) {
      if (/^["'*]/.test(raw)) continue;
      const token = raw.replace(/[.,;:!?)\]]+$/, '');
      if (/["'*]$/.test(token)) continue;
      const m = /^([A-Za-z]+)(\d+)$/.exec(token);
      if (!m) continue;
      for (const table of byPrefix.get(m[1].toUpperCase()) ?? []) {
        if (!platform.registry.has(table) || !platform.registry.table(table).columns.has('number')) continue;
        const rec = sys.first(table, `number=${token.toUpperCase()}`);
        if (rec) return rec;
      }
    }
    return null;
  }

  /** Keeps only the newest message of a reply (cut at the first reply separator). */
  cutReply(sys: Context, text: string): string {
    if (!text || !sys.registry.has('sys_email_reply_separator')) return text;
    let cut = text.length;
    for (const s of sys.query('sys_email_reply_separator', { query: 'active=true' })) {
      const sep = s.str('separator');
      if (!sep) continue;
      let idx = -1;
      if (s.str('type') === 'regex') {
        try {
          const m = new RegExp(sep, 'm').exec(text);
          idx = m ? m.index : -1;
        } catch {
          idx = -1;
        }
      } else idx = text.indexOf(sep);
      if (idx >= 0 && idx < cut) cut = idx;
    }
    const kept = text.slice(0, cut).trim();
    return kept || text.trim();
  }

  private runActions(
    sys: Context,
    emailRec: Rec,
    email: InboundEmail,
    cls: Classification,
    target: Rec | null,
    sender: Sender,
    log: string[],
  ): { ran: string[]; record: Rec | null; errors: string[] } {
    const platform = this.engine.platform;
    const ran: string[] = [];
    const errors: string[] = [];
    let record: Rec | null = null;
    if (!platform.registry.has('sysevent_in_email_action')) return { ran, record, errors };
    const actions = sys
      .query('sysevent_in_email_action', { query: 'active=true' })
      .sort(
        (a, b) =>
          (a.num('order') ?? 100) - (b.num('order') ?? 100) || a.str('name').localeCompare(b.str('name')),
      );
    let session: Context = sys;
    try {
      if (sender.userId) session = platform.contextAs(sender.userId);
    } catch {
      log.push(`Sender user ${sender.userId} could not be loaded; running as system`);
    }
    const actor = session.derive({ acl: false });
    const emailSubject = recSubject(emailRec, null, platform.registry);
    for (const a of actions) {
      if (a.str('type') !== cls.type) continue;
      const collection = a.str('collection');
      if (collection && !platform.registry.has(collection)) continue;
      if (cls.type === 'reply') {
        if (!target) continue;
        if (collection && !target.table.ancestors.includes(collection)) continue;
      }
      if (a.str('filter_condition') && !matches(a.str('filter_condition'), emailSubject, sys.env)) continue;
      if (a.str('condition_script') && !this.scriptCondition(actor, a, email, target)) continue;
      const roles = a
        .str('required_roles')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      if (roles.length && !session.hasAnyRole(roles)) {
        log.push(`Skipped "${a.str('name')}": sender lacks ${roles.join(' or ')}`);
        continue;
      }
      if (a.str('from') && a.str('from') !== sender.userId) continue;
      let stop = a.bool('stop_processing');
      try {
        const res = platform.db.tx(() => this.execute(a, email, emailRec, target, sender, actor, sys, log));
        ran.push(a.str('name'));
        if (res.record && !record && res.record.sysId !== target?.sysId) record = res.record;
        if (res.stop) stop = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push(`${a.str('name')}: ${message}`);
        log.push(`Action "${a.str('name')}" failed: ${message}`);
      }
      if (stop) break;
    }
    return { ran, record, errors };
  }

  private execute(
    a: Rec,
    email: InboundEmail,
    emailRec: Rec,
    target: Rec | null,
    sender: Sender,
    actor: Context,
    sys: Context,
    log: string[],
  ): HandlerResult {
    const args: HandlerArgs = {
      engine: this.engine,
      action: a,
      email,
      emailRec,
      target,
      sender,
      ctx: actor,
      sys,
      log: (m) => log.push(m),
    };
    const handler = a.str('resolvr_handler');
    let res: HandlerResult = {};
    if (handler && INBOUND_HANDLERS[handler]) res = INBOUND_HANDLERS[handler](args);
    else res = this.genericAction(args);
    if (a.str('action') === 'reply_email' && a.str('reply_email').trim()) {
      const about = res.record ?? target;
      this.engine.send(sys, {
        to: [sender.address],
        subject: `Re: ${email.subject}`,
        body: this.engine.render(sys, a.str('reply_email'), about),
        target: about,
      });
      log.push(`Replied to ${sender.address}`);
    }
    return res;
  }

  /** Field actions and an optional script on the target (reply) or a new record. */
  private genericAction(a: HandlerArgs): HandlerResult {
    const table = a.action.str('collection');
    let current: Rec | null = null;
    if (a.target) current = a.ctx.loadRaw(a.target.className, a.target.sysId);
    else if (table && a.ctx.registry.has(table)) current = a.ctx.newRecord(table);
    if (!current) return {};
    applyFieldActions(current, a.action.str('template'), a.email);
    const script = a.action.str('script');
    if (script.trim()) {
      const scripts = optionalService<ScriptService>(a.engine.platform, SERVICES.scripts);
      if (scripts && typeof scripts.run === 'function') {
        scripts.run(a.ctx, script, {
          current,
          vars: { email: a.email, email_action: { name: a.action.str('name'), sys_id: a.action.sysId } },
        });
      } else a.log(`Script of "${a.action.str('name')}" skipped: the scripts module is not installed`);
    }
    if (current.isNew()) {
      if (!a.action.str('template').trim() && !script.trim()) return {};
      a.ctx.insert(current);
      a.log(`Created ${current.table.label} ${current.displayValue()}`);
      return { record: current };
    }
    if (current.changes().length) a.ctx.update(current);
    return { record: current };
  }

  private scriptCondition(ctx: Context, a: Rec, email: InboundEmail, target: Rec | null): boolean {
    const scripts = optionalService<ScriptService>(this.engine.platform, SERVICES.scripts);
    if (!scripts || typeof scripts.condition !== 'function') {
      this.engine.warnOnce(
        `inbound-cond:${a.sysId}`,
        `Inbound action "${a.str('name')}" has a condition script but the scripts module is not installed; it is skipped`,
      );
      return false;
    }
    try {
      return scripts.condition(
        ctx,
        `var email = ${JSON.stringify(email)};\n${a.str('condition_script')}`,
        target,
        null,
      );
    } catch {
      return false;
    }
  }

  /** Stores base64 attachments of the inbound payload on the record the email produced. */
  private attachFiles(sys: Context, raw: unknown, record: Rec, emailRec: Rec, log: string[]): void {
    if (!Array.isArray(raw) || !raw.length) return;
    const dir = this.engine.attachmentDir();
    if (!dir) {
      log.push('Attachments not stored: the attachment directory is not configured');
      return;
    }
    for (const item of raw) {
      const f = (item ?? {}) as { filename?: unknown; contentType?: unknown; content?: unknown };
      if (typeof f.content !== 'string') continue;
      try {
        const name = typeof f.filename === 'string' && f.filename ? f.filename : 'attachment';
        const att = saveAttachment(
          sys,
          dir,
          record.className,
          record.sysId,
          name,
          typeof f.contentType === 'string' ? f.contentType : '',
          Buffer.from(f.content, 'base64'),
        );
        if (sys.registry.has('sys_email_attachment')) {
          sys.insert('sys_email_attachment', {
            email: emailRec.sysId,
            attachment: att.sysId,
            file_name: att.str('file_name'),
            content_disposition: 'attachment',
            source: 'inbound',
          });
        }
      } catch (e) {
        log.push(`Attachment not stored: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/** "User, New" and "New User" both become first "New", last "User". */
function splitDisplayName(name: string): { first: string; last: string } {
  const n = name.trim();
  if (!n) return { first: '', last: '' };
  if (n.includes(',')) {
    const [last, first] = n.split(',', 2).map((s) => s.trim());
    return { first: first ?? '', last: last ?? '' };
  }
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
