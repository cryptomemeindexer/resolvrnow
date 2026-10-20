import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { addMs, clock, nowGlide, toGlideDateTime } from '../../engine/util.js';
import { approvalRows, directDecision } from './approvals.js';
import { refreshAgenda } from './cab.js';
import { MODEL_IDS, STATE, T, TASK_STATE } from './constants.js';
import { createUnauthorizedChange } from './events.js';
import { createPipelineChange } from './product-api.js';
import { createStandardChange, createTemplate } from './standard.js';
import { approvalsOf, groupByName, usersWithRole } from './util.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Target = 'new' | 'assess' | 'authorize' | 'scheduled' | 'implement' | 'review' | 'closed' | 'canceled';

interface DemoChange {
  type: 'normal' | 'emergency';
  short: string;
  description: string;
  group: string;
  assignee: string;
  requester: string;
  ci?: { names: string[]; keywords: string[] };
  /** Planned start relative to now, in days, and duration in hours. */
  startDays: number;
  hours: number;
  risk?: number;
  impact?: number;
  target: Target;
  closeCode?: string;
  hold?: string;
  category?: string;
  /** Plan the change inside the end-of-quarter finance freeze (shows a blackout conflict). */
  inFreeze?: boolean;
}

/** CI hints: exact names first, then name fragments (the CMDB module may be absent or named differently). */
const CIS = {
  firewall: { names: ['fw-edge-01', 'aus-fw-01'], keywords: ['fw-', 'firewall'] },
  sql: { names: ['sql-prod-01', 'pay-db-01'], keywords: ['sql', '-db-'] },
  dns: { names: ['dns-01', 'dc-01'], keywords: ['dns', 'dc-'] },
  erp: { names: ['erp-app-01', 'pay-app-01'], keywords: ['erp', '-app-'] },
  web: { names: ['web-prod-01', 'cp-web-01'], keywords: ['web'] },
  vpn: { names: ['vpn-gw-01', 'aus-rtr-01'], keywords: ['vpn', 'rtr'] },
  mail: { names: ['mail-01'], keywords: ['mail'] },
  switch: { names: ['core-sw-01', 'aus-sw-core-01'], keywords: ['sw-core', 'switch', '-sw-'] },
  k8s: { names: ['k8s-prod-cluster', 'aus-esx-01'], keywords: ['k8s', 'esx', 'cluster'] },
  payroll: { names: ['payroll-app-01', 'Payroll Engine@pay-app-01'], keywords: ['payroll', 'pay-'] },
};

