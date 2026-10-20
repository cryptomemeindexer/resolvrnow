import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import { T } from './constants.js';
import { preferenceValue, setPreference } from './taxonomy.js';
import { q } from './util.js';

const donePreference = (id: string) => `resolvr.tour.${id}.done`;

function allowed(ctx: Context, tour: Rec): boolean {
  const roles = tour
    .str('roles')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return !roles.length || ctx.hasAnyRole(roles);
}

/** Active guided tours for a portal page (or all pages) that the user's roles allow. */
export function toursFor(ctx: Context, page?: string | null) {
  const sys = ctx.elevated();
  const filter = page ? `^page_id=${q(page)}^ORpage_idISEMPTY` : '';
  return sys
    .query(T.tour, { query: `active=true${filter}^ORDERBYname` })
    .filter((tour) => allowed(ctx, tour))
    .map((tour) => ({
      sys_id: tour.sysId,
      name: tour.str('name'),
      page_id: tour.str('page_id'),
      auto_launch: tour.bool('auto_launch'),
      done: preferenceValue(ctx, donePreference(tour.sysId)) === 'true',
      steps: sys.query(T.tourStep, { query: `guide=${tour.sysId}^ORDERBYorder` }).map((s) => ({
        order: s.num('order') ?? 100,
        target: s.str('target'),
        title: s.str('title'),
        content: s.str('content'),
        placement: s.str('placement') || 'bottom',
      })),
    }));
}

/** Marks a tour as completed for the user (it no longer starts automatically). */
export function completeTour(ctx: Context, id: string): void {
  const tour = isSysId(id) ? ctx.elevated().get(T.tour, id) : null;
  if (!tour?.bool('active') || !allowed(ctx, tour)) throw new NotFoundError();
  setPreference(ctx, donePreference(tour.sysId), 'true');
}
