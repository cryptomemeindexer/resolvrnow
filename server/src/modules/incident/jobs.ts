import type { Context } from '../../engine/context.js';
import type { ScheduledJobDef } from '../../engine/services/scheduler.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { INC_STATE, MIM_STATE, PROP } from './constants.js';
import { processStrikes } from './strikes.js';
import { propBool, propNum, propStr, quietly, subtractBusinessDays } from './util.js';

const DAY_MS = 86_400_000;

/** Context recorded as updater/closer: the configured run-as user, else the system user. */
function runAsContext(ctx: Context): Context {
  const name = propStr(ctx, PROP.autocloseRunAs, 'system');
  if (!name || name === 'system') return ctx;
  const user = /^[0-9a-f]{32}$/.test(name)
    ? ctx.platform.users.session(name)
    : ctx.platform.users.byUserName(name);
  return user ? ctx.platform.contextFor(user).elevated() : ctx;
}

/** Closes resolved incidents that stayed resolved longer than glide.ui.autoclose.time days. */
export function autoCloseIncidents(ctx: Context): number {
  const days = propNum(ctx, PROP.autocloseDays, 7);
  if (days <= 0) return 0;
  const now = nowGlide();
  const cutoff = propBool(ctx, PROP.autocloseBusinessDays, false)
    ? subtractBusinessDays(now, days)
    : addMs(now, -days * DAY_MS);
  const field = propBool(ctx, PROP.autocloseOnResolvedAt, true) ? 'resolved_at' : 'sys_updated_on';
  const actor = runAsContext(ctx);
  const due = ctx.query('incident', {
    query: `state=${INC_STATE.RESOLVED}^${field}<${cutoff}^major_incident_state!=${MIM_STATE.ACCEPTED}`,
  });
  let closed = 0;
  for (const inc of due) {
    try {
      quietly(() =>
        actor.update(inc, {
          state: INC_STATE.CLOSED,
          work_notes: `Closed automatically after ${days} day${days === 1 ? '' : 's'} in the Resolved state.`,
        }),
      );
      closed++;
    } catch (e) {
      ctx.platform.reportError(`incident auto-close ${inc.str('number')}`, e);
    }
  }
  return closed;
}

export const INCIDENT_JOBS: ScheduledJobDef[] = [
  {
    id: 'incident.autoclose',
    name: 'Autoclose Incidents',
    description: 'Closes incidents that have been resolved for longer than glide.ui.autoclose.time days',
    intervalMs: 3_600_000,
    run: autoCloseIncidents,
  },
  {
    id: 'incident.strike_reminders',
    name: 'Incident strike reminders',
    description: 'Reminds unresponsive callers and resolves incidents after the last reminder',
    intervalMs: 15 * 60_000,
    run: processStrikes,
  },
];