const CHANGES: DemoChange[] = [
  {
    type: 'normal',
    short: 'Upgrade core switch firmware in Austin HQ',
    description:
      'Move both core switches to the vendor long-term support firmware to fix the spanning tree bug.',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'marcus.chen',
    ci: CIS.switch,
    startDays: 18,
    hours: 3,
    risk: 3,
    target: 'new',
    category: 'Network',
  },
  {
    type: 'normal',
    short: 'Add firewall rule for partner SFTP access',
    description:
      'Allow the logistics partner to reach the SFTP gateway on port 22 from their published address range.',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'noah.johnson',
    ci: CIS.firewall,
    startDays: 9,
    hours: 1,
    risk: 4,
    target: 'assess',
    category: 'Network',
  },
  {
    type: 'normal',
    short: 'Upgrade production SQL Server to the 2022 release',
    description:
      'In-place upgrade of the finance reporting database server, including compatibility level change and index rebuild.',
    group: 'Database Administration',
    assignee: 'sofia.alvarez',
    requester: 'sofia.alvarez',
    ci: CIS.sql,
    startDays: 12,
    hours: 6,
    risk: 2,
    impact: 2,
    target: 'authorize',
    category: 'Software',
  },
  {
    type: 'normal',
    short: 'Migrate internal DNS zones to the new resolvers',
    description: 'Transfer northwind.internal zones to the new resolver pair and lower TTLs one day before.',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'priya.nair',
    ci: CIS.dns,
    startDays: 6,
    hours: 2,
    risk: 3,
    target: 'scheduled',
    category: 'Network',
  },
  {
    type: 'normal',
    short: 'Quarterly OS patching for finance servers',
    description:
      'Apply the quarterly cumulative updates to the finance application servers and reboot in sequence.',
    group: 'Cloud Operations',
    assignee: 'david.kim',
    requester: 'david.kim',
    ci: CIS.erp,
    startDays: -0.1,
    hours: 5,
    risk: 3,
    target: 'implement',
    category: 'Software',
  },
  {
    type: 'normal',
    short: 'Replace the VPN concentrator',
    description: 'Swap the end-of-life VPN concentrator for the new appliance and migrate user profiles.',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'fatima.alsayed',
    ci: CIS.vpn,
    startDays: -2,
    hours: 4,
    risk: 2,
    target: 'review',
    category: 'Network',
  },
  {
    type: 'normal',
    short: 'Upgrade the ERP application to version 12.4',
    description: 'Vendor upgrade with new tax tables for the next fiscal year.',
    group: 'Software Support',
    assignee: 'elena.petrova',
    requester: 'henry.anderson',
    ci: CIS.erp,
    startDays: -30,
    hours: 8,
    risk: 2,
    target: 'closed',
    closeCode: 'successful',
    category: 'Applications Software',
  },
  {
    type: 'normal',
    short: 'Decommission the legacy file server',
    description:
      'Archive remaining shares and power off the old file server after the migration to cloud storage.',
    group: 'Cloud Operations',
    assignee: 'david.kim',
    requester: 'lucas.moreau',
    startDays: -21,
    hours: 3,
    risk: 3,
    target: 'closed',
    closeCode: 'successful_issues',
    category: 'Hardware',
  },
  {
    type: 'normal',
    short: 'Rebuild reporting database indexes',
    description: 'Rebuild fragmented indexes on the reporting database during the maintenance window.',
    group: 'Database Administration',
    assignee: 'sofia.alvarez',
    requester: 'sofia.alvarez',
    ci: CIS.sql,
    startDays: 4,
    hours: 2,
    risk: 4,
    target: 'canceled',
    category: 'Software',
  },
  {
    type: 'normal',
    short: 'Migrate email to the new tenant',
    description: 'Move mailboxes in three waves; waiting for the vendor to deliver the additional licenses.',
    group: 'Software Support',
    assignee: 'elena.petrova',
    requester: 'maya.cohen',
    ci: CIS.mail,
    startDays: 25,
    hours: 12,
    risk: 2,
    target: 'new',
    hold: 'Waiting for the vendor to deliver additional licenses',
    category: 'Software',
  },
  {
    type: 'normal',
    short: 'Refresh Wi-Fi access points in the London office',
    description: 'Replace 24 access points with Wi-Fi 6E models, floor by floor, outside office hours.',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'priya.nair',
    startDays: 14,
    hours: 6,
    risk: 3,
    target: 'scheduled',
    category: 'Network',
  },
  {
    type: 'normal',
    short: 'Laptop refresh for the Sales team (40 devices)',
    description:
      'Image and hand out 40 new laptops to the Sales team and recover the old devices for wiping.',
    group: 'Hardware Support',
    assignee: 'jamal.wright',
    requester: 'charlotte.taylor',
    startDays: 10,
    hours: 8,
    risk: 4,
    target: 'assess',
    category: 'Hardware',
  },
  {
    type: 'normal',
    short: 'Increase the production Kubernetes node pool',
    description: 'Add three nodes to the production cluster ahead of the product launch.',
    group: 'Cloud Operations',
    assignee: 'david.kim',
    requester: 'tom.becker',
    ci: CIS.k8s,
    startDays: 8,
    hours: 2,
    risk: 4,
    target: 'authorize',
    category: 'Service',
  },
  {
    type: 'normal',
    short: 'Harden TLS configuration of the HR portal',
    description: 'Disable legacy protocol versions and weak ciphers on the HR portal load balancer.',
    group: 'Information Security',
    assignee: 'fatima.alsayed',
    requester: 'emma.williams',
    ci: CIS.web,
    startDays: 5,
    hours: 1,
    risk: 3,
    target: 'scheduled',
    category: 'Network',
  },
  {
    type: 'normal',
    short: 'Load the new tax tables into the ERP system',
    description: 'Vendor tax table update needed for the first invoices of the next quarter.',
    group: 'Software Support',
    assignee: 'elena.petrova',
    requester: 'noah.johnson',
    ci: CIS.erp,
    startDays: 0,
    hours: 3,
    risk: 3,
    target: 'scheduled',
    category: 'Applications Software',
    inFreeze: true,
  },
  {
    type: 'normal',
    short: 'Upgrade the build server toolchain',
    description: 'Upgrade compilers and SDKs on the shared build servers used by the application teams.',
    group: 'Application Development',
    assignee: 'tom.becker',
    requester: 'james.davis',
    startDays: -10,
    hours: 4,
    risk: 3,
    target: 'closed',
    closeCode: 'unsuccessful',
    category: 'Software',
  },
  {
    type: 'emergency',
    short: 'Patch critical OpenSSL vulnerability on web servers',
    description:
      'Apply the vendor fix for the remotely exploitable TLS library flaw on all public web servers.',
    group: 'Information Security',
    assignee: 'fatima.alsayed',
    requester: 'fatima.alsayed',
    ci: CIS.web,
    startDays: -0.05,
    hours: 3,
    risk: 2,
    impact: 1,
    target: 'implement',
    category: 'Software',
  },
  {
    type: 'emergency',
    short: 'Restore the edge firewall configuration',
    description: 'Roll back the faulty rule set pushed during the night that blocked inbound mail.',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'priya.nair',
    ci: CIS.firewall,
    startDays: -12,
    hours: 1,
    risk: 2,
    target: 'closed',
    closeCode: 'successful',
    category: 'Network',
  },
  {
    type: 'emergency',
    short: 'Emergency fix for the payroll export failure',
    description: 'Deploy the hotfix for the payroll export job that fails since the last bank format change.',
    group: 'Application Development',
    assignee: 'tom.becker',
    requester: 'henry.anderson',
    ci: CIS.payroll,
    startDays: 1,
    hours: 2,
    risk: 2,
    target: 'authorize',
    category: 'Applications Software',
  },
  {
    type: 'emergency',
    short: 'Block a malicious IP range at the edge',
    description:
      'Block the address range behind the credential stuffing attempts against the customer portal.',
    group: 'Information Security',
    assignee: 'fatima.alsayed',
    requester: 'fatima.alsayed',
    ci: CIS.firewall,
    startDays: -1,
    hours: 1,
    risk: 3,
    target: 'review',
    category: 'Network',
  },
];

