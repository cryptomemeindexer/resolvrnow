import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { DAY, DemoRun, HOUR, MINUTE } from '../incident/demo.js';
import { DEMO_SCENARIOS, MI_EMAIL } from '../incident/demo-data.js';
import {
  addIncidentsToProblem,
  communicateFix,
  communicateWorkaround,
  createProblemFromIncident,
} from './incidents.js';
import { createKnownErrorArticle, knowledgeAvailable } from './knowledge.js';
import {
  acceptRisk,
  assessProblem,
  cancelProblem,
  completeProblem,
  completeTask,
  confirmProblem,
  fixProblem,
  markDuplicate,
  resolveProblem,
  startTaskWork,
} from './lifecycle.js';

type Outcome = 'new' | 'assess' | 'rca' | 'fix' | 'resolved' | 'closed' | 'risk' | 'duplicate' | 'canceled';

interface TaskStory {
  type: 'rca' | 'general';
  short: string;
  assignee: string;
  group: string;
  done?: { cause_code?: string; fix_notes?: string; close_notes?: string };
}

interface ProblemStory {
  short: string;
  description: string;
  coordinator: string;
  group: string;
  /** Scenario keys (see the incident demo) whose incidents relate to the problem. */
  scenarios: string[];
  outcome: Outcome;
  cause?: string;
  workaround?: string;
  fix?: string;
  riskReason?: string;
  cancelReason?: string;
  knownError?: boolean;
  shareWorkaround?: boolean;
  shareFix?: boolean;
  duplicateOf?: string;
  tasks?: TaskStory[];
  /** Age of the problem when no incident is linked. */
  daysAgo: number;
}

const COORDINATORS = [
  'marcus.chen',
  'sofia.alvarez',
  'elena.petrova',
  'jamal.wright',
  'david.kim',
  'fatima.alsayed',
  'tom.becker',
];
const ANALYSTS = ['lucas.moreau'];

