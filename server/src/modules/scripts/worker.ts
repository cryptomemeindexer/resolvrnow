/**
 * Source of the sandbox worker thread (plain CommonJS, evaluated with `new Worker(src, { eval: true })`
 * so it runs the same way under tsx, vitest and the compiled server).
 *
 * The worker owns one QuickJS runtime (memory limit, stack limit, interrupt-based deadline) and
 * creates a fresh context per script execution. It talks to the main thread through a
 * MessagePort plus a shared doorbell (Atomics), so the main thread can wait synchronously:
 *
 *   main -> worker   { t: 'run', src, file, env, deadline, mem }   start a script
 *                    { t: 'ret', r }                               reply to a host call
 *   worker -> main   { t: 'ready' } | { t: 'fatal', e }
 *                    { t: 'call', fn, a }                          host call (JSON payload)
 *                    { t: 'done', ok, r | e }                      script finished
 *
 * While waiting for a host-call reply the worker accepts nested 'run' messages, which is how a
 * script's GlideRecord.insert() can trigger business rules that are scripts themselves.
 *
 * Kept as a template string: no backticks, backslashes or template placeholders inside.
 */
export const WORKER_SOURCE = `
'use strict';
const { workerData, receiveMessageOnPort } = require('node:worker_threads');

const port = workerData.port;
const sig = new Int32Array(workerData.sab);
const PRELUDE = workerData.prelude;
const STACK_LIMIT = workerData.stackLimit;
const MAX_DEPTH = workerData.maxDepth;
const FINISH_BUDGET_MS = 250;
const ERROR_HEADROOM = 4 * 1024 * 1024;
const MAX_RESULT = 16 * 1024 * 1024;

const POOL_SIZE = workerData.poolSize;

let memoryLimit = workerData.memoryLimit;
let rt = null;
let deadline = Infinity;
let depth = 0;
let queued = null;
let broken = false;
const pool = [];

function send(m) {
  port.postMessage(m);
  Atomics.add(sig, 1, 1);
  Atomics.notify(sig, 1);
}

function recv() {
  if (queued) {
    const m = queued;
    queued = null;
    return m;
  }
  for (;;) {
    let r = receiveMessageOnPort(port);
    if (r) return r.message;
    const seen = Atomics.load(sig, 0);
    r = receiveMessageOnPort(port);
    if (r) return r.message;
    Atomics.wait(sig, 0, seen);
  }
}

/** True when a message is waiting (it is kept for the next recv()). */
function messageWaiting() {
  if (queued) return true;
  const r = receiveMessageOnPort(port);
  if (!r) return false;
  queued = r.message;
  return true;
}

function text(e) {
  return e && e.message ? String(e.message) : String(e);
}

function hostCall(fn, payload) {
  send({ t: 'call', fn: fn, a: payload });
  for (;;) {
    const m = recv();
    if (m.t === 'ret') return m.r;
    if (m.t === 'run') runScript(m);
  }
}

function disposeContext(c) {
  for (const k of ['setup', 'finish', 'errinfo']) {
    if (c[k]) {
      try { c[k].dispose(); } catch (e) { /* already gone */ }
      c[k] = null;
    }
  }
  try { c.ctx.dispose(); } catch (e) { /* already gone */ }
}

function safeDump(ctx, h) {
  try {
    return ctx.dump(h);
  } catch (e) {
    return { name: 'Error', message: 'Script error' };
  }
}

function createContext() {
  const ctx = rt.newContext();
  const c = { ctx: ctx, setup: null, finish: null, errinfo: null };
  try {
    const bridge = ctx.newFunction('__host', function (fnH, payloadH) {
      const fn = fnH && ctx.typeof(fnH) === 'string' ? ctx.getString(fnH) : '';
      const payload = payloadH && ctx.typeof(payloadH) === 'string' ? ctx.getString(payloadH) : '[]';
      return ctx.newString(hostCall(fn, payload));
    });
    ctx.setProp(ctx.global, '__host', bridge);
    bridge.dispose();
    const r = ctx.evalCode(PRELUDE, 'prelude.js');
    if (r.error) {
      const d = safeDump(ctx, r.error);
      r.error.dispose();
      throw new Error('sandbox prelude failed: ' + JSON.stringify(d));
    }
    const api = r.value;
    c.setup = ctx.getProp(api, 'setup');
    c.finish = ctx.getProp(api, 'finish');
    c.errinfo = ctx.getProp(api, 'errinfo');
    api.dispose();
    return c;
  } catch (e) {
    disposeContext(c);
    throw e;
  }
}

function classify(info) {
  const msg = String(info.message || '');
  if (info.name === 'InternalError') {
    if (msg.indexOf('interrupted') >= 0) return 'timeout';
    if (msg.indexOf('out of memory') >= 0) return 'memory';
    if (msg.indexOf('stack overflow') >= 0) return 'stack';
  }
  if (msg.indexOf('stack overflow') >= 0) return 'stack';
  if (info.name === 'SyntaxError') return 'syntax';
  return 'error';
}

function failure(c, errH) {
  const ctx = c.ctx;
  let info = null;
  const saved = deadline;
  deadline = Date.now() + FINISH_BUDGET_MS;
  try { rt.setMemoryLimit(memoryLimit + ERROR_HEADROOM); } catch (e) { /* ignore */ }
  try {
    const r = ctx.callFunction(c.errinfo, ctx.undefined, errH);
    if (r.error) {
      r.error.dispose();
    } else {
      if (ctx.typeof(r.value) === 'string') info = JSON.parse(ctx.getString(r.value));
      r.value.dispose();
    }
  } catch (e) {
    info = null;
  }
  if (!info) {
    const d = safeDump(ctx, errH);
    info = d && typeof d === 'object' ? { name: String(d.name || 'Error'), message: String(d.message || '') } : { name: 'Error', message: String(d) };
  }
  deadline = saved;
  try { rt.setMemoryLimit(memoryLimit); } catch (e) { /* ignore */ }
  try { errH.dispose(); } catch (e) { /* ignore */ }
  info.kind = classify(info);
  return { t: 'done', ok: false, e: info };
}

function execute(c, m) {
  const ctx = c.ctx;
  const envH = ctx.newString(m.env);
  const sr = ctx.callFunction(c.setup, ctx.undefined, envH);
  envH.dispose();
  if (sr.error) return failure(c, sr.error);
  sr.value.dispose();
  const r = ctx.evalCode(m.src, m.file);
  if (r.error) return failure(c, r.error);
  const saved = deadline;
  deadline = Date.now() + FINISH_BUDGET_MS;
  let fr;
  try {
    fr = ctx.callFunction(c.finish, ctx.undefined, r.value);
  } finally {
    deadline = saved;
    r.value.dispose();
  }
  if (fr.error) return failure(c, fr.error);
  const out = ctx.typeof(fr.value) === 'string' ? ctx.getString(fr.value) : '{"v":null}';
  fr.value.dispose();
  if (out.length > MAX_RESULT) {
    return { t: 'done', ok: false, e: { kind: 'error', name: 'RangeError', message: 'Script result is too large' } };
  }
  return { t: 'done', ok: true, r: out };
}

function runScript(m) {
  const outer = deadline;
  depth++;
  deadline = Math.min(outer, m.deadline);
  let c = null;
  let out;
  try {
    if (depth > MAX_DEPTH) {
      out = { t: 'done', ok: false, e: { kind: 'depth', name: 'Error', message: 'Maximum script nesting depth exceeded' } };
    } else {
      if (depth === 1 && m.mem && m.mem !== memoryLimit) {
        memoryLimit = m.mem;
        rt.setMemoryLimit(memoryLimit);
      }
      c = pool.length ? pool.pop() : createContext();
      out = execute(c, m);
    }
  } catch (e) {
    // A WebAssembly trap or a host stack overflow leaves the interpreter in an unknown state:
    // report it, then retire this worker (the main thread starts a fresh one).
    const fatal = e instanceof WebAssembly.RuntimeError || e instanceof RangeError;
    if (fatal) broken = true;
    out = { t: 'done', ok: false, e: { kind: fatal ? 'crash' : 'internal', name: 'Error', message: 'Sandbox failure: ' + text(e) } };
  } finally {
    if (c && !broken) disposeContext(c);
    depth--;
    deadline = outer;
  }
  send(out);
  if (broken) process.exit(1);
}

/** Prepares contexts while the main thread is busy elsewhere, so the next scripts start at once. */
function fillPool() {
  while (pool.length < POOL_SIZE && !messageWaiting()) {
    try {
      pool.push(createContext());
    } catch (e) {
      return;
    }
  }
}

async function main() {
  try {
    const core = require(workerData.corePath);
    const variantModule = require(workerData.variantPath);
    const mod = await core.newQuickJSWASMModuleFromVariant(variantModule.default || variantModule);
    rt = mod.newRuntime();
    rt.setMemoryLimit(memoryLimit);
    rt.setMaxStackSize(STACK_LIMIT);
    rt.setInterruptHandler(function () { return Date.now() > deadline; });
    pool.push(createContext());
  } catch (e) {
    send({ t: 'fatal', e: 'sandbox initialisation failed: ' + text(e) });
    return;
  }
  send({ t: 'ready' });
  for (;;) {
    try {
      fillPool();
      const m = recv();
      if (m && m.t === 'run') runScript(m);
    } catch (e) {
      send({ t: 'fatal', e: text(e) });
      return;
    }
  }
}

main();
`;