interface DemoStandard {
  template: string;
  short: string;
  group: string;
  assignee: string;
  requester: string;
  ci?: { names: string[]; keywords: string[] };
  startDays: number;
  hours: number;
  target: Target;
  closeCode?: string;
}

const TEMPLATES = [
  {
    name: 'Restart an application service',
    category: 'Software',
    values: {
      short_description: 'Restart an application service',
      description: 'Graceful restart of a Windows or Linux service that is known to recover with a restart.',
      implementation_plan:
        '1. Announce in the team channel. 2. Stop the service. 3. Start the service. 4. Check the health endpoint.',
      backout_plan: 'Start the previous service version if the new start fails.',
      test_plan: 'Health endpoint returns OK and users can log in.',
      risk: 4,
      impact: 3,
      category: 'Software',
    },
    tasks: [{ name: 'Restart and verify the service', values: { change_task_type: 'implementation' } }],
  },
  {
    name: 'Apply monthly OS patches to a server',
    category: 'Software',
    values: {
      short_description: 'Apply monthly OS patches to a server',
      description: 'Install the approved monthly operating system updates and reboot.',
      implementation_plan: 'Snapshot the server, install the approved updates, reboot, verify services.',
      backout_plan: 'Revert to the snapshot taken before patching.',
      test_plan: 'Services start, monitoring is green, no new errors in the event log.',
      risk: 4,
      impact: 3,
      category: 'Software',
    },
    tasks: [
      { name: 'Take a snapshot', values: { change_task_type: 'planning' } },
      { name: 'Install updates and reboot', values: { change_task_type: 'implementation' } },
    ],
  },
  {
    name: 'Add a firewall rule from the approved catalog',
    category: 'Network',
    values: {
      short_description: 'Add a firewall rule from the approved catalog',
      description:
        'Add a rule that matches one of the pre-approved rule patterns (monitoring, backup, partner SFTP).',
      implementation_plan:
        'Add the rule in the management console, push the policy, confirm the hit counter.',
      backout_plan: 'Disable the rule and push the policy again.',
      test_plan: 'Connection test from the source host succeeds; unrelated traffic is unchanged.',
      risk: 4,
      impact: 3,
      category: 'Network',
    },
    tasks: [{ name: 'Add and push the rule', values: { change_task_type: 'implementation' } }],
  },
  {
    name: 'Replace a laptop (hardware refresh)',
    category: 'Hardware',
    values: {
      short_description: 'Replace a laptop (hardware refresh)',
      description: 'Swap an employee laptop for a new standard image device and recover the old one.',
      implementation_plan: 'Image the new device, transfer user data, hand over, collect the old device.',
      backout_plan: 'Give the old device back to the user until the issue is fixed.',
      test_plan: 'User can sign in, VPN and email work, data is present.',
      risk: 4,
      impact: 3,
      category: 'Hardware',
    },
    tasks: [
      { name: 'Prepare the new device', values: { change_task_type: 'planning' } },
      { name: 'Hand over and recover the old device', values: { change_task_type: 'implementation' } },
    ],
  },
  {
    name: 'Rotate a TLS certificate',
    category: 'Security',
    values: {
      short_description: 'Rotate a TLS certificate',
      description: 'Replace an expiring certificate with a new one from the internal certificate authority.',
      implementation_plan: 'Request the certificate, install it, reload the web server.',
      backout_plan: 'Reinstall the previous certificate while it is still valid.',
      test_plan: 'The site presents the new certificate and the chain validates.',
      risk: 4,
      impact: 3,
      category: 'Network',
    },
    tasks: [{ name: 'Install the new certificate', values: { change_task_type: 'implementation' } }],
  },
];

