// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notification templates use ${field} placeholders
import type { Platform } from '../../engine/platform.js';

export interface NotificationSeed {
  name: string;
  table: string;
  event: string;
  /** Record fields holding recipients (users, groups or lists). */
  fields?: string;
  /** Event parm1 / parm2 carry recipients (comma-separated user or group sys_ids). */
  parm1?: boolean;
  parm2?: boolean;
  condition?: string;
  subject: string;
  body: string;
  active?: boolean;
  sendSelf?: boolean;
}

const link = '<p><a href="${URI_REF}">Open ${number}</a></p>';

export const INCIDENT_NOTIFICATIONS: NotificationSeed[] = [
  {
    name: 'Incident opened for me',
    table: 'incident',
    event: 'incident.inserted',
    fields: 'caller_id',
    subject: 'Incident ${number} has been opened for you',
    body:
      '<p>We have logged your issue: ${short_description}.</p><p>We will keep you posted as it progresses.</p>' +
      link,
  },
  {
    name: 'Incident assigned to my group',
    table: 'incident',
    event: 'incident.assigned.to.group',
    fields: 'assignment_group',
    condition: 'assigned_toISEMPTY',
    subject: 'Incident ${number} has been assigned to ${assignment_group}',
    body: '<p>${short_description}</p><p>Priority: ${priority}. Caller: ${caller_id}.</p>' + link,
  },
  {
    name: 'Incident assigned to me',
    table: 'incident',
    event: 'incident.assigned',
    fields: 'assigned_to',
    subject: 'Incident ${number} has been assigned to you',
    body: '<p>${short_description}</p><p>Priority: ${priority}. Caller: ${caller_id}.</p>' + link,
  },
  {
    name: 'Incident commented',
    table: 'incident',
    event: 'incident.commented',
    fields: 'caller_id,watch_list',
    sendSelf: false,
    subject: 'New comment on incident ${number}',
    body: '<p>${comments:1}</p>' + link,
  },
  {
    name: 'Incident work noted',
    table: 'incident',
    event: 'incident.worknoted',
    fields: 'work_notes_list',
    active: false,
    sendSelf: false,
    subject: 'New work note on incident ${number}',
    body: '<p>${work_notes:1}</p>' + link,
  },
  {
    name: 'Incident resolved',
    table: 'incident',
    event: 'incident.resolved',
    fields: 'caller_id',
    subject: 'Incident ${number} has been resolved',
    body:
      '<p>Your incident "${short_description}" has been resolved.</p><p>Resolution: ${close_notes}</p>' +
      '<p>If the issue is not fixed, open the incident and select Reopen. Otherwise it closes automatically.</p>' +
      link,
  },
  {
    name: 'Caller responded',
    table: 'incident',
    event: 'incident.caller.responded',
    fields: 'assigned_to,watch_list',
    subject: 'The caller responded on incident ${number}',
    body:
      '<p>${caller_id} added a comment, so the incident is back In Progress.</p><p>${comments:1}</p>' + link,
  },
  {
    name: 'Awaiting caller reminder',
    table: 'incident',
    event: 'incident.strike.reminder',
    fields: 'caller_id',
    subject: 'Reminder: we need your reply on incident ${number}',
    body:
      '<p>We are waiting for information from you to continue working on "${short_description}".</p><p>${comments:1}</p>' +
      link,
  },
  {
    name: 'Incident reopened',
    table: 'incident',
    event: 'incident.reopened',
    fields: 'assigned_to',
    subject: 'Incident ${number} has been reopened',
    body: '<p>${short_description} was reopened and needs more work.</p>' + link,
  },
  {
    name: 'Major incident candidate rejected',
    table: 'incident',
    event: 'incident.mim.rejected',
    fields: 'assigned_to',
    subject: 'Major incident candidate ${number} was rejected',
    body:
      '<p>The proposal to treat ${number} as a major incident was rejected. Reason: ${event.parm2}</p>' +
      link,
  },
  {
    name: 'Major incident reassigned',
    table: 'incident',
    event: 'incident.mim.reassigned',
    parm1: true,
    parm2: true,
    subject: 'Incident ${number} is now a major incident',
    body:
      '<p>${number} was promoted to a major incident and reassigned to the major incident team.</p>' + link,
  },
  {
    name: 'New IA Raised',
    table: 'incident_alert',
    event: 'incident_alert.inserted',
    fields: 'assigned_to,assignment_group',
    subject: 'Communication plan ${number} raised for ${source_incident}',
    body: '<p>${short_description}</p><p>${background}</p>' + link,
  },
  {
    name: 'IA Actions Taken',
    table: 'incident_alert',
    event: 'incident_alert.actions_taken',
    fields: 'assigned_to,assignment_group',
    subject: 'Actions taken on ${number}',
    body: '<p>${actions_taken:1}</p>' + link,
  },
  {
    name: 'IA Cancelled',
    table: 'incident_alert',
    event: 'incident_alert.canceled',
    fields: 'assigned_to,assignment_group',
    subject: 'Communication plan ${number} canceled',
    body: '<p>${short_description}</p>' + link,
  },
  {
    name: 'IA Resolved Or Closed',
    table: 'incident_alert',
    event: 'incident_alert.closed',
    fields: 'assigned_to,assignment_group',
    subject: 'Communication plan ${number} closed',
    body: '<p>${short_description}</p>' + link,
  },
];

/**
 * Seeds default notification definitions when the notifications module provides
 * `sysevent_email_action`. Runs once per marker property so admin deletions stick, and
 * skips events that already have a notification on the same table.
 */
export function seedNotifications(platform: Platform, seeds: NotificationSeed[], marker: string): void {
  if (!platform.registry.has('sysevent_email_action') || platform.properties.get(marker) === 'true') return;
  const ctx = platform.systemContext();
  for (const n of seeds) {
    if (ctx.count('sysevent_email_action', `event_name=${n.event}^collection=${n.table}`) > 0) continue;
    try {
      ctx.insert('sysevent_email_action', {
        name: n.name,
        collection: n.table,
        generation_type: 'event',
        event_name: n.event,
        action_insert: false,
        action_update: false,
        recipient_fields: n.fields ?? '',
        event_parm_1: !!n.parm1,
        event_parm_2: !!n.parm2,
        condition: n.condition ?? '',
        subject: n.subject,
        message_html: n.body,
        send_self: n.sendSelf ?? true,
        active: n.active ?? true,
        weight: 0,
      });
    } catch (e) {
      platform.log.warn(
        `[resolvrnow] notification "${n.name}" was not seeded: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  platform.properties.set(marker, 'true');
}
