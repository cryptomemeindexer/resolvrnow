import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { nowGlide } from '../../engine/util.js';
import { ATTR, PROP, T } from './constants.js';
import { changeModels } from './model.js';
import {
  type Interval,
  mergeIntervals,
  overlaps,
  scheduleIntervals,
  toGlide,
  toMs,
  windowInsideSchedule,
  windowTouchesSchedule,
} from './schedules.js';
import { cmdbOf, DAY_MS, recordMatches, schedulesOf } from './util.js';

export interface ConflictFinding {
  type: string;
  conflicting_change?: string;
  configuration_item?: string;
  related_configuration_item?: string;
  schedule?: string;
  category?: string;
  description: string;
}

export interface ConflictCheck {
  findings: ConflictFinding[];
  /** Number of other changes evaluated against this one. */
  checked: number;
  outsideMaintenance: boolean;
}

/** Why conflict detection cannot run for a change, or null when it can. */
export function conflictPrecondition(change: Rec): string | null {
  if (change.bool('exclude_from_conflict_detection')) return 'The change is excluded from conflict detection';
  if (!change.str('start_date') || !change.str('end_date'))
    return 'The change needs a planned start date and a planned end date';
  if (!change.str('cmdb_ci')) return 'The change needs a configuration item';
  return null;
}

function ciLabel(change: Rec): string {
  return change.display('cmdb_ci') || 'the configuration item';
}

function loadCi(ctx: Context, ciId: string): Rec | null {
  if (!ciId || !ctx.registry.has('cmdb_ci')) return null;
  return ctx.elevated().get('cmdb_ci', ciId);
}

/** Blackout and maintenance schedules (condition schedules) that apply to a change and its CI. */
export function applicableSchedules(
  ctx: Context,
  change: Rec,
  ciId: string,
  ci: Rec | null,
): { blackouts: Rec[]; maintenance: Rec[] } {
  const sys = ctx.elevated();
  const applies = (s: Rec): boolean => {
    const source = s.str('source') || 'ci_class';
    const condition = s.str('condition');
    if (source === 'change_request') return recordMatches(ctx, change, condition, false);
    if (!ciId) return false;
    if (source === 'service') {
      const cmdb = cmdbOf(ctx.platform);
      if (!cmdb) return false;
      try {
        return cmdb.impactedServices(sys, ciId).some((svc) => recordMatches(ctx, svc, condition, false));
      } catch {
        return false;
      }
    }
    const appliesTo = s.str('applies_to') || 'cmdb_ci';
    if (ci) return ctx.registry.isA(ci.className, appliesTo) && recordMatches(ctx, ci, condition, false);
    // Without the CMDB only schedules that cover every configuration item can apply.
    return appliesTo === 'cmdb_ci' && !condition.trim();
  };
  return {
    blackouts: ctx.registry.has(T.blackout) ? sys.query(T.blackout).filter(applies) : [],
    maintenance: ctx.registry.has(T.maintenance) ? sys.query(T.maintenance).filter(applies) : [],
  };
}

/** Other active, non-excluded changes whose planned window overlaps [start, end). */
function overlappingChanges(
  ctx: Context,
  changeId: string,
  start: string,
  end: string,
  contiguous: boolean,
): Rec[] {
  const lt = contiguous ? '<' : '<=';
  const gt = contiguous ? '>' : '>=';
  return ctx
    .elevated()
    .query(
      T.change,
      `active=true^sys_id!=${changeId}^exclude_from_conflict_detection!=true^start_dateISNOTEMPTY^end_dateISNOTEMPTY^start_date${lt}${end}^end_date${gt}${start}`,
    );
}

/** Configuration items a change touches: primary CI plus affected CIs. */
function cisOf(ctx: Context, change: Rec, includeAffected: boolean): Set<string> {
  const out = new Set<string>();
  if (change.str('cmdb_ci')) out.add(change.str('cmdb_ci'));
  if (includeAffected && ctx.registry.has(T.taskCi)) {
    for (const r of ctx.elevated().query(T.taskCi, `task=${change.sysId}`))
      if (r.str('ci_item')) out.add(r.str('ci_item'));
  }
  return out;
}

