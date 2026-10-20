import type { FastifyInstance } from 'fastify';
import { type ApiDeps, ctxOf, HttpError } from '../../api/http.js';
import { NotFoundError } from '../../engine/errors.js';
import { clock, parseGlideDateTime, toGlideDateTime } from '../../engine/util.js';
import { scheduleEngine } from './engine.js';
import { DAY } from './time.js';

const MAX_WINDOW = 400 * DAY;

/** ResolvrNow schedule endpoints (calendar previews and business-time checks). */
export function registerSchedulesApi(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/app/schedules/:sysId/intervals', async (req) => {
    const ctx = ctxOf(req, deps);
    const { sysId } = req.params as { sysId: string };
    const q = req.query as Record<string, string | undefined>;
    if (!ctx.get('cmn_schedule', sysId)) throw new NotFoundError();
    const engine = scheduleEngine(deps.platform);
    if (!engine) throw new HttpError(503, 'Schedule engine not available');
    const from = q.from ? parseGlideDateTime(q.from)?.getTime() : clock.now().getTime();
    const to = q.to ? parseGlideDateTime(q.to)?.getTime() : (from ?? 0) + 7 * DAY;
    if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to))
      throw new HttpError(400, 'Invalid from/to');
    if (to - from > MAX_WINDOW) throw new HttpError(400, 'Window too large (maximum 400 days)');
    const zone = engine.zoneFor(sysId, q.tz ?? ctx.user.timeZone);
    const list = engine.intervals(sysId, zone, from, to);
    return {
      result: {
        schedule: sysId,
        time_zone: zone,
        from: toGlideDateTime(new Date(from)),
        to: toGlideDateTime(new Date(to)),
        total_ms: list.reduce((n, [s, e]) => n + e - s, 0),
        intervals: list.map(([s, e]) => ({
          start: toGlideDateTime(new Date(s)),
          end: toGlideDateTime(new Date(e)),
        })),
      },
    };
  });
}
