import { Context } from './context.js';
import { Database } from './db.js';
import type {
  AppModule,
  FormLayoutDef,
  ListLayoutDef,
  NavApplicationDef,
  UiActionDef,
  UiPolicyDef,
} from './module.js';
import { SchemaRegistry } from './registry.js';
import { RuleRegistry } from './rules.js';
import { AclService } from './services/acl.js';
import { ChoiceService } from './services/choices.js';
import { EventService } from './services/events.js';
import { HistoryService } from './services/history.js';
import { HookBus } from './services/hooks.js';
import { NumberService } from './services/numbers.js';
import { isHashed, verifyPassword } from './services/password.js';
import { PropertyService } from './services/properties.js';
import { Scheduler } from './services/scheduler.js';
import { SYSTEM_USER, type SessionUser, UserService } from './services/users.js';
import { newSysId, nowGlide } from './util.js';

export interface PlatformOptions {
  /** SQLite file path or ':memory:'. */
  dbFile: string;
  modules: AppModule[];
  /** Load demo data on first boot. */
  demo?: boolean;
  /** Throw instead of logging errors raised inside hooks/rules (tests). */
  strict?: boolean;
  /** Process events/async work automatically (server mode). */
  autoProcess?: boolean;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface PlatformError {
  where: string;
  message: string;
  at: string;
}

/** Wires the engine services together and boots the installed modules. */
export class Platform {
  readonly registry = new SchemaRegistry();
  readonly db: Database;
  readonly rules: RuleRegistry;
  readonly choices: ChoiceService;
  readonly numbers: NumberService;
  readonly history: HistoryService;
  readonly hooks = new HookBus();
  readonly properties: PropertyService;
  readonly users: UserService;
  readonly acl: AclService;
  readonly events: EventService;
  readonly scheduler: Scheduler;
  readonly modules: AppModule[];
  readonly errors: PlatformError[] = [];
  readonly navigation: NavApplicationDef[] = [];
  readonly forms = new Map<string, FormLayoutDef>();
  readonly lists = new Map<string, ListLayoutDef>();
  readonly uiActions = new Map<string, UiActionDef>();
  readonly uiPolicies: UiPolicyDef[] = [];
  /** Extension point for services contributed by modules (sla, approvals, flows, ai...). */
  readonly services = new Map<string, unknown>();
  /** Roles that admin does not imply (e.g. security_admin). */
  readonly elevatedRoles = new Set<string>();
  private asyncQueue: { key: string; fn: () => void }[] = [];
  private workScheduled = false;
  private booted = false;
  readonly log: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(readonly options: PlatformOptions) {
    this.db = new Database(options.dbFile);
    this.rules = new RuleRegistry(this.registry);
    this.choices = new ChoiceService(this.db, this.registry);
    this.numbers = new NumberService(this.db, this.registry);
    this.history = new HistoryService(this.db, this.registry);
    this.properties = new PropertyService(this.db, this.registry);
    this.users = new UserService(this.db, this.registry);
    this.acl = new AclService(this.db, this.registry);
    this.events = new EventService(this);
    this.scheduler = new Scheduler(this);
    this.modules = sortModules(options.modules);
    this.log = options.logger ?? console;
  }

  service<T>(name: string): T {
    const s = this.services.get(name);
    if (!s) throw new Error(`Service ${name} is not installed`);
    return s as T;
  }

  boot(): this {
    if (this.booted) return this;
    // 1. Schema
    for (const m of this.modules) {
      for (const t of m.tables ?? []) this.registry.define({ ...t, module: t.module ?? m.id });
    }
    for (const m of this.modules) {
      for (const [key, defs] of Object.entries(m.choices ?? {})) {
        const [table, field] = key.split('.');
        if (!this.registry.has(table)) continue;
        const def = this.registry.definitions().find((d) => d.name === table)!;
        def.overrides = { ...(def.overrides ?? {}), [field]: { ...(def.overrides?.[field] ?? {}), choices: defs } };
      }
    }
    this.registry.finalize();
    this.db.syncSchema(this.registry);

    // 2. Logic registration
    for (const m of this.modules) {
      for (const p of m.properties ?? []) this.properties.define(p);
      for (const r of m.roles ?? []) if (r.elevated) this.elevatedRoles.add(r.name);
      for (const r of m.rules ?? []) this.rules.add({ ...r, module: r.module ?? m.id });
      for (const a of m.acls ?? []) this.acl.defineNative({ ...a, module: a.module ?? m.id });
      for (const e of m.events ?? []) this.events.register(e.name, e.table, e.description);
      for (const h of m.eventHandlers ?? []) this.events.on(h);
      for (const j of m.jobs ?? []) this.scheduler.define({ ...j, module: j.module ?? m.id });
      if (m.ui) {
        this.navigation.push(...(m.ui.navigation ?? []));
        for (const f of m.ui.forms ?? []) this.forms.set(`${f.table}:${f.view ?? 'default'}`, f);
        for (const l of m.ui.lists ?? []) this.lists.set(`${l.table}:${l.view ?? 'default'}`, l);
        for (const a of m.ui.uiActions ?? []) this.uiActions.set(a.id, a);
        this.uiPolicies.push(...(m.ui.uiPolicies ?? []));
      }
    }
    this.registerCacheHooks();
    for (const m of this.modules) m.register?.(this);

    // 3. Data seeding
    this.choices.seed();
    this.numbers.seed();
    this.properties.seed();
    const ctx = this.systemContext();
    for (const m of this.modules) {
      const key = `resolvr.seed.${m.id}`;
      const version = String(m.seedVersion ?? 1);
      if (m.seed && this.properties.get(key) !== version) {
        this.db.tx(() => {
          m.seed!(ctx);
          this.properties.set(key, version);
        });
      }
    }
    for (const m of this.modules) m.afterBoot?.(this);
    if (this.options.demo && this.properties.get('resolvr.demo.loaded') !== 'true') {
      this.db.tx(() => {
        for (const m of this.modules) m.demo?.(ctx);
        this.properties.set('resolvr.demo.loaded', 'true');
      });
      this.drain();
    }
    this.booted = true;
    return this;
  }