/** Runs every enabled conflict check for a change without saving anything. */
export function findConflicts(ctx: Context, change: Rec): ConflictCheck {
  const props = ctx.platform.properties;
  const start = change.str('start_date');
  const end = change.str('end_date');
  const startMs = toMs(start);
  const endMs = toMs(end);
  const findings: ConflictFinding[] = [];
  if (startMs === null || endMs === null || endMs <= startMs)
    return { findings, checked: 0, outsideMaintenance: false };
  const contiguous = props.getBool(PROP.conflictContiguous, true);
  const advanced = props.get(PROP.conflictMode, 'basic') === 'advanced';
  const ciId = change.str('cmdb_ci');
  const ci = loadCi(ctx, ciId);
  const others = overlappingChanges(ctx, change.sysId, start, end, contiguous);
  const window = `${start} to ${end}`;

  // Configuration item already scheduled in another change.
  if (props.getBool(PROP.conflictCurrentCi, true) && ciId) {
    const mine = cisOf(ctx, change, advanced);
    for (const other of others) {
      const theirs = cisOf(ctx, other, true);
      for (const item of mine) {
        if (!theirs.has(item)) continue;
        findings.push({
          type: 'ci_already_scheduled',
          conflicting_change: other.sysId,
          configuration_item: item,
          description: `${other.str('number')} is also scheduled on ${item === ciId ? ciLabel(change) : 'an affected configuration item'} (${other.str('start_date')} to ${other.str('end_date')})`,
        });
      }
    }
    // Parent and child configuration items (advanced mode, needs the CMDB).
    const cmdb = cmdbOf(ctx.platform);
    if (advanced && cmdb) {
      const related: [string, Rec[]][] = [];
      try {
        related.push(['parent_ci_already_scheduled', cmdb.upstream(ctx.elevated(), ciId, 1)]);
        related.push(['child_ci_already_scheduled', cmdb.downstream(ctx.elevated(), ciId, 1)]);
      } catch {
        /* relationship walk unavailable */
      }
      for (const [type, cis] of related) {
        const ids = new Set(cis.map((r) => r.sysId));
        for (const other of others) {
          for (const item of cisOf(ctx, other, true)) {
            if (!ids.has(item)) continue;
            findings.push({
              type,
              conflicting_change: other.sysId,
              configuration_item: ciId,
              related_configuration_item: item,
              description: `${other.str('number')} is scheduled on a ${type.startsWith('parent') ? 'parent' : 'child'} configuration item during ${window}`,
            });
          }
        }
      }
    }
  }

  // Assignee already busy on another change.
  const assignee = change.str('assigned_to');
  if (props.getBool(PROP.conflictAssignedTo, true) && assignee) {
    for (const other of others) {
      if (other.str('assigned_to') !== assignee) continue;
      findings.push({
        type: 'assigned_to_already_scheduled',
        conflicting_change: other.sysId,
        configuration_item: ciId || undefined,
        description: `${change.display('assigned_to')} is also assigned to ${other.str('number')} (${other.str('start_date')} to ${other.str('end_date')})`,
      });
    }
  }

  // Blackout and maintenance schedules.
  let outsideMaintenance = false;
  const { blackouts, maintenance } = applicableSchedules(ctx, change, ciId, ci);
  if (props.getBool(PROP.conflictBlackout, true)) {
    for (const s of blackouts) {
      if (!windowTouchesSchedule(ctx, s.sysId, startMs, endMs)) continue;
      findings.push({
        type: 'blackout',
        schedule: s.sysId,
        category: s.str('category') || undefined,
        configuration_item: ciId || undefined,
        description: `The planned window overlaps the blackout "${s.str('name')}"`,
      });
    }
  }
  if (props.getBool(PROP.conflictMaintenance, true)) {
    const windows: Rec[] = [...maintenance];
    const ciSchedule = ci?.str('maintenance_schedule');
    if (ciSchedule) {
      const s = ctx.elevated().get(T.schedule, ciSchedule);
      if (s) windows.push(s);
    }
    for (const s of windows) {
      if (windowInsideSchedule(ctx, s.sysId, startMs, endMs)) continue;
      outsideMaintenance = true;
      findings.push({
        type: 'not_in_maintenance_window',
        schedule: s.sysId,
        category: s.has('category') ? s.str('category') || undefined : undefined,
        configuration_item: ciId || undefined,
        description: `The planned window is not inside the maintenance window "${s.str('name')}"`,
      });
    }
  }

  // Consolidate: one row per (type, schedule) or (type, conflicting change, CI); cap per type.
  const max = Math.max(1000, props.getNumber(PROP.conflictMaxCount, 1000));
  const seen = new Set<string>();
  const perType = new Map<string, number>();
  const unique = findings.filter((f) => {
    const key = `${f.type}|${f.schedule ?? ''}|${f.conflicting_change ?? ''}|${f.related_configuration_item ?? f.configuration_item ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const n = (perType.get(f.type) ?? 0) + 1;
    perType.set(f.type, n);
    return n <= max;
  });
  return { findings: unique, checked: others.length, outsideMaintenance };
}

export interface ConflictRun {
  status: 'Conflict' | 'No Conflict' | 'Not Run';
  conflicts: Rec[];
  checked: number;
  lastRun: string;
}

/** Deletes the conflict rows of a change. */
export function deleteConflicts(ctx: Context, changeId: string): void {
  const sys = ctx.elevated();
  for (const row of sys.query(T.conflict, `change=${changeId}`)) sys.delete(row);
}

/**
 * Runs conflict detection: replaces the change's conflict rows and updates
 * conflict_status, conflict_last_run and outside_maintenance_schedule.
 */
export function runConflictDetection(ctx: Context, changeId: string): ConflictRun {
  const sys = ctx.elevated();
  const change = sys.get(T.change, changeId);
  const now = nowGlide();
  if (!change) return { status: 'Not Run', conflicts: [], checked: 0, lastRun: now };
  const check = findConflicts(ctx, change);
  deleteConflicts(ctx, changeId);
  const rows = check.findings.map((f) =>
    sys.insert(T.conflict, {
      change: changeId,
      conflicting_change: f.conflicting_change ?? null,
      configuration_item: f.configuration_item ?? null,
      related_configuration_item: f.related_configuration_item ?? null,
      schedule: f.schedule ?? null,
      type: f.type,
      category: f.category ?? null,
      last_checked: now,
      resolvr_description: f.description,
    }),
  );
  const status = rows.length ? 'Conflict' : 'No Conflict';
  // Status fields are system-maintained: save without re-running business rules.
  sys.derive({ workflow: false }).update(change, {
    conflict_status: status,
    conflict_last_run: now,
    outside_maintenance_schedule: check.outsideMaintenance,
  });
  if (rows.length) ctx.queueEvent('change.conflict_detected', change, String(rows.length), null);
  return { status, conflicts: rows, checked: check.checked, lastRun: now };
}

/** Clears conflict results (cancel): rows removed and status back to Not Run. */
export function clearConflictResults(ctx: Context, changeId: string): void {
  const sys = ctx.elevated();
  const change = sys.get(T.change, changeId);
  if (!change) return;
  deleteConflicts(ctx, changeId);
  sys.derive({ workflow: false }).update(change, { conflict_status: 'Not Run', conflict_last_run: null });
}

/** Whether automatic detection may run in the change's current state (allow_conflict_detection). */
export function autoDetectionAllowed(ctx: Context, change: Rec): boolean {
  const svc = changeModels(ctx.platform);
  const model = svc.forRecord(change);
  const state = change.num('state');
  if (!model || state === null) return true;
  if (!svc.modelHasAttribute(model, ATTR.CONFLICT_DETECTION)) return true;
  return svc.hasAttribute(model, state, ATTR.CONFLICT_DETECTION);
}

// ------------------------------------------------------- scheduling assistant

export interface SlotSearch {
  ciId: string;
  /** Change being rescheduled (excluded from busy time); optional. */
  change?: Rec | null;
  durationMs: number;
  from: number;
  windowDays: number;
  limit: number;
  stepMs: number;
}

/**
 * Next available windows of the requested duration for a configuration item: no other
 * change on the CI, no blackout, and inside a maintenance window when one applies.
 */
export function findSlots(ctx: Context, search: SlotSearch): Interval[] {
  const horizonEnd = search.from + search.windowDays * DAY_MS;
  const sys = ctx.elevated();
  const contiguous = ctx.platform.properties.getBool(PROP.conflictContiguous, true);
  const exclude = search.change?.sysId ?? '';
  // Busy time: other active changes on the same CI (primary or affected).
  const busy: Interval[] = [];
  const onCi = new Set<string>();
  for (const c of sys.query(T.change, `active=true^cmdb_ci=${search.ciId}^sys_id!=${exclude || 'none'}`))
    onCi.add(c.sysId);
  if (ctx.registry.has(T.taskCi)) {
    for (const r of sys.query(T.taskCi, `ci_item=${search.ciId}`))
      if (r.str('task') !== exclude) onCi.add(r.str('task'));
  }
  for (const id of onCi) {
    const c = sys.get(T.change, id);
    if (!c?.bool('active') || c.bool('exclude_from_conflict_detection')) continue;
    const s = toMs(c.str('start_date'));
    const e = toMs(c.str('end_date'));
    if (s !== null && e !== null && e > s) busy.push({ start: s, end: e });
  }
  const busyMerged = mergeIntervals(busy);
  const probe = search.change ?? sys.newRecord(T.change);
  if (!search.change) probe.setRaw('cmdb_ci', search.ciId);
  const ci = loadCi(ctx, search.ciId);
  const { blackouts, maintenance } = applicableSchedules(ctx, probe, search.ciId, ci);
  const maintenanceIds = maintenance.map((m) => m.sysId);
  const ciSchedule = ci?.str('maintenance_schedule');
  if (ciSchedule) maintenanceIds.push(ciSchedule);
  const usesService = !!schedulesOf(ctx.platform);
  // Without the schedules service, occurrences are expanded once for the whole horizon.
  const blackoutTime = usesService
    ? []
    : mergeIntervals(blackouts.flatMap((b) => scheduleIntervals(ctx, b.sysId, search.from, horizonEnd)));
  const maintenanceTime = usesService
    ? []
    : maintenanceIds.map((id) => mergeIntervals(scheduleIntervals(ctx, id, search.from, horizonEnd)));
  const ok = (w: Interval): boolean => {
    if (busyMerged.some((b) => overlaps(w, b, contiguous))) return false;
    if (usesService) {
      if (blackouts.some((b) => windowTouchesSchedule(ctx, b.sysId, w.start, w.end))) return false;
      return maintenanceIds.every((id) => windowInsideSchedule(ctx, id, w.start, w.end));
    }
    if (blackoutTime.some((b) => b.start < w.end && b.end > w.start)) return false;
    return maintenanceTime.every((list) => list.some((m) => m.start <= w.start && m.end >= w.end));
  };
  const slots: Interval[] = [];
  const step = Math.max(60_000, search.stepMs);
  let t = Math.ceil(search.from / step) * step;
  while (t + search.durationMs <= horizonEnd && slots.length < search.limit) {
    const w = { start: t, end: t + search.durationMs };
    if (ok(w)) {
      slots.push(w);
      t = w.end;
    } else {
      t += step;
    }
  }
  return slots;
}

export function slotToJson(ctx: Context, slot: Interval): Record<string, unknown> {
  const disp = (ms: number) => {
    const probe = ctx.newRecord(T.change);
    probe.setRaw('start_date', toGlide(ms));
    return probe.display('start_date');
  };
  return {
    start: { value: toGlide(slot.start), display_value: disp(slot.start) },
    end: { value: toGlide(slot.end), display_value: disp(slot.end) },
  };
}
