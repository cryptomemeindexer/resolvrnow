import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import { type MatchSubject, matches } from '../../engine/query/matcher.js';
import { type ParsedQuery, parseEncodedQuery } from '../../engine/query/parser.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import type { EventRecord } from '../../engine/services/events.js';
import { JOURNAL_TYPES, type TableMeta } from '../../engine/types.js';
import { addMs, chunk, clock, isSysId, newSysId, nowGlide } from '../../engine/util.js';
import {
  type NotificationService,
  type OutboundEmail,
  optionalService,
  type ScriptService,
  SERVICES,
} from '../contracts.js';
import { InboundProcessor } from './inbound.js';
import { NATIVE_MAIL_SCRIPTS } from './mailscripts.js';
import { type OutboxResult, OutboxSender } from './outbox.js';
import { type Exclusion, type Recipient, type RecipientResult, resolveRecipients } from './recipients.js';
import {
  type EventLike,
  type MailDraft,
  type RenderEnv,
  type RenderHost,
  type RenderOptions,
  TemplateRenderer,
} from './render.js';
import { createSmtpTransport, LogTransport, type MailTransport, smtpConfig } from './transport.js';
import {
  type Address,
  decodeEntities,
  formatAddress,
  headerLines,
  htmlToText,
  isEmail,
  oneLine,
  parseAddressList,
  randomAlnum,
  sanitizeHtml,
  textToHtml,
} from './util.js';
import { applyWatermark, createWatermark } from './watermark.js';

/** Tables written by this module; record notifications never fire for them (no mail loops). */
const OWN_TABLES = new Set([
  'sys_email',
  'sys_email_log',
  'syslog_email',
  'sys_watermark',
  'sys_email_attachment',
  'sys_email_digest_part',
  'sys_email_digest_part_user',
  'resolvr_email_preview',
]);

const APPROVAL_TABLES = new Set(['sysapproval_approver', 'sysapproval_group']);

interface NotificationDef {
  sysId: string;
  name: string;
  collection: string;
  generationType: string;
  eventName: string;
  actionInsert: boolean;
  actionUpdate: boolean;
  condition: string;
  advancedCondition: string;
  order: number;
  weight: number;
}

export interface GenerateOptions {
  event?: EventLike | null;
  /** sysevent sys_id, recorded in sys_email_log. */
  eventId?: string | null;
  /** User who triggered the notification (for "Send to event creator"). */
  actorId?: string | null;
}

export interface GenerateResult {
  emails: Rec[];
  digested: string[];
  recipients: Recipient[];
  excluded: Exclusion[];
}

export interface ComposedEmail {
  subject: string;
  html: string;
  body: string;
  text: string;
  draft: MailDraft;
  contentType: string;
}

export interface PreviewResult {
  notification: { sys_id: string; name: string };
  target: { table: string; sys_id: string; display_value: string } | null;
  subject: string;
  body: string;
  body_text: string;
  content_type: string;
  recipients: Recipient[];
  excluded: Exclusion[];
}

export interface OutboundDraft {
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  html: string;
  text: string;
  contentType?: string;
  target: Rec | null;
  notificationId?: string | null;
  eventId?: string | null;
  weight?: number;
  importance?: string;
  from?: string;
  replyTo?: string;
  actorId?: string | null;
  omitWatermark?: boolean;
  log?: { level: 'info' | 'warn' | 'error'; message: string }[];
  attachmentIds?: string[];
}

/**
 * Email notification engine: decides which notifications fire for record changes and
 * events, resolves recipients, renders content, writes `sys_email` rows (with watermarks
 * for reply threading), handles digests, and owns the outbound sender and inbound processor.
 */
export class NotificationEngine implements NotificationService, RenderHost {
  readonly renderer: TemplateRenderer;
  readonly outbox: OutboxSender;
  readonly inbound: InboundProcessor;
  private defs: NotificationDef[] | null = null;
  private injected: MailTransport | null = null;
  private logTransport: LogTransport;
  private smtp: { key: string; transport: MailTransport | null } | null = null;
  private server: { publicUrl: string | null; attachmentDir: string | null } = {
    publicUrl: null,
    attachmentDir: null,
  };
  private lastSenderRun = 0;
  private warned = new Set<string>();
  private mailboxes = new Map<string, string | null>();

  constructor(readonly platform: Platform) {
    this.renderer = new TemplateRenderer(this);
    this.outbox = new OutboxSender(this);
    this.inbound = new InboundProcessor(this);
    this.logTransport = new LogTransport((line) => platform.log.info(line));
  }

  // ------------------------------------------------------------ configuration

  /** Values only the HTTP layer knows (public URL, attachment directory). */
  configureServer(cfg: { publicUrl?: string | null; attachmentDir?: string | null }): void {
    if (cfg.publicUrl !== undefined) this.server.publicUrl = cfg.publicUrl;
    if (cfg.attachmentDir !== undefined) this.server.attachmentDir = cfg.attachmentDir;
  }

  attachmentDir(): string | null {
    return this.server.attachmentDir;
  }

  baseUrl(): string {
    const url =
      this.platform.properties.get('glide.servlet.uri') ||
      process.env.RESOLVRNOW_PUBLIC_URL ||
      this.server.publicUrl ||
      'http://localhost:8080';
    return url.replace(/\/+$/, '');
  }

  /** Address the instance sends from (and receives replies on). */
  instanceAddress(): string {
    const configured = (
      this.platform.properties.get('glide.email.user') ||
      process.env.RESOLVRNOW_SMTP_FROM ||
      ''
    ).trim();
    const parsed = configured ? parseAddressList(configured)[0] : undefined;
    return parsed?.address ?? 'resolvrnow@localhost';
  }

