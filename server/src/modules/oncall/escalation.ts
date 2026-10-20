import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { clock, parseGlideDateTime, toGlideDateTime } from '../../engine/util.js';
import { type NotificationService, optionalService, SERVICES } from '../contracts.js';
import { ONCALL_PROPS, type OnCallService, type OnCallSnapshot } from './service.js';

export const ONCALL_EVENTS = {
  escalation: 'oncall.escalation',
  started: 'on_call.escalation.started',
  acknowledged: 'on_call.escalation.acknowledged',
  ended: 'on_call.escalation.ended',
  deliveryFailed: 'on_call.delivery.failed',
  timeoffRequested: 'on_call.timeoff.requested',
  timeoffApproved: 'on_call.timeoff.approved',
  timeoffRejected: 'on_call.timeoff.rejected',
} as const;

export type EndReason =
  | 'accepted'
  | 'exhausted'
  | 'no_on_call'
  | 'cancelled_group_change'
  | 'superseded'
  | 'assigned'
  | 'task_inactive';
export type Response = 'accepted' | 'rejected';

const CHANNEL_LABEL: Record<string, string> = {
  email: 'email',
  sms: 'SMS',
  voice: 'voice',
  slack: 'Slack',
  ms_teams: 'Microsoft Teams',
  mobile_push: 'mobile push',
};
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2 };

const msOf = (v: string): number | null => (v ? (parseGlideDateTime(v)?.getTime() ?? null) : null);
const glide = (t: number): string => toGlideDateTime(new Date(t));
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const usersOf = (level: Rec): string[] => level.str('escalatees').split(',').filter(Boolean);

/**
 * Runs on-call escalations (on-call.md section 5): pages the on-call people of a group
 * level by level until someone acknowledges, logging attempts and notifications.
 */
export class EscalationEngine {
  constructor(
    private platform: Platform,
    private service: OnCallService,
  ) {}

  private prop(name: string, fallback: string): string {
    return this.platform.properties.get(name) ?? fallback;
  }

  // ------------------------------------------------------------------ trigger

  activeFor(ctx: Context, task: Rec): Rec[] {
    return ctx.elevated().query('on_call_escalation', { query: `source=${task.sysId}^active=true` });
  }

  /**
   * Built-in trigger: an unassigned task of priority <= resolvr.oncall.escalation_priority
   * that gets an assignment group with a published shift (or is raised into that priority
   * range) pages the group's on-call people. Manual assignment, closure or a group change end
   * a running escalation.
   */
  onTaskWrite(task: Rec, prev: Rec | null, ctx: Context): void {
    if (!ctx.workflow) return;
    const now = clock.now().getTime();
    const insert = prev === null;
    const changed = (f: string) => (prev ? task.str(f) !== prev.str(f) : task.str(f) !== '');
    let running = this.activeFor(ctx, task);
    if (!task.bool('active')) {
      for (const e of running) this.end(ctx, e, 'task_inactive', now);
      return;
    }
    if (running.length && changed('assigned_to') && task.str('assigned_to')) {
      for (const e of running) this.end(ctx, e, 'assigned', now);
      running = [];
    }
    const group = task.str('assignment_group');
    const max = Number(this.prop(ONCALL_PROPS.maxPriority, '2'));
    const priority = task.num('priority') ?? Number.POSITIVE_INFINITY;
    const raised = changed('priority') && (prev?.num('priority') ?? Number.POSITIVE_INFINITY) > max;
    const unassignedOk =
      !this.platform.properties.getBool(ONCALL_PROPS.requireUnassigned, true) || !task.str('assigned_to');
    const fires =
      this.platform.properties.getBool(ONCALL_PROPS.autoEscalate, true) &&
      !!group &&
      priority <= max &&
      this.usesOnCall(ctx, group) &&
      unassignedOk &&
      (insert || changed('assignment_group') || raised) &&
      !(running.length && !changed('assignment_group'));
    if (fires) {
      for (const e of running) this.end(ctx, e, 'superseded', now);
      this.start(ctx, task, group, now);
    } else if (changed('assignment_group')) {
      for (const e of running) this.end(ctx, e, 'cancelled_group_change', now);
    }
  }

  /** Groups without a published shift do not use on-call scheduling and are never paged. */
  private usesOnCall(ctx: Context, groupId: string): boolean {
    return ctx.elevated().count('cmn_rota', `group=${groupId}^active=true^state=published`) > 0;
  }

  // ------------------------------------------------------------------ lifecycle