  private registerCacheHooks(): void {
    const ev = ['insert', 'update', 'delete'] as const;
    this.hooks.on([...ev], 'sys_choice', 'choices-cache', () => this.choices.invalidate());
    for (const t of ['sys_user', 'sys_user_group', 'sys_user_grmember', 'sys_user_role', 'sys_user_has_role', 'sys_group_has_role', 'sys_user_role_contains'])
      this.hooks.on([...ev], t, 'users-cache', () => this.users.invalidate());
    for (const t of ['sys_security_acl', 'sys_security_acl_role'])
      this.hooks.on([...ev], t, 'acl-cache', () => this.acl.invalidate());
    this.hooks.on([...ev], 'sys_properties', 'properties-cache', () => this.properties.invalidate());
  }

  // ------------------------------------------------------------- contexts

  systemContext(): Context {
    return new Context(this, SYSTEM_USER);
  }

  contextFor(user: SessionUser | null): Context {
    return new Context(this, user ?? SYSTEM_USER);
  }

  /** Context for a user by sys_id or user_name. */
  contextAs(userIdOrName: string): Context {
    const s = /^[0-9a-f]{32}$/.test(userIdOrName) ? this.users.session(userIdOrName) : this.users.byUserName(userIdOrName);
    if (!s) throw new Error(`Unknown user ${userIdOrName}`);
    return new Context(this, s);
  }

  /** Verifies credentials and returns the session user (null on failure). */
  authenticate(userName: string, password: string): SessionUser | null {
    if (!this.registry.has('sys_user')) return null;
    const row = this.db.get<{ sys_id: string; user_password: string | null; active: number | null; locked_out: number | null; failed_attempts: number | null }>(
      `SELECT "sys_id","user_password","active","locked_out","failed_attempts" FROM "sys_user" WHERE "user_name" = ? COLLATE NOCASE`,
      [userName],
    );
    if (!row || row.active === 0 || row.locked_out === 1) return null;
    if (!isHashed(row.user_password) || !verifyPassword(password, row.user_password)) {
      this.db.run(`UPDATE "sys_user" SET "failed_attempts" = COALESCE("failed_attempts",0) + 1 WHERE "sys_id" = ?`, [row.sys_id]);
      return null;
    }
    this.db.run(`UPDATE "sys_user" SET "failed_attempts" = 0, "last_login_time" = ? WHERE "sys_id" = ?`, [nowGlide(), row.sys_id]);
    return this.users.session(row.sys_id);
  }

  // ------------------------------------------------------------- async work

  enqueueAsync(key: string, fn: () => void): void {
    this.asyncQueue.push({ key, fn });
    this.scheduleWork();
  }

  scheduleWork(): void {
    if (!this.options.autoProcess || this.workScheduled) return;
    this.workScheduled = true;
    setImmediate(() => {
      this.workScheduled = false;
      try {
        this.drain();
      } catch (e) {
        this.reportError('async work', e);
      }
    });
  }

  /** Runs queued async business rules and processes ready events until idle. */
  drain(maxRounds = 20): void {
    for (let round = 0; round < maxRounds; round++) {
      const batch = this.asyncQueue.splice(0);
      for (const item of batch) {
        try {
          this.db.tx(item.fn);
        } catch (e) {
          this.reportError(`async ${item.key}`, e);
        }
      }
      const processed = this.events.process();
      if (batch.length === 0 && processed === 0) return;
    }
  }

  reportError(where: string, e: unknown): void {
    const message = e instanceof Error ? `${e.message}` : String(e);
    this.errors.push({ where, message, at: nowGlide() });
    if (this.errors.length > 500) this.errors.splice(0, this.errors.length - 500);
    if (this.options.strict) throw e instanceof Error ? e : new Error(message);
    this.log.error(`[resolvrnow] ${where}: ${message}`);
    if (this.registry.has('syslog')) {
      try {
        this.db.run(
          `INSERT INTO "syslog" ("sys_id","sys_class_name","level","source","message","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,0)`,
          [newSysId(), 'syslog', 'error', where.slice(0, 100), message.slice(0, 4000), nowGlide(), 'system', nowGlide(), 'system'],
        );
      } catch {
        /* logging must never throw */
      }
    }
  }

  start(): void {
    this.scheduler.start();
  }

  close(): void {
    this.scheduler.stop();
    this.db.close();
  }
}

function sortModules(mods: AppModule[]): AppModule[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const out: AppModule[] = [];
  const seen = new Set<string>();
  const visit = (m: AppModule, stack: string[]) => {
    if (seen.has(m.id)) return;
    if (stack.includes(m.id)) throw new Error(`Module dependency cycle: ${[...stack, m.id].join(' -> ')}`);
    for (const d of m.dependsOn ?? []) {
      const dep = byId.get(d);
      if (!dep) throw new Error(`Module ${m.id} depends on missing module ${d}`);
      visit(dep, [...stack, m.id]);
    }
    seen.add(m.id);
    out.push(m);
  };
  for (const m of mods) visit(m, []);
  return out;
}
