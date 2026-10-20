// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notification templates use ${field} placeholders
/**
 * Default email layout, templates, notifications and inbound actions shipped with
 * ResolvrNow. All wording is original.
 */

export const DEFAULT_LAYOUT_NAME = 'ResolvrNow default';

const FONT = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

/** Branded, accessible layout (inline CSS, presentation tables, high-contrast colours). */
export const DEFAULT_LAYOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>ResolvrNow</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f5f8;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #d9dee5;border-radius:8px;">
<tr>
<td style="padding:18px 28px;border-bottom:3px solid #1f5fbf;${FONT}font-size:18px;font-weight:700;color:#1f2933;">
<span style="color:#1f5fbf;">Resolvr</span>Now
</td>
</tr>
<tr>
<td style="padding:24px 28px;${FONT}font-size:15px;line-height:1.55;color:#1f2933;">
\${notification:body}
</td>
</tr>
<tr>
<td style="padding:16px 28px;border-top:1px solid #d9dee5;${FONT}font-size:12px;line-height:1.5;color:#52606d;">
You received this message from ResolvrNow because of your role on the record above. \${NOTIF_PREFS+link_text="Manage your email preferences"}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;

const H1 = 'margin:0 0 12px;font-size:20px;line-height:1.3;color:#1f2933;';
const P = 'margin:0 0 16px;';

export interface TemplateSeed {
  name: string;
  collection: string;
  subject: string;
  message_html: string;
  message_text?: string;
}

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    name: 'incident.assigned_to_me',
    collection: 'incident',
    subject: '${number} is now assigned to you',
    message_html: `<h1 style="${H1}">\${number} is in your queue</h1>
<p style="${P}">You are now the assignee of this incident. Please review it and let the caller know about the next steps.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'incident.assigned_to_group',
    collection: 'incident',
    subject: '${number} needs an owner in ${assignment_group}',
    message_html: `<h1 style="${H1}">\${number} was routed to \${assignment_group}</h1>
<p style="${P}">Nobody in the group has picked this incident up yet. If it is yours to handle, assign it to yourself.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'incident.commented',
    collection: 'incident',
    subject: 'New comment on ${number}',
    message_html: `<h1 style="${H1}">There is an update on your incident</h1>
<p style="${P}">A new comment was added to \${URI_REF}: \${short_description}</p>
\${mail_script:comments_history}
<p style="${P}">You can reply to this email to add your own comment.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'incident.resolved',
    collection: 'incident',
    subject: '${number} has been resolved',
    message_html: `<h1 style="${H1}">We believe your issue is fixed</h1>
<p style="${P}">Your incident \${URI_REF} (\${short_description}) was marked as resolved.</p>
<p style="${P}"><strong>Resolution notes:</strong><br>\${close_notes}</p>
<p style="${P}">If the problem is still there, reply to this email and tell us what you see so the team can follow up.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'approval.requested',
    collection: 'sysapproval_approver',
    subject: 'Approval needed for ${sysapproval}',
    message_html: `<h1 style="${H1}">Your approval is needed</h1>
<p style="${P}">\${sysapproval.URI_REF} is waiting for your decision: \${sysapproval.short_description}</p>
\${mail_script:approval_links}
\${mail_script:record_summary}`,
  },
  {
    name: 'sc_req_item.completed',
    collection: 'sc_req_item',
    subject: 'Your request ${number} is complete',
    message_html: `<h1 style="${H1}">Your request has been fulfilled</h1>
<p style="${P}">Everything for \${URI_REF} (\${cat_item}) has been completed. Thank you for your patience.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'change_request.approved',
    collection: 'change_request',
    subject: 'Change ${number} was approved',
    message_html: `<h1 style="${H1}">Your change was approved</h1>
<p style="${P}">The approvers have signed off on \${URI_REF}: \${short_description}. It can now move to scheduling and implementation.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'change_request.rejected',
    collection: 'change_request',
    subject: 'Change ${number} was rejected',
    message_html: `<h1 style="${H1}">Your change was not approved</h1>
<p style="${P}">An approver rejected \${URI_REF}: \${short_description}. Check the approval comments, adjust the plan and submit it again.</p>
\${mail_script:record_summary}`,
  },
  {
    name: 'task_sla.warning',
    collection: 'task_sla',
    subject: 'SLA warning for ${task}: ${event.parm2}% of the time used',
    message_html: `<h1 style="${H1}">An SLA is running out of time</h1>
<p style="${P}">\${task.URI_REF} (\${task.short_description}) has used \${event.parm2}% of the time allowed by \${sla}. Planned end: \${planned_end_time}.</p>
<p style="${P}">Please act now to avoid a breach.</p>`,
  },
];

