import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { T } from './constants.js';
import { csv, DAY_MS, groupMembers } from './util.js';

/** Default agenda filter: changes that need CAB and are awaiting or past authorization. */
export const DEFAULT_CAB_CONDITION = 'active=true^cab_required=true^stateIN-4,-3,-2';

function agendaWindow(meeting: Rec): { after: string; until: string } {
  const start = meeting.str('start');
  const after = meeting.str('changes_start_after') || start;
  const until = meeting.str('changes_start_on_or_before') || addMs(start, 7 * DAY_MS);
  return { after, until };
}

/**
 * Refresh agenda: adds active changes matching the meeting's change condition whose
 * planned start falls in the meeting window, and invites board members and requesters.
 * Returns the number of agenda items added.
 */
export function refreshAgenda(ctx: Context, meeting: Rec): number {
  const state = meeting.str('state');
  if (state === 'complete' || state === 'canceled')
    throw new InvalidError('The agenda of a completed or canceled meeting cannot change');
  const sys = ctx.elevated();
  const condition = meeting.str('change_condition') || DEFAULT_CAB_CONDITION;
  const { after, until } = agendaWindow(meeting);
  const dateFilter = meeting.bool('use_filter_dates') ? '' : `^start_date>${after}^start_date<=${until}`;
  const changes = sys.query(T.change, {
    query: `${condition}${dateFilter}`,
    orderBy: [{ field: 'start_date', desc: false }],
  });
  const existing = new Set(sys.query(T.agendaItem, `meeting=${meeting.sysId}`).map((i) => i.str('task')));
  let order = sys.count(T.agendaItem, `meeting=${meeting.sysId}`) * 10;
  let added = 0;
  for (const change of changes) {
    if (existing.has(change.sysId)) continue;
    order += 10;
    const preapproved = change.str('type') === 'standard';
    sys.insert(T.agendaItem, {
      meeting: meeting.sysId,
      task: change.sysId,
      order,
      short_description: `${change.str('number')}: ${change.str('short_description')}`,
      state: preapproved && meeting.bool('complete_preapproved') ? 'complete' : 'pending',
      allotted_time: meeting.num('time_per_agenda_item') ?? 600000,
      notification_recipients: change.str('requested_by') || null,
    });
    added++;
  }
  inviteAttendees(ctx, meeting);
  return added;
}

/** Attendees: manager, delegates, board members, members of board groups and change requesters. */
export function inviteAttendees(ctx: Context, meeting: Rec): number {
  const sys = ctx.elevated();
  const wanted = new Map<string, string>();
  const add = (user: string, type: string) => {
    if (user && !wanted.has(user)) wanted.set(user, type);
  };
  add(meeting.str('manager'), 'manager');
  for (const u of csv(meeting.str('delegates'))) add(u, 'delegate');
  for (const u of csv(meeting.str('board_members'))) add(u, 'board_member');
  for (const g of csv(meeting.str('board_groups')))
    for (const u of groupMembers(ctx, g)) add(u, 'board_member');
  for (const item of sys.query(T.agendaItem, `meeting=${meeting.sysId}`)) {
    const change = item.ref('task');
    if (change?.str('requested_by')) add(change.str('requested_by'), 'requester');
  }
  const existing = new Set(sys.query(T.attendee, `meeting=${meeting.sysId}`).map((a) => a.str('attendee')));
  let invited = 0;
  for (const [user, type] of wanted) {
    if (existing.has(user)) continue;
    sys.insert(T.attendee, { meeting: meeting.sysId, attendee: user, attendee_type: type });
    invited++;
  }
  if (invited) ctx.queueEvent('cab.meeting.invite', meeting, String(invited), null);
  return invited;
}

export function setMeetingState(
  ctx: Context,
  meeting: Rec,
  state: 'in_progress' | 'complete' | 'canceled',
): Rec {
  const current = meeting.str('state');
  const allowed: Record<string, string[]> = {
    in_progress: ['pending'],
    complete: ['in_progress'],
    canceled: ['pending'],
  };
  if (!allowed[state].includes(current)) {
    throw new InvalidError(
      `A ${current.replace('_', ' ')} meeting cannot move to ${state.replace('_', ' ')}`,
    );
  }
  const values: Record<string, unknown> = { state };
  if (state === 'in_progress' && !meeting.str('host')) values.host = ctx.user.sysId;
  ctx.update(meeting, values);
  return ctx.elevated().get(T.cabMeeting, meeting.sysId) ?? meeting;
}

/** Agenda item added: the change takes the meeting date as its CAB date. */
export function onAgendaItemAdded(ctx: Context, item: Rec): void {
  const sys = ctx.elevated();
  const meeting = item.ref('meeting');
  const change = sys.get(T.change, item.str('task'));
  if (!meeting || !change) return;
  const start = meeting.str('start');
  sys.derive({ workflow: false }).update(change, { cab_date: start.slice(0, 10), cab_date_time: start });
  ctx.queueEvent('cab.agenda_item.added', item, change.str('requested_by') || null, change.str('number'));
}

/** Agenda decision: noted on the change when the meeting records decisions automatically. */
export function onAgendaDecision(ctx: Context, item: Rec): void {
  const decision = item.str('decision');
  if (!decision) return;
  const meeting = item.ref('meeting');
  const sys = ctx.elevated();
  const change = sys.get(T.change, item.str('task'));
  if (!meeting || !change) return;
  if (item.str('state') !== 'complete') sys.derive({ workflow: false }).update(item, { state: 'complete' });
  if (!meeting.bool('auto_add_agenda_decisions')) return;
  const label = item.display('decision');
  const manager = meeting.display('manager') || ctx.user.name;
  sys.update(change, {
    work_notes: `(CAB Automation) - ${change.str('number')} - ${label} - ${manager} - ${nowGlide()} UTC`,
    cab_recommendation: change.str('cab_recommendation') || `CAB decision: ${label}`,
  });
}