const STORIES: ProblemStory[] = [
  {
    short: 'Meeting room add-in crashes Outlook on shared calendars',
    description:
      'Several users report Outlook closing when they open shared calendars since the October Office update.',
    coordinator: 'elena.petrova',
    group: 'Software Support',
    scenarios: ['outlook_shared_calendar'],
    outcome: 'fix',
    cause:
      'The meeting room add-in calls a calendar interface that changed in the latest Office build and fails on calendars with many recurring meetings.',
    workaround:
      '<p>Disable the meeting room add-in (File, Options, Add-ins) and use Outlook on the web for shared calendars until the fixed add-in is deployed.</p>',
    fix: '<p>Deploy version 3.2 of the meeting room add-in, which uses the supported calendar interface.</p>',
    knownError: true,
    shareWorkaround: true,
    tasks: [
      {
        type: 'rca',
        short: 'Reproduce the crash and identify the failing component',
        assignee: 'elena.petrova',
        group: 'Software Support',
        done: {
          cause_code: 'software_issue',
          fix_notes: '<p>Upgrade the add-in to version 3.2 or later.</p>',
        },
      },
    ],
    daysAgo: 25,
  },
  {
    short: 'London VPN tunnel drops healthy sessions',
    description:
      'Recurring VPN disconnects for London users, roughly every ten minutes, across several teams.',
    coordinator: 'marcus.chen',
    group: 'Network Operations',
    scenarios: ['vpn_drops'],
    outcome: 'resolved',
    cause:
      "Dead peer detection timers on the London tunnel were shorter than the ISP's link failover time, so healthy sessions were torn down.",
    workaround: '<p>Reconnect the VPN client; sessions on the backup gateway are not affected.</p>',
    fix: '<p>Aligned the dead peer detection timers with the ISP failover window and pushed the new client profile to every London laptop.</p>',
    shareFix: true,
    daysAgo: 30,
  },
  {
    short: 'Wi-Fi roaming between floors at Austin HQ takes too long',
    description: 'Laptops lose connectivity for up to a minute when moving between the 3rd and 4th floors.',
    coordinator: 'marcus.chen',
    group: 'Network Operations',
    scenarios: ['wifi_roaming'],
    outcome: 'rca',
    workaround: '<p>Install the latest wireless driver from the software center.</p>',
    tasks: [
      {
        type: 'rca',
        short: 'Capture roaming traces on floors 3 and 4',
        assignee: 'marcus.chen',
        group: 'Network Operations',
      },
    ],
    daysAgo: 14,
  },
  {
    short: 'Nightly ERP inventory batch overruns its window',
    description:
      'The inventory batch has finished after 07:00 several times this month, delaying the morning refresh.',
    coordinator: 'sofia.alvarez',
    group: 'Database Administration',
    scenarios: ['erp_batch'],
    outcome: 'assess',
    daysAgo: 6,
  },
  {
    short: 'Docking stations lose display output after sleep',
    description: 'External monitors stay black after laptops wake up while docked; several reports per week.',
    coordinator: 'jamal.wright',
    group: 'Hardware Support',
    scenarios: ['dock_display'],
    outcome: 'rca',
    cause: 'Dock firmware does not restore display links when USB selective suspend is enabled.',
    workaround:
      '<p>Turn off USB selective suspend for the dock in the power plan, or unplug and replug the dock.</p>',
    knownError: true,
    shareWorkaround: true,
    daysAgo: 33,
  },
  {
    short: 'Single sign-on loops in Safari',
    description: 'Safari users are redirected to the sign-in page again and again.',
    coordinator: 'fatima.alsayed',
    group: 'Information Security',
    scenarios: ['sso_loop'],
    outcome: 'closed',
    cause:
      'The identity provider issued the session cookie without the SameSite attribute, which Safari blocks on cross-site requests.',
    fix: '<p>Identity provider updated to issue the session cookie with SameSite=None and Secure.</p>',
    shareFix: true,
    daysAgo: 45,
  },
  {
    short: 'Expense app receipt uploads time out at peak hours',
    description: 'Submitting expense reports with many receipts fails with a timeout during month-end.',
    coordinator: 'tom.becker',
    group: 'Application Development',
    scenarios: ['expense_timeout'],
    outcome: 'risk',
    cause: 'The SaaS vendor caps receipt uploads at 30 seconds per request.',
    workaround: '<p>Submit receipts in batches of five or fewer.</p>',
    riskReason:
      'The vendor will not change the limit before its next major release; the batch workaround is reliable and documented.',
    daysAgo: 40,
  },
  {
    short: 'File server FS02 runs out of space every few weeks',
    description: 'Disk space alerts on FS02 keep coming back after each clean-up.',
    coordinator: 'david.kim',
    group: 'Cloud Operations',
    scenarios: ['disk_space'],
    outcome: 'new',
    daysAgo: 2,
  },
  {
    short: 'VPN client disconnects after the Windows update',
    description: 'Logged separately before the London VPN investigation started.',
    coordinator: 'marcus.chen',
    group: 'Network Operations',
    scenarios: [],
    outcome: 'duplicate',
    duplicateOf: 'London VPN tunnel drops healthy sessions',
    daysAgo: 28,
  },
  {
    short: 'Print jobs hang on the London print server',
    description: 'The 2nd floor queue in London stalls about once a week.',
    coordinator: 'jamal.wright',
    group: 'Hardware Support',
    scenarios: ['printer_queue'],
    outcome: 'rca',
    tasks: [
      {
        type: 'general',
        short: 'Collect spooler logs from the London print server',
        assignee: 'lucas.moreau',
        group: 'Hardware Support',
        done: {
          close_notes:
            'Logs from the last three stalls collected; all three started with a job from the same label printer driver.',
        },
      },
      {
        type: 'rca',
        short: 'Find which driver produces the corrupted print jobs',
        assignee: 'jamal.wright',
        group: 'Hardware Support',
      },
    ],
    daysAgo: 10,
  },
  {
    short: 'Endpoint agent scan slows down laptop start-up',
    description: 'Start-up takes over ten minutes on laptops with large profiles.',
    coordinator: 'fatima.alsayed',
    group: 'Information Security',
    scenarios: ['slow_boot'],
    outcome: 'fix',
    cause: 'The endpoint policy scans the whole user profile at sign-in instead of on access.',
    workaround: '<p>Move the full scan to lunch time for the affected devices.</p>',
    fix: '<p>Exclude the profile cache from the sign-in scan in the endpoint policy and keep on-access scanning.</p>',
    shareWorkaround: true,
    daysAgo: 18,
  },
  {
    short: 'Account lockouts after password changes',
    description: 'Several lockouts reported right after users changed their passwords.',
    coordinator: 'ravi.menon',
    group: 'Problem Management',
    scenarios: ['account_locked'],
    outcome: 'canceled',
    cancelReason:
      'Caused by passwords saved on phones; handled with a knowledge article rather than a problem.',
    daysAgo: 9,
  },
];

const shortOf = (key: string) => DEMO_SCENARIOS.find((s) => s.key === key)?.short ?? '';
const isOpen = (inc: Rec) => ['1', '2', '3'].includes(inc.str('state'));

