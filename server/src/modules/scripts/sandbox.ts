import { createRequire } from 'node:module';
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { PRELUDE } from './prelude.js';
import { WORKER_SOURCE } from './worker.js';

/**
 * Main-thread side of the script sandbox.
 *
 * Scripts run in QuickJS (WebAssembly) inside a dedicated worker thread. The platform engine is
 * synchronous, so the main thread blocks on an Atomics doorbell while a script runs and serves the
 * script's host calls (GlideRecord operations...) in between. Running QuickJS off the main thread
 * gives three guarantees an in-process interpreter cannot:
 *
 * - a large native stack for the interpreter, so deeply nested source or data structures end in a
 *   clean "stack overflow" error inside the sandbox instead of a host stack overflow;
 * - a hard wall-clock limit: if a script stops answering (a long native operation that ignores the
 *   interrupt handler), the worker is terminated and replaced;
 * - isolation of crashes: whatever happens inside the worker cannot corrupt the main thread.
 */

export type SandboxErrorKind =
  | 'error'
  | 'syntax'
  | 'timeout'
  | 'memory'
  | 'stack'
  | 'depth'
  | 'internal'
  | 'crash'
  | 'restart';

export interface SandboxErrorInfo {
  kind: SandboxErrorKind;
  name: string;
  message: string;
  stack?: string;
  line?: number;
}

export interface RunRequest {
  src: string;
  /** File name used in stack traces. */
  file: string;
  /** JSON environment handed to the prelude's setup(). */
  env: string;
  /** Epoch milliseconds after which the interpreter interrupts the script. */
  deadline: number;
  /** Runtime memory limit in bytes. */
  mem: number;
}

export type RunOutcome = { ok: true; r: string } | { ok: false; e: SandboxErrorInfo };

/** Bytes of interpreter stack: bounds the JavaScript call depth (roughly 5000 plain frames). */
export const SCRIPT_STACK_BYTES = 1024 * 1024;
/** Worker native stack sizes to try (MB); the interpreter needs far less, this is headroom. */
const WORKER_STACK_MB = [256, 64];
const READY_TIMEOUT_MS = 20_000;
/** Minimum time to wait for a reply once the main thread hands control back to the worker. */
const MIN_WAIT_MS = 1_000;
const MAX_NESTED_RUNS = 16;
/** Fresh contexts the worker keeps ready (creating one costs a few milliseconds). */
const CONTEXT_POOL_SIZE = 3;

interface Channel {
  worker: Worker;
  port: MessagePort;
  sig: Int32Array;
  dead: boolean;
}

