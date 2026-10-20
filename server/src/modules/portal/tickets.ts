import type { Context } from '../../engine/context.js';
import { AccessError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { diffMs, nowGlide } from '../../engine/util.js';
import { type ApprovalService, optionalService, SERVICES } from '../contracts.js';
import {
  EXT,
  LAYOUT_VARIABLE_TYPES,
  PROPS,
  SURVEY_OPEN,
  T,
  UR_AGENT_ROLES,
  UR_REASON,
  UR_STATE,
} from './constants.js';
import { type Lang, t } from './i18n.js';
import { closeUniversalRequest, isUniversalRequest, primaryOf, universalRequestOf } from './ur.js';
import {
  catalogService,
  hasColumn,
  hasTable,
  idList,
  isTicketParty,
  q,
  REQUESTER_FIELDS,
  refOf,
  userByName,
} from './util.js';

// ------------------------------------------------------------------ sources (My Tickets)

interface Source {
  table: string;
  /** Fields that make a record "mine" (requester or opener). */
  fields: string[];
  /** i18n key of the module label. */
  module: string;
  /** Only the table's own class (the generic task source). */
  exactClass?: boolean;
}

const SOURCES: Source[] = [
  { table: T.ur, fields: ['opened_for', 'opened_by'], module: 'module.general' },
  { table: EXT.incident, fields: ['caller_id', 'opened_by'], module: 'module.it_incident' },
  { table: EXT.ritm, fields: ['requested_for', 'opened_by'], module: 'module.it_request' },
  { table: EXT.request, fields: ['requested_for', 'opened_by'], module: 'module.request' },
  { table: 'problem', fields: ['opened_by'], module: 'module.problem' },
  { table: 'task', fields: ['opened_by'], module: 'module.general', exactClass: true },
];

const MODULE_BY_TABLE: Record<string, string> = Object.fromEntries(
  SOURCES.filter((s) => !s.exactClass).map((s) => [s.table, s.module]),
);

/** Roles that work tickets; they see department records directly and are not limited to their own tickets. */
export function isFulfiller(ctx: Context): boolean {
  return ctx.user.isSystem || ctx.hasAnyRole([...UR_AGENT_ROLES, 'admin']);
}

export type View = 'open' | 'closed' | 'all';
export type Badge =
  | 'submitted'
  | 'awaiting_approval'
  | 'in_progress'
  | 'action_needed'
  | 'closed'
  | 'cancelled';

export interface TicketQuery {
  view?: View;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: 'updated' | 'created' | 'number';
  order?: 'asc' | 'desc';
}

/** Open survey instances of the user by trigger record. */
export function pendingSurveysByTrigger(ctx: Context): Map<string, string> {
  const out = new Map<string, string>();
  const me = ctx.user.sysId;
  if (!me) return out;
  for (const inst of ctx
    .elevated()
    .query(T.instance, { query: `user=${me}^stateINready,wip^trigger_idISNOTEMPTY`, limit: 1000 })) {
    out.set(inst.str('trigger_id'), inst.sysId);
  }
  return out;
}

/** Tickets the user requested or that were opened for them, after the portal de-duplication rules. */
export function myTicketRecords(ctx: Context, opts: TicketQuery = {}): Rec[] {
  const me = ctx.user.sysId;
  if (!me) return [];
  const view = opts.view ?? 'open';
  const text = String(opts.q ?? '').trim();
  const recs: Rec[] = [];
  const seen = new Set<string>();
  for (const src of SOURCES) {
    if (!hasTable(ctx, src.table)) continue;
    const fields = src.fields.filter((f) => hasColumn(ctx, src.table, f));
    if (!fields.length) continue;
    const parts = [fields.map((f, i) => `${i ? '^OR' : ''}${f}=${me}`).join('')];
    if (src.exactClass) parts.push(`sys_class_name=${src.table}`);
    if (view === 'open') parts.push('active=true');
    if (view === 'closed') parts.push('active=false');
    if (text) parts.push(`numberSTARTSWITH${q(text)}^ORshort_descriptionLIKE${q(text)}`);
    let rows: Rec[] = [];
    try {
      rows = ctx.query(src.table, { query: `${parts.join('^')}^ORDERBYDESCsys_updated_on`, limit: 500 });
    } catch (e) {
      if (e instanceof AccessError) continue;
      throw e;
    }
    for (const r of rows) {
      if (seen.has(r.sysId)) continue;
      seen.add(r.sysId);
      recs.push(r);
    }
  }
  return dedupe(ctx, recs);
}

/** A record that belongs to one of my URs is replaced by that UR; a request is hidden behind its items. */
function dedupe(ctx: Context, recs: Rec[]): Rec[] {
  const me = ctx.user.sysId!;
  const sys = ctx.elevated();
  const urIds = new Set(
    recs
      .filter((r) => !isUniversalRequest(r) && r.has('universal_request') && r.str('universal_request'))
      .map((r) => r.str('universal_request')),
  );
  const myUrs = new Set<string>();
  if (urIds.size && hasTable(ctx, T.ur)) {
    for (const ur of sys.query(T.ur, {
      query: `sys_idIN${idList(urIds)}^opened_for=${me}^ORopened_by=${me}`,
    }))
      myUrs.add(ur.sysId);
  }
  const requestIds = recs.filter((r) => r.table.ancestors.includes(EXT.request)).map((r) => r.sysId);
  const requestsWithItems = new Set<string>();
  if (requestIds.length && hasTable(ctx, EXT.ritm) && hasColumn(ctx, EXT.ritm, 'request')) {
    const mine = ['requested_for', 'opened_by'].filter((f) => hasColumn(ctx, EXT.ritm, f));
    const who = mine.map((f, i) => `${i ? '^OR' : ''}${f}=${me}`).join('');
    for (const item of sys.query(EXT.ritm, {
      query: `requestIN${idList(requestIds)}${who ? `^${who}` : ''}`,
    }))
      requestsWithItems.add(item.str('request'));
  }
  return recs.filter((r) => {
    if (!isUniversalRequest(r) && r.has('universal_request') && myUrs.has(r.str('universal_request')))
      return false;
    if (r.table.ancestors.includes(EXT.request) && requestsWithItems.has(r.sysId)) return false;
    return true;
  });
}

function sortTickets(
  recs: Rec[],
  sort: TicketQuery['sort'] = 'updated',
  order: TicketQuery['order'] = 'desc',
): Rec[] {
  const key = (r: Rec) =>
    sort === 'number' ? r.str('number') : sort === 'created' ? createdOf(r) : r.str('sys_updated_on');
  const dir = order === 'asc' ? 1 : -1;
  return [...recs].sort(
    (a, b) => dir * key(a).localeCompare(key(b)) || dir * a.str('number').localeCompare(b.str('number')),
  );
}

function createdOf(rec: Rec): string {
  return (rec.has('opened_at') && rec.str('opened_at')) || rec.str('sys_created_on');
}

export function listMyTickets(ctx: Context, lang: Lang, opts: TicketQuery = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const all = sortTickets(myTicketRecords(ctx, opts), opts.sort, opts.order);
  const surveys = pendingSurveysByTrigger(ctx);
  return {
    total: all.length,
    limit,
    offset,
    view: opts.view ?? 'open',
    tickets: all.slice(offset, offset + limit).map((r) => ticketRow(ctx, r, lang, surveys)),
  };
}

/** One row of My Tickets / My Recent Items. */
export function ticketRow(ctx: Context, rec: Rec, lang: Lang, surveys: Map<string, string>) {
  const primary = isUniversalRequest(rec) ? primaryOf(ctx, rec) : null;
  const survey = surveys.get(rec.sysId) ?? null;
  return {
    table: rec.className,
    sys_id: rec.sysId,
    number: rec.str('number'),
    title: rec.str('short_description') || rec.str('number'),
    module: moduleOf(ctx, rec, primary, lang),
    state: stateOf(rec, primary, lang),
    created: createdOf(rec),
    updated: rec.str('sys_updated_on'),
    active: rec.bool('active'),
    survey_pending: !!survey,
    survey_instance: survey,
  };
}

function moduleOf(ctx: Context, rec: Rec, primary: Rec | null, lang: Lang): { key: string; label: string } {
  if (isUniversalRequest(rec)) {
    if (rec.str('department')) return { key: 'department', label: rec.display('department') };
    const via = primary
      ? MODULE_BY_TABLE[primary.table.ancestors.find((a) => MODULE_BY_TABLE[a] && a !== T.ur) ?? '']
      : undefined;
    const key = via ?? 'module.general';
    return { key, label: t(lang, key) };
  }
  const table = rec.table.ancestors.find((a) => MODULE_BY_TABLE[a]);
  if (table) return { key: MODULE_BY_TABLE[table], label: t(lang, MODULE_BY_TABLE[table]) };
  if (rec.className === 'task') return { key: 'module.general', label: t(lang, 'module.general') };
  return { key: `table.${rec.className}`, label: ctx.registry.table(rec.className).label };
}

/** User-facing state badge (one vocabulary for every ticket type). */
export function badgeOf(rec: Rec, primary: Rec | null = null): Badge {
  const anc = rec.table.ancestors;
  const state = rec.str('state');
  if (anc.includes(T.ur)) {
    if (state === UR_STATE.NEW) return 'submitted';
    if (state === UR_STATE.AWAITING) return 'action_needed';
    if (state === UR_STATE.CLOSED) return 'closed';
    if (state === UR_STATE.CANCELED) return 'cancelled';
    if (primary?.table.ancestors.includes(EXT.ritm) && primary.str('approval') === 'requested')
      return 'awaiting_approval';
    return 'in_progress';
  }
  if (anc.includes(EXT.incident)) {
    if (state === '1') return 'submitted';
    if (state === '3') return rec.str('hold_reason') === '1' ? 'action_needed' : 'in_progress';
    if (state === '6') return 'action_needed';
    if (state === '7') return 'closed';
    if (state === '8') return 'cancelled';
    return 'in_progress';
  }
  if (anc.includes(EXT.ritm)) {
    const stage = rec.str('stage');
    const approval = rec.str('approval');
    if (stage === 'Request Cancelled' || approval === 'rejected') return 'cancelled';
    if (!rec.bool('active')) return 'closed';
    if (approval === 'requested') return 'awaiting_approval';
    if ((stage === 'waiting_for_approval' || !stage) && state !== '2') return 'submitted';
    return 'in_progress';
  }
  if (anc.includes(EXT.request)) {
    const rs = rec.str('request_state');
    if (rs === 'closed_cancelled' || rs === 'closed_rejected') return 'cancelled';
    if (!rec.bool('active') || rs.startsWith('closed')) return 'closed';
    if (rs === 'requested' || rec.str('approval') === 'requested') return 'awaiting_approval';
    return 'in_progress';
  }
  if (!rec.bool('active')) return 'closed';
  if (rec.str('approval') === 'requested') return 'awaiting_approval';
  if (state === '' || state === '-5' || state === '1') return 'submitted';
  return 'in_progress';
}

function stateOf(rec: Rec, primary: Rec | null, lang: Lang) {
  const badge = badgeOf(rec, primary);
  return {
    value: rec.str('state'),
    label: rec.display('state'),
    badge,
    badge_label: t(lang, `badge.${badge}`),
  };
}

// ------------------------------------------------------------------ access

function isApproverOf(ctx: Context, rec: Rec): boolean {
  const me = ctx.user.sysId;
  if (!me || !hasTable(ctx, EXT.approval)) return false;
  const links = ['sysapproval', 'document_id'].filter((f) => hasColumn(ctx, EXT.approval, f));
  if (!links.length || !hasColumn(ctx, EXT.approval, 'approver')) return false;
  const which = links.map((f, i) => `${i ? '^OR' : ''}${f}=${rec.sysId}`).join('');
  return ctx.elevated().count(EXT.approval, `approver=${me}^${which}`) > 0;
}

/** Explicit portal check on top of ACLs: end users only see tickets they are a party to. */
export function canSeeTicket(ctx: Context, rec: Rec): boolean {
  if (isFulfiller(ctx)) return true;
  const me = ctx.user.sysId;
  if (!me) return false;
  if (isTicketParty(rec, me)) return true;
  const parent = rec.has('request') ? rec.ref('request') : null;
  if (parent && isTicketParty(parent, me)) return true;
  const ur = universalRequestOf(ctx, rec);
  if (ur && ur.sysId !== rec.sysId && isTicketParty(ur, me)) return true;
  return isApproverOf(ctx, rec);
}

/**
 * Loads a ticket for the portal. Unknown, unreadable or foreign tickets are reported as
 * not found (no existence leak). Requesters asking for the department record behind a
 * universal request get the universal request instead.
 */
export function loadPortalTicket(
  ctx: Context,
  table: string,
  sysId: string,
): { rec: Rec; redirectedFrom: { table: string; sys_id: string } | null } {
  if (!hasTable(ctx, table) || !ctx.registry.isA(table, 'task')) throw new NotFoundError();
  const rec = ctx.get(table, sysId);
  if (!rec || !canSeeTicket(ctx, rec)) throw new NotFoundError();
  if (!isUniversalRequest(rec) && !isFulfiller(ctx)) {
    const ur = universalRequestOf(ctx, rec);
    if (ur && isTicketParty(ur, ctx.user.sysId))
      return { rec: ur, redirectedFrom: { table: rec.className, sys_id: rec.sysId } };
  }
  return { rec, redirectedFrom: null };
}

// ------------------------------------------------------------------ detail

function field(lang: Lang, name: string, rec: Rec | null, path: string | null) {
  const has = !!rec && !!path && rec.has(path);
  return {
    name,
    label: t(lang, `ticket.summary.${name}`),
    value: has ? rec!.str(path!) : '',
    display_value: has ? rec!.display(path!) : '',
  };
}

function summaryOf(rec: Rec, primary: Rec | null, lang: Lang) {
  const work = primary ?? rec;
  const isItem = work.table.ancestors.includes(EXT.ritm);
  const item =
    isItem && work.has('cat_item') && work.str('cat_item')
      ? field(lang, 'item', work, 'cat_item')
      : { ...field(lang, 'item', rec, 'short_description'), value: '' };
  const requesterPath =
    ['opened_for', 'requested_for', 'caller_id', 'requested_by', 'opened_by'].find(
      (f) => rec.has(f) && rec.str(f),
    ) ?? null;
  let stage: ReturnType<typeof field>;
  if (isItem && work.has('stage')) stage = field(lang, 'stage', work, 'stage');
  else stage = field(lang, 'stage', work, 'state');
  if (isUniversalRequest(rec) && !primary) stage = field(lang, 'stage', rec, 'state');
  return [
    item,
    field(lang, 'requested_for', rec, requesterPath),
    field(lang, 'assignment_group', work, 'assignment_group'),
    field(lang, 'assigned_to', work, 'assigned_to'),
    stage,
  ];
}

/** Submitted catalog variables of a requested item (or answers of a record producer). */
export function submittedVariables(ctx: Context, rec: Rec | null): Record<string, unknown>[] {
  const out: { name: string; label: string; value: string; display_value: string }[] = [];
  if (!rec) return out;
  // The catalog module renders answers itself (masked variables, multi-row sets) when installed.
  const catalog = catalogService(ctx.platform);
  if (rec.table.ancestors.includes(EXT.ritm) && typeof catalog?.ticket === 'function') {
    try {
      const variables = catalog.ticket(ctx, EXT.ritm, rec.sysId).variables;
      if (Array.isArray(variables)) return variables as Record<string, unknown>[];
    } catch {
      // Not readable through the catalog API (for example a UR requester): use the generic reader.
    }
  }
  const sys = ctx.elevated();
  let answers: { question: Rec | null; value: string; order: number }[] = [];
  const optionsLinked =
    hasTable(ctx, EXT.itemOptionLink) &&
    hasTable(ctx, EXT.itemOption) &&
    rec.table.ancestors.includes(EXT.ritm);
  if (optionsLinked) {
    const links = sys.query(EXT.itemOptionLink, { query: `request_item=${rec.sysId}`, limit: 500 });
    const options = links.length
      ? sys.query(EXT.itemOption, {
          query: `sys_idIN${idList(links.map((l) => l.str('sc_item_option')))}`,
          limit: 500,
        })
      : [];
    answers = options.map((o) => ({
      question: o.ref('item_option_new'),
      value: o.str('value'),
      order: o.num('order') ?? 100,
    }));
  }
  if (!answers.length && hasTable(ctx, EXT.questionAnswer)) {
    answers = sys
      .query(EXT.questionAnswer, { query: `table_sys_id=${rec.sysId}`, limit: 500 })
      .map((a) => ({ question: a.ref('question'), value: a.str('value'), order: a.num('order') ?? 100 }));
  }
  answers.sort((a, b) => (a.question?.num('order') ?? a.order) - (b.question?.num('order') ?? b.order));
  for (const a of answers) {
    const qn = a.question;
    if (!a.value || (qn && (LAYOUT_VARIABLE_TYPES.has(qn.str('type')) || qn.bool('hidden')))) continue;
    let display = a.value;
    const refTable = qn?.has('reference') ? qn.str('reference') : '';
    if (refTable && hasTable(ctx, refTable))
      display = a.value
        .split(',')
        .map((id) => sys.displayOf(refTable, id) || id)
        .join(', ');
    else if (qn && hasTable(ctx, EXT.variableChoice)) {
      const choice = sys.first(EXT.variableChoice, `question=${qn.sysId}^value=${q(a.value)}`);
      if (choice) display = choice.str('text') || a.value;
    }
    out.push({
      name: qn?.str('name') ?? '',
      label: qn ? qn.str('question_text') || qn.str('name') : '',
      value: a.value,
      display_value: display,
    });
  }
  return out;
}

/** Customer-visible activity: comments only (never work notes), newest first. */
export function customerActivity(ctx: Context, rec: Rec, primary: Rec | null) {
  const limit = ctx.platform.properties.getNumber(PROPS.streamLimit, 100);
  const users = new Map<string, { sys_id: string | null; name: string }>();
  const entries = [rec, primary]
    .filter((r): r is Rec => !!r)
    .flatMap((r) =>
      ctx.platform.history.journal(r.className, r.sysId, ['comments']).map((j) => ({ ...j, source: r })),
    );
  entries.sort((a, b) => b.sys_created_on.localeCompare(a.sys_created_on));
  const kept: typeof entries = [];
  for (const e of entries) {
    // Comments synchronised between a UR and its primary ticket appear in both journals.
    const dup = kept.some(
      (k) =>
        k.value === e.value &&
        k.sys_created_by === e.sys_created_by &&
        Math.abs(diffMs(k.sys_created_on, e.sys_created_on)) <= 60_000,
    );
    if (!dup) kept.push(e);
  }
  return kept.slice(0, Math.max(1, limit)).map((e) => {
    const u = userByName(ctx, users, e.sys_created_by);
    return {
      type: 'comment',
      sys_id: e.sys_id,
      value: e.value,
      created_on: e.sys_created_on,
      created_by: e.sys_created_by,
      user_name: u.name,
      user_id: u.sys_id,
      is_me: !!u.sys_id && u.sys_id === ctx.user.sysId,
    };
  });
}

export function ticketAttachments(ctx: Context, rec: Rec, primary: Rec | null) {
  if (!hasTable(ctx, EXT.attachment)) return [];
  const ids = [rec.sysId, primary?.sysId].filter((x): x is string => !!x);
  return ctx
    .elevated()
    .query(EXT.attachment, { query: `table_sys_idIN${idList(ids)}^ORDERBYDESCsys_created_on`, limit: 200 })
    .map((a) => ({
      sys_id: a.sysId,
      file_name: a.str('file_name'),
      content_type: a.str('content_type'),
      size_bytes: a.num('size_bytes') ?? 0,
      created_on: a.str('sys_created_on'),
      created_by: a.str('sys_created_by'),
      download_url: `/api/app/portal/tickets/${rec.className}/${rec.sysId}/attachments/${a.sysId}`,
    }));
}

/** Attachment of a ticket (or of the primary ticket behind a UR), or null. */
export function ticketAttachment(ctx: Context, rec: Rec, attachmentId: string): Rec | null {
  if (!hasTable(ctx, EXT.attachment)) return null;
  const att = ctx.elevated().get(EXT.attachment, attachmentId);
  if (!att) return null;
  const owners = [rec.sysId];
  if (isUniversalRequest(rec) && rec.str('primary_task')) owners.push(rec.str('primary_task'));
  return owners.includes(att.str('table_sys_id')) ? att : null;
}

// ------------------------------------------------------------------ timeline

export type StepStatus = 'done' | 'current' | 'pending' | 'skipped' | 'cancelled';
export interface Step {
  key: string;
  label: string;
  status: StepStatus;
  at: string | null;
}

function firstTaskOpened(ctx: Context, ritm: Rec): string | null {
  if (!hasTable(ctx, EXT.catalogTask) || !hasColumn(ctx, EXT.catalogTask, 'request_item')) return null;
  const task = ctx
    .elevated()
    .first(EXT.catalogTask, `request_item=${ritm.sysId}`, [{ field: 'opened_at', desc: false }]);
  return task?.str('opened_at') || null;
}

/** Keeps the reached steps and ends with a red "Cancelled" step. */
function cancelledTimeline(steps: Step[], at: string | null, lang: Lang): Step[] {
  const reached = steps
    .filter((s) => s.status === 'done' || s.status === 'current')
    .map((s) => ({ ...s, status: 'done' as StepStatus }));
  return [...reached, { key: 'cancelled', label: t(lang, 'timeline.cancelled'), status: 'cancelled', at }];
}

/** Request timeline: Submitted, Awaiting Approval, Fulfillment, Closed (or the incident equivalent). */
export function timelineOf(ctx: Context, rec: Rec, primary: Rec | null, lang: Lang): Step[] {
  const step = (key: string, status: StepStatus, at: string | null = null): Step => ({
    key,
    label: t(lang, `timeline.${key}`),
    status,
    at: at || null,
  });
  const work = primary ?? rec;
  const submittedAt = createdOf(rec);
  const anc = work.table.ancestors;

  if (anc.includes(EXT.ritm)) {
    const approval = work.str('approval');
    const stage = work.str('stage');
    const active = work.bool('active');
    const cancelled =
      approval === 'rejected' ||
      stage === 'Request Cancelled' ||
      (isUniversalRequest(rec) && rec.str('state') === UR_STATE.CANCELED);
    let approvalStatus: StepStatus = 'skipped';
    if (approval === 'requested') approvalStatus = 'current';
    else if (['approved', 'rejected', 'cancelled'].includes(approval)) approvalStatus = 'done';
    else if (active && (stage === 'waiting_for_approval' || !stage)) approvalStatus = 'pending';
    let fulfilment: StepStatus = 'pending';
    if (stage === 'complete' || (!active && !cancelled)) fulfilment = 'done';
    else if (stage === 'fulfillment' || stage === 'delivery' || work.str('state') === '2')
      fulfilment = 'current';
    const steps = [
      step('submitted', 'done', submittedAt),
      step(
        'awaiting_approval',
        approvalStatus,
        approvalStatus === 'done' || approvalStatus === 'current' ? work.str('approval_set') : null,
      ),
      step('fulfillment', fulfilment, fulfilment === 'pending' ? null : firstTaskOpened(ctx, work)),
      step('closed', !active && !cancelled ? 'done' : 'pending', !active ? work.str('closed_at') : null),
    ];
    return cancelled ? cancelledTimeline(steps, work.str('closed_at'), lang) : steps;
  }

  if (anc.includes(EXT.incident)) {
    const state = work.str('state');
    const progressed = ['2', '3', '6', '7'].includes(state) || !!work.str('work_start');
    // A routed request is in progress as soon as its incident exists (state mapping).
    const working = state === '2' || state === '3' || (state === '1' && isUniversalRequest(rec));
    const steps = [
      step('submitted', 'done', submittedAt),
      step('in_progress', working ? 'current' : progressed ? 'done' : 'pending', work.str('work_start')),
      step(
        'resolved',
        state === '6' ? 'current' : state === '7' ? 'done' : 'pending',
        work.str('resolved_at'),
      ),
      step('closed', state === '7' ? 'done' : 'pending', state === '7' ? work.str('closed_at') : null),
    ];
    return state === '8' ? cancelledTimeline(steps, work.str('closed_at'), lang) : steps;
  }

  // Generic task, or a universal request that has not been routed yet.
  if (isUniversalRequest(rec) && rec.str('state') === UR_STATE.CANCELED) {
    const progressed = !!rec.str('primary_task') || !!rec.str('work_start');
    return cancelledTimeline(
      [step('submitted', 'done', submittedAt), step('in_progress', progressed ? 'done' : 'pending')],
      rec.str('closed_at'),
      lang,
    );
  }
  const active = rec.bool('active');
  const fresh = isUniversalRequest(rec)
    ? rec.str('state') === UR_STATE.NEW
    : ['', '-5', '1'].includes(work.str('state'));
  return [
    step('submitted', 'done', submittedAt),
    step('in_progress', !active ? 'done' : fresh ? 'pending' : 'current', null),
    step(
      'closed',
      active ? 'pending' : 'done',
      active ? null : work.str('closed_at') || rec.str('closed_at'),
    ),
  ];
}

// ------------------------------------------------------------------ actions

export interface PortalAction {
  name: string;
  label: string;
  style: 'primary' | 'default' | 'destructive';
  comment: 'none' | 'optional' | 'required';
}

/**
 * How the user relates to a ticket for requester-side actions: the person it is for, the person who
 * raised it, or neither (watchers, approvers and agents only comment from the portal).
 */
function requesterRole(ctx: Context, rec: Rec): 'requester' | 'opener' | null {
  const me = ctx.user.sysId;
  if (!me) return null;
  const records = [rec];
  const ur = universalRequestOf(ctx, rec);
  if (ur && ur.sysId !== rec.sysId) records.push(ur);
  if (records.some((r) => REQUESTER_FIELDS.some((f) => r.has(f) && r.str(f) === me))) return 'requester';
  if (records.some((r) => r.has('opened_by') && r.str('opened_by') === me)) return 'opener';
  return null;
}

/** Actions offered on the portal ticket page (requester-side lifecycle only). */
export function availableActions(ctx: Context, rec: Rec, primary: Rec | null, lang: Lang): PortalAction[] {
  const out: PortalAction[] = [];
  const a = (
    name: string,
    labelKey: string,
    style: PortalAction['style'],
    comment: PortalAction['comment'],
  ) => out.push({ name, label: t(lang, labelKey), style, comment });
  if (rec.bool('active')) a('comment', 'action.comment', 'default', 'required');
  const role = requesterRole(ctx, rec);
  if (!role) return out;
  const work = primary ?? rec;
  const anc = work.table.ancestors;
  if (anc.includes(EXT.incident) && work.str('major_incident_state') !== 'accepted') {
    const state = work.str('state');
    if (['1', '2', '3'].includes(state)) a('resolve', 'action.resolve', 'default', 'optional');
    if (state === '6') {
      // Accepting the solution is the requester's decision; the opener may still reject it.
      if (role === 'requester') a('accept', 'action.accept', 'primary', 'optional');
      a('reopen', 'action.reopen', 'default', 'required');
    }
  }
  if (
    anc.includes(EXT.ritm) &&
    work.bool('active') &&
    work.str('stage') === 'waiting_for_approval' &&
    work.str('approval') !== 'approved'
  ) {
    a('cancel', 'action.cancel', 'destructive', 'optional');
  }
  if (isUniversalRequest(rec) && rec.bool('active')) {
    if (!primary && rec.str('state') === UR_STATE.NEW)
      a('cancel', 'action.cancel', 'destructive', 'optional');
    if (
      role === 'requester' &&
      rec.str('state') === UR_STATE.AWAITING &&
      rec.str('state_reason') === UR_REASON.CONFIRM &&
      !primary?.bool('active')
    ) {
      a('confirm', 'action.confirm', 'primary', 'optional');
    }
  }
  return out;
}

const ACTION_ALIASES: Record<string, string> = {
  close: 'accept',
  confirm_resolution: 'confirm',
  reject: 'reopen',
};

/** Runs a portal action as the user (business rules see the requester; ACLs were checked by the portal). */
export function runPortalAction(
  ctx: Context,
  rec: Rec,
  rawName: string,
  comment: string,
  lang: Lang,
): string {
  const name = ACTION_ALIASES[rawName] ?? rawName;
  const primary = isUniversalRequest(rec) ? primaryOf(ctx, rec) : null;
  const action = availableActions(ctx, rec, primary, lang).find((x) => x.name === name);
  if (!action || name === 'comment')
    throw new AccessError('Action not available', `${rawName} is not available for ${rec.str('number')}`);
  const text = comment.trim();
  if (action.comment === 'required' && !text) throw new InvalidError('A comment is required for this action');
  const sys = ctx.elevated();
  const work = primary ?? rec;
  const withComment = (values: Record<string, unknown>) => (text ? { ...values, comments: text } : values);
  switch (name) {
    case 'resolve':
      sys.update(
        work,
        withComment({
          state: '6',
          close_code: 'Resolved by caller',
          close_notes: text || 'Resolved by the requester from the portal',
        }),
      );
      break;
    case 'reopen':
      sys.update(work, withComment({ state: '2' }));
      break;
    case 'accept':
      sys.update(work, withComment({ state: '7' }));
      break;
    case 'confirm':
      closeUniversalRequest(ctx, rec, text);
      break;
    case 'cancel':
      cancelTicket(ctx, rec, primary, text);
      break;
    default:
      throw new AccessError('Action not available');
  }
  return `${rec.str('number')}: ${action.label}`;
}

function cancelTicket(ctx: Context, rec: Rec, primary: Rec | null, text: string): void {
  const sys = ctx.elevated();
  const work = primary ?? rec;
  if (work.table.ancestors.includes(EXT.ritm)) {
    const reason = text || 'Cancelled by the requester from the portal';
    const catalog = catalogService(ctx.platform);
    if (typeof catalog?.cancel === 'function') {
      // The catalog stops approvals and tasks; the requester's reason stays customer visible.
      sys.update(work, { comments: reason });
      catalog.cancel(sys, sys.get(work.className, work.sysId) ?? work, reason);
    } else {
      sys.update(work, { state: '4', stage: 'Request Cancelled', comments: reason });
      const approvals = optionalService<ApprovalService>(ctx.platform, SERVICES.approvals);
      const fresh = approvals ? sys.get(work.className, work.sysId) : null;
      if (approvals && fresh) approvals.cancel(sys, fresh, 'Cancelled by the requester');
    }
  }
  if (isUniversalRequest(rec)) {
    const ur = sys.get(T.ur, rec.sysId) ?? rec;
    // Comments already reached the primary ticket; the UR records the cancellation itself.
    closeUniversalRequest(ctx, ur, primary ? '' : text, UR_STATE.CANCELED);
  }
}

/** Adds a requester comment (as the user; the UR hooks copy it to the primary ticket). */
export function addPortalComment(ctx: Context, rec: Rec, comment: string): void {
  const text = comment.trim();
  if (!text) throw new InvalidError('A comment is required');
  if (!rec.bool('active'))
    throw new InvalidError('This ticket is closed', 'Comments can only be added to open tickets');
  if (!rec.has('comments')) throw new InvalidError('This ticket does not accept comments');
  ctx.elevated().update(rec, { comments: text });
}

/** Full payload of the portal ticket page. */
export function ticketDetail(
  ctx: Context,
  rec: Rec,
  lang: Lang,
  redirectedFrom: { table: string; sys_id: string } | null,
) {
  const primary = isUniversalRequest(rec) ? primaryOf(ctx, rec) : null;
  const surveys = pendingSurveysByTrigger(ctx);
  const row = ticketRow(ctx, rec, lang, surveys);
  const work = primary ?? rec;
  const actions = availableActions(ctx, rec, primary, lang);
  return {
    table: rec.className,
    sys_id: rec.sysId,
    number: row.number,
    title: row.title,
    description: rec.str('description'),
    module: row.module,
    header: { number: row.number, created: row.created, updated: row.updated, state: row.state },
    summary: summaryOf(rec, primary, lang),
    variables: submittedVariables(
      ctx,
      work.table.ancestors.includes(EXT.ritm) || !isUniversalRequest(rec) ? work : null,
    ),
    activity: customerActivity(ctx, rec, primary),
    attachments: ticketAttachments(ctx, rec, primary),
    timeline: timelineOf(ctx, rec, primary, lang),
    actions,
    can_comment: actions.some((a) => a.name === 'comment'),
    survey: row.survey_instance ? { instance_id: row.survey_instance } : null,
    primary:
      primary && isFulfiller(ctx)
        ? { table: primary.className, sys_id: primary.sysId, number: primary.str('number') }
        : null,
    redirected_from: redirectedFrom,
    opened_for: refOf(
      rec,
      ['opened_for', 'requested_for', 'caller_id', 'opened_by'].find((f) => rec.has(f) && rec.str(f)) ??
        'opened_by',
    ),
    requested_by: refOf(rec, 'opened_by'),
    active: rec.bool('active'),
  };
}

// ------------------------------------------------------------------ approvals (To-dos)

function approvalTarget(ctx: Context, approval: Rec): Rec | null {
  const sys = ctx.elevated();
  if (approval.has('sysapproval') && approval.str('sysapproval')) {
    const target = sys.get('task', approval.str('sysapproval'));
    if (target) return target;
  }
  const table = approval.has('source_table') ? approval.str('source_table') : '';
  const id = approval.has('document_id') ? approval.str('document_id') : '';
  return table && id && hasTable(ctx, table) ? sys.get(table, id) : null;
}

/** Users whose approvals the current user may act on (self plus active approval delegations). */
function approverIds(ctx: Context): string[] {
  const me = ctx.user.sysId;
  if (!me) return [];
  const ids = [me];
  if (hasTable(ctx, 'sys_user_delegate')) {
    const now = nowGlide();
    for (const d of ctx
      .elevated()
      .query('sys_user_delegate', { query: `delegate=${me}^approvals=true`, limit: 100 })) {
      const starts = d.str('starts');
      const ends = d.str('ends');
      if ((starts && starts > now) || (ends && ends < now)) continue;
      ids.push(d.str('user'));
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

export function pendingApprovalRecords(ctx: Context): Rec[] {
  if (!hasTable(ctx, EXT.approval) || !hasColumn(ctx, EXT.approval, 'approver')) return [];
  const ids = approverIds(ctx);
  if (!ids.length) return [];
  return ctx.elevated().query(EXT.approval, {
    query: `approverIN${idList(ids)}^state=requested^ORDERBYsys_created_on`,
    limit: 200,
  });
}

export function approvalJson(ctx: Context, approval: Rec) {
  const target = approvalTarget(ctx, approval);
  return {
    sys_id: approval.sysId,
    state: { value: approval.str('state'), label: approval.display('state') },
    created: approval.str('sys_created_on'),
    due_date: approval.has('due_date') ? approval.str('due_date') : '',
    approver: refOf(approval, 'approver'),
    on_behalf_of: approval.str('approver') !== ctx.user.sysId ? refOf(approval, 'approver') : null,
    target: target
      ? {
          table: target.className,
          table_label: target.table.label,
          sys_id: target.sysId,
          number: target.str('number'),
          title: target.str('short_description') || target.displayValue(),
          requested_for: refOf(
            target,
            ['requested_for', 'opened_for', 'caller_id', 'opened_by'].find(
              (f) => target.has(f) && target.str(f),
            ) ?? 'opened_by',
          ),
          item: target.has('cat_item') ? refOf(target, 'cat_item') : null,
          price: target.has('price') ? target.str('price') : '',
          variables: submittedVariables(ctx, target).slice(0, 10),
        }
      : null,
  };
}

/** Approves or rejects an approval the user owns (or holds through a delegation). */
export function decideApproval(
  ctx: Context,
  approvalId: string,
  decision: 'approved' | 'rejected',
  comment: string,
): Rec {
  if (!hasTable(ctx, EXT.approval)) throw new NotFoundError();
  const approval = ctx.elevated().get(EXT.approval, approvalId);
  if (!approval || !approverIds(ctx).includes(approval.str('approver'))) throw new NotFoundError();
  if (approval.str('state') !== 'requested') throw new InvalidError('This approval has already been decided');
  if (decision === 'rejected' && !comment.trim()) throw new InvalidError('A comment is required to reject');
  const service = optionalService<ApprovalService>(ctx.platform, SERVICES.approvals);
  if (service) service.decide(ctx.elevated(), approval, decision, comment.trim() || undefined);
  else
    ctx
      .elevated()
      .update(approval, { state: decision, ...(comment.trim() ? { comments: comment.trim() } : {}) });
  return ctx.elevated().get(EXT.approval, approvalId) ?? approval;
}

/** Open tasks assigned to an end user (for example a "pick up your laptop" catalog task). */
export function myAssignedTasks(ctx: Context): Rec[] {
  const me = ctx.user.sysId;
  if (!me || isFulfiller(ctx)) return [];
  return ctx.elevated().query('task', { query: `assigned_to=${me}^active=true^ORDERBYdue_date`, limit: 100 });
}

/** Number of open survey instances of the user. */
export function pendingSurveyCount(ctx: Context): number {
  const me = ctx.user.sysId;
  return me ? ctx.elevated().count(T.instance, `user=${me}^stateIN${SURVEY_OPEN.join(',')}`) : 0;
}
