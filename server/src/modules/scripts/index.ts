import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { AppModule } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import { SERVICES } from '../contracts.js';
import { registerScriptsApi } from './api.js';
import { ScriptRuleLoader } from './rules.js';
import { sandboxEngine } from './sandbox.js';
import { ScriptRuntime } from './service.js';

export type { BackgroundResult, ScriptResult } from './service.js';
export { ScriptError, ScriptRuntime, truthy } from './service.js';

const loaders = new WeakMap<Platform, ScriptRuleLoader>();

function runtimeOf(platform: Platform): ScriptRuntime {
  return platform.service<ScriptRuntime>(SERVICES.scripts);
}

/**
 * Starts the sandbox worker ahead of the first script. Scripts start it on demand anyway; this
 * only moves the start-up cost (tests, server boot).
 */
export async function scriptsReady(): Promise<void> {
  sandboxEngine().start();
}

/** Sandboxed server-side scripting (GlideRecord-compatible API), business rule scripts, script includes, background scripts. */
export const scriptsModule: AppModule = {
  id: 'scripts',
  name: 'Scripting',
  description:
    'Sandboxed server-side scripting (GlideRecord-compatible API), business rule scripts, script includes, ACL scripts, scheduled and background scripts.',
  dependsOn: ['platform'],
  properties: [
    {
      name: 'resolvr.script.timeout_ms',
      value: '2000',
      type: 'integer',
      description:
        'Maximum run time of one server-side script, including the scripts it triggers (milliseconds)',
    },
    {
      name: 'resolvr.script.background_timeout_ms',
      value: '10000',
      type: 'integer',
      description: 'Maximum run time of a background script or scheduled script execution (milliseconds)',
    },
    {
      name: 'resolvr.script.memory_limit_mb',
      value: '32',
      type: 'integer',
      description: 'Memory available to a server-side script and the scripts it triggers (MB)',
    },
    {
      name: 'resolvr.script.max_rows',
      value: '10000',
      type: 'integer',
      description: 'Rows returned by a GlideRecord query that sets no limit',
    },
  ],
  jobs: [
    {
      id: 'scripts.scheduled',
      name: 'Run scheduled script executions',
      description: 'Runs active sysauto_script records whose repeat interval has elapsed',
      intervalMs: 60_000,
      run(ctx) {
        runtimeOf(ctx.platform).runDueScheduled();
      },
    },
  ],
  ui: {
    uiActions: [
      {
        id: 'sysauto_script.execute_now',
        table: 'sysauto_script',
        label: 'Execute Now',
        actionName: 'execute_now',
        roles: ['admin'],
        run(rec, ctx) {
          const result = runtimeOf(ctx.platform).runScheduled(rec);
          return result
            ? { message: `Scheduled script ${rec.str('name')} ran in ${result.durationMs} ms` }
            : { error: `Scheduled script ${rec.str('name')} failed; see the system log` };
        },
      },
    ],
  },
  register(platform) {
    const runtime = new ScriptRuntime(platform);
    const loader = new ScriptRuleLoader(platform, runtime);
    platform.services.set(SERVICES.scripts, runtime);
    loaders.set(platform, loader);
    platform.acl.scriptRunner = (script, rec, ctx) => runtime.acl(script, rec, ctx);
    platform.hooks.on(['insert', 'update'], 'sys_script', 'scripts.rules', (rec) => {
      loader.sync(rec);
    });
    platform.hooks.on('delete', 'sys_script', 'scripts.rules', (rec) => loader.remove(rec));
    platform.hooks.on(['insert', 'update', 'delete'], 'sys_script_include', 'scripts.includes', () =>
      runtime.invalidateIncludes(),
    );
  },
  afterBoot(platform) {
    loaders.get(platform)?.loadAll();
  },
  http(app, deps) {
    registerScriptsApi(app as FastifyInstance, deps as ApiDeps);
  },
};
