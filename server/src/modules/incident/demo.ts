import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { clock, parseGlideDateTime } from '../../engine/util.js';
import {
  DEMO_SCENARIOS,
  type DemoScenario,
  MI_CANDIDATE,
  MI_EMAIL,
  MI_NETWORK,
  MI_REJECTED,
} from './demo-data.js';
import { sendCommunication } from './icm.js';
import { closeIncident, reopenIncident, resolveIncident } from './lifecycle.js';
import {
  promoteMajorIncident,
  proposeMajorIncident,
  regeneratePirTimeline,
  rejectMajorIncident,
} from './mim.js';
import { MI_PLAN_DEFINITION } from './seed.js';
import { quietly } from './util.js';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Small deterministic PRNG so the demo looks the same on every install. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plays demo stories in the past: the clock is moved to each step's time so audit
 * entries, journals, resolve times and KPI fields carry realistic timestamps. Moves are
 * relative and always undone, so a frozen or offset clock is left as it was.
 */
export class DemoRun {
  readonly base: number;
  readonly platform: Platform;
  private readonly rand: () => number;
  private readonly contexts = new Map<string, Context>();

  constructor(
    readonly sys: Context,
    seed: number,
  ) {
    this.platform = sys.platform;
    this.base = clock.now().getTime();
    this.rand = mulberry32(seed);
  }

