import type { Rec } from '../../engine/record.js';
import type { RenderEnv } from './render.js';
import { escapeHtml } from './util.js';
import { WATERMARK_MARKER, WATERMARK_PLACEHOLDER } from './watermark.js';

export interface NativeMailScript {
  description: string;
  run(env: RenderEnv): string;
}

const SUMMARY_FIELDS = [
  'number',
  'short_description',
  'sysapproval',
  'document_id',
  'task',
  'cat_item',
  'state',
  'stage',
  'priority',
  'caller_id',
  'requested_for',
  'requested_by',
  'approver',
  'assignment_group',
  'assigned_to',
  'due_date',
  'planned_end_time',
];

const TH =
  'text-align:left;padding:6px 12px 6px 0;color:#52606d;font-weight:600;width:36%;vertical-align:top;font-size:14px;';
const TD = 'padding:6px 0;vertical-align:top;font-size:14px;color:#1f2933;';
const BUTTON =
  'display:inline-block;background-color:#1f5fbf;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:6px;font-size:14px;';
const BUTTON_SECONDARY =
  'display:inline-block;background-color:#ffffff;color:#1f5fbf;text-decoration:none;font-weight:600;padding:9px 17px;border-radius:6px;border:1px solid #1f5fbf;font-size:14px;';

function summaryRows(env: RenderEnv, rec: Rec): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const f of SUMMARY_FIELDS) {
    const col = rec.column(f);
    if (!col?.storage || f === rec.table.displayField) continue;
    const value = env.renderer.fieldValue({ ...env, opts: { ...env.opts, html: false } }, rec, f).trim();
    if (!value || value === 'false') continue;
    rows.push({ label: col.label, value });
    if (rows.length >= 7) break;
  }
  return rows;
}

/** Built-in mail scripts, referenced as `${mail_script:<name>}`. */
export const NATIVE_MAIL_SCRIPTS: Record<string, NativeMailScript> = {
  record_summary: {
    description: 'Key fields of the record and a button that opens it.',
    run(env) {
      const rec = env.rec;
      if (!rec) return '';
      const rows = summaryRows(env, rec);
      const url = env.renderer.recordUrl(rec.className, rec.sysId);
      const name = rec.displayValue() || rec.table.label;
      if (!env.opts.html) {
        return `${rows.map((r) => `${r.label}: ${r.value}`).join('\n')}\n\nView ${name}: ${url}\n`;
      }
      const table = rows.length
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:8px 0 20px;">${rows
            .map(
              (r) =>
                `<tr><th scope="row" style="${TH}">${escapeHtml(r.label)}</th><td style="${TD}">${escapeHtml(r.value)}</td></tr>`,
            )
            .join('')}</table>`
        : '';
      return `${table}<p style="margin:0 0 8px;"><a href="${escapeHtml(url)}" style="${BUTTON}">View ${escapeHtml(name)}</a></p>`;
    },
  },
  comments_history: {
    description: 'The most recent customer-visible comments (glide.email.journal.lines entries).',
    run(env) {
      const rec = env.rec;
      if (!rec?.has('comments')) return '';
      const body = env.renderer.journal(env, rec, ['comments']);
      if (!body) return '';
      if (!env.opts.html) return `Recent comments\n\n${body}`;
      return `<h2 style="margin:20px 0 10px;font-size:16px;line-height:1.3;color:#1f2933;">Recent comments</h2><div style="border-left:3px solid #dfe3e8;padding:4px 0 4px 14px;margin:0 0 16px;">${body}</div>`;
    },
  },
  approval_links: {
    description: 'Approve and reject reply links for approval emails, plus a link to the approval.',
    run(env) {
      const rec = env.rec;
      if (!rec) return '';
      const host = env.renderer.host;
      const about =
        rec.has('sysapproval') && rec.str('sysapproval') ? rec.display('sysapproval') : rec.displayValue();
      const mailto = (word: string) =>
        `mailto:${host.instanceAddress()}?subject=${encodeURIComponent(`Re: ${about} - ${word}`)}&body=${encodeURIComponent(`${word}\n\n${WATERMARK_MARKER}${WATERMARK_PLACEHOLDER}`)}`;
      const url = env.renderer.recordUrl(rec.className, rec.sysId);
      if (!env.opts.html) {
        return `To approve, reply with "approve" as the first word. To reject, reply with "reject" and a reason.\nOpen the approval: ${url}\n`;
      }
      return [
        '<p style="margin:16px 0 10px;">Reply to this email with <strong>approve</strong> or <strong>reject</strong> as the first word, or use one of these buttons:</p>',
        '<p style="margin:0 0 16px;">',
        `<a href="${escapeHtml(mailto('approve'))}" style="${BUTTON}">Approve</a>&nbsp;&nbsp;`,
        `<a href="${escapeHtml(mailto('reject'))}" style="${BUTTON_SECONDARY}">Reject</a>`,
        '</p>',
        `<p style="margin:0 0 8px;font-size:13px;"><a href="${escapeHtml(url)}" style="color:#1f5fbf;text-decoration:underline;">Open the approval in ResolvrNow</a></p>`,
      ].join('');
    },
  },
};