export interface NotificationSeed {
  name: string;
  collection: string;
  category: string;
  template: string;
  generation_type: 'engine' | 'event';
  event_name?: string;
  action_insert?: boolean;
  action_update?: boolean;
  condition?: string;
  recipient_fields?: string;
  send_self?: boolean;
  weight?: number;
  order?: number;
  description: string;
}

/**
 * Default notifications, keyed by table name: each only fires when its table exists.
 * Incident notifications listen to the events the Incident module queues; the others
 * use record conditions so they work whichever module produces the change.
 */
export const DEFAULT_NOTIFICATIONS: NotificationSeed[] = [
  {
    name: 'Incident assigned to me',
    collection: 'incident',
    category: 'Incident',
    template: 'incident.assigned_to_me',
    generation_type: 'event',
    event_name: 'incident.assigned',
    recipient_fields: 'assigned_to',
    send_self: false,
    description: 'Tells the new assignee that an incident is now theirs.',
  },
  {
    name: 'Incident assigned to my group',
    collection: 'incident',
    category: 'Incident',
    template: 'incident.assigned_to_group',
    generation_type: 'event',
    event_name: 'incident.assigned.to.group',
    condition: 'assigned_toISEMPTY',
    recipient_fields: 'assignment_group',
    send_self: false,
    description: 'Tells an assignment group that an unassigned incident is waiting for an owner.',
  },
  {
    name: 'Incident commented',
    collection: 'incident',
    category: 'Incident',
    template: 'incident.commented',
    generation_type: 'event',
    event_name: 'incident.commented',
    recipient_fields: 'caller_id',
    send_self: false,
    weight: 5,
    description: 'Sends new customer-visible comments to the caller (never to the person who wrote them).',
  },
  {
    name: 'Incident resolved',
    collection: 'incident',
    category: 'Incident',
    template: 'incident.resolved',
    generation_type: 'event',
    event_name: 'incident.resolved',
    recipient_fields: 'caller_id',
    weight: 10,
    description: 'Lets the caller know the incident was resolved and how to reopen it.',
  },
  {
    name: 'Approval requested',
    collection: 'sysapproval_approver',
    category: 'Approval',
    template: 'approval.requested',
    generation_type: 'engine',
    action_insert: true,
    action_update: true,
    condition: 'stateCHANGESTOrequested',
    recipient_fields: 'approver',
    description: 'Asks the approver for a decision, with approve and reject reply links.',
  },
  {
    name: 'Request item completed',
    collection: 'sc_req_item',
    category: 'Request',
    template: 'sc_req_item.completed',
    generation_type: 'engine',
    action_update: true,
    condition: 'stateCHANGESTO3',
    recipient_fields: 'requested_for',
    description: 'Tells the person the item was requested for that it has been delivered.',
  },
  {
    name: 'Change approved',
    collection: 'change_request',
    category: 'Change',
    template: 'change_request.approved',
    generation_type: 'engine',
    action_update: true,
    condition: 'approvalCHANGESTOapproved',
    recipient_fields: 'requested_by',
    description: 'Tells the requester that the change was approved.',
  },
  {
    name: 'Change rejected',
    collection: 'change_request',
    category: 'Change',
    template: 'change_request.rejected',
    generation_type: 'engine',
    action_update: true,
    condition: 'approvalCHANGESTOrejected',
    recipient_fields: 'requested_by',
    description: 'Tells the requester that the change was rejected.',
  },
  {
    name: 'SLA warning',
    collection: 'task_sla',
    category: 'Service Level',
    template: 'task_sla.warning',
    generation_type: 'event',
    event_name: 'sla.warning.75',
    recipient_fields: 'task.assigned_to,task.assigned_to.manager',
    description: 'Warns the assignee and their manager when an SLA has used 75% of its time.',
  },
];

