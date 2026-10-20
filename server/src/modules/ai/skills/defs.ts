/**
 * Generative skills for ITSM. Each skill builds a compact context from a record (or a
 * question), carries stable instructions for the LLM path, and always has a
 * deterministic offline output used when no provider is configured, when the model
 * declines, or when the provider fails.
 */
import type { Context } from '../../../engine/context.js';
import type { Platform } from '../../../engine/platform.js';
import type { Rec } from '../../../engine/record.js';
import type { TableMeta } from '../../../engine/types.js';
import type { SimilarityService } from '../ml/similarity.js';
import {
  analyze,
  countRelevantWords,
  firstSentence,
  plainText,
  SurfaceForms,
  sentences,
  truncate,
} from '../ml/text.js';
import {
  buildRecordContext,
  type ContextSpec,
  type RecordContext,
  type RelatedSpec,
  renderRecordData,
} from './context.js';
import { escapeData, sanitize } from './guard.js';

export interface SkillEnv {
  ctx: Context;
  platform: Platform;
  similarity: SimilarityService;
  maxChars: number;
}

export type SkillInput = Record<string, unknown> & { table?: string; sys_id?: string };

export interface SourceRef {
  table: string;
  sys_id: string;
  number: string;
  title: string;
  score?: number;
  citation?: number;
}

export interface OfflineOutput {
  text: string;
  sections?: Record<string, unknown>;
}

export interface PreparedSkill {
  /** Task line placed before the data in the user message. */
  task: string;
  /** Delimited data sections. */
  data: string;
  truncated: boolean;
  sources: SourceRef[];
  offline(): OfflineOutput;
  /** Answer without calling the LLM (for example, no knowledge matched the question). */
  skipLlm?: boolean;
}

export interface SkillDef {
  id: string;
  label: string;
  description: string;
  kind: 'summary' | 'generation' | 'qa';
  defaultActive: boolean;
  defaultRoles: string[];
  /** Nominal table shown in the skill configuration. */
  table: string | null;
  needsRecord: boolean;
  appliesTo?(meta: TableMeta): boolean;
  /** Stable, skill-specific instructions appended to the system prompt. */
  instructions: string;
  prepare(env: SkillEnv, rec: Rec | null, input: SkillInput): PreparedSkill;
  /** Side effects after generation (e.g. saving a knowledge draft); returns extra response fields. */
  after?(
    env: SkillEnv,
    rec: Rec | null,
    input: SkillInput,
    text: string,
  ): Record<string, unknown> | undefined;
}

/** A guardrail stopped the skill before generation (insufficient input, wrong state...). */
export class SkillError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

// ------------------------------------------------------------------ helpers

const isTask = (meta: TableMeta) => meta.ancestors.includes('task');

type StateKind = 'new' | 'wip' | 'resolved' | 'closed' | 'canceled';

export function stateKind(rec: Rec): StateKind {
  const label = rec.has('state') ? rec.display('state').toLowerCase() : '';
  if (/cancel/.test(label)) return 'canceled';
  if (/resolved/.test(label)) return 'resolved';
  if (/closed|complete|skipped|incomplete/.test(label)) return 'closed';
  if (rec.has('active') && !rec.bool('active')) return 'closed';
  if (label === '' || /^(new|open|pending|draft)$/.test(label)) return 'new';
  return 'wip';
}

function section(title: string, body: string | string[]): string {
  if (Array.isArray(body))
    return `${title}\n${body.length ? body.map((b) => `- ${b}`).join('\n') : '- None recorded.'}`;
  return `${title}\n${body}`;
}

const joinSections = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('\n\n');