  start(ctx: Context, task: Rec, groupId: string, now: number): Rec {
    const e = ctx.elevated();
    const s = this.service.snapshot(ctx);
    const tracks = this.service
      .rotasForEscalation(s, groupId, now)
      .map((rota) => ({ rota, levels: this.service.plan(s, rota, now, task) }))
      .filter((t) => t.levels.length);
    const escalation = e.insert('on_call_escalation', {
      group: groupId,
      table: task.className,
      source: task.sysId,
      category: 'assign_by_acknowledgement',
      subflow: 'On-Call: Assign by Acknowledgement',
      active: true,
      acknowledged: false,
      channels: '',
    });
    if (!tracks.length) {
      e.update(escalation, { active: false, end_reason: 'no_on_call', end_time: glide(now) });
      this.journal(
        e,
        task,
        `On-call escalation: no one is on call for ${s.groupField(groupId, 'name') || 'the assignment group'}.`,
      );
      e.queueEvent(ONCALL_EVENTS.ended, escalation, task.sysId, 'no_on_call');
      return escalation;
    }
    for (const track of tracks) {
      for (const level of track.levels) {
        const first = level.level === 1;
        e.insert('on_call_escalation_level', {
          escalation: escalation.sysId,
          rota: track.rota.id,
          roster: level.roster,
          level: level.level,
          escalatees: level.users.join(','),
          catch_all: level.catchAll,
          active: first,
          started_at: first ? glide(now) : null,
          attempts: level.attempts,
          time_between_reminders: level.timeBetween,
          wait_after: level.wait,
          attempts_made: 0,
          next_attempt_at: first ? glide(now) : null,
          ends_at: first ? glide(now + level.attempts * level.timeBetween + level.wait) : null,
          outcome: 'pending',
        });
      }
    }
    e.queueEvent(ONCALL_EVENTS.started, escalation, task.sysId, groupId);
    this.process(ctx, escalation, now);
    return escalation;
  }

  /** Ends an escalation; pending attempts are dropped. */
  end(ctx: Context, escalation: Rec, reason: EndReason, now: number): void {
    const e = ctx.elevated();
    for (const level of this.levels(e, escalation, 'active=true'))
      e.update(level, { active: false, outcome: 'cancelled', next_attempt_at: null });
    e.update(escalation, { active: false, end_reason: reason, end_time: glide(now), next_action_at: null });
    e.queueEvent(ONCALL_EVENTS.ended, escalation, escalation.str('source'), reason);
  }

  private levels(ctx: Context, escalation: Rec, extra = ''): Rec[] {
    return ctx.query('on_call_escalation_level', {
      query: `escalation=${escalation.sysId}${extra ? `^${extra}` : ''}`,
      orderBy: [
        { field: 'rota', desc: false },
        { field: 'level', desc: false },
      ],
    });
  }

  private startLevel(ctx: Context, level: Rec, at: number): void {
    const r = level.num('attempts') ?? 0;
    const t = level.num('time_between_reminders') ?? 900_000;
    const w = level.num('wait_after') ?? t;
    ctx.update(level, {
      active: true,
      started_at: glide(at),
      attempts_made: 0,
      next_attempt_at: glide(at),
      ends_at: glide(at + r * t + w),
    });
  }

  /** Sends due attempts, moves to the next level when one elapses and finishes exhausted tracks. */
  process(ctx: Context, escalation: Rec, now: number): void {
    const e = ctx.elevated();
    if (!escalation.bool('active')) return;
    const all = this.levels(e, escalation);
    const tracks = new Map<string, Rec[]>();
    for (const l of all) tracks.set(l.str('rota'), [...(tracks.get(l.str('rota')) ?? []), l]);
    const s = this.service.snapshot(ctx);
    for (const levels of tracks.values()) {
      let current = levels.find((l) => l.bool('active')) ?? null;
      while (current) {
        if (current.str('outcome') !== 'rejected') this.sendDue(e, s, escalation, current, now);
        const ends = msOf(current.str('ends_at')) ?? now;
        if (now < ends) break;
        e.update(current, {
          active: false,
          outcome: current.str('outcome') === 'pending' ? 'no_response' : current.str('outcome'),
          next_attempt_at: null,
        });
        const next =
          levels.find((l) => (l.num('level') ?? 0) > (current!.num('level') ?? 0) && !l.str('started_at')) ??
          null;
        if (next) this.startLevel(e, next, ends);
        current = next;
      }
    }
    const fresh = this.levels(e, escalation);
    const active = fresh.filter((l) => l.bool('active'));
    if (!active.length) {
      const last = Math.max(...fresh.map((l) => msOf(l.str('ends_at')) ?? now));
      e.update(escalation, {
        active: false,
        acknowledged: false,
        end_reason: 'exhausted',
        end_time: glide(Math.min(now, last)),
        next_action_at: null,
      });
      const task = escalation.ref('source');
      if (task) this.journal(e, task, 'On-call escalation ended: nobody acknowledged the notifications.');
      e.queueEvent(ONCALL_EVENTS.ended, escalation, escalation.str('source'), 'exhausted');
      return;
    }
    const next = Math.min(
      ...active.flatMap((l) => [
        msOf(l.str('next_attempt_at')) ?? Number.POSITIVE_INFINITY,
        msOf(l.str('ends_at')) ?? Number.POSITIVE_INFINITY,
      ]),
    );
    e.update(escalation, { next_action_at: Number.isFinite(next) ? glide(next) : null });
  }