const STANDARD_CHANGES: DemoStandard[] = [
  {
    template: 'Restart an application service',
    short: 'Restart the print spooler on the London print server',
    group: 'Hardware Support',
    assignee: 'jamal.wright',
    requester: 'alex.rivera',
    startDays: -6,
    hours: 1,
    target: 'closed',
    closeCode: 'successful',
  },
  {
    template: 'Apply monthly OS patches to a server',
    short: 'Apply monthly patches to the intranet web server',
    group: 'Cloud Operations',
    assignee: 'david.kim',
    requester: 'david.kim',
    ci: CIS.web,
    startDays: 3,
    hours: 2,
    target: 'scheduled',
  },
  {
    template: 'Add a firewall rule from the approved catalog',
    short: 'Allow monitoring probes from the network operations center',
    group: 'Network Operations',
    assignee: 'marcus.chen',
    requester: 'marcus.chen',
    ci: CIS.firewall,
    startDays: -0.02,
    hours: 1,
    target: 'implement',
  },
  {
    template: 'Replace a laptop (hardware refresh)',
    short: 'Laptop refresh for a new hire in the Dubai office',
    group: 'Hardware Support',
    assignee: 'jamal.wright',
    requester: 'noor.haddad',
    startDays: 2,
    hours: 2,
    target: 'new',
  },
  {
    template: 'Rotate a TLS certificate',
    short: 'Rotate the intranet TLS certificate',
    group: 'Information Security',
    assignee: 'fatima.alsayed',
    requester: 'fatima.alsayed',
    ci: CIS.web,
    startDays: -1.5,
    hours: 1,
    target: 'review',
  },
  {
    template: 'Apply monthly OS patches to a server',
    short: 'Monthly patching of the build agents',
    group: 'Application Development',
    assignee: 'tom.becker',
    requester: 'tom.becker',
    startDays: 7,
    hours: 3,
    target: 'canceled',
  },
];

