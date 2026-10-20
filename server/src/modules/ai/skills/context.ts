/**
 * Builds the compact, structured context a skill sends to the LLM (and uses for its
 * offline fallback): readable fields, visible journal entries, state history and
 * related records. Field and journal access follow the caller's ACLs; work notes are
 * only included for agents. All values are sanitised (secrets redacted).
 */
import type { Context } from '../../../engine/context.js';
import type { Rec } from '../../../engine/record.js';
import { fieldText } from '../ml/records.js';
import { escapeData, sanitize } from './guard.js';

export interface JournalItem {
  field: string;
  label: string;
  at: string;
  by: string;
  text: string;
}

export interface RelatedItem {
  table: string;
  sys_id: string;
  number: string;
  title: string;
  values: Record<string, string>;
}

export interface RelatedSpec {
  key: string;
  label: string;
  table: string;
  /** Reference field on the related table pointing at the record. */
  field: string;
  /** Extra encoded query. */
  query?: string;
  /** Fields to show for each related record. */
  fields?: string[];
  limit?: number;
}

export interface ContextSpec {
  fields: string[];
  journal?: string[];
  history?: boolean;
  related?: RelatedSpec[];
}

export interface RecordContext {
  record: Rec;
  table: string;
  tableLabel: string;
  number: string;
  fields: Record<string, string>;
  labels: Record<string, string>;
  journal: JournalItem[];
  history: string[];
  related: Record<string, { label: string; items: RelatedItem[] }>;
  dropped: string[];
  canSeeWorkNotes: boolean;
}

/** Work notes are internal: only agents (itil) and administrators see them. */
export function canSeeWorkNotes(ctx: Context, rec: Rec): boolean {
  if (ctx.user.isSystem) return true;
  if (!ctx.hasRole('itil') && !ctx.hasRole('sn_incident_read') && !ctx.user.isAdmin) return false;
  return ctx.platform.acl.canField(ctx, rec.className, 'work_notes', 'read', rec);
}

function userDisplay(ctx: Context, userName: string): string {
  const row = ctx.platform.db.get<{ name: string }>(`SELECT "name" FROM "sys_user" WHERE "user_name" = ?`, [
    userName,
  ]);
  return row?.name || userName;
}

export function buildRecordContext(ctx: Context, rec: Rec, spec: ContextSpec): RecordContext {
  const p = ctx.platform;
  const table = rec.className;
  const fields: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const dropped: string[] = [];
  for (const f of spec.fields) {
    if (!rec.has(f)) continue;
    if (!p.acl.canField(ctx, table, f, 'read', rec)) {
      dropped.push(f);
      continue;
    }
    const v = sanitize(
      fieldText(rec, f) || (rec.column(f)?.type === 'glide_date_time' ? rec.str(f) : ''),
      4000,
    );
    if (!v) continue;
    fields[f] = v;
    labels[f] = rec.column(f)?.label ?? f;
  }

  const workNotes = canSeeWorkNotes(ctx, rec);
  const journalFields = (spec.journal ?? []).filter((f) => {
    if (!rec.has(f)) return false;
    if (f === 'work_notes' && !workNotes) {
      dropped.push(f);
      return false;
    }
    return p.acl.canField(ctx, table, f, 'read', rec);
  });
  const journal: JournalItem[] = journalFields.length
    ? p.history
        .journal(table, rec.sysId, journalFields)
        .reverse()
        .map((j) => ({
          field: j.element,
          label: rec.column(j.element)?.label ?? j.element,
          at: j.sys_created_on,
          by: userDisplay(ctx, j.sys_created_by),
          text: sanitize(j.value, 2000),
        }))
        .filter((j) => j.text)
    : [];

  const history: string[] = [];
  if (spec.history && rec.has('state') && p.acl.canField(ctx, table, 'state', 'read', rec)) {
    const label = (v: string | null) => (v ? (p.choices.label(table, 'state', v) ?? v) : '');
    for (const a of p.history
      .audit(table, rec.sysId)
      .filter((x) => x.fieldname === 'state')
      .reverse()) {
      const from = label(a.oldvalue);
      history.push(
        `${a.sys_created_on}: ${from ? `${from} -> ` : ''}${label(a.newvalue)} (by ${userDisplay(ctx, a.user)})`,
      );
    }
  }

  const related: RecordContext['related'] = {};
  for (const r of spec.related ?? []) {
    const meta = p.registry.tryTable(r.table);
    if (!meta?.columns.has(r.field) || !p.acl.canTable(ctx, r.table, 'read').allowed) continue;
    const recs = ctx.query(r.table, {
      query: `${r.field}=${rec.sysId}${r.query ? `^${r.query}` : ''}`,
      orderBy: [{ field: 'sys_created_on', desc: false }],
      limit: r.limit ?? 20,
    });
    if (!recs.length) continue;
    related[r.key] = {
      label: r.label,
      items: recs.map((x) => {
        const values: Record<string, string> = {};
        for (const f of r.fields ?? []) {
          if (!x.has(f) || !p.acl.canField(ctx, x.className, f, 'read', x)) continue;
          const v = sanitize(
            fieldText(x, f) || (x.column(f)?.type === 'glide_date_time' ? x.str(f) : ''),
            300,
          );
          if (v) values[f] = v;
        }
        return {
          table: x.className,
          sys_id: x.sysId,
          number: x.has('number') ? x.str('number') : x.displayValue(),
          title: sanitize(x.has('short_description') ? x.str('short_description') : x.displayValue(), 200),
          values,
        };
      }),
    };
  }

  return {
    record: rec,
    table,
    tableLabel: rec.table.label,
    number: rec.has('number') ? rec.str('number') : rec.displayValue(),
    fields,
    labels,
    journal,
    history,
    related,
    dropped,
    canSeeWorkNotes: workNotes,
  };
}