function grantRoles(run: DemoRun): void {
  const ctx = run.sys;
  const grant = (roleName: string, users: string[]) => {
    const role = ctx.first('sys_user_role', `name=${roleName}`);
    for (const name of users) {
      const user = ctx.first('sys_user', `user_name=${name}`);
      if (role && user && !ctx.first('sys_user_has_role', `user=${user.sysId}^role=${role.sysId}`)) {
        ctx.insert('sys_user_has_role', { user: user.sysId, role: role.sysId });
      }
    }
  };
  grant('problem_coordinator', COORDINATORS);
  grant('problem_task_analyst', ANALYSTS);
  run.platform.users.invalidate();
}

function incidentsOf(run: DemoRun, story: ProblemStory): Rec[] {
  const out: Rec[] = [];
  for (const key of story.scenarios)
    out.push(...run.sys.query('incident', { query: `short_description=${shortOf(key)}` }));
  return out.sort((a, b) => run.time(a, 'opened_at') - run.time(b, 'opened_at'));
}

const userNameOf = (run: DemoRun, sysId: string, fallback: string) =>
  (sysId && run.platform.users.session(sysId)?.userName) || fallback;

/** Plays one problem story from its first incident to the planned outcome. */
function playProblem(run: DemoRun, story: ProblemStory, problemIds: Map<string, string>): void {
  const limit = run.base - 15 * MINUTE;
  const incidents = incidentsOf(run, story);
  const first = incidents[0];
  const opener = incidents.find(isOpen) ?? null;
  const anchor = opener ?? first;
  const anchorTime = anchor ? run.time(anchor, 'opened_at') : run.base - story.daysAgo * DAY;
  let t = Math.max(
    Math.min(anchorTime + run.between(2, 6) * HOUR, limit - 6 * HOUR),
    anchorTime + 10 * MINUTE,
  );
  const coord = run.as(story.coordinator);

  // Raised from an open incident (which then waits on the problem) or logged directly.
  const id = run.at(t, () =>
    opener
      ? createProblemFromIncident(
          run.as(userNameOf(run, opener.str('assigned_to'), 'ravi.menon')),
          run.fresh('incident', opener.sysId),
        )
      : coord.insert('problem', {
          first_reported_by_task: first?.sysId ?? null,
          impact: first?.num('impact') ?? 3,
          urgency: first?.num('urgency') ?? 3,
          category: first?.str('category') ?? '',
        }),
  ).sysId;
  problemIds.set(story.short, id);
  const step = (minutes: number, fn: (p: Rec) => unknown) => {
    t = Math.min(t + minutes * MINUTE, limit);
    run.at(t, () => fn(run.fresh('problem', id)));
  };

  step(20, (p) =>
    coord.update(p, {
      short_description: story.short,
      description: story.description,
      assignment_group: run.groupId(story.group),
      work_notes:
        incidents.length > 1
          ? `Taking ownership; ${incidents.length} related incidents so far.`
          : 'Taking ownership.',
    }),
  );
  linkIncidents(run, coord, id, incidents, opener);
  if (story.outcome === 'new') return;
  step(10, (p) => assessProblem(coord, p, { assigned_to: run.userId(story.coordinator) }));
  if (story.outcome === 'assess') return;
  if (story.outcome === 'canceled') {
    step(run.between(60, 240), (p) => cancelProblem(coord, p, story.cancelReason));
    return;
  }
  if (story.outcome === 'duplicate') {
    const target = problemIds.get(story.duplicateOf ?? '');
    if (target)
      step(run.between(60, 180), (p) =>
        markDuplicate(coord, p, target, 'Same root cause as the London VPN investigation.'),
      );
    return;
  }
  step(run.between(60, 300), (p) => confirmProblem(coord, p));
  if (story.workaround) {
    step(run.between(120, 600), (p) =>
      coord.update(p, { workaround: story.workaround, work_notes: 'Workaround documented and verified.' }),
    );
    if (story.knownError) step(30, (p) => markKnownError(run, coord, p));
    if (story.shareWorkaround) step(30, (p) => communicateWorkaround(coord, p));
  }
  playTasks(run, story, id, t);
  if (story.outcome === 'rca') return;
  if (story.outcome === 'risk') {
    step(run.between(1, 3) * 24 * 60, (p) =>
      acceptRisk(coord, p, { cause_notes: story.cause, close_notes: story.riskReason }),
    );
    return;
  }
  step(run.between(1, 2) * 24 * 60, (p) =>
    fixProblem(coord, p, { cause_notes: story.cause, fix_notes: story.fix }),
  );
  if (story.outcome === 'fix') return;
  holdWaitingIncidents(run, id, t);
  step(run.between(1, 3) * 24 * 60, (p) => resolveProblem(coord, p));
  if (story.shareFix) step(20, (p) => communicateFix(coord, p));
  if (story.outcome === 'closed') step(run.between(3, 6) * 24 * 60, (p) => completeProblem(coord, p));
}