export const DEFAULT_CATEGORIES: { name: string; short_description: string }[] = [
  { name: 'General', short_description: 'Notifications that do not belong to a specific application' },
  { name: 'Incident', short_description: 'Incident assignment, updates and resolution' },
  { name: 'Approval', short_description: 'Requests for approval and approval outcomes' },
  { name: 'Request', short_description: 'Service catalog requests and items' },
  { name: 'Change', short_description: 'Change requests' },
  { name: 'Service Level', short_description: 'SLA warnings and breaches' },
];

export const DEFAULT_DIGEST_INTERVALS: { name: string; interval: number }[] = [
  { name: 'Every hour', interval: 3_600_000 },
  { name: 'Every 4 hours', interval: 14_400_000 },
  { name: 'Daily', interval: 86_400_000 },
  { name: 'Weekly', interval: 604_800_000 },
];

export const DEFAULT_REPLY_SEPARATORS: {
  name: string;
  type: 'string' | 'regex';
  separator: string;
  order: number;
  short_description: string;
}[] = [
  {
    name: 'Original message banner',
    type: 'string',
    separator: '-----Original Message-----',
    order: 100,
    short_description: 'Outlook style quoted message banner',
  },
  {
    name: 'On ... wrote',
    type: 'regex',
    separator: '^On .+ wrote:$',
    order: 200,
    short_description: 'Quote introduction line used by most mail clients',
  },
  {
    name: 'Quoted From header',
    type: 'regex',
    separator: '^From: .+$',
    order: 300,
    short_description: 'Quoted header block of the previous message',
  },
];

export const DEFAULT_MAILBOXES = ['Outbox', 'Sent', 'Failed', 'Skipped', 'Inbox', 'Junk', 'Drafts'];

export interface InboundSeed {
  name: string;
  type: 'new' | 'reply' | 'forward';
  collection: string;
  resolvr_handler: string;
  order: number;
  stop_processing: boolean;
  filter_condition?: string;
  description: string;
}

export const DEFAULT_INBOUND_ACTIONS: InboundSeed[] = [
  {
    name: 'Unsubscribe from notification',
    type: 'new',
    collection: 'cmn_notif_message',
    resolvr_handler: 'unsubscribe',
    order: 10,
    stop_processing: true,
    filter_condition: 'subjectSTARTSWITHUnsubscribe from',
    description: 'Processes the unsubscribe links placed in notifications with ${NOTIF_UNSUB}.',
  },
  {
    name: 'Approval decision by reply',
    type: 'reply',
    collection: 'sysapproval_approver',
    resolvr_handler: 'approval_reply',
    order: 50,
    stop_processing: true,
    description: 'Approves or rejects when the approver replies to an approval email with approve or reject.',
  },
  {
    name: 'Comment from reply',
    type: 'reply',
    collection: 'task',
    resolvr_handler: 'reply_comment',
    order: 100,
    stop_processing: true,
    description:
      'Adds a reply to a task notification (incident, change, request...) as a comment from the sender.',
  },
  {
    name: 'Create incident from email',
    type: 'new',
    collection: 'incident',
    resolvr_handler: 'create_record',
    order: 200,
    stop_processing: true,
    description: 'Opens an incident for new email, with the sender as caller.',
  },
  {
    name: 'Create incident from forwarded email',
    type: 'forward',
    collection: 'incident',
    resolvr_handler: 'create_record',
    order: 210,
    stop_processing: true,
    description: 'Opens an incident for forwarded email, even when it carries a watermark.',
  },
];
