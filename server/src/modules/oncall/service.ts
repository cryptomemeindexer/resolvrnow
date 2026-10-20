import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { isSysId } from '../../engine/util.js';
import { type Interval, mergeIntervals, type ScheduleEngine, scheduleEngine } from '../schedules/engine.js';
import { DAY, localDay } from '../schedules/time.js';
import {
  boundaryDay,
  boundaryInstant,
  eligible,
  holderAt,
  type MemberRow,
  memberFromRecord,
  type RotationSpec,
  rotationOf,
  slotAt,
} from './rotation.js';

export const ONCALL_PROPS = {
  allowOverlap: 'com.snc.on_call_rotation.allow_rota_overlap',
  overlapRule: 'com.snc.on_call_rotation.escalation_rule_rota_overlap',
  pto: 'com.snc.on_call_rotation.pto.configuration',
  dailyAtMidnight: 'com.snc.on_call_rotation.factor_daily_rotation_interval_all_day',
  logEscalations: 'com.snc.on_call_rotation.log_escalations',
  readRoles: 'com.snc.on_call_rotation.calendar_read_roles',
  autoEscalate: 'resolvr.oncall.auto_escalate',
  maxPriority: 'resolvr.oncall.escalation_priority',
  requireUnassigned: 'resolvr.oncall.escalation.require_unassigned',
} as const;

export type GapReason = 'time_off' | 'inactive' | 'not_in_group' | 'no_member';

export interface UserInfo {
  id: string;
  name: string;
  userName: string;
  email: string;
  mobile: string;
  active: boolean;
  manager: string | null;
}

export interface RosterInfo {
  rec: Rec;
  id: string;
  name: string;
  order: number;
  spec: RotationSpec | null;
  members: MemberRow[];
  attempts: number;
  timeBetween: number;
  forceChannel: string;
}

export interface RotaInfo {
  rec: Rec;
  id: string;
  name: string;
  groupId: string;
  scheduleId: string | null;
  zone: string;
  rosters: RosterInfo[];
}

export interface OnCallEntry {
  user: string | null;
  source: 'rotation' | 'coverage' | null;
  gap: GapReason | null;
}

export interface PlanLevel {
  level: number;
  users: string[];
  catchAll: boolean;
  attempts: number;
  timeBetween: number;
  /** Wait after the last reminder before the next level starts. */
  wait: number;
  roster: string | null;
}

export interface Segment {
  start: number;
  end: number;
  entry: OnCallEntry;
}

const MIN_TBR = 1000;

/** Per-computation cache of on-call data (users, groups, shifts, spans). */
export class OnCallSnapshot {
  private users = new Map<string, UserInfo | null>();
  private members = new Map<string, Set<string>>();
  private rotas = new Map<string, RotaInfo>();
  private timeOffs = new Map<string, Rec[]>();
  private coverageCache = new Map<string, Rec[]>();
  private extras = new Map<string, Rec[]>();
  private intervalMemo = new Map<string, Interval[]>();

  constructor(
    readonly ctx: Context,
    readonly engine: ScheduleEngine,
  ) {}

  get platform(): Platform {
    return this.ctx.platform;
  }

  user(id: string | null | undefined): UserInfo | null {
    if (!id || !isSysId(id)) return null;
    if (!this.users.has(id)) {
      const r = this.platform.db.get<Record<string, unknown>>(
        `SELECT "sys_id","name","user_name","email","mobile_phone","active","manager" FROM "sys_user" WHERE "sys_id" = ?`,
        [id],
      );
      this.users.set(
        id,
        r
          ? {
              id,
              name: String(r.name ?? r.user_name ?? ''),
              userName: String(r.user_name ?? ''),
              email: String(r.email ?? ''),
              mobile: String(r.mobile_phone ?? ''),
              active: r.active !== 0,
              manager: (r.manager as string) || null,
            }
          : null,
      );
    }
    return this.users.get(id) ?? null;
  }

  groupMembers(groupId: string): Set<string> {
    let set = this.members.get(groupId);
    if (!set) {
      set = new Set(
        this.platform.db
          .all<{ user: string }>(`SELECT "user" FROM "sys_user_grmember" WHERE "group" = ?`, [groupId])
          .map((r) => r.user),
      );
      this.members.set(groupId, set);
    }
    return set;
  }