  /** Sends the latest overdue attempt of a level (earlier missed ones are skipped). */
  private sendDue(ctx: Context, s: OnCallSnapshot, escalation: Rec, level: Rec, now: number): void {
    const r = level.num('attempts') ?? 0;
    const t = Math.max(1, level.num('time_between_reminders') ?? 900_000);
    const made = level.num('attempts_made') ?? 0;
    const started = msOf(level.str('started_at')) ?? now;
    if (made >= r + 1 || now < started) return;
    const due = Math.min(r + 1, Math.floor((now - started) / t) + 1);
    if (due <= made) return;
    const reached = this.sendAttempt(ctx, s, escalation, level, due, now);
    const exhausted = !reached || due >= r + 1;
    ctx.update(level, {
      attempts_made: reached ? due : r + 1,
      next_attempt_at: exhausted ? null : glide(started + due * t),
      outcome: reached ? level.str('outcome') : 'failed',
    });
  }

  /** One contact attempt to every escalatee of a level. Returns false when nobody could be reached. */
  private sendAttempt(
    ctx: Context,
    s: OnCallSnapshot,
    escalation: Rec,
    level: Rec,
    attempt: number,
    now: number,
  ): boolean {
    const log = this.platform.properties.getBool(ONCALL_PROPS.logEscalations, true);
    const task = escalation.ref('source');
    const roster = level.str('roster') ? ctx.get('cmn_rota_roster', level.str('roster')) : null;
    const forced = roster?.str('force_channel') ?? '';
    const contact = log
      ? ctx.insert('on_call_escalation_con_attempt', {
          escalation: escalation.sysId,
          escalation_level: level.sysId,
          rota: level.str('rota'),
          level: level.num('level'),
          attempt,
        })
      : null;
    const failedBefore = new Set(
      ctx
        .query('on_call_escalation_comm', { query: `escalation_level=${level.sysId}^status=failed` })
        .map((c) => c.str('escalatee')),
    );
    let reached = 0;
    for (const userId of usersOf(level)) {
      if (failedBefore.has(userId)) continue;
      const user = s.user(userId);
      const channel = forced || 'email';
      const address =
        channel === 'email' ? user?.email : channel === 'sms' || channel === 'voice' ? user?.mobile : userId;
      const base = {
        contact_attempt: contact?.sysId ?? null,
        escalation: escalation.sysId,
        escalation_level: level.sysId,
        escalatee: userId,
        comm_type: channel,
        catch_all: level.bool('catch_all'),
      };
      if (!address) {
        const reason = `No ${CHANNEL_LABEL[channel] ?? channel} address for ${user?.name ?? 'the user'}`;
        if (log) ctx.insert('on_call_escalation_comm', { ...base, status: 'failed', failure_reason: reason });
        if (task)
          this.journal(
            ctx,
            task,
            `On-call notification failed: ${user?.name ?? userId} via ${CHANNEL_LABEL[channel] ?? channel} at ${glide(now)} UTC (escalation level ${level.num('level')}): ${reason}.`,
          );
        ctx.queueEvent(ONCALL_EVENTS.deliveryFailed, escalation, userId, channel);
        continue;
      }
      reached++;
      if (log) ctx.insert('on_call_escalation_comm', { ...base, comm_value: address, status: 'sent' });
      if (channel === 'email' && task) this.email(ctx, task, userId, level, attempt);
      ctx.queueEvent(ONCALL_EVENTS.escalation, task ?? escalation, userId, String(level.num('level') ?? 1));
    }
    return reached > 0;
  }

  private email(ctx: Context, task: Rec, userId: string, level: Rec, attempt: number): void {
    const mailer = optionalService<NotificationService>(this.platform, SERVICES.notifications);
    if (!mailer) return;
    const number = task.str('number') || task.displayValue();
    mailer.send(ctx, {
      to: [userId],
      subject: `On-call: ${number} needs your response`,
      body: [
        `<p>${esc(task.str('short_description') || number)}</p>`,
        `<p>Priority: ${esc(task.display('priority'))}<br>Group: ${esc(task.display('assignment_group'))}<br>Escalation level ${level.num('level')}${level.bool('catch_all') ? ' (catch-all)' : ''}, attempt ${attempt}</p>`,
        '<p>Acknowledge the page in ResolvrNow to take the assignment.</p>',
      ].join('\n'),
      target: task,
      notification: ONCALL_EVENTS.escalation,
    });
  }

