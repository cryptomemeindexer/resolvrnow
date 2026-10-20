import nodemailer from 'nodemailer';
import type { Platform } from '../../engine/platform.js';

/** A fully built outbound message handed to a transport. */
export interface MailMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  /** `<id@host>` */
  messageId: string;
  headers: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  /** sys_email sys_id (for logging). */
  emailId?: string;
}

export interface SendInfo {
  messageId?: string;
  response?: string;
  accepted?: string[];
  rejected?: string[];
}

/**
 * Delivery channel for outbound email. `send` may complete synchronously (log transport)
 * or return a promise (SMTP). Failures are thrown; an error carrying a numeric
 * `responseCode` (SMTP reply code) decides between retry (4xx) and permanent failure (5xx).
 */
export interface MailTransport {
  readonly name: string;
  send(msg: MailMessage): Promise<SendInfo> | SendInfo;
  close?(): void;
}

/** Error raised by transports, shaped like nodemailer's errors. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly responseCode?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Default transport: records the email and writes one log line; nothing leaves the server. */
export class LogTransport implements MailTransport {
  readonly name = 'log';
  readonly sent: MailMessage[] = [];

  constructor(private readonly log: (line: string) => void = () => {}) {}

  send(msg: MailMessage): SendInfo {
    this.sent.push(msg);
    if (this.sent.length > 200) this.sent.splice(0, this.sent.length - 200);
    this.log(
      `[resolvrnow] email (log transport) to=${msg.to.join(', ')}${msg.cc.length ? ` cc=${msg.cc.join(', ')}` : ''} subject="${msg.subject}"`,
    );
    return {
      messageId: msg.messageId,
      response: '250 Logged by the log transport',
      accepted: [...msg.to, ...msg.cc, ...msg.bcc],
      rejected: [],
    };
  }
}

/** The part of a nodemailer transporter the SMTP transport uses (tests inject their own). */
export interface NodemailerLike {
  sendMail(mail: Record<string, unknown>): Promise<unknown>;
  close?(): void;
}

/** SMTP delivery through nodemailer. */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';

  constructor(readonly transporter: NodemailerLike) {}

  async send(msg: MailMessage): Promise<SendInfo> {
    const info = (await this.transporter.sendMail({
      from: msg.from,
      to: msg.to,
      cc: msg.cc.length ? msg.cc : undefined,
      bcc: msg.bcc.length ? msg.bcc : undefined,
      replyTo: msg.replyTo || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      messageId: msg.messageId,
      headers: msg.headers,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    })) as
      | { messageId?: unknown; response?: unknown; accepted?: unknown[]; rejected?: unknown[] }
      | undefined;
    return {
      messageId: typeof info?.messageId === 'string' ? info.messageId : msg.messageId,
      response: typeof info?.response === 'string' ? info.response : undefined,
      accepted: Array.isArray(info?.accepted) ? info.accepted.map(String) : undefined,
      rejected: Array.isArray(info?.rejected) ? info.rejected.map(String) : undefined,
    };
  }

  close(): void {
    this.transporter.close?.();
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * SMTP settings: environment variables (RESOLVRNOW_SMTP_HOST, _PORT, _USER, _PASS, _FROM,
 * _SECURE) take precedence over the `resolvr.email.smtp.*` properties.
 */
export function smtpConfig(platform: Platform, env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const prop = (name: string) => (platform.properties.get(name) ?? '').trim();
  const host = env.RESOLVRNOW_SMTP_HOST || prop('resolvr.email.smtp.host');
  const portRaw = env.RESOLVRNOW_SMTP_PORT || prop('resolvr.email.smtp.port');
  const secureRaw = (env.RESOLVRNOW_SMTP_SECURE || prop('resolvr.email.smtp.secure')).toLowerCase();
  const port = Number(portRaw) || (['true', '1', 'yes'].includes(secureRaw) ? 465 : 587);
  return {
    host,
    port,
    secure: secureRaw ? ['true', '1', 'yes'].includes(secureRaw) : port === 465,
    user: env.RESOLVRNOW_SMTP_USER || prop('resolvr.email.smtp.user'),
    pass: env.RESOLVRNOW_SMTP_PASS || prop('resolvr.email.smtp.password'),
    from: env.RESOLVRNOW_SMTP_FROM || prop('glide.email.user'),
  };
}

/** Builds an SMTP transport from configuration. */
export function createSmtpTransport(cfg: SmtpConfig): SmtpTransport {
  if (!cfg.host)
    throw new TransportError(
      'SMTP host is not configured (RESOLVRNOW_SMTP_HOST or resolvr.email.smtp.host)',
      undefined,
      'ECONFIG',
    );
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  return new SmtpTransport(transporter as unknown as NodemailerLike);
}

/** Wraps a nodemailer transport plugin (`{ name, version, send(mail, cb) }`) with real message composition. */
export function smtpTransportFromPlugin(plugin: unknown): SmtpTransport {
  const transporter = nodemailer.createTransport(plugin as Parameters<typeof nodemailer.createTransport>[0]);
  return new SmtpTransport(transporter as unknown as NodemailerLike);
}

export type FailureKind = 'retry' | 'delayed' | 'fail';

/** Classifies a delivery error: 4xx and network errors retry, address problems retry later, 5xx fail. */
export function classifyFailure(err: unknown): { kind: FailureKind; code: number | null; message: string } {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; message?: unknown };
  const code = Number(e.responseCode);
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (Number.isFinite(code) && code >= 500) return { kind: 'fail', code, message };
  if (Number.isFinite(code) && code >= 400) return { kind: 'retry', code, message };
  if (e.code === 'EENVELOPE') return { kind: 'delayed', code: null, message };
  if (e.code === 'ECONFIG') return { kind: 'fail', code: null, message };
  return { kind: 'retry', code: null, message };
}