  groupField(groupId: string, field: string): string {
    const g = this.ctx.loadRaw('sys_user_group', groupId);
    return g ? g.str(field) : '';
  }

  rota(rec: Rec): RotaInfo {
    const hit = this.rotas.get(rec.sysId);
    if (hit) return hit;
    const scheduleId = rec.str('schedule') || null;
    const dailyAtMidnight = this.platform.properties.getBool(ONCALL_PROPS.dailyAtMidnight);
    const rosters = this.ctx
      .query('cmn_rota_roster', { query: `rota=${rec.sysId}^active=true` })
      .map((r) => ({
        rec: r,
        id: r.sysId,
        name: r.str('name'),
        order: r.num('order') ?? 100,
        spec: rotationOf(r, dailyAtMidnight),
        members: this.ctx.query('cmn_rota_member', { query: `roster=${r.sysId}` }).map(memberFromRecord),
        attempts: Math.max(0, r.num('attempts') ?? 0),
        timeBetween: Math.max(MIN_TBR, r.num('time_between_reminders') ?? 900_000),
        forceChannel: r.str('force_channel'),
      }))
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    const info: RotaInfo = {
      rec,
      id: rec.sysId,
      name: rec.str('name'),
      groupId: rec.str('group'),
      scheduleId,
      zone: this.engine.fixedZone(scheduleId) ?? this.engine.systemZone(),
      rosters,
    };
    this.rotas.set(rec.sysId, info);
    return info;
  }

  /** Published, active shifts of a group. */
  rotasOf(groupId: string): RotaInfo[] {
    return this.ctx
      .query('cmn_rota', { query: `group=${groupId}^active=true^state=published^ORDERBYname` })
      .map((r) => this.rota(r));
  }

  timeOff(userId: string, groupId: string): Rec[] {
    const key = `${userId}|${groupId}`;
    let list = this.timeOffs.get(key);
    if (!list) {
      list = this.ctx.query('roster_schedule_span', {
        query: `type=time_off^user=${userId}^state=approved^group=${groupId}^ORgroupISEMPTY`,
      });
      this.timeOffs.set(key, list);
    }
    return list;
  }

  coverage(rosterId: string): Rec[] {
    let list = this.coverageCache.get(rosterId);
    if (!list) {
      list = this.ctx.query('roster_schedule_span', {
        query: `type=on_call^roster=${rosterId}^userISNOTEMPTY^state=approved^ORstateISEMPTY`,
        orderBy: [{ field: 'sys_created_on', desc: true }],
      });
      this.coverageCache.set(rosterId, list);
    }
    return list;
  }

  extraTime(rota: RotaInfo): Rec[] {
    let list = this.extras.get(rota.id);
    if (!list) {
      list = rota.scheduleId
        ? this.ctx.query('roster_schedule_span', {
            query: `type=on_call^schedule=${rota.scheduleId}^groupISNOTEMPTY^userISEMPTY^state=approved^ORstateISEMPTY`,
          })
        : [];
      this.extras.set(rota.id, list);
    }
    return list;
  }

  /** Occurrences of a span within `[from, to)` (memoised). */
  spanIntervals(span: Rec, zone: string, from: number, to: number): Interval[] {
    const key = `${span.sysId}|${zone}|${from}|${to}`;
    let list = this.intervalMemo.get(key);
    if (!list) {
      list = this.engine.spanIntervals(span, zone, from, to);
      this.intervalMemo.set(key, list);
    }
    return list;
  }

  /** Whether one of the span's occurrences contains `t`. */
  covers(span: Rec, zone: string, t: number): boolean {
    return this.spanIntervals(span, zone, t, t + 1).length > 0;
  }
}

/**
 * Who-is-on-call computations (on-call.md section 4): shift activity, rotation holders,
 * coverage and time off, escalation plans and calendar segments.
 */
export class OnCallService {
  constructor(private platform: Platform) {}

  snapshot(ctx: Context): OnCallSnapshot {
    const engine = scheduleEngine(this.platform);
    if (!engine) throw new Error('The schedules module is required for on-call scheduling');
    return new OnCallSnapshot(ctx.elevated(), engine);
  }

