import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import { matches } from '../../engine/query/matcher.js';
import { parseEncodedQuery } from '../../engine/query/parser.js';
import type { QueryBuilder } from '../../engine/querybuilder.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { clock, nowGlide, parseGlideDateTime } from '../../engine/util.js';
import type { ScriptService } from '../contracts.js';
import { type ExecOptions, ExecState, HOST_FUNCTIONS, type HostRuntime } from './host.js';
import { writeSyslog } from './log.js';
import { type SandboxErrorInfo, type SandboxErrorKind, sandboxEngine } from './sandbox.js';

/** A script that failed: syntax or runtime error, time limit, memory limit, stack overflow... */
export class ScriptError extends Error {
  /** Log lines written before the failure. */
  output: string[] = [];

  constructor(
    message: string,
    readonly kind: SandboxErrorKind = 'error',
    readonly line?: number,
  ) {
    super(message);
    this.name = 'ScriptError';
  }
}

export interface ScriptResult {
  value: unknown;
  output: string[];
  durationMs: number;
}

/** A business rule loaded from sys_script. */
export interface ScriptRuleInfo {
  id: string;
  sysId: string;
  name: string;
  table: string;
  when: 'before' | 'after' | 'async' | 'display';
  actions: ('insert' | 'update' | 'delete' | 'query')[];
  order: number;
  script: string;
  condition: string;
  filter: string;
  roles: string[];
  addMessage: boolean;
  message: string;
  abortAction: boolean;
  template: string;
}

export interface BackgroundResult {
  result: unknown;
  output: string[];
  durationMs: number;
  error?: { message: string; kind: SandboxErrorKind; line?: number };
}

const MAX_SOURCE_LENGTH = 1_000_000;
const MAX_NESTING = 12;
/** Extra time after the script deadline before a silent worker is considered hung. */
const HARD_KILL_GRACE_MS = 1_500;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** JavaScript truthiness of a script result, treating the strings 'false' and '0' as false. */
export function truthy(v: unknown): boolean {
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0';
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return !!v;
}

