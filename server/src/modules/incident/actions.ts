import type { Context } from '../../engine/context.js';
import { AbortError } from '../../engine/errors.js';
import type { UiActionDef } from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import { INC_STATE, MIM_STATE } from './constants.js';
import {
  addCommunicationTask,
  closeCommunicationPlan,
  closeCommunicationTask,
  createCommunicationPlan,
  sendCommunication,
} from './icm.js';
import {
  canClose,
  canReopen,
  canResolve,
  closeIncident,
  copyIncident,
  reopenIncident,
  resolveIncident,
} from './lifecycle.js';
import {
  demoteMajorIncident,
  linkToMajorIncident,
  promoteMajorIncident,
  proposeMajorIncident,
  regeneratePirTimeline,
  rejectMajorIncident,
} from './mim.js';
import { beginOutageNow, endOutageNow, OUTAGE_TASK_CLASSES } from './outage.js';
import { propBool } from './util.js';

const text = (input: Record<string, unknown>, field: string): string => String(input[field] ?? '').trim();
const recordRoute = (table: string, sysId: string) => `/workspace/record/${table}/${sysId}`;
const isOpenIncident = (rec: Rec) =>
  [INC_STATE.NEW, INC_STATE.IN_PROGRESS, INC_STATE.ON_HOLD].includes(rec.str('state') as '1');
const mimState = (rec: Rec) => rec.str('major_incident_state');
const AGENTS = ['itil', 'sn_incident_write'];
const MIM_MANAGERS = ['major_incident_manager'];

