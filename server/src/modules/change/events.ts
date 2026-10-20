import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { EventHandlerDef } from '../../engine/services/events.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { type NotificationService, optionalService, SERVICES } from '../contracts.js';
import { MODEL_IDS, PROP, STATE, stateLabel, T } from './constants.js';
import { evaluateAutomaticTransitions } from './transitions.js';
import { groupByName } from './util.js';

export const changeEvents = [
  { name: 'change_request.inserted', table: T.change, description: 'A change request was created' },
  { name: 'change_request.updated', table: T.change, description: 'A change request was updated' },
  {
    name: 'change.state_changed',
    table: T.change,
    description: 'Change state changed (parm1: new state, parm2: previous state)',
  },
  {
    name: 'change.approval_requested',
    table: T.change,
    description: 'Approval was requested for a change (parm1: state)',
  },
  {
    name: 'change.approved',
    table: T.change,
    description: 'An approval stage of a change was approved (parm1: state)',
  },
  {
    name: 'change.rejected',
    table: T.change,
    description: 'A change was rejected (parm1: state it was rejected in)',
  },
  { name: 'change.canceled', table: T.change, description: 'A change was canceled' },
  { name: 'change.closed', table: T.change, description: 'A change was closed (parm1: close code)' },
  { name: 'change.on_hold', table: T.change, description: 'A change was put on hold (parm1: reason)' },
  { name: 'change.released', table: T.change, description: 'A change on hold was released' },
  {
    name: 'change.conflict_detected',
    table: T.change,
    description: 'Conflict detection found conflicts (parm1: count)',
  },
  {
    name: 'change.unauthorized.created',
    table: T.change,
    description: 'An unauthorized change was recorded (parm1: CI)',
  },
  {
    name: 'sn_change.state.updated',
    table: T.change,
    description: 'Change state updated (enabled by resolvr.change.event.state_updated.enabled)',
  },
  {
    name: 'change_model.evaluate',
    table: T.change,
    description: 'Evaluate automatic model transitions (parm1: change sys_id)',
  },
  {
    name: 'ci.change.unplanned',
    description: 'A configuration item changed outside a valid change (parm1: CI sys_id, parm2: details)',
  },
  {
    name: 'change_task.assigned',
    table: T.task,
    description: 'A change task was assigned (parm1: assignee)',
  },
  {
    name: 'cab.meeting.invite',
    table: T.cabMeeting,
    description: 'CAB attendees were invited (parm1: count)',
  },
  {
    name: 'cab.agenda_item.added',
    table: T.agendaItem,
    description: 'A change was added to a CAB agenda (parm1: requester, parm2: change number)',
  },
  {
    name: 'std_change_proposal.approved',
    table: T.proposal,
    description: 'A standard change proposal was approved',
  },
  {
    name: 'std_change_proposal.rejected',
    table: T.proposal,
    description: 'A standard change proposal was rejected',
  },
];

/**
 * Records an unauthorized change for a configuration item that changed outside a valid
 * change. Returns null when one was recorded recently or a valid change covers the CI.
 */
export function createUnauthorizedChange(ctx: Context, ciId: string, details = ''): Rec | null {
  if (!ciId) return null;
  const props = ctx.platform.properties;
  const sys = ctx.elevated();
  const hours = props.getNumber(PROP.unauthorizedIgnoreHours, 24);
  const since = addMs(nowGlide(), -hours * 3_600_000);
  if (sys.count(T.change, `cmdb_ci=${ciId}^unauthorized=true^sys_created_on>=${since}`) > 0) return null;
  const valid = props.get(PROP.unauthorizedValidQuery, 'active=true^stateIN-1,0') ?? '';
  if (valid && sys.count(T.change, `cmdb_ci=${ciId}^${valid}`) > 0) return null;
  const mgmt = groupByName(ctx, props.get(PROP.managementGroup, 'Change Management') ?? 'Change Management');
  const ci = ctx.registry.has('cmdb_ci') ? sys.get('cmdb_ci', ciId) : null;
  const name = ci?.displayValue() || ciId;
  return sys.insert(T.change, {
    chg_model: MODEL_IDS.unauthorized,
    cmdb_ci: ciId,
    assignment_group: mgmt?.sysId ?? null,
    short_description: `Unauthorized change detected on ${name}`,
    description: details || `Configuration item ${name} changed without an authorized change.`,
    unauthorized: true,
  });
}

export const changeEventHandlers: EventHandlerDef[] = [
  {
    event: 'change_model.evaluate',
    name: 'Change: evaluate model transitions',
    run(ev, _rec, ctx) {
      const id = ev.parm1 || ev.instance;
      if (id) evaluateAutomaticTransitions(ctx, id);
    },
  },
  {
    event: 'ci.change.unplanned',
    name: 'Change: record unauthorized change',
    run(ev, _rec, ctx) {
      if (!ctx.platform.properties.getBool(PROP.unauthorizedEnabled, false)) return;
      createUnauthorizedChange(ctx, ev.parm1 ?? '', ev.parm2 ?? '');
    },
  },
  {
    event: 'change.state_changed',
    name: 'Change: notify the requester of state changes',
    run(ev, rec, ctx) {
      if (!rec || !ctx.platform.properties.getBool(PROP.notifyStateChange, true)) return;
      const state = Number(ev.parm1);
      if (![STATE.SCHEDULED, STATE.IMPLEMENT, STATE.REVIEW, STATE.CANCELED].includes(state as -2)) return;
      const notifier = optionalService<NotificationService>(ctx.platform, SERVICES.notifications);
      const requester = rec.str('requested_by');
      if (!notifier || !requester || requester === ev.user_id) return;
      const label = stateLabel(state);
      notifier.send(ctx, {
        to: [requester],
        subject: `${rec.str('number')} is now ${label}`,
        body: `<p>Your change ${rec.str('number')} (${rec.str('short_description')}) moved to <strong>${label}</strong>.</p>`,
        target: rec,
        notification: 'Change request state change',
      });
    },
  },
];
