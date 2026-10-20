import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { nowGlide } from '../../engine/util.js';
import { CLOSE_CODE, HOLD_REASON, INC_STATE, PROP } from './constants.js';
import { addBusinessDays, propNum, quietly } from './util.js';

/**
 * Caller strike cycle: while an incident waits for the caller, reminders are sent every
 * wait period; after the last reminder and one more wait period the incident is resolved.
 * State lives in `resolvr_incident_strike` rather than on the incident row.
 */
export function startStrikes(ctx: Context, inc: Rec): void {
  const count = propNum(ctx, PROP.strikeCount, 3);
  clearStrikes(ctx, inc);
  if (count <= 0) return;
  const sys = ctx.elevated();
  sys.insert('resolvr_incident_strike', {
    incident: inc.sysId,
    attempts: 1,
    next_due: nextDue(ctx, nowGlide()),
  });
  ctx.queueEvent('incident.strike.reminder', inc, '1', inc.str('caller_id'));
}

export function clearStrikes(ctx: Context, inc: Rec): void {
  const sys = ctx.elevated();
  for (const row of sys.query('resolvr_incident_strike', { query: `incident=${inc.sysId}` })) sys.delete(row);
}

function nextDue(ctx: Context, from: string): string {
  return addBusinessDays(from, Math.max(1, propNum(ctx, PROP.strikeWait, 1)));
}

/** Scheduled job: sends due reminders and resolves incidents whose caller never answered. */
export function processStrikes(ctx: Context): number {
  const count = propNum(ctx, PROP.strikeCount, 3);
  let processed = 0;
  for (const row of ctx.query('resolvr_incident_strike', {
    query: `next_due<=${nowGlide()}^ORDERBYnext_due`,
  })) {
    const inc = ctx.get('incident', row.str('incident'));
    if (!inc || inc.str('state') !== INC_STATE.ON_HOLD || inc.str('hold_reason') !== HOLD_REASON.CALLER) {
      ctx.delete(row);
      continue;
    }
    processed++;
    const attempts = row.num('attempts') ?? 0;
    if (count > 0 && attempts < count) {
      ctx.update(row, { attempts: attempts + 1, next_due: nextDue(ctx, nowGlide()) });
      ctx.queueEvent('incident.strike.reminder', inc, String(attempts + 1), inc.str('caller_id'));
      continue;
    }
    resolveUnresponsive(ctx, inc, attempts);
  }
  return processed;
}

function resolveUnresponsive(ctx: Context, inc: Rec, attempts: number): void {
  const note = `The caller did not respond to ${attempts} reminder${attempts === 1 ? '' : 's'}, so the incident was resolved automatically. Reply to reopen it if the issue persists.`;
  quietly(() =>
    ctx.update(inc, {
      state: INC_STATE.RESOLVED,
      close_code: CLOSE_CODE.NO_RESPONSE,
      close_notes: note,
      comments: note,
    }),
  );
  ctx.queueEvent('incident.strike.resolved', inc, String(attempts), inc.str('caller_id'));
}