function userId(ctx: Context, userName: string): string | null {
  return ctx.first('sys_user', `user_name=${userName}`)?.sysId ?? null;
}

function findCi(ctx: Context, ci?: { names: string[]; keywords: string[] }): string | null {
  if (!ci || !ctx.registry.has('cmdb_ci')) return null;
  for (const name of ci.names) {
    const hit = ctx.first('cmdb_ci', `name=${name}`);
    if (hit) return hit.sysId;
  }
  for (const k of ci.keywords) {
    const hit = ctx.first('cmdb_ci', `nameLIKE${k}`);
    if (hit) return hit.sysId;
  }
  return null;
}

const ORDER: Target[] = ['new', 'assess', 'authorize', 'scheduled', 'implement', 'review', 'closed'];

function approveStage(ctx: Context, change: Rec): void {
  const svc = approvalsOf(ctx.platform);
  if (svc) {
    const row = approvalRows(ctx, change.sysId, 'state=requested')[0];
    if (row) {
      const approver = row.str('approver');
      const actor = approver ? ctx.platform.users.session(approver) : null;
      const actorCtx = actor ? ctx.platform.contextFor(actor) : ctx;
      svc.decide(actorCtx, row, 'approved', 'Reviewed in the weekly change review.');
      return;
    }
  }
  directDecision(ctx, change, 'approved', 'Reviewed in the weekly change review.');
}

/** Walks a change through its model to the target state using the normal actions. */
function advance(ctx: Context, changeId: string, target: Target, closeCode = 'successful'): void {
  const sys = ctx;
  const get = () => sys.get(T.change, changeId)!;
  if (target === 'canceled') {
    sys.update(get(), {
      state: STATE.CANCELED,
      work_notes: 'Change canceled: no longer needed after the scope review.',
    });
    return;
  }
  const want = ORDER.indexOf(target);
  for (let guard = 0; guard < 12; guard++) {
    const change = get();
    const state = change.num('state');
    const current: Target = (
      {
        [-5]: 'new',
        [-4]: 'assess',
        [-3]: 'authorize',
        [-2]: 'scheduled',
        [-1]: 'implement',
        [0]: 'review',
        [3]: 'closed',
      } as Record<number, Target>
    )[state ?? -5];
    if (ORDER.indexOf(current) >= want) return;
    switch (current) {
      case 'new': {
        const type = change.str('type');
        const next =
          type === 'standard' ? STATE.SCHEDULED : type === 'emergency' ? STATE.AUTHORIZE : STATE.ASSESS;
        sys.update(change, { state: next });
        break;
      }
      case 'assess':
      case 'authorize':
        approveStage(sys, change);
        break;
      case 'scheduled': {
        // Past changes keep their planned dates as actual dates.
        const start = change.str('start_date');
        sys.update(change, {
          state: STATE.IMPLEMENT,
          ...(start && start < nowGlide() ? { work_start: start } : {}),
        });
        break;
      }
      case 'implement':
        for (const t of sys.query(T.task, `change_request=${changeId}^active=true^created_from=manual`)) {
          sys.update(t, {
            state: TASK_STATE.CLOSED,
            close_code: 'successful',
            close_notes: 'Done as planned.',
          });
        }
        if (get().num('state') === STATE.IMPLEMENT) {
          const end = get().str('end_date');
          sys.update(get(), { state: STATE.REVIEW, ...(end && end < nowGlide() ? { work_end: end } : {}) });
        }
        break;
      case 'review':
        sys.update(change, {
          state: STATE.CLOSED,
          close_code: closeCode,
          close_notes:
            closeCode === 'unsuccessful'
              ? 'Rolled back after the smoke tests failed; a new change will be raised.'
              : closeCode === 'successful_issues'
                ? 'Completed; two shares needed a manual permission fix afterwards.'
                : 'Completed as planned, no issues reported.',
          review_comments: 'Post-implementation review done with the requester.',
        });
        break;
      default:
        return;
    }
  }
}

