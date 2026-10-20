import type { AppModule } from '../src/engine/module.js';
import { Platform } from '../src/engine/platform.js';
import { clock } from '../src/engine/util.js';
import { platformModule } from '../src/modules/platform/index.js';
import { taskModule } from '../src/modules/task/index.js';

export function bootPlatform(extra: AppModule[] = [], opts: { demo?: boolean } = {}): Platform {
  clock.reset();
  process.env.RESOLVRNOW_ADMIN_PASSWORD = 'admin-test-pw';
  const p = new Platform({
    dbFile: ':memory:',
    modules: [platformModule, taskModule, ...extra],
    strict: true,
    demo: opts.demo,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return p.boot();
}

/** Creates a user with the given roles (and optional group memberships) and returns its sys_id. */
export function makeUser(p: Platform, userName: string, roles: string[] = [], groups: string[] = []): string {
  const ctx = p.systemContext();
  const u = ctx.insert('sys_user', {
    user_name: userName,
    first_name: userName.split('.')[0] ?? userName,
    last_name: userName.split('.')[1] ?? 'User',
    email: `${userName}@example.com`,
    user_password: 'Password1!',
  });
  for (const r of roles) {
    let role = ctx.getBy('sys_user_role', 'name', r);
    if (!role) role = ctx.insert('sys_user_role', { name: r });
    ctx.insert('sys_user_has_role', { user: u.sysId, role: role.sysId });
  }
  for (const g of groups) {
    let group = ctx.getBy('sys_user_group', 'name', g);
    if (!group) group = ctx.insert('sys_user_group', { name: g });
    ctx.insert('sys_user_grmember', { user: u.sysId, group: group.sysId });
  }
  p.users.invalidate();
  return u.sysId;
}
