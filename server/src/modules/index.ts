import type { AppModule } from '../engine/module.js';
import { platformModule } from './platform/index.js';
import { taskModule } from './task/index.js';
import { scriptsModule } from './scripts/index.js';
import { notificationsModule } from './notifications/index.js';
import { approvalsModule } from './approvals/index.js';
import { schedulesModule } from './schedules/index.js';
import { slaModule } from './sla/index.js';
import { cmdbModule } from './cmdb/index.js';
import { assetModule } from './asset/index.js';
import { flowModule } from './flow/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { incidentModule } from './incident/index.js';
import { problemModule } from './problem/index.js';
import { changeModule } from './change/index.js';
import { catalogModule } from './catalog/index.js';
import { oncallModule } from './oncall/index.js';
import { portalModule } from './portal/index.js';
import { aiModule } from './ai/index.js';
import { analyticsModule } from './analytics/index.js';

/**
 * Installed modules. The platform sorts them by `dependsOn`; ITSM applications each live
 * in their own folder under src/modules.
 */
export const ALL_MODULES: AppModule[] = [
  platformModule, taskModule, scriptsModule, notificationsModule, approvalsModule, schedulesModule, slaModule, cmdbModule, assetModule, flowModule, knowledgeModule, incidentModule, problemModule, changeModule, catalogModule, oncallModule, portalModule, aiModule, analyticsModule,
];

/**
 * Modules to boot: all by default, or the comma-separated ids in RESOLVRNOW_MODULES
 * (their dependencies are added automatically).
 */
export function selectModules(spec: string | undefined = process.env.RESOLVRNOW_MODULES): AppModule[] {
  if (!spec?.trim()) return ALL_MODULES;
  const byId = new Map(ALL_MODULES.map((m) => [m.id, m]));
  const wanted = new Set<string>();
  const add = (id: string) => {
    const m = byId.get(id);
    if (!m) throw new Error(`Unknown module ${id}`);
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const d of m.dependsOn ?? []) add(d);
  };
  for (const id of spec.split(',').map((s) => s.trim()).filter(Boolean)) add(id);
  add('platform');
  return ALL_MODULES.filter((m) => wanted.has(m.id));
}
