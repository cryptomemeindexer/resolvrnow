import type { Context } from '../../engine/context.js';
import { MIM_GROUP_NAME, PROP } from './constants.js';

const TRIGGER_RULES = [
  {
    name: 'Critical business service',
    order: 100,
    condition: 'business_service.busines_criticalityIN1 - most critical,2 - somewhat critical',
  },
  { name: 'Many child incidents', order: 200, condition: 'child_incidents>20' },
  { name: 'Priority 1 incident', order: 300, condition: 'priority=1' },
];

export const MI_PLAN_DEFINITION = 'Major incident communications';

/** Reference data: the major incident group, base trigger rules (inactive) and a plan definition (inactive). */
export function seedIncidentData(ctx: Context): void {
  const group =
    ctx.first('sys_user_group', `name=${MIM_GROUP_NAME}`) ??
    ctx.insert('sys_user_group', {
      name: MIM_GROUP_NAME,
      description: 'Coordinates major incidents from detection to post incident review',
    });
  if (!ctx.platform.properties.get(PROP.mimGroup)) ctx.platform.properties.set(PROP.mimGroup, group.sysId);
  const itil = ctx.getBy('sys_user_role', 'name', 'itil');
  if (itil && !ctx.first('sys_group_has_role', `group=${group.sysId}^role=${itil.sysId}`)) {
    ctx.insert('sys_group_has_role', { group: group.sysId, role: itil.sysId });
  }
  for (const r of TRIGGER_RULES) {
    if (!ctx.first('major_incident_trigger_rule', `name=${r.name}`)) {
      ctx.insert('major_incident_trigger_rule', {
        ...r,
        table: 'incident',
        action: 'propose',
        active: false,
      });
    }
  }
  if (!ctx.first('comm_plan_definition', `name=${MI_PLAN_DEFINITION}`)) {
    const def = ctx.insert('comm_plan_definition', {
      name: MI_PLAN_DEFINITION,
      table: 'incident',
      condition: 'major_incident_state=accepted',
      type: 'stakeholder',
      short_description: 'Stakeholder communications',
      order: 100,
      active: false,
    });
    const tasks = [
      {
        name: 'Send the initial stakeholder notice',
        channel: 'email',
        communication_frequency: 'once',
        due_in: 15 * 60_000,
        order: 100,
      },
      {
        name: 'Post hourly status updates',
        channel: 'email',
        communication_frequency: 'recurring',
        due_in: 60 * 60_000,
        order: 200,
      },
      {
        name: 'Open the technical bridge call',
        channel: 'conference',
        communication_frequency: 'once',
        due_in: 10 * 60_000,
        order: 300,
      },
    ];
    for (const t of tasks) ctx.insert('comm_task_definition', { ...t, comm_plan_definition: def.sysId });
  }
}