  private journal(ctx: Context, task: Rec, text: string): void {
    const fresh = ctx.elevated().get(task.className, task.sysId);
    if (fresh?.has('work_notes'))
      ctx.derive({ acl: false, workflow: false }).update(fresh, { work_notes: text });
  }

  // ------------------------------------------------------------------ jobs and responses

  /** Escalation timer job: advances every active escalation whose next action is due. */
  processDue(ctx: Context, now: number): number {
    const due = ctx
      .elevated()
      .query('on_call_escalation', { query: `active=true^next_action_at<=${glide(now)}` });
    for (const escalation of due) this.process(ctx, escalation, now);
    return due.length;
  }

  /** Accept or reject by an escalatee. Accepting assigns the task and ends every track. */
  respond(
    ctx: Context,
    escalation: Rec,
    userId: string,
    response: Response,
  ): { ok: boolean; message: string } {
    const e = ctx.elevated();
    const now = clock.now().getTime();
    const comms = e.query('on_call_escalation_comm', {
      query: `escalation=${escalation.sysId}^escalatee=${userId}^responseISEMPTY`,
    });
    for (const c of comms) e.update(c, { response, responded_at: glide(now) });
    const name = this.service.snapshot(ctx).user(userId)?.name ?? 'Someone';
    if (!escalation.bool('active')) return { ok: false, message: 'The escalation has already ended' };
    if (response === 'accepted') {
      for (const level of this.levels(e, escalation, 'active=true')) {
        e.update(level, {
          active: false,
          outcome: usersOf(level).includes(userId) ? 'accepted' : 'cancelled',
          next_attempt_at: null,
        });
      }
      const started = msOf(escalation.str('sys_created_on')) ?? now;
      e.update(escalation, {
        active: false,
        acknowledged: true,
        acknowledged_by: userId,
        acknowledged_at: glide(now),
        time_to_acknowledge: Math.max(0, now - started),
        end_time: glide(now),
        end_reason: 'accepted',
        next_action_at: null,
      });
      const task = escalation.ref('source');
      if (task) {
        const fresh = e.get(task.className, task.sysId)!;
        e.update(fresh, {
          assigned_to: userId,
          work_notes: `${name} acknowledged the on-call escalation and is now assigned.`,
        });
      }
      e.queueEvent(ONCALL_EVENTS.acknowledged, escalation, userId, escalation.str('source'));
      return { ok: true, message: `${name} acknowledged the escalation` };
    }
    const level = this.levels(e, escalation, 'active=true').find((l) => usersOf(l).includes(userId));
    if (level) {
      const rejected = new Set(
        e
          .query('on_call_escalation_comm', { query: `escalation_level=${level.sysId}^response=rejected` })
          .map((c) => c.str('escalatee')),
      ).add(userId);
      if (usersOf(level).every((u) => rejected.has(u))) {
        e.update(level, { ends_at: glide(now), outcome: 'rejected' });
        this.process(ctx, e.get('on_call_escalation', escalation.sysId)!, now);
      }
    }
    return { ok: true, message: `${name} declined the escalation` };
  }

  /** Provider delivery callback: the most advanced status wins and failed is terminal. */
  deliveryStatus(ctx: Context, comm: Rec, status: string, reason = ''): Rec {
    const e = ctx.elevated();
    const current = comm.str('status');
    if (current === 'failed') return comm;
    let next = status;
    if (status !== 'failed' && !(status in STATUS_RANK)) {
      this.platform.log.warn(`[resolvrnow] unknown on-call delivery status '${status}', recorded as sent`);
      next = 'sent';
    }
    if (next !== 'failed' && (STATUS_RANK[next] ?? 0) <= (STATUS_RANK[current] ?? 0)) return comm;
    e.update(comm, {
      status: next,
      failure_reason: next === 'failed' ? reason || 'Delivery failed' : comm.str('failure_reason'),
    });
    if (next === 'failed') {
      const escalation = comm.ref('escalation');
      const task = escalation?.ref('source');
      const user = comm.display('escalatee');
      if (task)
        this.journal(
          e,
          task,
          `On-call notification failed: ${user} via ${CHANNEL_LABEL[comm.str('comm_type')] ?? comm.str('comm_type')} at ${glide(clock.now().getTime())} UTC: ${reason || 'delivery failed'}.`,
        );
      if (escalation)
        e.queueEvent(ONCALL_EVENTS.deliveryFailed, escalation, comm.str('escalatee'), comm.str('comm_type'));
    }
    return comm;
  }
}
