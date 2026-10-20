import { readAttachment } from '../../api/now/attachment.js';
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { addMs, diffMs, nowGlide } from '../../engine/util.js';
import type { NotificationEngine } from './engine.js';
import { classifyFailure, type MailMessage, type SendInfo } from './transport.js';
import { addressColumn, parseHeaderLines } from './util.js';
import { stripWatermarks } from './watermark.js';

export interface OutboxResult {
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
}

/** Minutes to wait after the nth consecutive temporary failure (the last value repeats). */
export const RETRY_BACKOFF_MINUTES = [1, 5, 10, 20, 40, 60, 120, 120];
/** Minutes between attempts after an address validation failure. */
export const RETRY_DELAYED_MINUTES = 30;

const OUTBOUND_TYPES = ['send-ready', 'send-retry-backoff', 'send-retry-delayed'];

interface PendingRow {
  sys_id: string;
  target_table: string | null;
  instance: string | null;
  recipients: string | null;
  subject: string | null;
  body: string | null;
  body_text: string | null;
  weight: number | null;
}

/**
 * Outbound sender: suppresses duplicate notifications by weight, hands each due email to
 * the transport and records the outcome (sent, retry with backoff, failed).
 */
export class OutboxSender {
  private running: Promise<OutboxResult> | null = null;

  constructor(private readonly engine: NotificationEngine) {}

  /** One sender pass; concurrent calls share the pass in progress. */
  run(): Promise<OutboxResult> {
    if (this.running) return this.running;
    const pass = this.process().finally(() => {
      if (this.running === pass) this.running = null;
    });
    this.running = pass;
    return pass;
  }

  private async process(): Promise<OutboxResult> {
    const result: OutboxResult = { sent: 0, failed: 0, retried: 0, skipped: 0 };
    const platform = this.engine.platform;
    if (!platform.registry.has('sys_email')) return result;
    if (!platform.properties.getBool('glide.email.smtp.active', true)) return result;
    const transport = this.engine.transport();
    if (!transport) return result;
    const ctx = platform.systemContext();
    result.skipped = this.suppressDuplicates(ctx);
    const due = platform.db.all<{ sys_id: string }>(
      `SELECT "sys_id" FROM "sys_email" WHERE "state" = 'ready' AND ("type" = 'send-ready' OR ("type" IN ('send-retry-backoff','send-retry-delayed') AND ("resolvr_next_attempt" IS NULL OR "resolvr_next_attempt" <= ?))) ORDER BY "sys_created_on", rowid LIMIT 200`,
      [nowGlide()],
    );
    for (const { sys_id } of due) {
      const email = ctx.get('sys_email', sys_id);
      if (!email) continue;
      if (email.str('state') !== 'ready' || !OUTBOUND_TYPES.includes(email.str('type'))) continue;
      const msg = this.buildMessage(ctx, email);
      if (!msg.to.length && !msg.cc.length && !msg.bcc.length) {
        this.finish(ctx, sys_id, {
          type: 'send-ignored',
          state: 'ignored',
          mailbox: 'Skipped',
          error: 'No valid recipient address',
        });
        result.skipped++;
        continue;
      }
      try {
        const info = await transport.send(msg);
        this.markSent(ctx, sys_id, transport.name, info);
        result.sent++;
      } catch (e) {
        if (this.markFailed(ctx, sys_id, e) === 'failed') result.failed++;
        else result.retried++;
      }
    }
    return result;
  }