function distinct(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const k = s.toLowerCase().replace(/\W+/g, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function recordSource(rc: RecordContext): SourceRef {
  return {
    table: rc.table,
    sys_id: rc.record.sysId,
    number: rc.number,
    title: rc.fields.short_description ?? rc.number,
  };
}

function relatedSources(rc: RecordContext, keys: string[]): SourceRef[] {
  const out: SourceRef[] = [];
  for (const k of keys)
    for (const it of rc.related[k]?.items ?? [])
      out.push({ table: it.table, sys_id: it.sys_id, number: it.number, title: it.title });
  return out;
}

function prepareRecord(
  env: SkillEnv,
  rec: Rec,
  spec: ContextSpec,
  task: string,
  offline: (rc: RecordContext) => OfflineOutput,
  extraSources: string[] = [],
): PreparedSkill {
  return prepareFromContext(env, buildRecordContext(env.ctx, rec, spec), task, offline, extraSources);
}

function prepareFromContext(
  env: SkillEnv,
  rc: RecordContext,
  task: string,
  offline: (rc: RecordContext) => OfflineOutput,
  extraSources: string[] = [],
): PreparedSkill {
  const { text, truncated } = renderRecordData(rc, env.maxChars);
  return {
    task,
    data: text,
    truncated,
    sources: [recordSource(rc), ...relatedSources(rc, extraSources)],
    offline: () => offline(rc),
  };
}

function workNotes(rc: RecordContext): string[] {
  return rc.journal.filter((j) => j.field === 'work_notes').map((j) => j.text);
}

function comments(rc: RecordContext): string[] {
  return rc.journal.filter((j) => j.field === 'comments').map((j) => j.text);
}

/** First sentence of up to `n` latest distinct notes, oldest first. */
function keyActions(notes: string[], n = 5): string[] {
  const firsts = distinct(notes.map((t) => firstSentence(t)).filter(Boolean));
  return firsts.slice(-n);
}

function issueText(rc: RecordContext): string {
  const sd = rc.fields.short_description ?? '';
  const desc = rc.fields.description ? firstSentence(rc.fields.description, 300) : '';
  const parts = [sd];
  if (desc && desc.toLowerCase() !== sd.toLowerCase()) parts.push(desc);
  const who = rc.fields.caller_id ? ` Reported by ${rc.fields.caller_id}.` : '';
  const text = parts.filter(Boolean).join('. ').replace(/\.\./g, '.');
  return `${text}${/[.!?…]$/.test(text) ? '' : '.'}${who}`.trim();
}

const CAUSE_RE =
  /\b(root cause|caused by|because|due to|was the (?:issue|problem|culprit)|culprit|turned out|the cause)\b/i;

function findCause(texts: string[]): string | null {
  for (const t of [...texts].reverse()) {
    for (const s of sentences(t)) if (CAUSE_RE.test(s)) return truncate(s, 300);
  }
  return null;
}

function firstNameOf(rec: Rec): string {
  for (const f of ['caller_id', 'requested_for', 'opened_by']) {
    if (!rec.has(f)) continue;
    const u = rec.ref(f);
    if (!u) continue;
    const first = u.str('first_name') || u.str('name').split(' ')[0];
    if (first) return first;
  }
  return '';
}

function signature(env: SkillEnv, rc: RecordContext): string {
  const name = env.ctx.user.isSystem ? 'Service Desk' : env.ctx.user.name || 'Service Desk';
  const group = rc.fields.assignment_group;
  return group ? `${name}\n${group}` : name;
}

function stateLabel(rc: RecordContext): string {
  return rc.fields.state ?? 'Unknown';
}

/** Most frequent meaningful terms across texts (document frequency), as readable words. */
function recurringTerms(texts: string[], minDocs: number, n: number): { term: string; docs: number }[] {
  const surface = new SurfaceForms();
  const df = new Map<string, number>();
  for (const t of texts) {
    surface.add(t);
    for (const s of new Set(analyze(t))) df.set(s, (df.get(s) ?? 0) + 1);
  }
  return [...df.entries()]
    .filter(([s, d]) => d >= minDocs && s.length > 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([s, d]) => ({ term: surface.word(s), docs: d }));
}

/** Separates the "Title" section of a generated article from its body. */
export function splitTitle(text: string, fallback: string): { title: string; body: string } {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:#+\s*)?(?:\*\*)?title\b(?:\*\*)?\s*:?\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let end = i;
    let title = m[1].trim();
    if (!title) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      title = (lines[j] ?? '').trim();
      end = j;
    }
    if (title) {
      const body = [...lines.slice(0, i), ...lines.slice(end + 1)].join('\n').trim();
      return { title: truncate(title.replace(/^#+\s*/, ''), 160), body };
    }
  }
  return { title: truncate(fallback || 'Knowledge article', 160), body: text };
}

/** Simple HTML for knowledge drafts: headings, paragraphs and lists. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      close();
      continue;
    }
    let m = /^[-*•]\s+(.*)$/.exec(line);
    if (m) {
      if (list !== 'ul') {
        close();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${esc(m[1])}</li>`;
      continue;
    }
    m = /^\d+[.)]\s+(.*)$/.exec(line);
    if (m) {
      if (list !== 'ol') {
        close();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${esc(m[1])}</li>`;
      continue;
    }
    close();
    if (
      /^#{1,6}\s+/.test(line) ||
      /^(title|symptoms|issue|cause|resolution steps|resolution|keywords|workaround)\s*:?$/i.test(line)
    ) {
      html += `<h3>${esc(line.replace(/^#+\s*/, '').replace(/:$/, ''))}</h3>`;
    } else html += `<p>${esc(line)}</p>`;
  }
  close();
  return html;
}

const TASK_FIELDS = [
  'number',
  'short_description',
  'description',
  'state',
  'priority',
  'impact',
  'urgency',
  'category',
  'subcategory',
  'caller_id',
  'opened_by',
  'opened_at',
  'assignment_group',
  'assigned_to',
  'cmdb_ci',
  'business_service',
  'close_code',
  'close_notes',
  'resolved_at',
  'closed_at',
];

const TASK_RELATED: RelatedSpec[] = [
  {
    key: 'child_incidents',
    label: 'Child incidents',
    table: 'incident',
    field: 'parent_incident',
    fields: ['state'],
    limit: 20,
  },
  {
    key: 'affected_cis',
    label: 'Affected configuration items',
    table: 'task_ci',
    field: 'task',
    fields: ['ci_item'],
    limit: 20,
  },
  {
    key: 'sla',
    label: 'Service level agreements',
    table: 'task_sla',
    field: 'task',
    fields: ['sla', 'stage', 'has_breached'],
    limit: 10,
  },
];

// ------------------------------------------------------------------ skills

const incidentSummarization: SkillDef = {
  id: 'incident_summarization',
  label: 'Incident summarization',
  description:
    'Summarizes an incident (or any task) for an agent: issue, key actions taken and resolution, by state.',
  kind: 'summary',
  defaultActive: true,
  defaultRoles: ['itil', 'sn_incident_read'],
  table: 'incident',
  needsRecord: true,
  appliesTo: isTask,
  instructions: [
    'Summarize the record for a service desk agent who has not seen it before.',
    'Write the sections named in the task, in that order, each as a heading line followed by its content:',
    '- Issue: what is wrong and who is affected, in one to three sentences.',
    '- Key Actions Taken: bullets of the actions recorded in the journal, oldest first.',
    '- Resolution: how the issue was resolved, based on the close notes and resolution code.',
    'When the data contains them, you may add short sections "Affected CIs and Impacted Services", "Service Level Agreement" and "Child Incidents".',
    'Never list an action that is not in the journal. Keep the whole summary under 200 words.',
  ].join('\n'),
  prepare(env, rec) {
    const r = rec!;
    const kind = stateKind(r);
    const sections =
      kind === 'new'
        ? ['Issue']
        : kind === 'wip'
          ? ['Issue', 'Key Actions Taken']
          : ['Issue', 'Key Actions Taken', 'Resolution'];
    return prepareRecord(
      env,
      r,
      { fields: TASK_FIELDS, journal: ['comments', 'work_notes'], history: true, related: TASK_RELATED },
      `Task: summarize ${r.table.label} ${r.has('number') ? r.str('number') : ''}. Sections: ${sections.join(', ')}.`,
      (rc) => {
        const actions = keyActions(rc.canSeeWorkNotes && workNotes(rc).length ? workNotes(rc) : comments(rc));
        const resolution =
          kind === 'canceled'
            ? `Canceled.${rc.fields.close_notes ? ` ${rc.fields.close_notes}` : ''}`
            : [
                rc.fields.close_code ? `${rc.fields.close_code}.` : '',
                rc.fields.close_notes ??
                  (rc.fields.close_code ? '' : 'Resolved; no close notes were recorded.'),
              ]
                .filter(Boolean)
                .join(' ');
        const cis = [
          rc.fields.cmdb_ci,
          ...(rc.related.affected_cis?.items ?? []).map((i) => i.values.ci_item || i.title),
        ].filter(Boolean) as string[];
        const sla = (rc.related.sla?.items ?? []).map((i) =>
          [i.values.sla, i.values.stage, i.values.has_breached === 'true' ? 'breached' : '']
            .filter(Boolean)
            .join(', '),
        );
        const children = (rc.related.child_incidents?.items ?? []).map(
          (i) => `${i.number}: ${i.title}${i.values.state ? ` (${i.values.state})` : ''}`,
        );
        const out: Record<string, unknown> = { issue: issueText(rc) };
        const text = joinSections([
          section('Issue', out.issue as string),
          sections.includes('Key Actions Taken') &&
            section('Key Actions Taken', actions.length ? actions : ['No actions have been recorded yet.']),
          sections.includes('Resolution') && section('Resolution', resolution),
          kind !== 'new' &&
            distinct(cis).length > 0 &&
            section('Affected CIs and Impacted Services', distinct(cis)),
          sla.length > 0 && section('Service Level Agreement', sla),
          children.length > 0 && section('Child Incidents', children),
          rc.history.length > 0 && section('State history', rc.history.slice(-6)),
        ]);
        if (sections.includes('Key Actions Taken')) out.key_actions = actions;
        if (sections.includes('Resolution')) out.resolution = resolution;
        return { text, sections: out };
      },
      ['child_incidents'],
    );
  },
};

const resolutionNotes: SkillDef = {
  id: 'resolution_notes_generation',
  label: 'Resolution notes generation',
  description:
    'Drafts resolution notes (cause, steps, resolution) from the activity of a ticket; the resolution code is only suggested.',
  kind: 'generation',
  defaultActive: true,
  defaultRoles: ['itil'],
  table: 'incident',
  needsRecord: true,
  appliesTo: isTask,
  instructions: [
    'Write resolution notes for the ticket in three parts, each a heading line followed by its content:',
    '- Cause: what caused the issue. If the data does not state it, write "Not identified in the record."',
    '- Steps: bullets of the troubleshooting and fix steps, oldest first.',
    '- Resolution: how the issue was resolved and how it was confirmed.',
    'You may end with "Suggested resolution code: <code>" only when the data clearly supports it; it is a suggestion, never a decision.',
    'Keep the notes under 150 words.',
  ].join('\n'),
  prepare(env, rec) {
    const r = rec!;
    const rc = buildRecordContext(env.ctx, r, {
      fields: [
        'number',
        'short_description',
        'description',
        'state',
        'category',
        'cmdb_ci',
        'close_code',
        'close_notes',
      ],
      journal: ['comments', 'work_notes'],
    });
    // Guardrail: at least 50 meaningful words of activity.
    const words = countRelevantWords(
      [rc.fields.short_description ?? '', rc.fields.description ?? '', ...rc.journal.map((j) => j.text)].join(
        ' ',
      ),
    );
    if (words < 50) {
      throw new SkillError(
        422,
        'insufficient_activity',
        `Not enough activity to write resolution notes: ${words} relevant words found, at least 50 are needed across the description, work notes and comments.`,
      );
    }
    return prepareFromContext(
      env,
      rc,
      `Task: write resolution notes for ${r.table.label} ${rc.number}.`,
      (ctxData) => {
        const notes = workNotes(ctxData).length ? workNotes(ctxData) : comments(ctxData);
        const cause =
          findCause([...notes, ctxData.fields.description ?? '']) ?? 'Not identified in the record.';
        const steps = keyActions(notes, 6);
        const last = notes.length ? firstSentence(notes[notes.length - 1]) : '';
        const resolution = ctxData.fields.close_notes ?? (last || 'The issue was resolved.');
        const text = joinSections([
          section('Cause', cause),
          section('Steps', steps),
          section('Resolution', resolution),
        ]);
        return { text, sections: { cause, steps, resolution } };
      },
    );
  },
};

const EMAIL_TYPES = ['reply', 'acknowledge', 'update', 'resolution', 'follow_up', 'request_info'] as const;

const emailResponse: SkillDef = {
  id: 'email_response_generation',
  label: 'Email response generation',
  description:
    'Drafts an email to the requester (acknowledgement, update, resolution, follow-up) from customer-visible information.',
  kind: 'generation',
  defaultActive: false,
  defaultRoles: ['itil'],
  table: 'incident',
  needsRecord: true,
  appliesTo: isTask,
  instructions: [
    'Draft an email from the service desk to the requester. The text is customer-visible.',
    'Use only customer-visible information: never quote internal work notes, internal tools or other customers.',
    'First line "Subject: ..." referencing the ticket number, then a blank line and the body.',
    'Greet the requester by first name when known, keep the body under 150 words, and sign with the agent name and team given in the task.',
    'Do not promise dates or outcomes that are not in the data. If draft text is provided in <draft>, improve it instead of starting over.',
  ].join('\n'),
  prepare(env, rec, input) {
    const r = rec!;
    const kind = stateKind(r);
    const requested = String(input.type ?? input.intent ?? 'reply');
    const type = (EMAIL_TYPES as readonly string[]).includes(requested) ? requested : 'reply';
    const effective =
      type === 'reply'
        ? kind === 'new'
          ? 'acknowledge'
          : kind === 'resolved' || kind === 'closed'
            ? 'resolution'
            : 'update'
        : type;
    const tone = String(input.tone ?? 'friendly') === 'formal' ? 'formal' : 'friendly';
    const draft = typeof input.composer_text === 'string' ? sanitize(input.composer_text, 4000) : '';
    const prepared = prepareRecord(
      env,
      r,
      {
        fields: [
          'number',
          'short_description',
          'description',
          'state',
          'priority',
          'caller_id',
          'assignment_group',
          'assigned_to',
          'close_notes',
        ],
        journal: ['comments'],
      },
      `Task: draft a ${tone} ${effective.replace('_', ' ')} email for ${r.table.label} ${r.has('number') ? r.str('number') : ''}. Sign as: ${env.ctx.user.name || 'Service Desk'}.`,
      (rc) => {
        const first = firstNameOf(r);
        const number = rc.number;
        const sd = rc.fields.short_description ?? 'your request';
        const greet = tone === 'formal' ? `Dear ${first || 'customer'},` : `Hello ${first || 'there'},`;
        const latest = comments(rc).slice(-1)[0];
        const bodies: Record<string, string> = {
          acknowledge: `Thank you for contacting the service desk. We have received your request "${sd}" (${number})${rc.fields.assignment_group ? ` and it is now with ${rc.fields.assignment_group}` : ''}. We will keep you informed of progress.`,
          update: `Here is an update on "${sd}" (${number}). The ticket is currently ${stateLabel(rc).toLowerCase()}.${latest ? ` Latest update: ${firstSentence(latest)}` : ''} We will contact you again as soon as there is more news.`,
          resolution: `We have resolved "${sd}" (${number}).${rc.fields.close_notes ? ` Resolution: ${firstSentence(rc.fields.close_notes, 400)}` : ''} If the problem comes back, reply to this email and we will reopen the ticket.`,
          follow_up: `We are following up on "${sd}" (${number}). Could you let us know whether the issue is still occurring? If we do not hear back, we may close the ticket.`,
          request_info: `To continue working on "${sd}" (${number}), we need a little more information. Could you describe when the problem started and any error message you see?`,
        };
        const body = draft || bodies[effective] || bodies.update;
        const sign = tone === 'formal' ? 'Kind regards,' : 'Best regards,';
        const text = `Subject: ${number}: ${sd}\n\n${greet}\n\n${body}\n\n${sign}\n${signature(env, rc)}`;
        return { text, sections: { subject: `${number}: ${sd}`, body, type: effective } };
      },
    );
    if (draft) prepared.data += `\n<draft>\n${escapeData(draft)}\n</draft>`;
    return prepared;
  },
};

const ACTIVITY_OPTIONS = ['acknowledge', 'post_response', 'summarize_actions', 'follow_up'] as const;

const activityResponse: SkillDef = {
  id: 'incident_activity_response',
  label: 'Incident activity response recommendation',
  description:
    'Suggests a journal entry: acknowledge, post a response, summarize actions taken (work notes) or follow up.',
  kind: 'generation',
  defaultActive: false,
  defaultRoles: ['itil'],
  table: 'incident',
  needsRecord: true,
  appliesTo: isTask,
  instructions: [
    'Write one journal entry for the ticket, as requested by the option in the task:',
    '- acknowledge: tell the requester the ticket is being worked on.',
    '- post_response: give the requester a short status update.',
    '- summarize_actions: an internal work note listing the actions taken so far.',
    '- follow_up: ask the requester whether the issue persists or for missing information.',
    'Entries for the comments field are customer-visible: never include work note content in them.',
    'Keep the entry under 80 words; no subject line and no signature.',
  ].join('\n'),
  prepare(env, rec, input) {
    const r = rec!;
    const field = String(input.field ?? 'comments') === 'work_notes' ? 'work_notes' : 'comments';
    const requested = String(
      input.option ?? (field === 'work_notes' ? 'summarize_actions' : 'post_response'),
    );
    const option = (ACTIVITY_OPTIONS as readonly string[]).includes(requested) ? requested : 'post_response';
    if (option === 'summarize_actions' && field !== 'work_notes') {
      throw new SkillError(
        400,
        'invalid_option',
        'summarize_actions is only available for the work_notes field.',
      );
    }
    const journal = field === 'work_notes' ? ['comments', 'work_notes'] : ['comments'];
    return prepareRecord(
      env,
      r,
      {
        fields: [
          'number',
          'short_description',
          'description',
          'priority',
          'state',
          'caller_id',
          'assignment_group',
        ],
        journal,
      },
      `Task: write a ${field === 'work_notes' ? 'work note' : 'customer-visible comment'} for ${r.table.label} ${r.has('number') ? r.str('number') : ''}. Option: ${option}.`,
      (rc) => {
        const first = firstNameOf(r);
        const hi = first ? `Hi ${first}, ` : 'Hello, ';
        const sd = rc.fields.short_description ?? 'your request';
        let text: string;
        if (option === 'acknowledge')
          text = `${hi}thank you for reporting "${sd}". I am looking into it now and will update you shortly.`;
        else if (option === 'follow_up')
          text = `${hi}is "${sd}" still happening on your side? Please reply with any new details so we can continue, or let us know if it is solved.`;
        else if (option === 'summarize_actions') {
          const actions = keyActions(workNotes(rc), 6);
          text = actions.length
            ? `Actions taken so far:\n${actions.map((a) => `- ${a}`).join('\n')}`
            : 'No actions have been recorded yet.';
        } else
          text = `${hi}the ticket "${sd}" is currently ${stateLabel(rc).toLowerCase()}. We will keep you informed of any progress.`;
        return { text, sections: { option, field } };
      },
    );
  },
};

const kbArticle: SkillDef = {
  id: 'kb_article_generation',
  label: 'Knowledge article generation',
  description:
    'Drafts a knowledge article from a resolved incident; with "create": true the draft is saved and linked to the incident.',
  kind: 'generation',
  defaultActive: false,
  defaultRoles: ['itil'],
  table: 'incident',
  needsRecord: true,
  appliesTo: isTask,
  instructions: [
    'Draft a knowledge article from the resolved ticket, for agents and end users facing the same issue.',
    'Use these sections, each as a heading line: Title (one line), Symptoms, Cause, Resolution steps (numbered), Keywords (comma-separated).',
    "Generalise the content: remove people's names, ticket numbers and details specific to one user or device.",
    'Use only facts from the data; when the cause is unknown, say so.',
  ].join('\n'),
  prepare(env, rec) {
    const r = rec!;
    const kind = stateKind(r);
    const allowed = (env.platform.properties.get('com.snc.incident.create_knowledge.multistate.enable') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (kind !== 'resolved' && kind !== 'closed' && !allowed.includes(r.str('state'))) {
      throw new SkillError(
        409,
        'invalid_state',
        'Knowledge drafts are generated from resolved or closed records only.',
      );
    }
    if (
      env.platform.registry.has('m2m_kb_task') &&
      env.ctx.platform.systemContext().count('m2m_kb_task', `task=${r.sysId}`) > 0
    ) {
      throw new SkillError(409, 'invalid_state', 'A knowledge article is already attached to this record.');
    }
    return prepareRecord(
      env,
      r,
      {
        fields: [
          'number',
          'short_description',
          'description',
          'category',
          'subcategory',
          'cmdb_ci',
          'close_code',
          'close_notes',
        ],
        journal: ['comments', 'work_notes'],
      },
      `Task: draft a knowledge article from ${r.table.label} ${r.has('number') ? r.str('number') : ''}.`,
      (rc) => {
        const title = rc.fields.short_description ?? 'Untitled issue';
        const symptoms = rc.fields.description ?? rc.fields.short_description ?? '';
        const cause =
          findCause([...workNotes(rc), ...comments(rc), rc.fields.close_notes ?? '']) ??
          'Not identified; see the resolution steps.';
        const stepsSource = rc.fields.close_notes
          ? sentences(rc.fields.close_notes)
          : keyActions(workNotes(rc), 6);
        const steps = stepsSource.length ? stepsSource : ['Contact the service desk if the issue persists.'];
        const keywords = recurringTerms([title, symptoms, rc.fields.close_notes ?? ''], 1, 6).map(
          (t) => t.term,
        );
        const text = [
          'Title',
          title,
          '',
          'Symptoms',
          symptoms,
          '',
          'Cause',
          cause,
          '',
          'Resolution steps',
          ...steps.map((s, i) => `${i + 1}. ${s}`),
          '',
          'Keywords',
          keywords.join(', '),
        ].join('\n');
        return { text, sections: { title, symptoms, cause, resolution_steps: steps, keywords } };
      },
    );
  },
  after(env, rec, input, text) {
    if (input.create !== true && input.create !== 'true') return undefined;
    const p = env.platform;
    if (!p.registry.has('kb_knowledge'))
      return { article: null, article_error: 'The knowledge application is not installed.' };
    if (!p.acl.canTable(env.ctx, 'kb_knowledge', 'create').allowed)
      return { article: null, article_error: 'You are not allowed to create knowledge articles.' };
    const { title, body } = splitTitle(text, rec!.str('short_description'));
    const values: Record<string, unknown> = { short_description: title, text: textToHtml(body) };
    const meta = p.registry.table('kb_knowledge');
    if (meta.columns.has('workflow_state')) values.workflow_state = 'draft';
    const base = p.properties.get('glide.knowman.task_kb');
    if (
      base &&
      meta.columns.has('kb_knowledge_base') &&
      p.registry.has('kb_knowledge_base') &&
      env.ctx.elevated().get('kb_knowledge_base', base)
    ) {
      values.kb_knowledge_base = base;
    }
    if (meta.columns.has('source')) values.source = rec!.sysId;
    try {
      const article = env.ctx.insert('kb_knowledge', values);
      if (p.registry.has('m2m_kb_task'))
        env.ctx.elevated().insert('m2m_kb_task', { kb_knowledge: article.sysId, task: rec!.sysId });
      return {
        article: {
          table: 'kb_knowledge',
          sys_id: article.sysId,
          number: article.has('number') ? article.str('number') : '',
        },
      };
    } catch (e) {
      return { article: null, article_error: e instanceof Error ? e.message : String(e) };
    }
  },
};

const isChange = (meta: TableMeta) =>
  meta.ancestors.includes('change_request') || meta.columns.has('implementation_plan');

const CHANGE_FIELDS = [
  'number',
  'short_description',
  'description',
  'type',
  'state',
  'risk',
  'impact',
  'priority',
  'justification',
  'implementation_plan',
  'risk_impact_analysis',
  'test_plan',
  'backout_plan',
  'start_date',
  'end_date',
  'assignment_group',
  'assigned_to',
  'cmdb_ci',
  'business_service',
  'service_offering',
  'conflict_status',
  'close_code',
  'close_notes',
];

const changeSummarization: SkillDef = {
  id: 'change_summarization',
  label: 'Change request summarization',
  description:
    'Summarizes a change request: objective, plan, risk, affected CIs and impacted services; close notes once closed.',
  kind: 'summary',
  defaultActive: true,
  defaultRoles: ['itil'],
  table: 'change_request',
  needsRecord: true,
  appliesTo: isChange,
  instructions: [
    'Summarize the change request for a change approver. Write the sections named in the task, each as a heading line:',
    '- Objective: why the change is made.',
    '- Plan: implementation, test and backout approach, with the planned window when known.',
    '- Risk: the calculated risk and impact and the main risk factors.',
    '- Affected CIs and Impacted services: the configuration items and services involved.',
    '- Close notes and Incidents caused by change: only for closed changes.',
    'Keep the summary under 220 words and do not invent plans or risks.',
  ].join('\n'),
  prepare(env, rec) {
    const r = rec!;
    const kind = stateKind(r);
    if (kind === 'new' || kind === 'canceled') {
      throw new SkillError(
        409,
        'invalid_state',
        'Change summaries are available once the change has left New and while it is not canceled.',
      );
    }
    const closed = kind === 'closed';
    const sections = [
      'Objective',
      'Plan',
      'Risk',
      'Affected CIs',
      'Impacted services',
      ...(closed ? ['Close notes', 'Incidents caused by change'] : []),
    ];
    return prepareRecord(
      env,
      r,
      {
        fields: CHANGE_FIELDS,
        journal: ['comments', 'work_notes'],
        history: true,
        related: [
          {
            key: 'affected_cis',
            label: 'Affected configuration items',
            table: 'task_ci',
            field: 'task',
            fields: ['ci_item'],
            limit: 30,
          },
          {
            key: 'change_tasks',
            label: 'Change tasks',
            table: 'change_task',
            field: 'change_request',
            fields: ['state', 'assigned_to'],
            limit: 20,
          },
          {
            key: 'caused_incidents',
            label: 'Incidents caused by this change',
            table: 'incident',
            field: 'caused_by',
            fields: ['state', 'priority'],
            limit: 20,
          },
        ],
      },
      `Task: summarize change ${r.has('number') ? r.str('number') : ''}. Sections: ${sections.join(', ')}.`,
      (rc) => {
        const f = rc.fields;
        const objective =
          firstSentence(f.justification ?? '') ||
          firstSentence(f.description ?? '') ||
          f.short_description ||
          'Not stated.';
        const plan = [
          f.implementation_plan && `Implementation: ${firstSentence(f.implementation_plan)}`,
          f.test_plan && `Test: ${firstSentence(f.test_plan)}`,
          f.backout_plan ? `Backout: ${firstSentence(f.backout_plan)}` : 'Backout: no backout plan recorded.',
          (f.start_date || f.end_date) && `Window: ${f.start_date ?? '?'} to ${f.end_date ?? '?'}`,
        ].filter(Boolean) as string[];
        const risk = [
          `Risk ${f.risk ?? 'not calculated'}${f.impact ? `, impact ${f.impact}` : ''}${f.type ? `, ${f.type} change` : ''}.`,
          f.risk_impact_analysis ? firstSentence(f.risk_impact_analysis) : '',
          f.conflict_status ? `Conflict status: ${f.conflict_status}.` : '',
        ]
          .filter(Boolean)
          .join(' ');
        const cis = distinct(
          [
            f.cmdb_ci ?? '',
            ...(rc.related.affected_cis?.items ?? []).map((i) => i.values.ci_item || i.title),
          ].filter(Boolean),
        );
        const services = distinct([f.business_service ?? '', f.service_offering ?? ''].filter(Boolean));
        const incidents = (rc.related.caused_incidents?.items ?? []).map((i) => `${i.number}: ${i.title}`);
        const text = joinSections([
          section('Objective', objective),
          section('Plan', plan),
          section('Risk', risk),
          section('Affected CIs', cis),
          section('Impacted services', services),
          closed &&
            section(
              'Close notes',
              [f.close_code, f.close_notes].filter(Boolean).join(': ') || 'No close notes recorded.',
            ),
          closed && section('Incidents caused by change', incidents.length ? incidents : ['None recorded.']),
        ]);
        return { text, sections: { objective, plan, risk, affected_cis: cis, impacted_services: services } };
      },
      ['caused_incidents'],
    );
  },
};

const changeRiskExplanation: SkillDef = {
  id: 'change_risk_explanation',
  label: 'Change request risk explanation',
  description:
    'Explains the calculated risk of a change: contributing factors and similar past changes with the incidents they caused.',
  kind: 'summary',
  defaultActive: false,
  defaultRoles: ['itil'],
  table: 'change_request',
  needsRecord: true,
  appliesTo: isChange,
  instructions: [
    'Explain to a change approver why the change has its calculated risk.',
    'Start with one sentence stating the risk, then a "Contributing factors" bullet list grounded in the data (impact, type, plans, window, configuration items),',
    'then "Similar changes" listing the similar past changes from the data with the incidents they caused. Do not recompute or change the risk.',
    'Keep it under 180 words.',
  ].join('\n'),
  prepare(env, rec) {
    const r = rec!;
    if (!r.str('risk'))
      throw new SkillError(409, 'invalid_state', 'The risk of this change has not been calculated yet.');
    const ctx = env.ctx;
    const p = env.platform;
    const hasIncidents = p.registry.has('incident');
    const incMeta = hasIncidents ? p.registry.table('incident') : null;
    const similar =
      env.similarity.similarToRecord(ctx, r, [r.className], { limit: 5, minScore: 15 })[r.className] ?? [];
    const similarLines = similar.map((h) => {
      const caused = incMeta?.columns.has('caused_by') ? ctx.count('incident', `caused_by=${h.sys_id}`) : 0;
      return {
        hit: h,
        caused,
        line: `${h.number}: ${sanitize(h.title, 200)}${h.state ? ` (${h.state})` : ''}, ${caused} incident${caused === 1 ? '' : 's'} caused`,
      };
    });
    const ci = r.has('cmdb_ci') ? r.str('cmdb_ci') : '';
    const openOnCi =
      ci && incMeta?.columns.has('cmdb_ci') ? ctx.count('incident', `cmdb_ci=${ci}^active=true`) : 0;
    const prepared = prepareRecord(
      env,
      r,
      {
        fields: [
          'number',
          'short_description',
          'description',
          'type',
          'risk',
          'impact',
          'implementation_plan',
          'test_plan',
          'backout_plan',
          'start_date',
          'end_date',
          'assignment_group',
          'cmdb_ci',
        ],
      },
      `Task: explain the calculated risk of change ${r.has('number') ? r.str('number') : ''}.`,
      (rc) => {
        const f = rc.fields;
        const factors: string[] = [];
        if (f.impact) factors.push(`Impact is ${f.impact}.`);
        if (f.type) factors.push(`It is a ${f.type} change.`);
        factors.push(f.backout_plan ? 'A backout plan is documented.' : 'No backout plan is documented.');
        factors.push(f.test_plan ? 'A test plan is documented.' : 'No test plan is documented.');
        if (f.cmdb_ci)
          factors.push(
            `It affects ${f.cmdb_ci}${openOnCi ? `, which has ${openOnCi} open incident${openOnCi === 1 ? '' : 's'}` : ''}.`,
          );
        if (f.start_date && f.end_date) {
          const hours =
            (Date.parse(f.end_date.replace(' ', 'T')) - Date.parse(f.start_date.replace(' ', 'T'))) /
            3_600_000;
          if (Number.isFinite(hours) && hours > 0)
            factors.push(
              `The planned window is ${Math.round(hours * 10) / 10} hours${hours > 8 ? ', which is long' : ''}.`,
            );
        }
        const text = joinSections([
          `The calculated risk of ${rc.number} is ${f.risk ?? 'unknown'}.`,
          section('Contributing factors', factors),
          section(
            'Similar changes',
            similarLines.length ? similarLines.map((s) => s.line) : ['No similar past changes were found.'],
          ),
        ]);
        return {
          text,
          sections: {
            risk: f.risk ?? null,
            factors,
            similar_changes: similarLines.map((s) => ({ number: s.hit.number, incidents_caused: s.caused })),
          },
        };
      },
    );
    if (similarLines.length) {
      prepared.data += `\n<similar_changes>\n${similarLines.map((s) => `- ${escapeData(s.line)}`).join('\n')}\n</similar_changes>`;
      prepared.sources.push(
        ...similar.map((h) => ({
          table: h.table,
          sys_id: h.sys_id,
          number: h.number,
          title: h.title,
          score: h.score,
        })),
      );
    }
    if (openOnCi)
      prepared.data += `\n<ci_context>open incidents on the affected CI: ${openOnCi}</ci_context>`;
    return prepared;
  },
};

const isProblem = (meta: TableMeta) => meta.ancestors.includes('problem') || meta.columns.has('cause_notes');

const problemRca: SkillDef = {
  id: 'problem_rca_assist',
  label: 'Problem root cause analysis assist',
  description:
    'Assists root cause analysis: problem statement, timeline of linked incidents, probable causes with evidence, workaround and a known error draft.',
  kind: 'generation',
  defaultActive: false,
  defaultRoles: ['itil'],
  table: 'problem',
  needsRecord: true,
  appliesTo: isProblem,
  instructions: [
    'Assist the root cause analysis of the problem. Write these sections, each as a heading line:',
    'Problem statement; Timeline (dated bullets from the linked incidents, journal and state history);',
    'Probable causes (each cause followed by the evidence that supports it, citing record numbers from the data);',
    'Workaround; Suggested known error article (a title and a two-sentence summary).',
    'Only cite evidence present in the data and say when the evidence is weak. Keep it under 300 words.',
  ].join('\n'),
  prepare(env, rec) {
    const r = rec!;
    return prepareRecord(
      env,
      r,
      {
        fields: [
          'number',
          'short_description',
          'description',
          'state',
          'priority',
          'category',
          'cmdb_ci',
          'assignment_group',
          'cause_notes',
          'workaround',
          'fix_notes',
          'rfc',
          'first_reported_by_task',
        ],
        journal: ['work_notes', 'comments'],
        history: true,
        related: [
          {
            key: 'incidents',
            label: 'Linked incidents',
            table: 'incident',
            field: 'problem_id',
            fields: ['opened_at', 'state', 'priority', 'cmdb_ci', 'category'],
            limit: 50,
          },
          {
            key: 'problem_tasks',
            label: 'Problem tasks',
            table: 'problem_task',
            field: 'problem',
            fields: ['state'],
            limit: 20,
          },
        ],
      },
      `Task: assist the root cause analysis of problem ${r.has('number') ? r.str('number') : ''}.`,
      (rc) => {
        const f = rc.fields;
        const incidents = rc.related.incidents?.items ?? [];
        const dates = incidents
          .map((i) => i.values.opened_at)
          .filter(Boolean)
          .sort();
        const statement = `${issueText(rc)}${incidents.length ? ` ${incidents.length} linked incident${incidents.length === 1 ? '' : 's'}${dates.length ? ` between ${dates[0].slice(0, 10)} and ${dates[dates.length - 1].slice(0, 10)}` : ''}.` : ''}`;
        const timeline = [
          ...incidents
            .filter((i) => i.values.opened_at)
            .sort((a, b) => (a.values.opened_at < b.values.opened_at ? -1 : 1))
            .slice(0, 10)
            .map((i) => `${i.values.opened_at}: ${i.number} opened: ${i.title}`),
          ...rc.history.slice(-5),
        ];
        const causes: string[] = [];
        if (f.cause_notes)
          causes.push(`${firstSentence(f.cause_notes, 300)} (evidence: cause notes on ${rc.number})`);
        const noteCause = findCause(workNotes(rc));
        if (noteCause) causes.push(`${noteCause} (evidence: work notes on ${rc.number})`);
        const ciCounts = new Map<string, string[]>();
        for (const i of incidents) {
          const ci = i.values.cmdb_ci;
          if (ci) ciCounts.set(ci, [...(ciCounts.get(ci) ?? []), i.number]);
        }
        for (const [ci, nums] of [...ciCounts.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 2)) {
          if (nums.length >= 2)
            causes.push(
              `A fault on ${ci} (evidence: ${nums.length} of ${incidents.length} linked incidents affect it: ${nums.slice(0, 5).join(', ')})`,
            );
        }
        for (const t of recurringTerms(
          incidents.map((i) => i.title),
          Math.max(2, Math.ceil(incidents.length / 3)),
          3,
        )) {
          causes.push(
            `Recurring symptom "${t.term}" (evidence: mentioned in ${t.docs} of ${incidents.length} linked incidents)`,
          );
        }
        if (!causes.length)
          causes.push('Not enough evidence in the record yet; link incidents or add cause notes.');
        const workaround = f.workaround ?? 'No workaround recorded.';
        const kbTitle = `Known error: ${f.short_description ?? rc.number}`;
        const kbSummary = [
          f.cause_notes ? firstSentence(f.cause_notes) : '',
          f.workaround ? `Workaround: ${firstSentence(f.workaround)}` : 'No workaround is available yet.',
        ]
          .filter(Boolean)
          .join(' ');
        const text = joinSections([
          section('Problem statement', statement),
          section('Timeline', timeline.length ? timeline : ['No dated events recorded.']),
          section('Probable causes', causes),
          section('Workaround', workaround),
          section('Suggested known error article', `${kbTitle}\n${kbSummary}`),
        ]);
        return {
          text,
          sections: {
            problem_statement: statement,
            timeline,
            probable_causes: causes,
            workaround,
            suggested_known_error_article: { title: kbTitle, summary: kbSummary },
          },
        };
      },
      ['incidents'],
    );
  },
};

export const NO_ANSWER = 'I could not find an answer in the knowledge base.';

/** Sentences of an article that best match the question, in article order. */
function bestPassage(text: string, question: string, maxSentences = 3): string {
  const q = new Set(analyze(question));
  const all = sentences(text).filter((s) => s.length > 3);
  const scored = all.map((s, i) => {
    const terms = analyze(s);
    const hits = terms.filter((t) => q.has(t)).length;
    return { s, i, score: hits / Math.sqrt(terms.length + 1) };
  });
  const top = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, maxSentences);
  const chosen = (top.some((t) => t.score > 0) ? top.filter((t) => t.score > 0) : scored.slice(0, 2)).sort(
    (a, b) => a.i - b.i,
  );
  return truncate(chosen.map((c) => c.s).join(' '), 700);
}

const searchQa: SkillDef = {
  id: 'search_qa',
  label: 'Knowledge search Q&A',
  description:
    'Answers a question from published knowledge articles, with numbered citations; answers "no answer" when nothing relevant is found.',
  kind: 'qa',
  defaultActive: true,
  defaultRoles: ['snc_internal'],
  table: 'kb_knowledge',
  needsRecord: false,
  instructions: [
    "Answer the employee's question using only the numbered sources in <knowledge_sources>.",
    'Cite every source you use with its number in square brackets, for example [1].',
    `If the sources do not answer the question, reply exactly: "${NO_ANSWER}"`,
    'Keep the answer under 120 words, written for a non-technical employee.',
  ].join('\n'),
  prepare(env, _rec, input) {
    const question = sanitize(String(input.question ?? input.q ?? input.text ?? ''), 1000);
    if (!question) throw new SkillError(400, 'invalid_input', 'A question is required.');
    const hits = env.similarity.suggestKnowledge(env.ctx, question, { limit: 3 });
    const sources: SourceRef[] = [];
    const passages: { n: number; number: string; title: string; text: string }[] = [];
    for (const h of hits) {
      const art = env.ctx.get(h.table, h.sys_id);
      if (!art) continue;
      const passage = sanitize(bestPassage(plainText(art.str('text')) || h.title, question), 1500);
      const n = passages.length + 1;
      passages.push({ n, number: h.number, title: sanitize(h.title, 200), text: passage });
      sources.push({
        table: h.table,
        sys_id: h.sys_id,
        number: h.number,
        title: h.title,
        score: h.score,
        citation: n,
      });
    }
    const data = [
      `<question>\n${escapeData(question)}\n</question>`,
      '<knowledge_sources>',
      ...passages.map(
        (p) =>
          `<source id="${p.n}" number="${escapeData(p.number)}" title="${escapeData(p.title).replace(/"/g, "'")}">\n${escapeData(p.text)}\n</source>`,
      ),
      '</knowledge_sources>',
    ].join('\n');
    return {
      task: 'Task: answer the question from the knowledge sources, with citations.',
      data: truncate(data, env.maxChars),
      truncated: data.length > env.maxChars,
      sources,
      skipLlm: passages.length === 0,
      offline: () => {
        if (!passages.length) return { text: NO_ANSWER, sections: { answer: null } };
        const best = passages[0];
        const text = `${best.text} [${best.n}]\n\nSources:\n${passages.map((p) => `[${p.n}] ${p.number} ${p.title}`).join('\n')}`;
        return {
          text,
          sections: {
            answer: best.text,
            citations: passages.map((p) => ({ n: p.n, number: p.number, title: p.title })),
          },
        };
      },
    };
  },
};

export const SKILLS: ReadonlyMap<string, SkillDef> = new Map(
  [
    incidentSummarization,
    resolutionNotes,
    emailResponse,
    activityResponse,
    kbArticle,
    changeSummarization,
    changeRiskExplanation,
    problemRca,
    searchQa,
  ].map((s) => [s.id, s]),
);