  /** Resolves a group by sys_id or name. */
  resolveGroup(ctx: Context, idOrName: string): Rec | null {
    const sys = ctx.elevated();
    if (/^[0-9a-f]{32}$/.test(idOrName)) return sys.get('sys_user_group', idOrName);
    return sys.first('sys_user_group', `name=${idOrName.replace(/\^/g, '^^')}`);
  }

  // ------------------------------------------------------------------ shift activity

  rotaActiveAt(s: OnCallSnapshot, rota: RotaInfo, t: number): boolean {
    if (!rota.rec.bool('active') || rota.rec.str('state') !== 'published') return false;
    if (s.engine.contains(rota.scheduleId, rota.zone, t)) return true;
    return s.extraTime(rota).some((span) => s.covers(span, rota.zone, t));
  }

  /** Active time of a shift within `[from, to)`: its schedule plus extra-time entries. */
  activeIntervals(s: OnCallSnapshot, rota: RotaInfo, from: number, to: number): Interval[] {
    const list = s.engine.intervals(rota.scheduleId, rota.zone, from, to);
    for (const span of s.extraTime(rota)) list.push(...s.spanIntervals(span, rota.zone, from, to));
    return mergeIntervals(list);
  }

  // ------------------------------------------------------------------ who is on call

  /** Why a user cannot take a call right now, or null when available. */
  unavailable(s: OnCallSnapshot, userId: string, rota: RotaInfo, t: number): GapReason | null {
    const u = s.user(userId);
    if (!u?.active) return 'inactive';
    if (!s.groupMembers(rota.groupId).has(userId)) return 'not_in_group';
    if (s.timeOff(userId, rota.groupId).some((span) => s.covers(span, rota.zone, t))) return 'time_off';
    return null;
  }

  slotOf(roster: RosterInfo, rota: RotaInfo, t: number): number {
    return roster.spec ? slotAt(roster.spec, rota.zone, t) : -1;
  }

  holder(roster: RosterInfo, rota: RotaInfo, t: number): MemberRow | null {
    if (!roster.spec) return null;
    return holderAt(roster.spec, roster.members, this.slotOf(roster, rota, t));
  }

  /** The on-call user of one roster at `t`: an available cover first, then the rotation holder. */
  onCall(s: OnCallSnapshot, rota: RotaInfo, roster: RosterInfo, t: number): OnCallEntry {
    for (const span of s.coverage(roster.id)) {
      if (!s.covers(span, rota.zone, t)) continue;
      const user = span.str('user');
      if (!this.unavailable(s, user, rota, t)) return { user, source: 'coverage', gap: null };
    }
    const h = this.holder(roster, rota, t);
    if (!h) return { user: null, source: null, gap: 'no_member' };
    const reason = this.unavailable(s, h.user, rota, t);
    return reason
      ? { user: null, source: null, gap: reason }
      : { user: h.user, source: 'rotation', gap: null };
  }

  // ------------------------------------------------------------------ escalation plans (4.5, 4.6, 5.3)

  catchAllUsers(s: OnCallSnapshot, rota: RotaInfo, t: number): string[] {
    const r = rota.rec;
    switch (r.str('catch_all')) {
      case 'group_manager':
        return [s.groupField(rota.groupId, 'manager')].filter(Boolean);
      case 'rota_manager': {
        if (r.str('manager')) return [r.str('manager')];
        const pref = s.ctx.first('on_call_group_preference', `group=${rota.groupId}`);
        return (pref?.str('shift_managers') ?? '').split(',').filter(Boolean);
      }
      case 'individual':
        return [r.str('catch_all_member')].filter(Boolean);
      case 'all': {
        const rosters = r.str('catch_all_roster')
          ? rota.rosters.filter((x) => x.id === r.str('catch_all_roster'))
          : rota.rosters;
        const day = localDay(rota.zone, t);
        const users = rosters.flatMap((x) => eligible(x.members, day).map((m) => m.user));
        return [...new Set(users)].filter((u) => !this.unavailable(s, u, rota, t));
      }
      default:
        return [];
    }
  }

