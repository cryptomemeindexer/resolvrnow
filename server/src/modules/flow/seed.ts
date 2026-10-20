import type { Context } from '../../engine/context.js';
import { FLOW_TABLE } from './tables.js';
import type { FlowDefinition } from './types.js';

/** Example flow shipped with ResolvrNow (tables are referenced by name only). */
export const NOTIFY_CALLER_ON_RESOLVE: FlowDefinition = {
  schema: 'resolvr.flow/v1',
  name: 'Notify caller when incident is resolved',
  internal_name: 'notify_caller_incident_resolved',
  description: 'Emails the caller when an incident moves to Resolved.',
  type: 'flow',
  run_as: 'system',
  trigger: {
    type: 'record',
    table: 'incident',
    when: 'updated',
    condition: 'stateCHANGESTO6',
    run: 'always',
  },
  steps: [
    {
      id: 'notify_caller',
      type: 'action',
      action: 'send_notification',
      label: 'Email the caller',
      when_error: 'continue',
      inputs: {
        record: '{{trigger.current}}',
        to: ['{{trigger.current.caller_id}}'],
        subject: 'Incident {{trigger.current.number}} has been resolved',
        body:
          '<p>Hello {{trigger.current.caller_id.first_name}},</p>' +
          '<p>Your incident {{trigger.current.number}} ({{trigger.current.short_description}}) has been resolved.</p>' +
          '<p>Resolution notes: {{trigger.current.close_notes}}</p>' +
          '<p>If the problem is not fixed, reply to this email to reopen it.</p>',
        event: 'incident.resolved.caller_notice',
      },
    },
    {
      id: 'log',
      type: 'action',
      action: 'log',
      label: 'Log the notice',
      inputs: {
        level: 'info',
        message:
          'Resolution notice for {{trigger.current.number}} handled (sent: {{steps.notify_caller.sent}})',
      },
    },
  ],
};

export function seedFlows(ctx: Context): void {
  if (ctx.getBy(FLOW_TABLE, 'internal_name', NOTIFY_CALLER_ON_RESOLVE.internal_name!)) return;
  ctx.insert(FLOW_TABLE, {
    name: NOTIFY_CALLER_ON_RESOLVE.name,
    internal_name: NOTIFY_CALLER_ON_RESOLVE.internal_name,
    description: NOTIFY_CALLER_ON_RESOLVE.description,
    type: 'flow',
    status: 'published',
    active: true,
    run_as: 'system',
    resolvr_definition: JSON.stringify(NOTIFY_CALLER_ON_RESOLVE, null, 2),
  });
}
