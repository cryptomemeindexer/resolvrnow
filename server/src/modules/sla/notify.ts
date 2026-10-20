import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { type NotificationService, optionalService, SERVICES } from '../contracts.js';

export const SLA_EVENTS = {
  warning50: 'sla.warning.50',
  warning75: 'sla.warning.75',
  breached: 'sla.breached',
} as const;

export function eventFor(threshold: number): string {
  if (threshold >= 100) return SLA_EVENTS.breached;
  return threshold >= 75 ? SLA_EVENTS.warning75 : SLA_EVENTS.warning50;
}

/** Who is told about a threshold: 50 % goes to the assignee and the CI's support contact, later ones to the assignee and their manager. */
export function recipientsFor(task: Rec | null, threshold: number): string[] {
  if (!task) return [];
  const list =
    threshold < 75
      ? [task.str('assigned_to'), task.str('cmdb_ci.supported_by')]
      : [task.str('assigned_to'), task.str('assigned_to.manager')];
  return [...new Set(list.filter(Boolean))];
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Queues the threshold event and, when the notifications module is installed, emails the recipients. */
export function raiseThreshold(ctx: Context, taskSla: Rec, task: Rec | null, threshold: number): void {
  const event = eventFor(threshold);
  ctx.queueEvent(event, taskSla, taskSla.str('task'), String(threshold));
  const mailer = optionalService<NotificationService>(ctx.platform, SERVICES.notifications);
  if (!mailer || !ctx.platform.properties.getBool('resolvr.sla.notifications', true)) return;
  const to = recipientsFor(task, threshold);
  if (!to.length) return;
  const number = task?.str('number') || taskSla.display('task');
  const sla = taskSla.display('sla');
  const what = threshold >= 100 ? 'has breached' : `has reached ${threshold}% of its target`;
  const lines = [
    `<p>The SLA <strong>${esc(sla)}</strong> on ${esc(number)} ${what}.</p>`,
    task?.str('short_description') ? `<p>${esc(task.str('short_description'))}</p>` : '',
    `<p>Breach time: ${esc(taskSla.str('planned_end_time') || 'not set')} (UTC)<br>Business time left: ${esc(taskSla.display('business_time_left') || '0 Seconds')}</p>`,
  ];
  mailer.send(ctx, {
    to,
    subject: `${number}: SLA ${sla} ${threshold >= 100 ? 'breached' : `at ${threshold}%`}`,
    body: lines.filter(Boolean).join('\n'),
    target: task,
    notification: event,
  });
}