/** New-record form prefilled through sysparm_query (values must not contain '^'). */
function newFormRoute(table: string, values: Record<string, string>): string {
  const q = Object.entries(values)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v.replace(/\^/g, ' ')}`)
    .join('^');
  return `/workspace/record/${table}/-1?sysparm_query=${encodeURIComponent(q)}`;
}

const reason = (label = 'Reason') => [{ field: 'work_notes', label, mandatory: true }];

const incidentActions: UiActionDef[] = [
  {
    id: 'incident.resolve',
    table: 'incident',
    label: 'Resolve',
    actionName: 'resolve_incident',
    style: 'primary',
    order: 10,
    condition: canResolve,
    prompt: [
      { field: 'close_code', mandatory: true },
      { field: 'close_notes', mandatory: true },
    ],
    run(rec, ctx, input) {
      resolveIncident(ctx, rec, {
        close_code: text(input, 'close_code'),
        close_notes: text(input, 'close_notes'),
      });
      return { message: `${rec.str('number')} resolved` };
    },
  },
  {
    id: 'incident.reopen',
    table: 'incident',
    label: 'Reopen',
    actionName: 'reopen_incident',
    style: 'primary',
    order: 20,
    condition: canReopen,
    prompt: [{ field: 'comments', label: 'Why does the issue need more work?', mandatory: false }],
    run(rec, ctx, input) {
      reopenIncident(ctx, rec, { comments: text(input, 'comments') });
      return { message: `${rec.str('number')} reopened` };
    },
  },
  {
    id: 'incident.close',
    table: 'incident',
    label: 'Close Incident',
    actionName: 'close_incident',
    order: 30,
    condition: canClose,
    run(rec, ctx) {
      closeIncident(ctx, rec);
      return { message: `${rec.str('number')} closed` };
    },
  },
  {
    id: 'incident.propose_major',
    table: 'incident',
    label: 'Propose Major Incident',
    order: 200,
    roles: AGENTS,
    condition: (rec) =>
      isOpenIncident(rec) && ![MIM_STATE.PROPOSED, MIM_STATE.ACCEPTED].includes(mimState(rec) as 'proposed'),
    prompt: [...reason('Why is this a major incident?'), { field: 'business_impact', mandatory: true }],
    run(rec, ctx, input) {
      proposeMajorIncident(ctx, rec, {
        reason: text(input, 'work_notes'),
        business_impact: text(input, 'business_impact'),
      });
      return { message: 'Proposed as a major incident candidate' };
    },
  },
  {
    id: 'incident.promote_major',
    table: 'incident',
    label: 'Promote to Major Incident',
    order: 210,
    roles: MIM_MANAGERS,
    condition: (rec) => isOpenIncident(rec) && mimState(rec) !== MIM_STATE.ACCEPTED,
    prompt: [...reason('Promotion notes'), { field: 'business_impact', mandatory: true }],
    run(rec, ctx, input) {
      const mi = promoteMajorIncident(ctx, rec, {
        reason: text(input, 'work_notes'),
        business_impact: text(input, 'business_impact'),
      });
      return mi.sysId === rec.sysId
        ? { message: 'Promoted to major incident' }
        : {
            message: `Major incident ${mi.str('number')} created`,
            redirect: recordRoute('incident', mi.sysId),
          };
    },
  },
  {
    id: 'incident.reject_major',
    table: 'incident',
    label: 'Reject Major Incident Candidate',
    order: 220,
    list: true,
    roles: MIM_MANAGERS,
    condition: (rec) => mimState(rec) === MIM_STATE.PROPOSED,
    prompt: reason('Rejection reason'),
    run(rec, ctx, input) {
      rejectMajorIncident(ctx, rec, text(input, 'work_notes'));
      return { message: 'Major incident candidate rejected' };
    },
  },
  {
    id: 'incident.demote_major',
    table: 'incident',
    label: 'Demote Major Incident',
    order: 230,
    roles: MIM_MANAGERS,
    condition: (rec) => mimState(rec) === MIM_STATE.ACCEPTED,
    prompt: reason('Demotion reason'),
    run(rec, ctx, input) {
      demoteMajorIncident(ctx, rec, text(input, 'work_notes'));
      return { message: 'Major incident demoted' };
    },
  },
  {
    id: 'incident.link_major',
    table: 'incident',
    label: 'Link to Major Incident',
    order: 240,
    list: true,
    roles: AGENTS,
    condition: (rec) => rec.bool('active') && !mimState(rec),
    prompt: [{ field: 'parent_incident', label: 'Major incident', mandatory: true }],
    run(rec, ctx, input) {
      linkToMajorIncident(ctx, rec, text(input, 'parent_incident'));
      return { message: 'Linked to the major incident' };
    },
  },
  {
    id: 'incident.regenerate_pir',
    table: 'incident',
    label: 'Regenerate PIR Timeline',
    order: 250,
    roles: MIM_MANAGERS,
    condition: (rec) => mimState(rec) === MIM_STATE.ACCEPTED && rec.str('state') === INC_STATE.RESOLVED,
    run(rec, ctx) {
      regeneratePirTimeline(ctx, rec);
      return { message: 'Post incident report timeline regenerated' };
    },
  },
  {
    id: 'incident.create_task',
    table: 'incident',
    label: 'Create Incident Task',
    order: 300,
    roles: AGENTS,
    condition: (rec) => rec.bool('active'),
    saveFirst: true,
    run(rec) {
      return {
        redirect: newFormRoute('incident_task', { incident: rec.sysId, cmdb_ci: rec.str('cmdb_ci') }),
      };
    },
  },
  {
    id: 'incident.copy',
    table: 'incident',
    label: 'Copy Incident',
    order: 310,
    condition: (rec, ctx) =>
      propBool(ctx, 'com.snc.incident.copy.enable', true) &&
      (ctx.hasAnyRole(AGENTS) || rec.str('opened_by') === ctx.user.sysId),
    run(rec, ctx) {
      const copy = copyIncident(ctx, rec);
      return { message: `${copy.str('number')} created`, redirect: recordRoute('incident', copy.sysId) };
    },
  },
  {
    id: 'incident.create_child',
    table: 'incident',
    label: 'Create Child Incident',
    order: 320,
    roles: AGENTS,
    condition: (rec, ctx) =>
      propBool(ctx, 'com.snc.incident.create.child.enable', true) &&
      ![INC_STATE.CLOSED, INC_STATE.CANCELED].includes(rec.str('state') as '7'),
    run(rec, ctx) {
      const child = copyIncident(ctx, rec, { child: true });
      return {
        message: `Child incident ${child.str('number')} created`,
        redirect: recordRoute('incident', child.sysId),
      };
    },
  },
  {
    id: 'incident.new_comm_plan',
    table: 'incident',
    label: 'New Communication Plan',
    order: 330,
    roles: ['major_incident_manager', 'ia_admin', 'communication_manager'],
    condition: (rec) => rec.bool('active'),
    run(rec, ctx) {
      const plan = createCommunicationPlan(ctx, rec);
      return {
        message: `${plan.str('number')} created`,
        redirect: recordRoute('incident_alert', plan.sysId),
      };
    },
  },
  {
    id: 'task.create_outage',
    table: 'task',
    label: 'Create Outage',
    order: 400,
    roles: ['itil', 'sn_task_outage_admin'],
    condition: (rec) => OUTAGE_TASK_CLASSES.includes(rec.className),
    run(rec) {
      return {
        redirect: newFormRoute('cmdb_ci_outage', {
          task_number: rec.sysId,
          cmdb_ci: rec.str('cmdb_ci'),
          short_description: `Outage related to ${rec.str('number')}`,
        }),
      };
    },
  },
];

const openPlan = (rec: Rec) => rec.str('state') === '1';
const openCommTask = (rec: Rec) => ['-5', '1', '2'].includes(rec.str('state'));
const PLAN_ROLES = ['ia_admin', 'major_incident_manager', 'communication_manager'];
const planOwner = (rec: Rec, ctx: Context) =>
  ctx.hasAnyRole(PLAN_ROLES) || rec.str('assigned_to') === ctx.user.sysId;

const communicationActions: UiActionDef[] = [
  {
    id: 'incident_alert.add_task',
    table: 'incident_alert',
    label: 'Add Communication Task',
    order: 10,
    condition: (rec, ctx) => openPlan(rec) && planOwner(rec, ctx),
    prompt: [{ field: 'short_description', label: 'Task', mandatory: true }],
    run(rec, ctx, input) {
      const task = addCommunicationTask(ctx, rec, { short_description: text(input, 'short_description') });
      return {
        message: `${task.str('number')} added`,
        redirect: recordRoute('incident_alert_task', task.sysId),
      };
    },
  },
  {
    id: 'incident_alert.close',
    table: 'incident_alert',
    label: 'Close Plan',
    style: 'primary',
    order: 20,
    condition: (rec, ctx) => openPlan(rec) && planOwner(rec, ctx),
    run(rec, ctx) {
      closeCommunicationPlan(ctx, rec);
      return { message: 'Communication plan closed' };
    },
  },
  {
    id: 'incident_alert.cancel',
    table: 'incident_alert',
    label: 'Cancel Plan',
    style: 'destructive',
    order: 30,
    condition: (rec, ctx) => openPlan(rec) && planOwner(rec, ctx),
    run(rec, ctx) {
      closeCommunicationPlan(ctx, rec, true);
      return { message: 'Communication plan canceled' };
    },
  },
  {
    id: 'incident_alert_task.send',
    table: 'incident_alert_task',
    label: 'Mark as Sent',
    style: 'primary',
    order: 10,
    condition: (rec, ctx) => openCommTask(rec) && planOwner(rec, ctx),
    prompt: [{ field: 'work_notes', label: 'What was communicated?', mandatory: false }],
    run(rec, ctx, input) {
      sendCommunication(ctx, rec, text(input, 'work_notes'));
      return { message: 'Communication recorded' };
    },
  },
  {
    id: 'incident_alert_task.close',
    table: 'incident_alert_task',
    label: 'Close Task',
    order: 20,
    condition: (rec, ctx) => openCommTask(rec) && planOwner(rec, ctx),
    run(rec, ctx) {
      closeCommunicationTask(ctx, rec);
      return { message: 'Communication task closed' };
    },
  },
];

const outageActions: UiActionDef[] = [
  {
    id: 'cmdb_ci_outage.begin_now',
    table: 'cmdb_ci_outage',
    label: 'Begin Outage Now',
    order: 10,
    roles: ['itil', 'sn_task_outage_admin'],
    condition: (rec) => !rec.str('begin'),
    run(rec, ctx) {
      beginOutageNow(ctx, rec);
      return { message: 'Outage started' };
    },
  },
  {
    id: 'cmdb_ci_outage.end_now',
    table: 'cmdb_ci_outage',
    label: 'End Outage Now',
    order: 20,
    roles: ['itil', 'sn_task_outage_admin'],
    condition: (rec) => !!rec.str('begin') && !rec.str('end'),
    run(rec, ctx) {
      if (!rec.str('begin')) throw new AbortError('The outage has not begun');
      endOutageNow(ctx, rec);
      return { message: 'Outage ended' };
    },
  },
];

export const INCIDENT_UI_ACTIONS: UiActionDef[] = [
  ...incidentActions,
  ...communicationActions,
  ...outageActions,
];