  /** Custom escalation set for a task: first matching non-default set by order, else the default set. */
  pickSet(s: OnCallSnapshot, rota: RotaInfo, task: Rec | null): Rec | null {
    const sets = s.ctx.query('cmn_rota_escalation_set', {
      query: `cmn_rota=${rota.id}^active=true^ORDERBYorder`,
    });
    for (const set of sets) {
      if (set.bool('default')) continue;
      const table = set.str('table');
      if (table && !task?.table.ancestors.includes(table)) continue;
      const cond = set.str('condition');
      if (cond && (!task || !matches(cond, recSubject(task, null, s.ctx.registry), s.ctx.env))) continue;
      return set;
    }
    return sets.find((x) => x.bool('default')) ?? null;
  }

  private customLevels(s: OnCallSnapshot, rota: RotaInfo, set: Rec, t: number): PlanLevel[] {
    const steps = s.ctx.query('cmn_rota_esc_step_def', {
      query: `cmn_rota_escalation_set=${set.sysId}^ORDERBYescalation_level`,
    });
    return steps.map((step, i) => {
      const users: string[] = [];
      for (const rosterId of step.str('rosters').split(',').filter(Boolean)) {
        const roster = rota.rosters.find((r) => r.id === rosterId);
        const u = roster ? this.onCall(s, rota, roster, t).user : null;
        if (u) users.push(u);
      }
      for (const u of step.str('users').split(',').filter(Boolean)) {
        const info = s.user(u);
        if (info?.active && !s.timeOff(u, rota.groupId).some((span) => s.covers(span, rota.zone, t)))
          users.push(u);
      }
      for (const g of step.str('groups').split(',').filter(Boolean))
        users.push(...this.firstResponders(s, g, t));
      if (step.bool('group_manager')) {
        const path = step.str('group_manager_field') || 'manager';
        const group = s.ctx.loadRaw('sys_user_group', rota.groupId);
        const m = group?.str(path);
        if (m) users.push(m);
      }
      const tbr = Math.max(MIN_TBR, step.num('time_between_reminders') ?? 900_000);
      return {
        level: i + 1,
        users: [...new Set(users)],
        catchAll: false,
        attempts: Math.max(0, step.num('reminder_num') ?? 0),
        timeBetween: tbr,
        wait: step.num('time_to_next_step') || tbr,
        roster: null,
      };
    });
  }

  /** Level-1 users of a group's escalation at `t`, or all its active members when it has no active shift. */
  firstResponders(s: OnCallSnapshot, groupId: string, t: number): string[] {
    for (const rota of s.rotasOf(groupId)) {
      if (!this.rotaActiveAt(s, rota, t)) continue;
      const first = this.plan(s, rota, t, null, false)[0];
      if (first) return first.users;
    }
    return [...s.groupMembers(groupId)].filter((u) => s.user(u)?.active);
  }

  /** Ordered escalation levels of a shift at `t` (empty when the shift is not active). */
  plan(
    s: OnCallSnapshot,
    rota: RotaInfo,
    t: number,
    task: Rec | null = null,
    withCatchAll = true,
  ): PlanLevel[] {
    if (!this.rotaActiveAt(s, rota, t)) return [];
    let levels: PlanLevel[] = [];
    const set = rota.rec.bool('use_custom_escalation') ? this.pickSet(s, rota, task) : null;
    if (set) levels = this.customLevels(s, rota, set, t).filter((l) => l.users.length);
    else {
      const raw: { user: string | null; roster: RosterInfo }[] = [];
      if (rota.rosters.length === 1) {
        const roster = rota.rosters[0];
        const k = this.slotOf(roster, rota, t);
        if (k < 0 || !roster.spec) return [];
        raw.push({ user: this.onCall(s, rota, roster, t).user, roster });
        const list = eligible(roster.members, boundaryDay(roster.spec, k));
        const h = holderAt(roster.spec, roster.members, k);
        const idx = h ? list.findIndex((m) => m.id === h.id) : -1;
        const rest = idx < 0 ? list : [...list.slice(idx + 1), ...list.slice(0, idx)];
        for (const m of rest) if (!this.unavailable(s, m.user, rota, t)) raw.push({ user: m.user, roster });
      } else {
        for (const roster of rota.rosters) raw.push({ user: this.onCall(s, rota, roster, t).user, roster });
      }
      const seen = new Set<string>();
      for (const r of raw) {
        if (!r.user || seen.has(r.user)) continue;
        seen.add(r.user);
        levels.push({
          level: 0,
          users: [r.user],
          catchAll: false,
          attempts: r.roster.attempts,
          timeBetween: r.roster.timeBetween,
          wait: r.roster.timeBetween,
          roster: r.roster.id,
        });
      }
    }
    if (withCatchAll && rota.rec.str('catch_all') && rota.rec.str('catch_all') !== 'none') {
      const users = this.catchAllUsers(s, rota, t);
      const last = levels[levels.length - 1] ?? {
        attempts: 0,
        timeBetween: 900_000,
        wait: 900_000,
        roster: null,
      };
      if (users.length)
        levels.push({
          level: 0,
          users,
          catchAll: true,
          attempts: last.attempts,
          timeBetween: last.timeBetween,
          wait: last.wait,
          roster: last.roster,
        });
    }
    return levels.map((l, i) => ({ ...l, level: i + 1 }));
  }

