import type { FastifyInstance } from 'fastify';
import { type ApiDeps, ctxOf, HttpError } from '../../api/http.js';
import { isSysId } from '../../engine/util.js';
import type { ScriptRuntime } from './service.js';

const MAX_SCRIPT_LENGTH = 1_000_000;

function runtimeOf(deps: ApiDeps): ScriptRuntime {
  const r = deps.platform.services.get('scripts') as ScriptRuntime | undefined;
  if (!r) throw new HttpError(503, 'Scripting is not available');
  return r;
}

function scriptField(body: unknown, name: string): string {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
  if (typeof v !== 'string' || !v.trim())
    throw new HttpError(400, `Missing ${name}`, `The request body must contain a non-empty "${name}" string`);
  if (v.length > MAX_SCRIPT_LENGTH) throw new HttpError(400, `${name} is too long`);
  return v;
}

/** Product APIs for administrators: background scripts and condition testing. */
export function registerScriptsApi(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/api/app/scripts/background', async (req) => {
    const ctx = ctxOf(req, deps);
    if (!ctx.user.isAdmin)
      throw new HttpError(403, 'Insufficient rights', 'Background scripts require the admin role');
    const script = scriptField(req.body, 'script');
    return runtimeOf(deps).background(ctx, script);
  });

  app.post('/api/app/scripts/eval-condition', async (req) => {
    const ctx = ctxOf(req, deps);
    if (!ctx.user.isAdmin)
      throw new HttpError(403, 'Insufficient rights', 'Testing conditions requires the admin role');
    const condition = scriptField(req.body, 'condition');
    const body = req.body as Record<string, unknown>;
    let current = null;
    if (body.table !== undefined || body.sys_id !== undefined) {
      const table = typeof body.table === 'string' ? body.table : '';
      const sysId = typeof body.sys_id === 'string' ? body.sys_id : '';
      if (!deps.platform.registry.has(table))
        throw new HttpError(400, 'Invalid table', `Unknown table "${table}"`);
      if (!isSysId(sysId)) throw new HttpError(400, 'Invalid sys_id');
      current = ctx.elevated().get(table, sysId);
      if (!current) throw new HttpError(404, 'No Record found', `No ${table} record with sys_id ${sysId}`);
    }
    return runtimeOf(deps).testCondition(ctx, condition, current);
  });
}