  random(): number {
    return this.rand();
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.rand();
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  chance(p: number): boolean {
    return this.rand() < p;
  }

  shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Context of a demo user (ACLs off, identity kept for journals and audit). */
  as(userName: string): Context {
    let ctx = this.contexts.get(userName);
    if (!ctx) {
      ctx = this.platform.contextAs(userName).elevated();
      this.contexts.set(userName, ctx);
    }
    return ctx;
  }

  userId(userName: string): string {
    return this.platform.users.byUserName(userName)?.sysId ?? '';
  }

  groupId(name: string): string {
    return this.sys.first('sys_user_group', `name=${name}`)?.sysId ?? '';
  }

  /** Runs `fn` with the clock at `when` (epoch ms). */
  at<T>(when: number, fn: () => T): T {
    const shift = Math.round(when) - clock.now().getTime();
    clock.advance(shift);
    try {
      return fn();
    } finally {
      clock.advance(-shift);
    }
  }

  /** Fresh copy of a record (a new context, so referenced records are never stale). */
  fresh(table: string, sysId: string): Rec {
    return this.platform.systemContext().get(table, sysId)!;
  }

  /** Epoch ms of a stored date-time field. */
  time(rec: Rec, field: string): number {
    return parseGlideDateTime(rec.str(field))?.getTime() ?? this.base;
  }
}

const SERVICE_DESK = ['alex.rivera', 'noor.haddad', 'hannah.lee', 'alex.rivera', 'noor.haddad', 'priya.nair'];
const RESOLVERS: Record<string, string[]> = {
  'Service Desk': ['alex.rivera', 'noor.haddad', 'hannah.lee'],
  'Network Operations': ['marcus.chen'],
  'Database Administration': ['sofia.alvarez'],
  'Hardware Support': ['jamal.wright', 'lucas.moreau'],
  'Software Support': ['elena.petrova'],
  'Cloud Operations': ['david.kim'],
  'Information Security': ['fatima.alsayed'],
  'Application Development': ['tom.becker'],
};
const CALLERS = [
  'olivia.martin',
  'noah.johnson',
  'emma.williams',
  'liam.brown',
  'ava.jones',
  'ethan.garcia',
  'mia.miller',
  'james.davis',
  'layla.hassan',
  'charlotte.taylor',
  'henry.anderson',
];
const SITE_CALLERS: Record<string, string[]> = {
  london: ['noah.johnson', 'mia.miller'],
  austin: ['olivia.martin', 'emma.williams', 'charlotte.taylor', 'henry.anderson'],
  singapore: ['ava.jones'],
};
const SCENARIO_SITE: Record<string, string> = {
  vpn_drops: 'london',
  printer_queue: 'london',
  wifi_roaming: 'austin',
  printer_toner: 'austin',
  dns_internal: 'singapore',
};
const MANAGERS: Record<string, string> = {
  'olivia.martin': 'charlotte.taylor',
  'ethan.garcia': 'charlotte.taylor',
  'noah.johnson': 'henry.anderson',
  'james.davis': 'tom.becker',
};
const SELF_REPORTED = new Set(['self-service', 'email', 'chat']);
const AUTO_CLOSE_NOTE = 'Closed automatically after 7 days in the Resolved state.';

type Outcome = 'new' | 'in_progress' | 'on_hold' | 'resolved' | 'closed' | 'canceled';
interface Slot {
  outcome: Outcome;
  daysAgo: number;
  hold?: '1' | '4' | '5';
  scenario?: string;
  reopen?: boolean;
}

/** Planned outcomes for the 67 regular incidents (major incidents are played separately). */
function plannedSlots(run: DemoRun): Slot[] {
  const slots: Slot[] = [];
  for (let i = 0; i < 30; i++)
    slots.push({
      outcome: 'closed',
      daysAgo: 12 + i * 1.55 + run.between(0, 1),
      reopen: [2, 9, 17].includes(i),
    });
  for (const d of [5, 20, 41]) slots.push({ outcome: 'canceled', daysAgo: d + run.between(0, 1) });
  for (let i = 0; i < 10; i++)
    slots.push({ outcome: 'resolved', daysAgo: 1.2 + i * 0.5 + run.between(0, 0.4) });
  for (let i = 0; i < 11; i++)
    slots.push({ outcome: 'in_progress', daysAgo: 0.4 + i * 0.8 + run.between(0, 0.3) });
  for (let i = 0; i < 8; i++) slots.push({ outcome: 'new', daysAgo: 0.05 + i * 0.18 });
  slots.push(
    { outcome: 'on_hold', daysAgo: 1.4, hold: '1', scenario: 'teams_audio' },
    { outcome: 'on_hold', daysAgo: 2.1, hold: '1', scenario: 'slow_boot' },
    { outcome: 'on_hold', daysAgo: 6.3, hold: '4', scenario: 'laptop_battery' },
    { outcome: 'on_hold', daysAgo: 8.6, hold: '4', scenario: 'antivirus_alert' },
    { outcome: 'on_hold', daysAgo: 3.2, hold: '5', scenario: 'portal_500' },
  );
  return slots;
}

/** Pairs slots with scenario instances (fixed pairs first, the rest shuffled). */
function castScenarios(run: DemoRun, slots: Slot[]): [Slot, DemoScenario][] {
  const pool: DemoScenario[] = [];
  for (const s of DEMO_SCENARIOS) for (let i = 0; i < s.count; i++) pool.push(s);
  const fixed: [Slot, DemoScenario][] = [];
  for (const slot of slots.filter((s) => s.scenario)) {
    const i = pool.findIndex((s) => s.key === slot.scenario);
    if (i >= 0) fixed.push([slot, pool.splice(i, 1)[0]]);
  }
  const rest = run.shuffle(pool);
  const free = slots.filter((s) => !s.scenario);
  return [...fixed, ...free.slice(0, rest.length).map((s, i): [Slot, DemoScenario] => [s, rest[i]])];
}

/** Time needed to resolve, by impact and urgency. */
function resolveDuration(run: DemoRun, s: DemoScenario): number {
  const weight = s.impact + s.urgency;
  if (weight <= 3) return run.between(1.5 * HOUR, 6 * HOUR);
  if (weight === 4) return run.between(3 * HOUR, 20 * HOUR);
  return run.between(5 * HOUR, 2.5 * DAY);
}

/** One regular incident, played from the report to its planned outcome. */
function playIncident(run: DemoRun, slot: Slot, s: DemoScenario): void {
  const limit = run.base - 10 * MINUTE;
  const opened = run.base - slot.daysAgo * DAY - run.between(0, 3) * HOUR;
  const site = SCENARIO_SITE[s.key];
  const callerName = run.pick(site ? SITE_CALLERS[site] : CALLERS);
  const desk = run.pick(SERVICE_DESK);
  const values: Record<string, unknown> = {
    caller_id: run.userId(callerName),
    short_description: s.short,
    description: s.description,
    category: s.category,
    subcategory: s.subcategory ?? '',
    impact: s.impact,
    urgency: s.urgency,
    contact_type: s.channel,
  };
  if (MANAGERS[callerName] && run.chance(0.4)) values.watch_list = run.userId(MANAGERS[callerName]);
  const reporter = SELF_REPORTED.has(s.channel) ? callerName : desk;
  const id = run.at(opened, () => run.as(reporter).insert('incident', values)).sysId;
  const update = (user: string, t: number, v: Record<string, unknown>) =>
    t < limit ? run.at(t, () => run.as(user).update(run.fresh('incident', id), v)) : null;

  if (slot.outcome === 'new') {
    if (run.chance(0.5))
      update(desk, opened + run.between(5, 25) * MINUTE, { assignment_group: run.groupId(s.group) });
    return;
  }

  // Triage by the service desk, sometimes with a hand-off to the resolver group.
  let t = opened + run.between(6, 35) * MINUTE;
  const resolver = s.group === 'Service Desk' ? desk : run.pick(RESOLVERS[s.group]);
  if (s.group !== 'Service Desk' && run.chance(0.45)) {
    update(desk, t, {
      assignment_group: run.groupId('Service Desk'),
      assigned_to: run.userId(desk),
      work_notes: 'Picked up from the queue. Checking the basics with the caller first.',
    });
    t += run.between(20, 80) * MINUTE;
  }
  update(desk, t, {
    assignment_group: run.groupId(s.group),
    assigned_to: run.userId(resolver),
    work_notes: s.group === 'Service Desk' ? 'Taking this one directly.' : `Routing to ${s.group}.`,
  });
  t += run.between(0.5, 3) * HOUR;
  update(resolver, t, { work_notes: s.notes[0] });
  if (s.ask && run.chance(0.6)) {
    t += run.between(10, 50) * MINUTE;
    update(resolver, t, { comments: s.ask[0] });
    t += run.between(0.5, 3) * HOUR;
    update(callerName, t, { comments: s.ask[1] });
  }
  if (s.notes[1]) {
    t += run.between(1, 4) * HOUR;
    update(resolver, t, { work_notes: s.notes[1] });
  }

  if (slot.outcome === 'in_progress') return;
  if (slot.outcome === 'on_hold') {
    putOnHold(run, id, slot.hold!, resolver, Math.min(t + run.between(1, 5) * HOUR, limit - HOUR));
    return;
  }
  if (slot.outcome === 'canceled') {
    update(desk, t + run.between(10, 60) * MINUTE, {
      state: '8',
      work_notes: run.pick([
        'The caller raised the same issue twice; continuing in the earlier ticket.',
        'The caller confirmed it cleared up before we started. Canceling.',
        'Reported under the wrong service; the caller opened a request instead.',
      ]),
    });
    return;
  }

  const resolvedAt = Math.min(t + resolveDuration(run, s), limit - 30 * MINUTE);
  run.at(resolvedAt, () =>
    resolveIncident(run.as(resolver), run.fresh('incident', id), {
      close_code: s.closeCode,
      close_notes: s.fix,
    }),
  );
  let finalResolution = resolvedAt;
  if (slot.reopen) {
    const back = resolvedAt + run.between(6, 26) * HOUR;
    run.at(back, () =>
      reopenIncident(run.as(callerName), run.fresh('incident', id), {
        comments: 'The issue came back this morning, same symptoms as before.',
      }),
    );
    update(resolver, back + run.between(1, 3) * HOUR, {
      work_notes: 'Reopened by the caller. The first fix did not hold; digging deeper.',
    });
    finalResolution = back + run.between(5, 20) * HOUR;
    run.at(finalResolution, () =>
      resolveIncident(run.as(resolver), run.fresh('incident', id), {
        close_code: s.closeCode,
        close_notes: `${s.fix} Checked again with the caller after the reopen.`,
      }),
    );
  }
  if (slot.outcome === 'closed') closeLater(run, id, callerName, finalResolution);
}

function putOnHold(run: DemoRun, id: string, reason: '1' | '4' | '5', resolver: string, when: number): void {
  const values: Record<string, unknown> = { state: '3', hold_reason: reason };
  if (reason === '1') {
    values.comments =
      'Could you restart and try again, then tell us whether the problem is still there? We keep the ticket open until we hear from you.';
  } else if (reason === '4') {
    values.work_notes = `Opened a case with the vendor (reference NW-${4000 + Math.floor(run.random() * 900)}). Waiting for their engineer.`;
  } else {
    values.work_notes =
      'The fix needs a configuration change; it is scheduled for the next maintenance window.';
  }
  run.at(when, () => run.as(resolver).update(run.fresh('incident', id), values));
}

/** The caller confirms the fix, or the incident closes itself after the auto-close delay. */
function closeLater(run: DemoRun, id: string, callerName: string, resolvedAt: number): void {
  if (run.chance(0.55)) {
    run.at(resolvedAt + run.between(2, 30) * HOUR, () =>
      closeIncident(run.as(callerName), run.fresh('incident', id), {
        comments: 'Confirmed, all good now. Thanks!',
      }),
    );
    return;
  }
  autoClose(run, id, resolvedAt + 7 * DAY + run.between(5, 55) * MINUTE);
}

function autoClose(run: DemoRun, id: string, when: number): void {
  run.at(when, () =>
    quietly(() => run.sys.update(run.fresh('incident', id), { state: '7', work_notes: AUTO_CLOSE_NOTE })),
  );
}

function addIncidentTask(
  run: DemoRun,
  incidentId: string,
  when: number,
  user: string,
  values: Record<string, unknown>,
): string {
  return run.at(when, () => run.as(user).insert('incident_task', { incident: incidentId, ...values }).sysId);
}

// ---------------------------------------------------------------- major incidents

/** Works the communication tasks attached to a major incident's plan. */
function communicate(run: DemoRun, incidentId: string, t0: number, closeAt?: number): void {
  const plan = run.sys.first('incident_alert', `source_incident=${incidentId}`);
  if (!plan) return;
  for (const task of run.sys.query('incident_alert_task', {
    query: `incident_alert=${plan.sysId}^ORDERBYorder`,
  })) {
    const recurring = task.str('communication_frequency') === 'recurring';
    for (const m of recurring ? [30, 90, 150] : [25]) {
      if (t0 + m * MINUTE > run.base - 5 * MINUTE) continue;
      run.at(t0 + m * MINUTE, () => {
        const fresh = run.fresh('incident_alert_task', task.sysId);
        if (!['-5', '1', '2'].includes(fresh.str('state'))) return;
        sendCommunication(
          run.as('priya.nair'),
          fresh,
          recurring ? 'Status update posted to the IT status page and emailed to all staff.' : 'Done.',
        );
      });
    }
  }
  if (closeAt === undefined) return;
  run.at(closeAt, () => {
    for (const task of run.sys.query('incident_alert_task', {
      query: `incident_alert=${plan.sysId}^stateIN-5,1,2`,
    })) {
      const fresh = run.fresh('incident_alert_task', task.sysId);
      run.as('priya.nair').update(fresh, { state: (fresh.num('times_performed') ?? 0) > 0 ? '3' : '7' });
    }
    run.as('priya.nair').update(run.fresh('incident_alert', plan.sysId), {
      state: '3',
      actions_taken: 'Service restored; final notice sent.',
    });
  });
}

function playNetworkMajorIncident(run: DemoRun): void {
  const t0 = run.base - 16 * DAY - 7 * HOUR;
  const mi = run.at(t0, () =>
    run.as('marcus.chen').insert('incident', {
      caller_id: run.userId('marcus.chen'),
      short_description: MI_NETWORK.short,
      description: MI_NETWORK.description,
      category: 'network',
      impact: 1,
      urgency: 1,
      contact_type: 'phone',
      assignment_group: run.groupId('Network Operations'),
      assigned_to: run.userId('marcus.chen'),
    }),
  ).sysId;
  const children = MI_NETWORK.children.map((short, i) => {
    const caller = SITE_CALLERS.austin[i % SITE_CALLERS.austin.length];
    return run.at(t0 + (3 + i * 4) * MINUTE, () =>
      run.as('alex.rivera').insert('incident', {
        caller_id: run.userId(caller),
        short_description: short,
        category: 'network',
        impact: 3,
        urgency: 1,
        contact_type: 'phone',
        parent_incident: mi,
        work_notes: 'Part of the Austin network outage.',
      }),
    ).sysId;
  });
  run.at(t0 + 10 * MINUTE, () =>
    promoteMajorIncident(run.as('priya.nair'), run.fresh('incident', mi), {
      reason: 'The entire Austin site is offline.',
      business_impact: MI_NETWORK.businessImpact,
    }),
  );
  run.at(t0 + 30 * MINUTE, () =>
    run.as('marcus.chen').update(run.fresh('incident', mi), {
      cause: MI_NETWORK.cause,
      work_notes:
        'Core switch A supervisor is down and the standby did not take over. A spare module is on its way from the Austin depot.',
      actions_taken: 'Vendor support engaged under the premium contract.',
    }),
  );
  const task = addIncidentTask(run, mi, t0 + 35 * MINUTE, 'marcus.chen', {
    short_description: 'Replace the supervisor module in core switch A',
    assignment_group: run.groupId('Network Operations'),
    assigned_to: run.userId('marcus.chen'),
  });
  const resolvedAt = t0 + 3 * HOUR + 20 * MINUTE;
  communicate(run, mi, t0, resolvedAt + 30 * MINUTE);
  run.at(resolvedAt - 10 * MINUTE, () =>
    run.as('marcus.chen').update(run.fresh('incident_task', task), {
      state: '3',
      close_notes: 'Module replaced and the stack restored.',
    }),
  );
  run.at(resolvedAt, () =>
    resolveIncident(run.as('marcus.chen'), run.fresh('incident', mi), {
      close_code: 'Solution provided',
      close_notes: MI_NETWORK.fix,
    }),
  );
  run.at(resolvedAt + DAY, () => {
    run.as('priya.nair').update(run.fresh('incident', mi), {
      overview: MI_NETWORK.overview,
      lessons_learned: MI_NETWORK.findings,
    });
    regeneratePirTimeline(run.as('priya.nair'), run.fresh('incident', mi));
  });
  run.at(resolvedAt + 2 * DAY, () => closeIncident(run.as('priya.nair'), run.fresh('incident', mi)));
  for (const child of children) autoClose(run, child, resolvedAt + 7 * DAY + 20 * MINUTE);
}

function playCandidates(run: DemoRun): void {
  const t0 = run.base - 20 * HOUR;
  const candidate = run.at(t0, () =>
    run.as('noor.haddad').insert('incident', {
      caller_id: run.userId('noah.johnson'),
      short_description: MI_CANDIDATE.short,
      description: MI_CANDIDATE.description,
      category: 'inquiry',
      subcategory: 'internal application',
      impact: 1,
      urgency: 2,
      contact_type: 'phone',
      assignment_group: run.groupId('Application Development'),
      assigned_to: run.userId('tom.becker'),
    }),
  ).sysId;
  run.at(t0 + 40 * MINUTE, () =>
    proposeMajorIncident(run.as('noor.haddad'), run.fresh('incident', candidate), {
      reason: MI_CANDIDATE.reason,
      business_impact: MI_CANDIDATE.businessImpact,
    }),
  );
  run.at(t0 + 3 * HOUR, () =>
    run.as('tom.becker').update(run.fresh('incident', candidate), {
      state: '2',
      work_notes:
        'The bank changed the file schema on the 1st and our export still uses the old version. Preparing a corrected file.',
    }),
  );

  const t1 = run.base - 5 * DAY - 4 * HOUR;
  const rejected = run.at(t1, () =>
    run.as('alex.rivera').insert('incident', {
      caller_id: run.userId('mia.miller'),
      short_description: MI_REJECTED.short,
      description: MI_REJECTED.description,
      category: 'hardware',
      impact: 2,
      urgency: 2,
      contact_type: 'phone',
      assignment_group: run.groupId('Hardware Support'),
      assigned_to: run.userId('lucas.moreau'),
    }),
  ).sysId;
  run.at(t1 + 20 * MINUTE, () =>
    proposeMajorIncident(run.as('alex.rivera'), run.fresh('incident', rejected), {
      reason: MI_REJECTED.reason,
      business_impact: 'Board meeting presentations at risk',
    }),
  );
  run.at(t1 + 50 * MINUTE, () =>
    rejectMajorIncident(run.as('priya.nair'), run.fresh('incident', rejected), MI_REJECTED.rejection),
  );
  run.at(t1 + 6 * HOUR, () =>
    resolveIncident(run.as('lucas.moreau'), run.fresh('incident', rejected), {
      close_code: 'Solution provided',
      close_notes: MI_REJECTED.fix,
    }),
  );
  run.at(t1 + 30 * HOUR, () => closeIncident(run.as('mia.miller'), run.fresh('incident', rejected)));
}

function playEmailMajorIncident(run: DemoRun): void {
  const t0 = run.base - 3 * HOUR - 20 * MINUTE;
  const mi = run.at(t0, () =>
    run.as('noor.haddad').insert('incident', {
      caller_id: null,
      short_description: MI_EMAIL.short,
      description: MI_EMAIL.description,
      category: 'software',
      subcategory: 'email',
      impact: 1,
      urgency: 1,
      contact_type: 'monitoring',
      assignment_group: run.groupId('Cloud Operations'),
      assigned_to: run.userId('david.kim'),
      work_notes: MI_EMAIL.notes[0],
    }),
  ).sysId;
  MI_EMAIL.children.forEach((short, i) => {
    const caller = CALLERS[(i * 3 + 1) % CALLERS.length];
    const at = t0 + (8 + i * 9) * MINUTE;
    const child = run.at(at, () =>
      run.as(caller).insert('incident', {
        caller_id: run.userId(caller),
        short_description: short,
        category: 'software',
        subcategory: 'email',
        impact: 3,
        urgency: 2,
        contact_type: 'self-service',
      }),
    );
    run.at(at + 4 * MINUTE, () =>
      run.as('alex.rivera').update(run.fresh('incident', child.sysId), {
        parent_incident: mi,
        work_notes: 'Linked to the ongoing email delivery incident.',
      }),
    );
  });
  run.at(t0 + 15 * MINUTE, () =>
    proposeMajorIncident(run.as('noor.haddad'), run.fresh('incident', mi), {
      reason: 'Mail flow is degraded for everyone and user reports keep coming in.',
      business_impact: MI_EMAIL.businessImpact,
    }),
  );
  run.at(t0 + 22 * MINUTE, () =>
    promoteMajorIncident(run.as('priya.nair'), run.fresh('incident', mi), {
      reason: 'Confirmed company-wide impact on mail flow.',
      business_impact: MI_EMAIL.businessImpact,
    }),
  );
  run.at(t0 + 35 * MINUTE, () =>
    run.as('priya.nair').update(run.fresh('incident', mi), {
      cause: MI_EMAIL.cause,
      work_notes: MI_EMAIL.notes[1],
      actions_taken: 'Bridge call opened; Cloud Operations and Information Security engaged.',
    }),
  );
  addIncidentTask(run, mi, t0 + 40 * MINUTE, 'priya.nair', {
    short_description: 'Issue a new TLS certificate for the outbound relay',
    assignment_group: run.groupId('Information Security'),
    assigned_to: run.userId('fatima.alsayed'),
    state: '2',
  });
  run.at(t0 + 70 * MINUTE, () =>
    run.as('david.kim').update(run.fresh('incident', mi), {
      work_notes: MI_EMAIL.notes[2],
      actions_taken: 'Outbound traffic failed over to the secondary relay.',
    }),
  );
  communicate(run, mi, t0);
}

/** Incident tasks on a few regular incidents (vendor shipment, order replay). */
function addScenarioTasks(run: DemoRun): void {
  const battery = run.sys.first(
    'incident',
    `short_description=${DEMO_SCENARIOS.find((s) => s.key === 'laptop_battery')!.short}`,
  );
  if (battery) {
    addIncidentTask(
      run,
      battery.sysId,
      Math.min(run.time(battery, 'opened_at') + 26 * HOUR, run.base - HOUR),
      'jamal.wright',
      {
        short_description: 'Ship the laptop to the vendor repair depot',
        assignment_group: run.groupId('Hardware Support'),
        assigned_to: run.userId('lucas.moreau'),
        state: '2',
      },
    );
  }
  const orders = run.sys.first(
    'incident',
    `short_description=${DEMO_SCENARIOS.find((s) => s.key === 'api_integration')!.short}`,
  );
  if (!orders) return;
  const when = Math.min(run.time(orders, 'opened_at') + 2 * HOUR, run.base - HOUR);
  const task = addIncidentTask(run, orders.sysId, when, 'tom.becker', {
    short_description: 'Replay the queued web shop orders into the ERP',
    assignment_group: run.groupId('Application Development'),
    assigned_to: run.userId('tom.becker'),
  });
  if (orders.bool('active') && orders.str('state') !== '6') return;
  run.at(Math.min(when + HOUR, run.base - 30 * MINUTE), () => {
    const fresh = run.fresh('incident_task', task);
    if (fresh.bool('active'))
      run
        .as('tom.becker')
        .update(fresh, { state: '3', close_notes: 'All 312 orders replayed and confirmed in the ERP.' });
  });
}

/** Demo data: about 80 incidents for Northwind Labs over the last 60 days. */
export function seedIncidentDemo(ctx: Context): void {
  if (
    !ctx.first('sys_user', 'user_name=priya.nair') ||
    ctx.first('incident', `short_description=${MI_EMAIL.short}`)
  )
    return;
  const run = new DemoRun(ctx, 20261021);
  const def = ctx.first('comm_plan_definition', `name=${MI_PLAN_DEFINITION}`);
  if (def && !def.bool('active')) ctx.update(def, { active: true });
  for (const [slot, scenario] of castScenarios(run, plannedSlots(run))) playIncident(run, slot, scenario);
  addScenarioTasks(run);
  playNetworkMajorIncident(run);
  playCandidates(run);
  playEmailMajorIncident(run);
}