  /** Start of the active interval of a shift that contains `t`. */
  private activeSince(s: OnCallSnapshot, rota: RotaInfo, t: number): number {
    const list = this.activeIntervals(s, rota, t - 8 * DAY, t + 1);
    return list.find(([a, b]) => a <= t && t < b)?.[0] ?? Number.NEGATIVE_INFINITY;
  }

  /** Shifts that take part in an escalation at `t`, applying the overlap rule. */
  rotasForEscalation(s: OnCallSnapshot, groupId: string, t: number): RotaInfo[] {
    const active = s.rotasOf(groupId).filter((r) => this.rotaActiveAt(s, r, t));
    if (active.length <= 1) return active;
    const pref = s.ctx.first('on_call_group_preference', `group=${groupId}`);
    let rule = pref?.str('escalation_rule_rota_overlap') || 'default';
    if (rule === 'default') rule = this.platform.properties.get(ONCALL_PROPS.overlapRule) || 'all';
    if (rule !== 'incoming' && rule !== 'outgoing') return active;
    const ranked = active
      .map((r) => ({ r, since: this.activeSince(s, r, t) }))
      .sort((a, b) => a.since - b.since || (a.r.id < b.r.id ? -1 : 1));
    if (rule === 'outgoing') return [ranked[0].r];
    const latest = ranked[ranked.length - 1].since;
    return [ranked.find((x) => x.since === latest)!.r];
  }

  // ------------------------------------------------------------------ calendar segments (4.8)

  /** Who is on call for one roster across `[from, to)`, split where the answer changes. */
  segments(s: OnCallSnapshot, rota: RotaInfo, roster: RosterInfo, from: number, to: number): Segment[] {
    const active = this.activeIntervals(s, rota, from, to);
    if (!active.length) return [];
    const breaks = new Set<number>();
    if (roster.spec) {
      let k = Math.max(0, this.slotOf(roster, rota, from) + 1);
      for (
        let b = boundaryInstant(roster.spec, k, rota.zone);
        b < to;
        b = boundaryInstant(roster.spec, ++k, rota.zone)
      ) {
        if (b > from) breaks.add(b);
      }
    }
    const edges = (spans: Rec[]) => {
      for (const span of spans)
        for (const [a, b] of s.spanIntervals(span, rota.zone, from, to)) breaks.add(a).add(b);
    };
    edges(s.coverage(roster.id));
    for (const u of new Set(roster.members.map((m) => m.user))) edges(s.timeOff(u, rota.groupId));
    const sorted = [...breaks].sort((a, b) => a - b);
    const out: Segment[] = [];
    for (const [a, b] of active) {
      const cuts = [a, ...sorted.filter((x) => x > a && x < b), b];
      for (let i = 0; i < cuts.length - 1; i++) {
        const entry = this.onCall(s, rota, roster, cuts[i]);
        const last = out[out.length - 1];
        if (
          last &&
          last.end === cuts[i] &&
          last.entry.user === entry.user &&
          last.entry.source === entry.source &&
          last.entry.gap === entry.gap
        )
          last.end = cuts[i + 1];
        else out.push({ start: cuts[i], end: cuts[i + 1], entry });
      }
    }
    return out;
  }
}

export function onCallService(platform: Platform): OnCallService | undefined {
  return platform.services.get('oncall') as OnCallService | undefined;
}