  /** From header: `"ResolvrNow" <address>`. */
  fromHeader(): string {
    const name = this.platform.properties.get('resolvr.email.from_name') ?? 'ResolvrNow';
    return formatAddress({ address: this.instanceAddress(), name: name.trim() });
  }

  messageDomain(): string {
    return this.instanceAddress().split('@')[1] || 'resolvrnow.local';
  }

  /** Token proving that an unsubscribe request comes from a link this instance sent. */
  instanceId(): string {
    let id = this.platform.properties.get('resolvr.instance_id') ?? '';
    if (!id || id === '(generated)') {
      id = randomAlnum(32);
      if (this.platform.registry.has('sys_properties'))
        this.platform.properties.set('resolvr.instance_id', id);
    }
    return id;
  }

  inboundSecret(): string {
    return (
      this.platform.properties.get('resolvr.email.inbound_secret') ||
      process.env.RESOLVRNOW_EMAIL_INBOUND_SECRET ||
      ''
    ).trim();
  }

  /** sys_id of a mailbox (Outbox, Sent, Failed, Skipped, Inbox, Junk, Drafts). */
  mailboxId(name: string): string | null {
    if (!this.mailboxes.has(name) || this.mailboxes.get(name) === null) {
      const row = this.platform.registry.has('sys_mailbox')
        ? this.platform.db.get<{ sys_id: string }>(
            `SELECT "sys_id" FROM "sys_mailbox" WHERE "name" = ? LIMIT 1`,
            [name],
          )
        : undefined;
      this.mailboxes.set(name, row?.sys_id ?? null);
    }
    return this.mailboxes.get(name) ?? null;
  }

  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.platform.log.warn(`[resolvrnow] ${message}`);
  }

  // ------------------------------------------------------------ transport

  /** Overrides the configured transport (tests, embedding). Pass null to restore. */
  setTransport(t: MailTransport | null): void {
    this.injected = t;
  }

  /** Transport selected by `resolvr.email.transport` (`log` default, or `smtp`); null when SMTP is not configured. */
  transport(): MailTransport | null {
    if (this.injected) return this.injected;
    const kind = (
      this.platform.properties.get('resolvr.email.transport') ||
      process.env.RESOLVRNOW_EMAIL_TRANSPORT ||
      'log'
    )
      .trim()
      .toLowerCase();
    if (kind !== 'smtp') return this.logTransport;
    const cfg = smtpConfig(this.platform);
    const key = JSON.stringify(cfg);
    if (this.smtp?.key === key) return this.smtp.transport;
    this.smtp?.transport?.close?.();
    try {
      this.smtp = { key, transport: createSmtpTransport(cfg) };
    } catch (e) {
      this.warnOnce(
        `smtp:${key}`,
        `SMTP transport unavailable, emails stay in the outbox: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.smtp = { key, transport: null };
    }
    return this.smtp.transport;
  }

  /** Delivers due emails now (duplicate suppression, transport, retries). */
  processOutbox(): Promise<OutboxResult> {
    return this.outbox.run();
  }

  /** Scheduled sender: runs at most every `resolvr.email.sender.interval_ms`. */
  runSenderJob(): void {
    const interval = this.platform.properties.getNumber('resolvr.email.sender.interval_ms', 60_000);
    const now = clock.now().getTime();
    if (now - this.lastSenderRun < interval) return;
    this.lastSenderRun = now;
    this.outbox
      .run()
      .catch((e) =>
        this.platform.log.error(`[resolvrnow] email sender: ${e instanceof Error ? e.message : String(e)}`),
      );
  }

  // ------------------------------------------------------------ notification definitions

  invalidate(): void {
    this.defs = null;
  }

  private definitions(): NotificationDef[] {
    if (this.defs) return this.defs;
    if (!this.platform.registry.has('sysevent_email_action')) return [];
    const recs = this.platform.systemContext().query('sysevent_email_action', { query: 'active=true' });
    this.defs = recs
      .map((r) => ({
        sysId: r.sysId,
        name: r.str('name'),
        collection: r.str('collection'),
        generationType: r.str('generation_type') || 'engine',
        eventName: r.str('event_name'),
        actionInsert: r.bool('action_insert'),
        actionUpdate: r.bool('action_update'),
        condition: r.str('condition'),
        advancedCondition: r.str('advanced_condition'),
        order: r.num('order') ?? 100,
        weight: r.num('weight') ?? 0,
      }))
      .sort((a, b) => a.order - b.order || b.weight - a.weight || a.name.localeCompare(b.name));
    return this.defs;
  }

  private appliesTo(def: NotificationDef, table: TableMeta | null, eventTable: string | null): boolean {
    if (!def.collection) return true;
    if (!this.platform.registry.has(def.collection)) return false;
    if (table) return table.ancestors.includes(def.collection);
    return def.collection === eventTable;
  }

  private loadNotification(ctx: Context, idOrName: string): Rec | null {
    if (!idOrName || !this.platform.registry.has('sysevent_email_action')) return null;
    const sys = ctx.elevated();
    if (isSysId(idOrName)) {
      const r = sys.loadRaw('sysevent_email_action', idOrName);
      if (r) return r;
    }
    return sys.first('sysevent_email_action', `name=${idOrName}`);
  }

  private isLoadingDemo(): boolean {
    return !!this.platform.options.demo && this.platform.properties.get('resolvr.demo.loaded') !== 'true';
  }

  // ------------------------------------------------------------ triggers

  /**
   * Record hook (after insert/update, once the after rules ran): evaluates "record inserted
   * or updated" notifications while the previous values and the journal entries of the
   * operation are known, and generates their email in the same transaction (a savepoint, so
   * a failing notification never leaves partial rows).
   */
  onRecord(op: 'insert' | 'update', rec: Rec, previous: Rec | null, ctx: Context): void {
    if (!ctx.workflow || OWN_TABLES.has(rec.table.root)) return;
    const defs = this.definitions().filter(
      (d) =>
        d.generationType === 'engine' &&
        !!d.collection &&
        (op === 'insert' ? d.actionInsert : d.actionUpdate) &&
        this.appliesTo(d, rec.table, null),
    );
    if (!defs.length || this.isLoadingDemo()) return;
    const subject = this.subjectFor(rec, previous, { insert: op === 'insert', journal: true });
    for (const d of defs) {
      if (d.condition && !matches(this.prepareCondition(d.condition, rec.table), subject, ctx.env)) continue;
      if (d.advancedCondition && !this.advancedConditionPasses(ctx, d, rec, previous, null)) continue;
      const n = this.loadNotification(ctx, d.sysId);
      if (!n) continue;
      this.platform.db.tx(() => this.generate(ctx, n, rec, { event: null, actorId: ctx.user.sysId }));
    }
  }

  /** Event handler (registered for every event): "event is fired" notifications. */
  onEvent(ev: EventRecord, rec: Rec | null, ctx: Context): void {
    const defs = this.definitions().filter(
      (d) =>
        d.generationType === 'event' &&
        d.eventName === ev.name &&
        this.appliesTo(d, rec?.table ?? null, ev.table),
    );
    if (!defs.length) return;
    const event: EventLike = {
      sys_id: ev.sys_id,
      name: ev.name,
      parm1: ev.parm1,
      parm2: ev.parm2,
      user_id: ev.user_id,
      table: ev.table,
      instance: ev.instance,
    };
    for (const d of defs) {
      if (d.condition) {
        if (!rec) continue;
        if (!matches(this.prepareCondition(d.condition, rec.table), this.subjectFor(rec, null, {}), ctx.env))
          continue;
      }
      if (d.advancedCondition && !this.advancedConditionPasses(ctx, d, rec, null, event)) continue;
      const n = this.loadNotification(ctx, d.sysId);
      if (!n) continue;
      this.platform.db.tx(() =>
        this.generate(ctx, n, rec, { event, eventId: ev.sys_id, actorId: ev.user_id }),
      );
    }
  }

  /** Whether an active "event is fired" notification on an installed table listens to `eventName`. */
  handlesEvent(eventName: string): boolean {
    return this.definitions().some(
      (d) =>
        d.generationType === 'event' &&
        d.eventName === eventName &&
        (!d.collection || this.platform.registry.has(d.collection)),
    );
  }

  /** Sends a notification on demand (flow "send notification" steps, `triggered` notifications). */
  trigger(ctx: Context, notification: string, rec: Rec | null, event?: EventLike | null): GenerateResult {
    const n = this.loadNotification(ctx, notification);
    if (!n) throw new NotFoundError('Notification not found', notification);
    return this.platform.db.tx(() =>
      this.generate(ctx, n, rec, { event: event ?? null, actorId: ctx.user.sysId }),
    );
  }

  /** Match subject aware of the insert/update context and of journal entries added by the operation. */
  private subjectFor(
    rec: Rec,
    previous: Rec | null,
    opts: { insert?: boolean; journal?: boolean },
  ): MatchSubject {
    const base = recSubject(rec, previous, this.platform.registry);
    return {
      ...base,
      isNew: opts.insert ? () => true : base.isNew,
      journal: opts.journal
        ? (path: string) =>
            path.includes('.') ? null : rec.journal.filter((j) => j.field === path).map((j) => j.value)
        : undefined,
    };
  }

  /** `<journal>VALCHANGES` means "an entry was added by this operation". */
  private prepareCondition(condition: string, table: TableMeta): ParsedQuery {
    const parsed = parseEncodedQuery(condition);
    for (const block of parsed.blocks) {
      for (const cluster of block) {
        for (const c of cluster) {
          const col = table.columns.get(c.field);
          if (col && JOURNAL_TYPES.has(col.type) && c.op === 'VALCHANGES') c.op = 'ISNOTEMPTY';
        }
      }
    }
    return parsed;
  }

  /** Advanced conditions are scripts; without the scripts module they fail closed. */
  private advancedConditionPasses(
    ctx: Context,
    def: NotificationDef,
    rec: Rec | null,
    previous: Rec | null,
    event: EventLike | null,
  ): boolean {
    const scripts = optionalService<ScriptService>(this.platform, SERVICES.scripts);
    if (!scripts || typeof scripts.condition !== 'function') {
      this.warnOnce(
        `adv:${def.sysId}`,
        `Notification "${def.name}" has an advanced condition but the scripts module is not installed; it will not send`,
      );
      return false;
    }
    try {
      const script = event
        ? `var event = ${JSON.stringify({ name: event.name, parm1: event.parm1 ?? '', parm2: event.parm2 ?? '', user_id: event.user_id ?? '' })};\n${def.advancedCondition}`
        : def.advancedCondition;
      return scripts.condition(ctx, script, rec, previous);
    } catch (e) {
      this.platform.log.warn(
        `[resolvrnow] advanced condition of "${def.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  // ------------------------------------------------------------ generation

  /** Renders subject and bodies of a notification for a record (no side effects). */
  compose(ctx: Context, n: Rec, rec: Rec | null, event: EventLike | null): ComposedEmail {
    const sys = ctx.elevated();
    const template = n.str('template') ? sys.loadRaw('sysevent_email_template', n.str('template')) : null;
    const pick = (field: string) => n.str(field) || template?.str(field) || '';
    const draft: MailDraft = { cc: [], bcc: [] };
    const base: RenderOptions = { html: false, event, notification: n, draft };
    let subject = oneLine(this.renderer.render(ctx, pick('subject'), rec, base));
    const body = this.renderer.render(ctx, pick('message_html'), rec, { ...base, html: true });
    const textSource = pick('message_text');
    const text = textSource ? this.renderer.render(ctx, textSource, rec, base).trim() : htmlToText(body);
    const html = this.wrapLayout(ctx, template, body, rec, base);
    if (draft.subject) subject = oneLine(draft.subject);
    const contentType = n.str('content_type') || 'text/html';
    return { subject: subject || n.str('name'), html, body, text, draft, contentType };
  }

  /** Wraps a body with the template's layout, or the default layout when the template has none. */
  wrapLayout(ctx: Context, template: Rec | null, body: string, rec: Rec | null, opts: RenderOptions): string {
    if (!body.trim() || !this.platform.registry.has('sys_email_layout')) return body;
    const sys = ctx.elevated();
    let layout: Rec | null = null;
    const layoutId = template?.str('email_layout') ?? '';
    if (layoutId) layout = sys.loadRaw('sys_email_layout', layoutId);
    else {
      const name = this.platform.properties.get('resolvr.email.default_layout') ?? '';
      if (name) layout = sys.first('sys_email_layout', `name=${name}`);
    }
    if (!layout) return body;
    const source =
      layout.bool('advanced') && layout.str('advanced_layout')
        ? layout.str('advanced_layout')
        : layout.str('layout');
    if (!source.trim()) return body;
    const slot = 'RESOLVRNOTIFICATIONBODYSLOT';
    const rendered = this.renderer.render(ctx, source.replace(/\$\{notification:body\}/g, slot), rec, {
      ...opts,
      html: true,
    });
    return rendered.includes(slot) ? rendered.split(slot).join(body) : `${rendered}${body}`;
  }

  /** Recipients of a notification occurrence (with the reasons for inclusion and exclusion). */
  recipientsFor(
    ctx: Context,
    n: Rec,
    rec: Rec | null,
    event: EventLike | null,
    actorId: string | null,
  ): RecipientResult {
    const list = (field: string) =>
      n
        .str(field)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const tokens: { source: string; values: string[] }[] = [];
    if (event) {
      if (n.bool('event_parm_1') && event.parm1)
        tokens.push({ source: 'Event parm1', values: event.parm1.split(',') });
      if (n.bool('event_parm_2') && event.parm2)
        tokens.push({ source: 'Event parm2', values: event.parm2.split(',') });
    }
    const collection = n.str('collection');
    return resolveRecipients(
      ctx,
      {
        users: list('recipient_users'),
        groups: list('recipient_groups'),
        fields: list('recipient_fields'),
        tokens,
        notificationId: n.sysId,
        subscribable: n.bool('subscribable'),
        sendSelf: n.get('send_self') === null ? true : n.bool('send_self'),
        actorId,
        excludeDelegates: n.bool('exclude_delegates'),
        mandatory: n.bool('mandatory'),
        forceDelivery: n.bool('force_delivery'),
        isApproval:
          APPROVAL_TABLES.has(collection) ||
          (!!rec && rec.table.ancestors.some((t) => APPROVAL_TABLES.has(t))),
        instanceAddresses: [this.instanceAddress()],
      },
      rec,
    );
  }

  /** Generates the emails (and digest parts) of one notification occurrence. */
  generate(ctx: Context, n: Rec, rec: Rec | null, opts: GenerateOptions = {}): GenerateResult {
    const event = opts.event ?? null;
    const actorId = opts.actorId ?? null;
    const rr = this.recipientsFor(ctx, n, rec, event, actorId);
    const result: GenerateResult = {
      emails: [],
      digested: [],
      recipients: rr.included,
      excluded: rr.excluded,
    };
    if (!rr.included.length) return result;
    const composed = this.compose(ctx, n, rec, event);

    let direct = rr.included;
    if (n.bool('digestable')) {
      const digestUsers = this.digestRecipients(n, rr.included);
      if (digestUsers.length) {
        this.collectDigest(ctx, n, rec, event, composed, digestUsers);
        result.digested = digestUsers.map((r) => r.userId!);
        const set = new Set(result.digested);
        direct = rr.included.filter((r) => !r.userId || !set.has(r.userId));
      }
    }
    if (!direct.length) return result;

    const props = this.platform.properties;
    const includeLog = props.getBool('glide.notification.recipient.include_logging', true);
    const excludeLog = props.getBool('glide.notification.recipient.exclude_logging', true);
    const max = Math.max(1, props.getNumber('glide.email.smtp.max_recipients', 100));
    const attachmentIds = n.bool('include_attachments') && rec ? this.recordAttachments(rec) : [];
    const groups = chunk(direct, max);
    groups.forEach((group, i) => {
      const log: OutboundDraft['log'] = [];
      log.push({
        level: 'info',
        message: `Generated by notification "${n.str('name')}"${event ? ` for event ${event.name}` : ''}`,
      });
      if (includeLog)
        for (const r of group)
          log.push({
            level: 'info',
            message: `Included ${r.name ? `${r.name} <${r.address}>` : r.address}: ${r.reason}`,
          });
      if (excludeLog && i === 0)
        for (const x of rr.excluded) log.push({ level: 'info', message: `Excluded ${x.who}: ${x.reason}` });
      const email = this.createOutbound(ctx, {
        to: group.map((r) => ({ address: r.address, name: r.name })),
        cc: composed.draft.cc,
        bcc: composed.draft.bcc,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        contentType: composed.contentType,
        target: rec,
        notificationId: n.sysId,
        eventId: opts.eventId ?? null,
        weight: n.num('weight') ?? 0,
        importance: n.str('importance'),
        from: composed.draft.from || n.str('from') || undefined,
        replyTo: composed.draft.replyTo || n.str('reply_to') || undefined,
        actorId,
        omitWatermark: n.bool('omit_watermark'),
        log,
        attachmentIds,
      });
      result.emails.push(email);
    });
    return result;
  }

  private recordAttachments(rec: Rec): string[] {
    if (!this.platform.registry.has('sys_attachment')) return [];
    return this.platform.db
      .all<{ sys_id: string }>(
        `SELECT "sys_id" FROM "sys_attachment" WHERE "table_sys_id" = ? ORDER BY "sys_created_on", rowid`,
        [rec.sysId],
      )
      .map((r) => r.sys_id);
  }

  /** Writes a send-ready sys_email (with watermark, email log and recipient explanation). */
  createOutbound(ctx: Context, d: OutboundDraft): Rec {
    const sys = ctx.elevated();
    const id = newSysId();
    const label =
      d.target && !d.omitWatermark && this.platform.registry.has('sys_watermark')
        ? createWatermark(sys, d.target, id)
        : null;
    const visible = this.platform.properties.getBool('glide.email.watermark.visible', true);
    const contentType = d.contentType || 'text/html';
    const marked = applyWatermark(d.html, d.text, label, visible);
    const headers: Record<string, string> = { 'Auto-Submitted': 'auto-generated' };
    if (d.from) headers.From = d.from;
    if (label) headers['X-ResolvrNow-Watermark'] = `Ref:${label}`;
    const seen = new Set<string>();
    const unique = (list: Address[] | undefined) =>
      (list ?? [])
        .map((a) => a.address.trim())
        .filter((a) => {
          const key = a.toLowerCase();
          if (!a || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    const to = unique(d.to);
    const cc = unique(d.cc);
    const bcc = unique(d.bcc);
    const actor = d.actorId
      ? this.platform.db.get<{ user_name: string }>(`SELECT "user_name" FROM "sys_user" WHERE "sys_id" = ?`, [
          d.actorId,
        ])
      : undefined;
    const email = sys.insert('sys_email', {
      sys_id: id,
      type: 'send-ready',
      state: 'ready',
      mailbox: this.mailboxId('Outbox'),
      notification_type: 'SMTP',
      target_table: d.target?.className ?? null,
      instance: d.target?.sysId ?? null,
      subject: oneLine(d.subject) || '(no subject)',
      body: contentType === 'text/plain' ? textToHtml(marked.text) : marked.html,
      body_text: marked.text,
      content_type: contentType,
      recipients: to.join(', '),
      direct: to.join(', '),
      copied: cc.join(', '),
      blind_copied: bcc.join(', '),
      reply_to: d.replyTo ?? null,
      importance: d.importance || null,
      weight: d.weight ?? 0,
      user_id: d.actorId && actor ? d.actorId : null,
      user: actor?.user_name ?? null,
      message_id: `<${id}.${randomAlnum(10).toLowerCase()}@${this.messageDomain()}>`,
      headers: headerLines(headers),
      resolvr_attempts: 0,
    });
    if ((d.notificationId || d.eventId) && this.platform.registry.has('sys_email_log')) {
      sys.insert('sys_email_log', {
        email: id,
        notification: d.notificationId ?? null,
        event: d.eventId ?? null,
      });
    }
    for (const entry of d.log ?? []) this.logEmail(sys, id, entry.level, entry.message);
    if (d.attachmentIds?.length && this.platform.registry.has('sys_email_attachment')) {
      for (const attId of d.attachmentIds) {
        const att = sys.loadRaw('sys_attachment', attId);
        if (!att) continue;
        sys.insert('sys_email_attachment', {
          email: id,
          attachment: attId,
          file_name: att.str('file_name'),
          content_disposition: 'attachment',
          source: 'notification',
        });
      }
    }
    return email;
  }

  logEmail(ctx: Context, emailId: string, level: 'info' | 'warn' | 'error', message: string): void {
    if (!this.platform.registry.has('syslog_email')) return;
    ctx.elevated().insert('syslog_email', { email: emailId, level, message: message.slice(0, 4000) });
  }

  // ------------------------------------------------------------ digests

  private digestRecipients(n: Rec, included: Recipient[]): Recipient[] {
    const out: Recipient[] = [];
    const hasPrefs = this.platform.registry.has('cmn_notif_message');
    for (const r of included) {
      if (!r.userId) continue;
      const pref = hasPrefs
        ? this.platform.db.get<{ digest: number | null }>(
            `SELECT "digest" FROM "cmn_notif_message" WHERE "user" = ? AND "notification" = ? LIMIT 1`,
            [r.userId, n.sysId],
          )
        : undefined;
      const wants = pref && pref.digest !== null ? pref.digest === 1 : n.bool('default_digest');
      if (wants) out.push(r);
    }
    return out;
  }

  private intervalMs(ctx: Context, n: Rec, userId: string): number {
    const sys = ctx.elevated();
    const pref = this.platform.registry.has('cmn_notif_message')
      ? this.platform.db.get<{ digest_interval: string | null }>(
          `SELECT "digest_interval" FROM "cmn_notif_message" WHERE "user" = ? AND "notification" = ? LIMIT 1`,
          [userId, n.sysId],
        )
      : undefined;
    for (const id of [pref?.digest_interval, n.str('default_interval')]) {
      if (!id) continue;
      const iv = sys.loadRaw('sys_email_digest_interval', id);
      const ms = iv?.num('interval');
      if (ms && ms > 0) return ms;
    }
    return 3_600_000;
  }

  private collectDigest(
    ctx: Context,
    n: Rec,
    rec: Rec | null,
    event: EventLike | null,
    composed: ComposedEmail,
    users: Recipient[],
  ): void {
    const sys = ctx.elevated();
    const digestTemplate = n.str('digest_template')
      ? sys.loadRaw('sysevent_email_template', n.str('digest_template'))
      : null;
    const base: RenderOptions = { html: false, event, notification: n };
    const htmlSource = n.str('digest_html') || digestTemplate?.str('message_html') || '';
    const textSource = n.str('digest_text') || digestTemplate?.str('message_text') || '';
    const html = htmlSource
      ? this.renderer.render(ctx, htmlSource, rec, { ...base, html: true })
      : composed.body;
    const text = textSource ? this.renderer.render(ctx, textSource, rec, base) : htmlToText(html);
    const part = sys.insert('sys_email_digest_part', {
      notification: n.sysId,
      target_table: rec?.className ?? null,
      instance: rec?.sysId ?? null,
      subject: composed.subject,
      body: html,
      body_text: text,
    });
    const single = (n.str('digest_type') || 'single') === 'single';
    for (const u of users) {
      const key = `${n.sysId}:${u.userId}:${single ? (rec?.sysId ?? '*') : '*'}`;
      const open = this.platform.db.get<{ send_after: string | null }>(
        `SELECT MIN("send_after") AS "send_after" FROM "sys_email_digest_part_user" WHERE "digest_key" = ? AND ("sent" IS NULL OR "sent" = 0)`,
        [key],
      );
      const sendAfter = open?.send_after || addMs(nowGlide(), this.intervalMs(ctx, n, u.userId!));
      sys.insert('sys_email_digest_part_user', {
        digest_part: part.sysId,
        user: u.userId,
        digest_key: key,
        send_after: sendAfter,
        sent: false,
      });
    }
  }

  /** Sends digests whose interval elapsed; returns the number of digest emails created. */
  processDigests(ctx: Context = this.platform.systemContext()): number {
    if (!this.platform.registry.has('sys_email_digest_part_user')) return 0;
    const sys = ctx.elevated();
    const keys = this.platform.db.all<{ digest_key: string }>(
      `SELECT DISTINCT "digest_key" FROM "sys_email_digest_part_user" WHERE ("sent" IS NULL OR "sent" = 0) AND "send_after" <= ?`,
      [nowGlide()],
    );
    let created = 0;
    for (const { digest_key: key } of keys) {
      this.platform.db.tx(() => {
        const rows = sys.query('sys_email_digest_part_user', {
          query: `digest_key=${key}^sent=false`,
          orderBy: [{ field: 'sys_created_on', desc: false }],
        });
        if (!rows.length) return;
        const parts = rows
          .map((r) => sys.loadRaw('sys_email_digest_part', r.str('digest_part')))
          .filter((p): p is Rec => !!p);
        const markSent = () => {
          for (const r of rows) sys.update(r, { sent: true });
        };
        const n = parts.length ? sys.loadRaw('sysevent_email_action', parts[0].str('notification')) : null;
        const userId = rows[0].str('user');
        const user = sys.loadRaw('sys_user', userId);
        const address = this.userAddress(userId);
        if (!n || !user?.bool('active') || !address) {
          markSent();
          return;
        }
        const single = (n.str('digest_type') || 'single') === 'single';
        const target =
          single && parts[0].str('target_table') && parts[0].str('instance')
            ? sys.loadRaw(parts[0].str('target_table'), parts[0].str('instance'))
            : null;
        const sepHtml = n.str('digest_separator_html') || '<br><hr><br>';
        const sepText = (
          n.str('digest_separator_text') || '\n----------------------------------------\n'
        ).replace(/\\n/g, '\n');
        const body = parts.map((p) => p.str('body')).join(sepHtml);
        const text = parts.map((p) => p.str('body_text')).join(sepText);
        const digestTemplate = n.str('digest_template')
          ? sys.loadRaw('sysevent_email_template', n.str('digest_template'))
          : null;
        const subjectSource =
          n.str('digest_subject') ||
          digestTemplate?.str('subject') ||
          `${n.str('name')}: ${parts.length} update${parts.length === 1 ? '' : 's'}`;
        const subject = oneLine(
          this.renderer.render(ctx, subjectSource, target, { html: false, notification: n }),
        );
        const html = this.wrapLayout(ctx, digestTemplate, body, target, { html: true, notification: n });
        this.createOutbound(ctx, {
          to: [{ address, name: user.str('name') }],
          subject,
          html,
          text,
          contentType: n.str('content_type') || 'text/html',
          target,
          notificationId: n.sysId,
          from: n.str('digest_from') || undefined,
          replyTo: n.str('digest_reply_to') || undefined,
          omitWatermark: !single || n.bool('omit_watermark'),
          log: [{ level: 'info', message: `Digest of ${parts.length} occurrence(s) of "${n.str('name')}"` }],
        });
        markSent();
        created++;
      });
    }
    return created;
  }

  /** Primary email device address, else sys_user.email. */
  userAddress(userId: string): string | null {
    const db = this.platform.db;
    if (this.platform.registry.has('cmn_notif_device')) {
      const d = db.get<{ email_address: string | null }>(
        `SELECT "email_address" FROM "cmn_notif_device" WHERE "user" = ? AND "type" = 'Email' AND "primary_email" = 1 AND ("active" IS NULL OR "active" = 1) ORDER BY "order", rowid LIMIT 1`,
        [userId],
      );
      if (d?.email_address && isEmail(d.email_address)) return d.email_address.trim();
    }
    const u = db.get<{ email: string | null }>(`SELECT "email" FROM "sys_user" WHERE "sys_id" = ?`, [userId]);
    return u?.email && isEmail(u.email) ? u.email.trim() : null;
  }

  // ------------------------------------------------------------ preview

  /** Renders a notification against a record without creating any email. */
  preview(
    ctx: Context,
    notification: string,
    record: string,
    event?: Partial<EventLike> | null,
  ): PreviewResult {
    const n = this.loadNotification(ctx, notification);
    if (!n) throw new NotFoundError('Notification not found', notification);
    const collection = n.str('collection');
    let rec: Rec | null = null;
    const ref = record.trim();
    if (ref) {
      if (!collection || !this.platform.registry.has(collection))
        throw new InvalidError(`The notification table ${collection || '(none)'} is not installed`);
      const sys = ctx.elevated();
      rec = isSysId(ref) ? sys.get(collection, ref) : null;
      if (!rec && sys.registry.table(collection).columns.has('number'))
        rec = sys.first(collection, `number=${ref.toUpperCase()}`);
      if (!rec) throw new NotFoundError('Record not found', `No ${collection} record matches ${ref}`);
    }
    const ev: EventLike | null = event
      ? {
          name: event.name ?? n.str('event_name'),
          parm1: event.parm1 ?? null,
          parm2: event.parm2 ?? null,
          user_id: ctx.user.sysId,
        }
      : null;
    const composed = this.compose(ctx, n, rec, ev);
    const rr = this.recipientsFor(ctx, n, rec, ev, ctx.user.sysId);
    const visible = this.platform.properties.getBool('glide.email.watermark.visible', true);
    const sample = rec && !n.bool('omit_watermark') ? 'MSG0000000_previewpreviewpreview' : null;
    const marked = applyWatermark(composed.html, composed.text, sample, visible);
    return {
      notification: { sys_id: n.sysId, name: n.str('name') },
      target: rec ? { table: rec.className, sys_id: rec.sysId, display_value: rec.displayValue() } : null,
      subject: composed.subject,
      body: composed.contentType === 'text/plain' ? textToHtml(marked.text) : marked.html,
      body_text: marked.text,
      content_type: composed.contentType,
      recipients: rr.included,
      excluded: rr.excluded,
    };
  }

  // ------------------------------------------------------------ NotificationService contract

  /**
   * Queues an ad-hoc email (recipients: user or group sys_ids, user names, addresses).
   * `notification` may name a notification record (used for weight and watermark options).
   * When it instead names an event that an active "event is fired" notification handles,
   * the email is not queued: the configurable notification replaces the built-in email
   * (returns null), so modules that both raise an event and send mail never double up.
   */
  send(ctx: Context, email: OutboundEmail): Rec | null {
    const n = email.notification ? this.loadNotification(ctx, email.notification) : null;
    if (email.notification && !n && this.handlesEvent(email.notification)) return null;
    const instance = [this.instanceAddress()];
    const to = resolveRecipients(
      ctx,
      { users: email.to, applyPreferences: false, instanceAddresses: instance },
      null,
    ).included;
    const cc = resolveRecipients(
      ctx,
      { users: email.cc ?? [], applyPreferences: false, instanceAddresses: instance },
      null,
    ).included.filter((c) => !to.some((t) => t.address.toLowerCase() === c.address.toLowerCase()));
    if (!to.length && !cc.length) return null;
    const target = email.target ?? null;
    const isDocument = /<html[\s>]/i.test(email.body);
    const html = isDocument
      ? email.body
      : this.wrapLayout(ctx, null, email.body, target, { html: true, notification: n });
    return this.platform.db.tx(() =>
      this.createOutbound(ctx, {
        to: to.length ? to.map((r) => ({ address: r.address, name: r.name })) : [],
        cc: cc.map((r) => ({ address: r.address, name: r.name })),
        subject: oneLine(decodeEntities(email.subject)),
        html,
        text: htmlToText(email.body),
        target,
        notificationId: n?.sysId ?? null,
        weight: n?.num('weight') ?? 0,
        actorId: ctx.user.sysId,
        omitWatermark: n?.bool('omit_watermark') ?? false,
      }),
    );
  }

  /** Expands a template against a record for HTML output (values are escaped). */
  render(ctx: Context, template: string, rec: Rec | null, extra?: Record<string, string>): string {
    return this.renderer.render(ctx, template, rec, { html: true, extra });
  }

  /** Plain-text variant of `render` (subjects, text bodies). */
  renderText(ctx: Context, template: string, rec: Rec | null, extra?: Record<string, string>): string {
    return this.renderer.render(ctx, template, rec, { html: false, extra });
  }

  // ------------------------------------------------------------ mail scripts

  runMailScript(name: string, env: RenderEnv): string | null {
    const native = NATIVE_MAIL_SCRIPTS[name];
    if (native) return native.run(env);
    if (!this.platform.registry.has('sys_script_email')) return null;
    const row = env.ctx.elevated().first('sys_script_email', `name=${name}`);
    if (!row) return null;
    if (row.bool('resolvr_native')) return '';
    let out = this.runCustomScript(row.str('script'), env);
    if (row.bool('new_lines_to_html') && env.opts.html) out = out.replace(/\r?\n/g, '<br>');
    return env.opts.html ? sanitizeHtml(out) : out;
  }

  runInlineScript(code: string, env: RenderEnv): string {
    const out = this.runCustomScript(code, env);
    return env.opts.html ? sanitizeHtml(out) : out;
  }

  /**
   * Runs an admin-authored mail script in the scripts sandbox. The script gets `current`,
   * `template.print()`, `email.addAddress()`, `email.setFrom()`, `email.setReplyTo()`,
   * `email.setSubject()`, `email_action` and `event`; printed output is inserted.
   */
  private runCustomScript(code: string, env: RenderEnv): string {
    const scripts = optionalService<ScriptService>(this.platform, SERVICES.scripts);
    if (!scripts || typeof scripts.run !== 'function') {
      this.warnOnce('mailscript', 'Custom mail scripts need the scripts module; they render empty');
      return '';
    }
    const n = env.opts.notification;
    const ev = env.opts.event;
    const wrapped = `(function () {
var __out = [];
var template = { print: function (s) { __out.push(String(s)); }, space: function (n) { for (var i = 0; i < (n || 1); i++) { __out.push('&nbsp;'); } } };
var email = { __cc: [], __bcc: [], __from: null, __replyTo: null, __subject: null,
  addAddress: function (type, address, name) { var list = String(type).toLowerCase() === 'bcc' ? this.__bcc : this.__cc; list.push({ address: String(address), name: name ? String(name) : '' }); },
  setFrom: function (v) { this.__from = String(v); }, setReplyTo: function (v) { this.__replyTo = String(v); }, setSubject: function (v) { this.__subject = String(v); } };
var email_action = ${JSON.stringify(n ? { sys_id: n.sysId, name: n.str('name'), collection: n.str('collection') } : {})};
var event = ${JSON.stringify(ev ? { name: ev.name, parm1: ev.parm1 ?? '', parm2: ev.parm2 ?? '', user_id: ev.user_id ?? '' } : {})};
var __ret = (function () {
${code}
})();
if (__ret !== undefined && __ret !== null) { __out.push(String(__ret)); }
return JSON.stringify({ out: __out.join(''), cc: email.__cc, bcc: email.__bcc, from: email.__from, replyTo: email.__replyTo, subject: email.__subject });
})()`;
    try {
      const result = scripts.run(env.ctx, wrapped, { current: env.rec });
      if (typeof result !== 'string') return result === undefined || result === null ? '' : String(result);
      try {
        const parsed = JSON.parse(result) as {
          out?: string;
          cc?: { address: string; name: string }[];
          bcc?: { address: string; name: string }[];
          from?: string | null;
          replyTo?: string | null;
          subject?: string | null;
        };
        const draft = env.opts.draft;
        if (draft) {
          for (const a of parsed.cc ?? [])
            if (isEmail(a.address)) draft.cc.push({ address: a.address, name: a.name ?? '' });
          for (const a of parsed.bcc ?? [])
            if (isEmail(a.address)) draft.bcc.push({ address: a.address, name: a.name ?? '' });
          if (parsed.from) draft.from = parsed.from;
          if (parsed.replyTo) draft.replyTo = parsed.replyTo;
          if (parsed.subject) draft.subject = parsed.subject;
        }
        return parsed.out ?? '';
      } catch {
        return result;
      }
    } catch (e) {
      this.platform.log.warn(
        `[resolvrnow] mail script failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return '';
    }
  }

  // ------------------------------------------------------------ users, devices, access

  /** Keeps a primary email device in sync with sys_user.email. */
  syncPrimaryDevice(rec: Rec, previous: Rec | null, ctx: Context): void {
    if (!this.platform.registry.has('cmn_notif_device')) return;
    if (previous && !rec.changed('email')) return;
    const email = rec.str('email').trim();
    const sys = ctx.elevated();
    const existing = sys.first('cmn_notif_device', `user=${rec.sysId}^type=Email^primary_email=true`);
    if (existing) {
      if (existing.str('email_address') !== email) sys.update(existing, { email_address: email });
      return;
    }
    if (!email) return;
    sys.insert('cmn_notif_device', {
      user: rec.sysId,
      name: 'Primary email',
      type: 'Email',
      email_address: email,
      primary_email: true,
      active: true,
      order: 10,
    });
  }

  /** Email access restrictions: emails produced by a restricted notification are readable only by matching users. */
  canReadEmail(ctx: Context, email: Rec | null): boolean {
    if (
      !email ||
      !this.platform.registry.has('email_access_restriction') ||
      !this.platform.registry.has('sys_email_log')
    )
      return true;
    const rows = this.platform.db.all<{ conditions: string | null }>(
      `SELECT r."conditions" AS "conditions" FROM "sys_email_log" l JOIN "email_access_restriction" r ON r."notification" = l."notification" WHERE l."email" = ?`,
      [email.sysId],
    );
    if (!rows.length) return true;
    const user = ctx.user.sysId ? ctx.elevated().loadRaw('sys_user', ctx.user.sysId) : null;
    if (!user) return false;
    return rows.every(
      (r) => !r.conditions || matches(r.conditions, recSubject(user, null, this.platform.registry), ctx.env),
    );
  }
}