type WorkerMessage =
  | { t: 'ready' }
  | { t: 'fatal'; e: string }
  | { t: 'call'; fn: string; a: string }
  | { t: 'done'; ok: true; r: string }
  | { t: 'done'; ok: false; e: SandboxErrorInfo };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SandboxEngine {
  private ch: Channel | null = null;
  private restarts = 0;

  /** Number of times the worker had to be replaced (crash or hard timeout). */
  get restartCount(): number {
    return this.restarts;
  }

  /** Starts the worker now instead of on the first script. */
  start(): void {
    this.channel();
  }

  /** Terminates the worker (a new one starts on the next script). */
  stop(): void {
    if (this.ch) this.kill(this.ch, false);
  }

  /**
   * Runs a script synchronously. `onCall` serves host calls and must not throw: it returns the
   * JSON reply envelope. `hardDeadline` is when the worker is considered hung and is replaced.
   */
  run(req: RunRequest, onCall: (fn: string, payload: string) => string, hardDeadline: number): RunOutcome {
    let ch: Channel;
    try {
      ch = this.channel();
    } catch (e) {
      return { ok: false, e: { kind: 'internal', name: 'Error', message: message(e) } };
    }
    this.post(ch, { t: 'run', ...req });
    for (;;) {
      const m = this.receive(ch, Math.max(hardDeadline - Date.now(), MIN_WAIT_MS));
      if (!m) {
        this.kill(ch, true);
        return {
          ok: false,
          e: {
            kind: 'timeout',
            name: 'Error',
            message: 'Script did not stop at its time limit; the sandbox was restarted',
          },
        };
      }
      if (m.t === 'call') {
        const reply = onCall(String(m.fn), String(m.a));
        if (ch.dead || this.ch !== ch) {
          return {
            ok: false,
            e: {
              kind: 'restart',
              name: 'Error',
              message: 'The script sandbox was restarted while this script was running',
            },
          };
        }
        this.post(ch, { t: 'ret', r: reply });
        continue;
      }
      if (m.t === 'done') {
        if (m.ok) return { ok: true, r: String(m.r) };
        if (m.e.kind === 'crash') this.kill(ch, true);
        return { ok: false, e: m.e };
      }
      if (m.t === 'fatal') {
        this.kill(ch, true);
        return { ok: false, e: { kind: 'crash', name: 'Error', message: String(m.e) } };
      }
    }
  }

  private channel(): Channel {
    if (this.ch && !this.ch.dead) return this.ch;
    this.ch = null;
    let last: unknown = null;
    for (const mb of WORKER_STACK_MB) {
      try {
        this.ch = this.spawn(mb);
        return this.ch;
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`Unable to start the script sandbox: ${message(last)}`);
  }

  private spawn(stackMb: number): Channel {
    const req = createRequire(import.meta.url);
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(8);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        port: port2,
        sab,
        corePath: req.resolve('quickjs-emscripten-core'),
        variantPath: req.resolve('@jitl/quickjs-wasmfile-release-sync'),
        prelude: PRELUDE,
        memoryLimit: 32 * 1024 * 1024,
        stackLimit: SCRIPT_STACK_BYTES,
        maxDepth: MAX_NESTED_RUNS,
        poolSize: CONTEXT_POOL_SIZE,
      },
      transferList: [port2],
      resourceLimits: { stackSizeMb: stackMb },
    });
    const ch: Channel = { worker, port: port1, sig: new Int32Array(sab), dead: false };
    worker.unref();
    port1.unref();
    // Listeners are required: an unhandled 'error' event would crash the host process.
    worker.on('error', () => {
      ch.dead = true;
    });
    worker.on('exit', () => {
      ch.dead = true;
    });
    const ready = this.receive(ch, READY_TIMEOUT_MS);
    if (ready?.t !== 'ready') {
      this.kill(ch, false);
      throw new Error(ready?.t === 'fatal' ? ready.e : 'the sandbox worker did not start in time');
    }
    return ch;
  }

  private post(ch: Channel, m: unknown): void {
    ch.port.postMessage(m);
    Atomics.add(ch.sig, 0, 1);
    Atomics.notify(ch.sig, 0);
  }

  private receive(ch: Channel, timeoutMs: number): WorkerMessage | null {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = receiveMessageOnPort(ch.port);
      if (r) return r.message as WorkerMessage;
      const seen = Atomics.load(ch.sig, 1);
      const again = receiveMessageOnPort(ch.port);
      if (again) return again.message as WorkerMessage;
      const left = end - Date.now();
      if (left <= 0) return null;
      Atomics.wait(ch.sig, 1, seen, left);
    }
  }

  private kill(ch: Channel, restart: boolean): void {
    ch.dead = true;
    if (this.ch === ch) this.ch = null;
    if (restart) this.restarts++;
    try {
      ch.port.close();
    } catch {
      /* already closed */
    }
    ch.worker.terminate().catch(() => {
      /* the thread is gone either way */
    });
  }
}

let shared: SandboxEngine | null = null;

/** Process-wide sandbox (one worker serves every platform instance; scripts never run concurrently). */
export function sandboxEngine(): SandboxEngine {
  shared ??= new SandboxEngine();
  return shared;
}