function markKnownError(run: DemoRun, coord: Context, prb: Rec): void {
  if (knowledgeAvailable(run.platform)) createKnownErrorArticle(coord, prb);
  else
    coord.update(prb, {
      known_error: true,
      work_notes: 'Root cause known and a workaround is available: flagged as a known error.',
    });
}

/** Other incidents are related as they come in (or shortly after the problem was logged). */
function linkIncidents(
  run: DemoRun,
  coord: Context,
  problemId: string,
  incidents: Rec[],
  opener: Rec | null,
): void {
  const created = run.time(run.fresh('problem', problemId), 'opened_at');
  for (const inc of incidents) {
    if (inc.sysId === opener?.sysId) continue;
    const when = Math.max(run.time(inc, 'opened_at') + run.between(1, 4) * HOUR, created + 30 * MINUTE);
    run.at(Math.min(when, run.base - 20 * MINUTE), () =>
      addIncidentsToProblem(coord, run.fresh('problem', problemId), [inc.sysId]),
    );
  }
}

/** Open incidents of a problem about to be fixed wait on it, so the fix resolves them. */
function holdWaitingIncidents(run: DemoRun, problemId: string, when: number): void {
  for (const inc of run.sys.query('incident', { query: `problem_id=${problemId}^stateIN1,2` })) {
    if (run.time(inc, 'opened_at') > when) continue;
    run.at(when, () =>
      run.as(userNameOf(run, inc.str('assigned_to'), 'ravi.menon')).update(run.fresh('incident', inc.sysId), {
        state: '3',
        hold_reason: '3',
        work_notes: 'Waiting for the permanent fix from the related problem.',
      }),
    );
  }
}

function playTasks(run: DemoRun, story: ProblemStory, problemId: string, from: number): void {
  let t = from;
  for (const task of story.tasks ?? []) {
    t = Math.min(t + run.between(30, 180) * MINUTE, run.base - 2 * HOUR);
    const id = run.at(t, () =>
      run.as(story.coordinator).insert('problem_task', {
        problem: problemId,
        problem_task_type: task.type,
        short_description: task.short,
        assignment_group: run.groupId(task.group),
        assigned_to: run.userId(task.assignee),
      }),
    ).sysId;
    t = Math.min(t + run.between(30, 120) * MINUTE, run.base - HOUR);
    run.at(t, () => startTaskWork(run.as(task.assignee), run.fresh('problem_task', id)));
    if (!task.done) continue;
    t = Math.min(t + run.between(4, 30) * HOUR, run.base - 30 * MINUTE);
    run.at(t, () => completeTask(run.as(task.assignee), run.fresh('problem_task', id), task.done!));
  }
}

/** The mail relay problem raised from the ongoing major incident (the major incident does not go on hold). */
function playMajorProblem(run: DemoRun): void {
  const mi = run.sys.first('incident', `short_description=${MI_EMAIL.short}`);
  if (!mi) return;
  const t = Math.min(run.time(mi, 'opened_at') + 90 * MINUTE, run.base - 40 * MINUTE);
  const coord = run.as('david.kim');
  const id = run.at(t, () =>
    coord.insert('problem', {
      short_description: 'Expired relay certificate stopped outbound mail',
      description: MI_EMAIL.cause,
      first_reported_by_task: mi.sysId,
      impact: 1,
      urgency: 1,
      category: 'software',
      subcategory: 'email',
      assignment_group: run.groupId('Cloud Operations'),
      assigned_to: run.userId('david.kim'),
    }),
  ).sysId;
  run.at(t + 5 * MINUTE, () =>
    run.as('priya.nair').update(run.fresh('incident', mi.sysId), { problem_id: id }),
  );
  run.at(t + 10 * MINUTE, () =>
    coord.update(run.fresh('problem', id), {
      major_problem: true,
      work_notes: 'Major problem: company-wide outage. A review is required once fixed.',
    }),
  );
  run.at(t + 25 * MINUTE, () => confirmProblem(coord, run.fresh('problem', id)));
}

/** Demo data: a dozen problems linked to the demo incidents. */
export function seedProblemDemo(ctx: Context): void {
  if (!ctx.first('sys_user', 'user_name=ravi.menon') || ctx.count('problem') > 0) return;
  const run = new DemoRun(ctx, 40001);
  grantRoles(run);
  const problemIds = new Map<string, string>();
  for (const story of STORIES) playProblem(run, story, problemIds);
  playMajorProblem(run);
}