  /**
   * Among ready emails for the same record and the same recipients, keeps only the highest
   * weight (weight 0 always sends) and drops emails whose subject and body (ignoring the
   * watermark) repeat an email already kept.
   */
  suppressDuplicates(ctx: Context): number {
    const rows = this.engine.platform.db.all<PendingRow>(
      `SELECT "sys_id","target_table","instance","recipients","subject","body","body_text","weight" FROM "sys_email" WHERE "type" = 'send-ready' AND "state" = 'ready' AND "instance" IS NOT NULL AND "instance" <> '' ORDER BY "sys_created_on", rowid`,
    );
    const groups = new Map<string, PendingRow[]>();
    for (const r of rows) {
      const recipients = addressColumn(r.recipients ?? '')
        .map((a) => a.toLowerCase())
        .sort()
        .join(',');
      if (!recipients) continue;
      const key = `${r.target_table}|${r.instance}|${recipients}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    let skipped = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const skip = new Map<string, string>();
      const weighted = group.filter((e) => (e.weight ?? 0) > 0);
      if (weighted.length) {
        const max = Math.max(...weighted.map((e) => e.weight ?? 0));
        const keeper = weighted.find((e) => (e.weight ?? 0) === max)!;
        for (const e of weighted) if ((e.weight ?? 0) < max) skip.set(e.sys_id, keeper.sys_id);
      }
      const seen = new Map<string, string>();
      for (const e of group) {
        if (skip.has(e.sys_id)) continue;
        const content = comparableContent(e);
        const first = seen.get(content);
        if (first) skip.set(e.sys_id, first);
        else seen.set(content, e.sys_id);
      }
      for (const [id, keeper] of skip) {
        this.finish(ctx, id, {
          type: 'send-ignored',
          state: 'ignored',
          mailbox: 'Skipped',
          error: `Duplicate of ${keeper}`,
        });
        skipped++;
      }
    }
    return skipped;
  }

  /** Builds the transport message from a sys_email row. */
  buildMessage(ctx: Context, email: Rec): MailMessage {
    const engine = this.engine;
    const headers = parseHeaderLines(email.str('headers'));
    const contentType = email.str('content_type') || 'text/html';
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (
        k === 'from' ||
        k === 'reply-to' ||
        k === 'to' ||
        k === 'cc' ||
        k === 'bcc' ||
        k === 'subject' ||
        k === 'message-id'
      )
        continue;
      extra[canonicalHeader(k)] = v;
    }
    const importance = email.str('importance');
    if (importance === 'high') Object.assign(extra, { Importance: 'high', 'X-Priority': '1' });
    else if (importance === 'low') Object.assign(extra, { Importance: 'low', 'X-Priority': '5' });
    const to = addressColumn(email.str('direct') || email.str('recipients'));
    const msg: MailMessage = {
      from: headers.from || engine.fromHeader(),
      to,
      cc: addressColumn(email.str('copied')),
      bcc: addressColumn(email.str('blind_copied')),
      replyTo: email.str('reply_to') || undefined,
      subject: email.str('subject'),
      html: contentType === 'text/plain' ? undefined : email.str('body'),
      text: contentType === 'text/html' ? undefined : email.str('body_text'),
      messageId: email.str('message_id') || `<${email.sysId}@${engine.messageDomain()}>`,
      headers: extra,
      emailId: email.sysId,
    };
    const attachments = this.attachments(ctx, email);
    if (attachments.length) msg.attachments = attachments;
    return msg;
  }

  private attachments(ctx: Context, email: Rec): NonNullable<MailMessage['attachments']> {
    const platform = this.engine.platform;
    if (!platform.registry.has('sys_email_attachment')) return [];
    const links = platform.db.all<{ attachment: string | null; file_name: string | null }>(
      `SELECT "attachment","file_name" FROM "sys_email_attachment" WHERE "email" = ? AND "attachment" IS NOT NULL`,
      [email.sysId],
    );
    if (!links.length) return [];
    const dir = this.engine.attachmentDir();
    if (!dir) {
      this.engine.logEmail(
        ctx,
        email.sysId,
        'warn',
        'Attachments skipped: the attachment directory is not known to the sender',
      );
      return [];
    }
    const out: NonNullable<MailMessage['attachments']> = [];
    for (const l of links) {
      const att = ctx.elevated().loadRaw('sys_attachment', l.attachment!);
      if (!att) continue;
      try {
        out.push({
          filename: l.file_name || att.str('file_name'),
          content: readAttachment(dir, att),
          contentType: att.str('content_type') || undefined,
        });
      } catch (e) {
        this.engine.logEmail(
          ctx,
          email.sysId,
          'warn',
          `Attachment ${att.str('file_name')} could not be read: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  }

  private markSent(ctx: Context, id: string, transport: string, info: SendInfo): void {
    const email = ctx.get('sys_email', id);
    if (!email) return;
    ctx.update(email, {
      type: 'sent',
      state: 'processed',
      mailbox: this.engine.mailboxId('Sent'),
      error_string: '',
      status: `Sent with the ${transport} transport${info.response ? `: ${info.response}` : ''}`.slice(
        0,
        1000,
      ),
      resolvr_attempts: (email.num('resolvr_attempts') ?? 0) + 1,
      resolvr_next_attempt: null,
    });
    this.engine.logEmail(
      ctx,
      id,
      'info',
      `Delivered with the ${transport} transport${info.response ? ` (${info.response})` : ''}`,
    );
  }

  /** Records a failed attempt; returns whether the email is now permanently failed. */
  private markFailed(ctx: Context, id: string, err: unknown): 'failed' | 'retry' {
    const email = ctx.get('sys_email', id);
    if (!email) return 'failed';
    const { kind, code, message } = classifyFailure(err);
    const attempts = (email.num('resolvr_attempts') ?? 0) + 1;
    const detail = `${code ? `${code} ` : ''}${message}`.slice(0, 1000);
    const lookbackHrs = this.engine.platform.properties.getNumber('glide.email.smtp.claim.lookback.hrs', 24);
    const now = nowGlide();
    const created = email.str('sys_created_on') || now;
    const expired = diffMs(now, created) >= lookbackHrs * 3_600_000;
    if (kind === 'fail' || expired) {
      ctx.update(email, {
        type: 'send-failed',
        state: 'error',
        mailbox: this.engine.mailboxId('Failed'),
        error_string: expired && kind !== 'fail' ? `Retry window elapsed: ${detail}`.slice(0, 1000) : detail,
        resolvr_attempts: attempts,
        resolvr_next_attempt: null,
      });
      this.engine.logEmail(ctx, id, 'error', `Delivery attempt ${attempts} failed permanently: ${detail}`);
      return 'failed';
    }
    const minutes =
      kind === 'delayed'
        ? RETRY_DELAYED_MINUTES
        : RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length) - 1];
    const next = addMs(now, minutes * 60_000);
    ctx.update(email, {
      type: kind === 'delayed' ? 'send-retry-delayed' : 'send-retry-backoff',
      state: 'ready',
      mailbox: this.engine.mailboxId('Outbox'),
      error_string: detail,
      resolvr_attempts: attempts,
      resolvr_next_attempt: next,
    });
    this.engine.logEmail(
      ctx,
      id,
      'warn',
      `Delivery attempt ${attempts} failed (${detail}); next attempt after ${next}`,
    );
    return 'retry';
  }

  private finish(
    ctx: Context,
    id: string,
    outcome: { type: string; state: string; mailbox: string; error: string },
  ): void {
    const email = ctx.get('sys_email', id);
    if (!email) return;
    ctx.update(email, {
      type: outcome.type,
      state: outcome.state,
      mailbox: this.engine.mailboxId(outcome.mailbox),
      error_string: outcome.error,
    });
    this.engine.logEmail(ctx, id, 'info', `Not sent: ${outcome.error}`);
  }
}

/**
 * Subject and body used to recognise identical emails: watermarks are removed and sys_ids
 * masked, so notification-specific links (preferences, unsubscribe) do not make otherwise
 * identical content look different.
 */
function comparableContent(e: PendingRow): string {
  const body = stripWatermarks(e.body || e.body_text || '').replace(/[0-9a-f]{32}/g, '#');
  return `${e.subject ?? ''}\n${body}`;
}

function canonicalHeader(name: string): string {
  return name
    .split('-')
    .map((p) => (p.toLowerCase() === 'resolvrnow' ? 'ResolvrNow' : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('-');
}