const attr = (s: string) => escapeData(s).replace(/"/g, "'");

/**
 * Renders the context as a delimited data section. When it exceeds `maxChars`,
 * the oldest journal entries go first, then related records, then state history,
 * then long field values are shortened.
 */
export function renderRecordData(rc: RecordContext, maxChars: number): { text: string; truncated: boolean } {
  const fieldLines = Object.entries(rc.fields).map(([f, v]) => ({ f, v }));
  let journal = [...rc.journal];
  let history = [...rc.history];
  const related = Object.entries(rc.related).map(([key, r]) => ({
    key,
    label: r.label,
    items: [...r.items],
  }));
  let truncated = false;

  const render = () => {
    const out: string[] = [`<record_data table="${attr(rc.table)}" number="${attr(rc.number)}">`, '<fields>'];
    for (const { f, v } of fieldLines) out.push(`${f} (${escapeData(rc.labels[f] ?? f)}): ${escapeData(v)}`);
    out.push('</fields>');
    if (journal.length) {
      out.push('<journal>');
      for (const j of journal)
        out.push(`[${j.at}] ${escapeData(j.label)} by ${escapeData(j.by)}:\n${escapeData(j.text)}`);
      out.push('</journal>');
    }
    if (history.length) {
      out.push('<state_history>');
      for (const h of history) out.push(escapeData(h));
      out.push('</state_history>');
    }
    for (const r of related) {
      if (!r.items.length) continue;
      out.push(`<related name="${attr(r.key)}" label="${attr(r.label)}">`);
      for (const it of r.items) {
        const extra = Object.entries(it.values)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        out.push(
          `- ${escapeData(it.number)} | ${escapeData(it.title)}${extra ? ` | ${escapeData(extra)}` : ''}`,
        );
      }
      out.push('</related>');
    }
    out.push('</record_data>');
    return out.join('\n');
  };

  let text = render();
  let guard = 0;
  while (text.length > maxChars && guard++ < 10_000) {
    truncated = true;
    if (journal.length) journal = journal.slice(1);
    else if (related.some((r) => r.items.length)) {
      const r = [...related].reverse().find((x) => x.items.length)!;
      r.items.pop();
    } else if (history.length) history = history.slice(1);
    else {
      const longest = fieldLines.reduce((a, b) => (b.v.length > a.v.length ? b : a), fieldLines[0]);
      if (!longest || longest.v.length <= 40) {
        text = `${text.slice(0, Math.max(0, maxChars - 20))}\n</record_data>`;
        break;
      }
      longest.v = `${longest.v.slice(0, Math.floor(longest.v.length / 2))}…`;
    }
    text = render();
  }
  return { text, truncated };
}