function lineOf(info: SandboxErrorInfo, file: string): number | undefined {
  if (typeof info.line === 'number') return info.line;
  const stack = info.stack ?? '';
  const marker = `(${file}:`;
  const at = stack.indexOf(marker);
  if (at < 0) return undefined;
  const n = Number.parseInt(stack.slice(at + marker.length), 10);
  return Number.isFinite(n) ? n : undefined;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The scripting runtime: runs sandboxed scripts for business rules, conditions, ACLs, script
 * includes, scheduled jobs and background scripts. Registered as the `scripts` service.
 */
export class ScriptRuntime implements ScriptService, HostRuntime {
  private readonly stack: ExecState[] = [];
  private readonly activeRules = new Set<string>();
  private includes: { names: string[]; byName: Map<string, { n: string; src: string }> } | null = null;

  constructor(readonly platform: Platform) {}

  // ------------------------------------------------------------- settings

  timeoutMs(): number {
    return Math.min(
      600_000,
      Math.max(10, this.platform.properties.getNumber('resolvr.script.timeout_ms', 2000)),
    );
  }

  /** Background and scheduled scripts are administrative batch work and get a longer limit. */
  backgroundTimeoutMs(): number {
    return Math.min(
      600_000,
      Math.max(10, this.platform.properties.getNumber('resolvr.script.background_timeout_ms', 10_000)),
    );
  }

  memoryLimitMb(): number {
    return Math.min(
      1024,
      Math.max(4, this.platform.properties.getNumber('resolvr.script.memory_limit_mb', 32)),
    );
  }

  maxRows(): number {
    return Math.min(
      100_000,
      Math.max(1, this.platform.properties.getNumber('resolvr.script.max_rows', 10_000)),
    );
  }

  // ------------------------------------------------------------ execution

  /** Runs a script and returns its result (the `answer` variable when set, else the completion value). */
  execute(opts: ExecOptions): ScriptResult {
    const started = Date.now();
    if (typeof opts.source !== 'string') throw new ScriptError('Script must be a string');
    if (opts.source.length > MAX_SOURCE_LENGTH)
      throw new ScriptError(`Script is longer than ${MAX_SOURCE_LENGTH} characters`);
    if (this.stack.length >= MAX_NESTING)
      throw new ScriptError('Maximum script nesting depth exceeded', 'depth');
    const timeout = opts.timeoutMs ?? this.timeoutMs();
    const st = new ExecState(this, opts.ctx, opts);
    const outer = this.stack[this.stack.length - 1];
    st.deadline = Math.min(outer ? outer.deadline : Number.POSITIVE_INFINITY, started + timeout);
    this.stack.push(st);
    try {
      const env = st.env(this.includeNames(), clock.now().getTime() - Date.now());
      const outcome = sandboxEngine().run(
        {
          src: opts.source,
          file: opts.file,
          env: JSON.stringify(env),
          deadline: st.deadline,
          mem: this.memoryLimitMb() * 1024 * 1024,
        },
        (fn, payload) => this.dispatch(st, fn, payload),
        st.deadline + HARD_KILL_GRACE_MS,
      );
      if (!outcome.ok) {
        const err = this.toError(outcome.e, timeout, opts.file);
        err.output = st.output;
        throw err;
      }
      let value: unknown = null;
      try {
        value = (JSON.parse(outcome.r) as { v: unknown }).v;
      } catch {
        value = null;
      }
      return { value, output: st.output, durationMs: Date.now() - started };
    } finally {
      this.stack.pop();
    }
  }

  private dispatch(st: ExecState, fn: string, payload: string): string {
    try {
      if (this.stack[this.stack.length - 1] !== st)
        throw new Error('Host call from a script that is not running');
      const handler = Object.hasOwn(HOST_FUNCTIONS, fn) ? HOST_FUNCTIONS[fn] : undefined;
      if (!handler) throw new Error(`Unknown host function ${fn}`);
      const args = JSON.parse(payload) as unknown;
      if (!Array.isArray(args)) throw new Error('Malformed host call');
      const v = handler(st, args);
      return JSON.stringify({ ok: true, v: v === undefined ? null : v });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        e: errorText(e) || 'Host error',
        n: e instanceof Error && e.name !== 'Error' ? e.name : undefined,
      });
    }
  }

  private toError(info: SandboxErrorInfo, timeout: number, file: string): ScriptError {
    switch (info.kind) {
      case 'timeout':
        return new ScriptError(`Script execution exceeded the time limit of ${timeout} ms`, 'timeout');
      case 'memory':
        return new ScriptError(`Script exceeded the memory limit of ${this.memoryLimitMb()} MB`, 'memory');
      case 'stack':
        return new ScriptError('Maximum call stack size exceeded (stack overflow)', 'stack');
      default: {
        const line = lineOf(info, file);
        const name = info.name && info.name !== 'Error' ? `${info.name}: ` : '';
        return new ScriptError(
          `${name}${info.message || 'Script error'}${line ? ` (line ${line})` : ''}`,
          info.kind,
          line,
        );
      }
    }
  }

  logError(ctx: Context, source: string, e: unknown): void {
    const msg = errorText(e);
    writeSyslog(this.platform, 'error', source, msg, ctx.user.userName);
    this.platform.log.warn(`[resolvrnow] ${source}: ${msg}`);
  }

  // ------------------------------------------------------- ScriptService

  run(
    ctx: Context,
    script: string,
    bindings: { current?: Rec | null; previous?: Rec | null; vars?: Record<string, unknown> } = {},
  ): unknown {
    return this.execute({
      ctx,
      source: script,
      file: 'script.js',
      label: 'Script',
      current: bindings.current,
      previous: bindings.previous,
      vars: bindings.vars,
    }).value;
  }

  condition(ctx: Context, script: string, current: Rec | null, previous: Rec | null = null): boolean {
    return this.evaluateCondition(ctx, script, current, previous, 'Condition script');
  }

  private evaluateCondition(
    ctx: Context,
    script: string,
    current: Rec | null,
    previous: Rec | null,
    label: string,
  ): boolean {
    if (!script?.trim()) return true;
    try {
      return truthy(
        this.execute({ ctx, source: script, file: 'condition.js', label, current, previous }).value,
      );
    } catch (e) {
      this.logError(ctx, label, e);
      return false;
    }
  }

  /**
   * ACL script: `current` is the record, writes are refused, and only a true answer grants access.
   * Table-level checks have no record (`current` is null): a script that cannot be evaluated
   * without one is not decisive there, and is evaluated again for every record read or written.
   */
  acl(script: string, rec: Rec | null, ctx: Context): boolean {
    if (!script.trim()) return true;
    try {
      const r = this.execute({
        ctx,
        source: script,
        file: 'acl.js',
        label: 'ACL script',
        current: rec,
        readOnly: true,
      });
      return r.value === true || r.value === 'true';
    } catch (e) {
      if (rec === null && e instanceof ScriptError && e.kind === 'error') return true;
      this.logError(ctx, 'ACL script', e);
      return false;
    }
  }

  // ------------------------------------------------------- business rules

  ruleCondition(info: ScriptRuleInfo, cur: Rec, prev: Rec | null, ctx: Context): boolean {
    if (info.roles.length && !ctx.hasAnyRole(info.roles)) return false;
    if (info.filter.trim() && !matches(info.filter, recSubject(cur, prev, this.platform.registry), ctx.env))
      return false;
    if (info.condition.trim())
      return this.evaluateCondition(ctx, info.condition, cur, prev, `Business rule: ${info.name}`);
    return true;
  }

  runRule(info: ScriptRuleInfo, cur: Rec, prev: Rec | null, ctx: Context): void {
    const label = `Business rule: ${info.name}`;
    const key = `${info.id}:${cur.sysId}`;
    if (this.activeRules.has(key)) {
      writeSyslog(
        this.platform,
        'warn',
        label,
        `Rule re-entered for ${cur.className} ${cur.sysId}; skipped to prevent recursion`,
        ctx.user.userName,
      );
      return;
    }
    this.activeRules.add(key);
    try {
      if (info.abortAction) {
        if (info.addMessage && info.message) ctx.addErrorMessage(info.message);
        cur.abort(info.message || undefined);
        return;
      }
      if (info.template.trim() && info.when === 'before') applyTemplate(cur, info.template);
      if (info.addMessage && info.message) ctx.addInfoMessage(info.message);
      if (!info.script.trim()) return;
      try {
        this.execute({
          ctx,
          source: info.script,
          file: `sys_script/${info.name}.js`,
          label,
          current: cur,
          previous: prev,
          phase: info.when,
          abortMessage: info.message || undefined,
        });
      } catch (e) {
        this.logError(ctx, label, e);
      }
    } finally {
      this.activeRules.delete(key);
    }
  }

  runQueryRule(info: ScriptRuleInfo, qb: QueryBuilder, ctx: Context): void {
    const label = `Business rule: ${info.name}`;
    const key = `${info.id}:query`;
    if (this.activeRules.has(key)) return;
    if (info.roles.length && !ctx.hasAnyRole(info.roles)) return;
    this.activeRules.add(key);
    try {
      const live = { table: qb.table, qb };
      if (info.condition.trim()) {
        const r = this.execute({
          ctx,
          source: info.condition,
          file: 'condition.js',
          label,
          liveQuery: live,
          phase: 'query',
        });
        if (!truthy(r.value)) return;
      }
      if (info.script.trim()) {
        this.execute({
          ctx,
          source: info.script,
          file: `sys_script/${info.name}.js`,
          label,
          liveQuery: live,
          phase: 'query',
        });
      }
    } catch (e) {
      this.logError(ctx, label, e);
    } finally {
      this.activeRules.delete(key);
    }
  }

  // --------------------------------------------------- background scripts

  background(ctx: Context, script: string): BackgroundResult {
    const started = Date.now();
    let out: BackgroundResult;
    try {
      const r = this.execute({
        ctx,
        source: script,
        file: 'background.js',
        label: 'Background script',
        timeoutMs: this.backgroundTimeoutMs(),
      });
      out = { result: r.value, output: r.output, durationMs: Date.now() - started };
    } catch (e) {
      const se = e instanceof ScriptError ? e : null;
      out = {
        result: null,
        output: se?.output ?? [],
        durationMs: Date.now() - started,
        error: { message: errorText(e), kind: se?.kind ?? 'error', ...(se?.line ? { line: se.line } : {}) },
      };
    }
    const status = out.error ? `failed: ${out.error.message}` : 'completed';
    writeSyslog(
      this.platform,
      out.error ? 'warn' : 'info',
      'Background script',
      `Background script run by ${ctx.user.userName} ${status} in ${out.durationMs} ms:\n${script.slice(0, 2000)}`,
      ctx.user.userName,
    );
    return out;
  }

  /** Evaluates a condition for testing; `current` is the given record (or null). */
  testCondition(
    ctx: Context,
    condition: string,
    current: Rec | null,
  ): {
    result: boolean;
    value: unknown;
    output: string[];
    durationMs: number;
    error?: { message: string; kind: SandboxErrorKind; line?: number };
  } {
    const started = Date.now();
    try {
      const r = this.execute({
        ctx,
        source: condition,
        file: 'condition.js',
        label: 'Condition test',
        current,
        previous: null,
      });
      return { result: truthy(r.value), value: r.value, output: r.output, durationMs: r.durationMs };
    } catch (e) {
      const se = e instanceof ScriptError ? e : null;
      return {
        result: false,
        value: null,
        output: se?.output ?? [],
        durationMs: Date.now() - started,
        error: { message: errorText(e), kind: se?.kind ?? 'error', ...(se?.line ? { line: se.line } : {}) },
      };
    }
  }

  // ---------------------------------------------------- scheduled scripts

  /** Runs every active sysauto_script whose period has elapsed; returns how many ran. */
  runDueScheduled(): number {
    if (!this.platform.registry.has('sysauto_script')) return 0;
    const now = clock.now().getTime();
    let n = 0;
    for (const job of this.platform.systemContext().query('sysauto_script', 'active=true')) {
      if (!isDue(job, now)) continue;
      this.runScheduled(job);
      n++;
    }
    return n;
  }

  /** Runs one scheduled script now (as its run_as user, else as system) and records last_run. */
  runScheduled(job: Rec): ScriptResult | null {
    const name = job.str('name') || job.sysId;
    const label = `Scheduled script: ${name}`;
    const runAs = job.str('run_as');
    const session = runAs ? this.platform.users.session(runAs) : null;
    const ctx = session ? this.platform.contextFor(session) : this.platform.systemContext();
    let result: ScriptResult | null = null;
    try {
      result = this.execute({
        ctx,
        source: job.str('script'),
        file: `sysauto_script/${name}.js`,
        label,
        timeoutMs: this.backgroundTimeoutMs(),
      });
    } catch (e) {
      this.logError(ctx, label, e);
    }
    try {
      this.platform.systemContext().derive({ workflow: false }).update(job, { last_run: nowGlide() });
    } catch (e) {
      this.logError(ctx, label, e);
    }
    return result;
  }

  // ------------------------------------------------------ script includes

  invalidateIncludes(): void {
    this.includes = null;
  }

  private loadIncludes(): { names: string[]; byName: Map<string, { n: string; src: string }> } {
    if (this.includes) return this.includes;
    const byName = new Map<string, { n: string; src: string }>();
    const names: string[] = [];
    if (this.platform.registry.has('sys_script_include')) {
      const rows = this.platform.db.all<{
        name: string | null;
        api_name: string | null;
        script: string | null;
      }>(
        `SELECT "name","api_name","script" FROM "sys_script_include" WHERE "active" IS NULL OR "active" = 1 ORDER BY "sys_created_on"`,
      );
      for (const r of rows) {
        const name = (r.name ?? '').trim();
        if (!name || byName.has(name)) continue;
        const entry = { n: name, src: r.script ?? '' };
        byName.set(name, entry);
        if (IDENTIFIER_RE.test(name)) names.push(name);
        const api = (r.api_name ?? '').trim();
        if (api && !byName.has(api)) byName.set(api, entry);
      }
    }
    this.includes = { names, byName };
    return this.includes;
  }

  includeNames(): string[] {
    return this.loadIncludes().names;
  }

  includeSource(name: string): { n: string; src: string } | null {
    return this.loadIncludes().byName.get(name) ?? null;
  }
}

/** Applies a business rule's "set field values" template (`field=value^field2=value2`). */
function applyTemplate(cur: Rec, template: string): void {
  const parsed = parseEncodedQuery(template);
  for (const block of parsed.blocks) {
    for (const cluster of block) {
      const c = cluster[0];
      if (c && c.op === '=' && cur.has(c.field)) cur.set(c.field, c.value);
    }
  }
}

function isDue(job: Rec, now: number): boolean {
  const start = parseGlideDateTime(job.str('run_start'))?.getTime() ?? null;
  if (start !== null && now < start) return false;
  const last = parseGlideDateTime(job.str('last_run'))?.getTime() ?? null;
  if (last === null) return true;
  const period = job.num('run_period') ?? 0;
  if (period <= 0) return false;
  return now >= last + period;
}
