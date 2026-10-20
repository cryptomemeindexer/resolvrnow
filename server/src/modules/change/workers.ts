import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { SessionUser } from '../../engine/services/users.js';
import { nowGlide } from '../../engine/util.js';
import { T } from './constants.js';
import { readJson } from './util.js';

export interface WorkerMessages {
  errorMessages: string[];
  warningMessages: string[];
  infoMessages: string[];
}

export interface WorkerResult {
  payload?: Record<string, unknown>;
  messages?: Partial<WorkerMessages>;
  /** Marks the worker as failed (state 4). */
  error?: boolean;
}

const WORKER_STATE_LABEL: Record<string, string> = {
  '1': 'Waiting',
  '2': 'In-Progress',
  '3': 'Complete',
  '4': 'Error',
};

export function createWorker(
  ctx: Context,
  type: string,
  opts: { change?: Rec | null; ciId?: string | null; request?: Record<string, unknown> },
): Rec {
  return ctx.elevated().insert(T.worker, {
    type,
    state: 1,
    task: opts.change?.sysId ?? null,
    cmdb_ci: opts.ciId ?? null,
    request: JSON.stringify(opts.request ?? {}),
    messages: JSON.stringify({ errorMessages: [], warningMessages: [], infoMessages: [] }),
  });
}

/** Runs a worker body now and records its outcome. */
export function executeWorker(
  platform: Platform,
  user: SessionUser,
  workerId: string,
  body: (ctx: Context, worker: Rec) => WorkerResult,
): void {
  const ctx = platform.contextFor(user);
  const sys = ctx.elevated();
  const worker = sys.get(T.worker, workerId);
  if (!worker || worker.num('state') === 3 || worker.num('state') === 4) return;
  sys.update(worker, { state: 2, started_at: nowGlide() });
  let result: WorkerResult;
  try {
    result = body(ctx, worker);
  } catch (e) {
    result = { error: true, messages: { errorMessages: [e instanceof Error ? e.message : String(e)] } };
  }
  const messages: WorkerMessages = {
    errorMessages: result.messages?.errorMessages ?? [],
    warningMessages: result.messages?.warningMessages ?? [],
    infoMessages: result.messages?.infoMessages ?? [],
  };
  const fresh = sys.get(T.worker, workerId) ?? worker;
  sys.update(fresh, {
    state: result.error ? 4 : 3,
    completed_at: nowGlide(),
    payload: JSON.stringify(result.payload ?? {}),
    messages: JSON.stringify(messages),
  });
}

/** Queues a worker on the platform's async queue (processed right away in server mode). */
export function queueWorker(
  ctx: Context,
  worker: Rec,
  body: (ctx: Context, worker: Rec) => WorkerResult,
): void {
  const platform = ctx.platform;
  const user = ctx.user;
  platform.enqueueAsync(`chg_mgt_worker:${worker.sysId}`, () =>
    executeWorker(platform, user, worker.sysId, body),
  );
}

/** The REST envelope of a worker. */
export function workerEnvelope(worker: Rec, baseUrl: string): Record<string, unknown> {
  const state = String(worker.num('state') ?? 1);
  const out: Record<string, unknown> = {
    worker: { sysId: worker.sysId, link: `${baseUrl}/api/sn_chg_rest/change/worker/${worker.sysId}` },
    request: worker.str('request'),
    state: { value: Number(state), display_value: WORKER_STATE_LABEL[state] ?? state },
    type: worker.str('type'),
    messages: readJson<WorkerMessages>(worker.str('messages'), {
      errorMessages: [],
      warningMessages: [],
      infoMessages: [],
    }),
  };
  const payload = readJson<Record<string, unknown>>(worker.str('payload'), {});
  if (Object.keys(payload).length) out.payload = payload;
  return out;
}