/** Demo steps never break the demo of other modules: failures are recorded and logged. */
function safely(ctx: Context, label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    const message = `${label}: ${e instanceof Error ? e.message : String(e)}`;
    ctx.platform.errors.push({ where: 'change demo', message, at: nowGlide() });
    ctx.platform.log.warn(`[resolvrnow] change demo: ${message}`);
  }
}

function quarterEnd(now: Date, offsetQuarters = 0): Date {
  const q = Math.floor(now.getUTCMonth() / 3) + offsetQuarters;
  return new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
}

const spanDate = (d: Date) => toGlideDateTime(d).replace(/[-:]/g, '').replace(' ', 'T');

/** Demo data for Northwind Labs: changes across types and states, templates, a freeze and a CAB. */
export function changeDemo(ctx: Context): void {
  const now = clock.now();
  const nowStr = nowGlide();

  // Change Management and CAB Approval members.
  safely(ctx, 'groups', () => {
    const add = (group: string, users: string[]) => {
      const g = groupByName(ctx, group);
      if (!g) return;
      for (const u of users) {
        const id = userId(ctx, u);
        if (id && !ctx.first('sys_user_grmember', `group=${g.sysId}^user=${id}`))
          ctx.insert('sys_user_grmember', { group: g.sysId, user: id });
      }
    };
    add('CAB Approval', ['grace.okafor', 'maya.cohen']);
    add('Change Management', ['grace.okafor']);
    ctx.platform.users.invalidate();
  });

  // Standard change templates.
  for (const t of TEMPLATES) safely(ctx, `template ${t.name}`, () => void createTemplate(ctx, t));

  // End-of-quarter finance freeze and a weekend maintenance window.
  safely(ctx, 'schedules', () => {
    if (!ctx.first(T.blackout, 'name=End-of-quarter finance freeze')) {
      const freeze = ctx.insert(T.blackout, {
        name: 'End-of-quarter finance freeze',
        description: 'No changes to finance systems while the books are closed at the end of each quarter.',
        category: 'hard_freeze',
        source: 'change_request',
        condition:
          'category=Applications Software^ORshort_descriptionLIKEfinance^ORshort_descriptionLIKEERP^ORshort_descriptionLIKEpayroll',
        time_zone: 'UTC',
      });
      for (const offset of [0, 1]) {
        const end = quarterEnd(now, offset);
        const start = new Date(end.getTime() - 6 * DAY);
        ctx.insert(T.span, {
          schedule: freeze.sysId,
          name: `Quarter close ${toGlideDateTime(start).slice(0, 7)}`,
          start_date_time: spanDate(start),
          end_date_time: spanDate(end),
        });
      }
    }
    if (!ctx.first(T.maintenance, 'name=Database weekend maintenance window')) {
      const sqlCi = findCi(ctx, CIS.sql);
      const window = ctx.insert(T.maintenance, {
        name: 'Database weekend maintenance window',
        description: 'Database servers may only change on Saturday nights.',
        category: 'general',
        source: 'ci_class',
        applies_to: 'cmdb_ci',
        condition: sqlCi ? `sys_id=${sqlCi}` : 'name=sql-prod-01',
        time_zone: 'UTC',
      });
      const saturday = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + ((6 - now.getUTCDay() + 7) % 7),
          22,
        ),
      );
      ctx.insert(T.span, {
        schedule: window.sysId,
        name: 'Saturday night',
        start_date_time: spanDate(saturday),
        end_date_time: spanDate(new Date(saturday.getTime() + 8 * HOUR)),
        repeat_type: 'weekly',
        days_of_week: '6',
      });
    }
  });

  // Normal and emergency changes.
  for (const d of CHANGES) {
    safely(ctx, d.short, () => {
      if (ctx.first(T.change, `short_description=${d.short}`)) return;
      const start = d.inFreeze
        ? toGlideDateTime(new Date(quarterEnd(now).getTime() - 3 * DAY + 20 * HOUR))
        : addMs(nowStr, Math.round(d.startDays * DAY));
      const group = groupByName(ctx, d.group);
      const values: Record<string, unknown> = {
        chg_model: d.type === 'emergency' ? MODEL_IDS.emergency : MODEL_IDS.normal,
        short_description: d.short,
        description: d.description,
        category: d.category ?? 'Other',
        assignment_group: group?.sysId ?? null,
        assigned_to: userId(ctx, d.assignee),
        requested_by: userId(ctx, d.requester),
        cmdb_ci: findCi(ctx, d.ci),
        start_date: start,
        end_date: addMs(start, d.hours * HOUR),
        risk: d.risk ?? null,
        impact: d.impact ?? 3,
        justification: 'Keeps the service supported and secure.',
        implementation_plan: 'Follow the runbook attached to the change, step by step.',
        backout_plan:
          'Restore the previous version or configuration from the backup taken before the change.',
        test_plan: 'Run the service smoke tests and confirm monitoring is green.',
      };
      const change = ctx.insert(T.change, values);
      advance(ctx, change.sysId, d.target, d.closeCode);
      if (d.hold) ctx.update(ctx.get(T.change, change.sysId)!, { on_hold: true, on_hold_reason: d.hold });
    });
  }

  // Standard changes from the templates.
  for (const d of STANDARD_CHANGES) {
    safely(ctx, d.short, () => {
      if (ctx.first(T.change, `short_description=${d.short}`)) return;
      const producer = ctx.first(T.producer, `name=${d.template}`);
      if (!producer) return;
      const start = addMs(nowStr, Math.round(d.startDays * DAY));
      const { change } = createStandardChange(ctx, producer.sysId, {
        short_description: d.short,
        assignment_group: groupByName(ctx, d.group)?.sysId ?? null,
        assigned_to: userId(ctx, d.assignee),
        requested_by: userId(ctx, d.requester),
        cmdb_ci: findCi(ctx, d.ci),
        start_date: start,
        end_date: addMs(start, d.hours * HOUR),
      });
      advance(ctx, change.sysId, d.target, d.closeCode);
    });
  }

  // A change recorded after an unplanned configuration change.
  safely(ctx, 'unauthorized change', () => {
    const ci = findCi(ctx, CIS.switch);
    if (ci && !ctx.first(T.change, `cmdb_ci=${ci}^unauthorized=true`)) {
      createUnauthorizedChange(
        ctx,
        ci,
        'Port channel configuration changed on the core switch outside any change window.',
      );
    }
  });

  // Pipeline gates: one pre-approved standard deployment and one waiting for approval.
  safely(ctx, 'pipeline', () => {
    if (ctx.count(T.pipeline) > 0) return;
    createPipelineChange(ctx, {
      pipeline: 'northwind-intranet/deploy',
      build: '1842',
      commit: '9f3c2ab',
      short_description: 'Restart intranet service after configuration deploy',
      risk: 'low',
      template: 'Restart an application service',
      assignment_group: 'Software Support',
    });
    createPipelineChange(ctx, {
      pipeline: 'northwind-portal/release',
      build: '311',
      commit: 'c41d07e',
      short_description: 'Release customer portal 3.8 to production',
      risk: 'moderate',
      assignment_group: 'Application Development',
      ci: 'web-prod-01',
    });
  });

  // Weekly CAB meeting next Tuesday at 15:00 UTC.
  safely(ctx, 'CAB meeting', () => {
    if (ctx.first(T.cabMeeting, 'name=Weekly Change Advisory Board')) return;
    const days = (2 - now.getUTCDay() + 7) % 7 || 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 15));
    const cab = groupByName(ctx, 'CAB Approval');
    const manager = userId(ctx, 'grace.okafor') ?? usersWithRole(ctx, 'change_manager')[0] ?? null;
    const meeting = ctx.insert(T.cabMeeting, {
      name: 'Weekly Change Advisory Board',
      manager,
      board_groups: cab?.sysId ?? null,
      start: toGlideDateTime(start),
      end: toGlideDateTime(new Date(start.getTime() + HOUR)),
      conference_details: 'Room Austin 4.12 and the CAB video bridge',
      changes_start_after: nowStr,
      changes_start_on_or_before: addMs(toGlideDateTime(start), 21 * DAY),
      auto_add_agenda_decisions: true,
    });
    refreshAgenda(ctx, meeting);
  });
}
