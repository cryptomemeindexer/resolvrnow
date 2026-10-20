import { createHash, randomBytes } from 'node:crypto';
import type { Context } from '../../engine/context.js';
import type { AppModule, RoleDef } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import { DYNAMIC_FILTERS } from '../../engine/query/macros.js';
import { hashPassword, isHashed } from '../../engine/services/password.js';
import { STORAGE } from '../../engine/types.js';
import { newSysId, nowGlide } from '../../engine/util.js';
import { seedDemoOrganization } from './demo.js';
import { platformTables } from './tables.js';

export const platformRoles: RoleDef[] = [
  { name: 'admin', description: 'Full administrative access to the platform' },
  { name: 'security_admin', description: 'Manages access controls', elevated: true },
  { name: 'user_admin', description: 'Manages users, groups and role assignments' },
  { name: 'snc_internal', description: 'Implicit role of every internal (employee) user' },
  { name: 'snc_external', description: 'External users (customers, partners)' },
  { name: 'itil', description: 'Service desk agent: works incidents, problems, changes and requests' },
  { name: 'itil_admin', description: 'ITIL administrator', contains: ['itil'] },
  { name: 'approver_user', description: 'Can approve records' },
  { name: 'report_user', description: 'Can create reports' },
  { name: 'report_admin', description: 'Administers reports and dashboards', contains: ['report_user'] },
  { name: 'rest_service', description: 'Integration account with REST access' },
];

/** Mirrors the code-defined schema into sys_db_object / sys_dictionary when it changes. */
function syncDictionary(platform: Platform): void {
  const tables = platform.registry.tables();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        tables.map((t) => [t.name, t.label, t.parent, [...t.columns.values()].filter((c) => c.definedOn === t.name).map((c) => [c.name, c.type, c.label, c.reference ?? '', c.maxLength ?? 0])]),
      ),
    )
    .digest('hex');
  if (platform.properties.get('resolvr.schema.fingerprint') === fingerprint) return;
  const db = platform.db;
  const now = nowGlide();
  db.tx(() => {
    const existingTables = new Map(
      db.all<{ sys_id: string; name: string }>(`SELECT "sys_id","name" FROM "sys_db_object"`).map((r) => [r.name, r.sys_id]),
    );
    for (const t of tables) {
      if (existingTables.has(t.name)) {
        db.run(`UPDATE "sys_db_object" SET "label" = ?, "is_extendable" = ?, "module" = ? WHERE "sys_id" = ?`, [
          t.label,
          t.extensible ? 1 : 0,
          t.def.module ?? null,
          existingTables.get(t.name)!,
        ]);
        continue;
      }
      const id = newSysId();
      existingTables.set(t.name, id);
      db.run(
        `INSERT INTO "sys_db_object" ("sys_id","sys_class_name","name","label","is_extendable","module","custom","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,0,?,?,?,?,0)`,
        [id, 'sys_db_object', t.name, t.label, t.extensible ? 1 : 0, t.def.module ?? null, now, 'system', now, 'system'],
      );
    }
    for (const t of tables) {
      if (t.parent) db.run(`UPDATE "sys_db_object" SET "super_class" = ? WHERE "name" = ?`, [existingTables.get(t.parent)!, t.name]);
    }
    const existingCols = new Set(
      db.all<{ k: string }>(`SELECT "name" || '.' || "element" AS k FROM "sys_dictionary"`).map((r) => r.k),
    );
    for (const t of tables) {
      for (const c of t.columns.values()) {
        if (c.definedOn !== t.name && !c.system) continue;
        if (c.system && t.parent) continue;
        const key = `${t.name}.${c.name}`;
        if (existingCols.has(key)) continue;
        db.run(
          `INSERT INTO "sys_dictionary" ("sys_id","sys_class_name","name","element","column_label","internal_type","max_length","reference","mandatory","read_only","default_value","active","display","dependent_on_field","choice","attributes","custom","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,0,?,?,?,?,0)`,
          [
            newSysId(),
            'sys_dictionary',
            t.name,
            c.name,
            c.label,
            c.type,
            c.maxLength ?? (STORAGE[c.type] === 'TEXT' ? 255 : null),
            c.reference ?? null,
            c.mandatory ? 1 : 0,
            c.readOnly ? 1 : 0,
            typeof c.defaultValue === 'function' ? null : (c.defaultValue ?? null) === null ? null : String(c.defaultValue),
            t.displayField === c.name ? 1 : 0,
            c.dependentOn ?? null,
            c.choiceMode === 'dropdown_with_none' ? 1 : c.choiceMode === 'dropdown_without_none' ? 3 : c.choices ? 1 : 0,
            c.attributes ? Object.entries(c.attributes).map(([k, v]) => `${k}=${v}`).join(',') : null,
            now,
            'system',
            now,
            'system',
          ],
        );
      }
    }
  });
  platform.properties.set('resolvr.schema.fingerprint', fingerprint);
}

/** Ensures a role exists and returns its sys_id. */
export function ensureRole(ctx: Context, def: RoleDef): string {
  const existing = ctx.getBy('sys_user_role', 'name', def.name);
  if (existing) return existing.sysId;
  return ctx.insert('sys_user_role', {
    name: def.name,
    description: def.description ?? '',
    elevated_privilege: !!def.elevated,
  }).sysId;
}

/** Creates roles from all modules and wires role containment. */
function seedRoles(platform: Platform, ctx: Context): void {
  const all = platform.modules.flatMap((m) => m.roles ?? []);
  const ids = new Map<string, string>();
  for (const r of all) ids.set(r.name, ensureRole(ctx, r));
  for (const r of all) {
    for (const c of r.contains ?? []) {
      const roleId = ids.get(r.name)!;
      const containsId = ids.get(c) ?? ensureRole(ctx, { name: c });
      const exists = ctx.first('sys_user_role_contains', `role=${roleId}^contains=${containsId}`);
      if (!exists) ctx.insert('sys_user_role_contains', { role: roleId, contains: containsId });
    }
  }
}

/**
 * Mirrors native ACLs into sys_security_acl so they are visible and can be deactivated. The
 * mirror is for display and the active flag only (enforcement reads roles from the code), but
 * it is kept faithful: missing roles are created, role lists follow the definitions and
 * mirrors of definitions that no longer exist are removed.
 */
function mirrorAcls(platform: Platform, ctx: Context): void {
  const defs = new Map(platform.acl.nativeDefs());
  const rows = platform.db.all<{ sys_id: string; native_id: string }>(
    `SELECT "sys_id","native_id" FROM "sys_security_acl" WHERE "native_id" IS NOT NULL`,
  );
  const mirrored = new Map<string, string>();
  for (const r of rows) {
    if (defs.has(r.native_id) && !mirrored.has(r.native_id)) {
      mirrored.set(r.native_id, r.sys_id);
      continue;
    }
    const stale = ctx.get('sys_security_acl', r.sys_id);
    if (stale) ctx.delete(stale);
  }
  const roleIds = new Map<string, string>();
  const roleId = (name: string) => {
    let id = roleIds.get(name);
    if (!id) {
      id = ensureRole(ctx, { name });
      roleIds.set(name, id);
    }
    return id;
  };
  for (const [id, def] of defs) {
    let aclId = mirrored.get(id);
    if (!aclId) {
      aclId = ctx.insert('sys_security_acl', {
        name: def.name,
        operation: def.operation,
        type: 'record',
        active: true,
        admin_overrides: def.adminOverrides ?? true,
        condition: def.condition ?? '',
        description: def.description ?? (def.script ? 'Native access check implemented in TypeScript' : ''),
        native_id: id,
      }).sysId;
    }
    const want = new Set((def.roles ?? []).map(roleId));
    const links = ctx.query('sys_security_acl_role', `sys_security_acl=${aclId}`);
    const have = new Set<string>();
    for (const link of links) {
      const role = link.str('sys_user_role');
      if (want.has(role) && !have.has(role)) have.add(role);
      else ctx.delete(link);
    }
    for (const role of want) {
      if (!have.has(role)) ctx.insert('sys_security_acl_role', { sys_security_acl: aclId, sys_user_role: role });
    }
  }
  platform.acl.invalidate();
}

/** Mirrors native business rules into sys_script and applies admin activation toggles. */
function mirrorRules(platform: Platform, ctx: Context): void {
  const rows = platform.db.all<{ native_id: string; active: number }>(
    `SELECT "native_id","active" FROM "sys_script" WHERE "native_id" IS NOT NULL`,
  );
  const known = new Map(rows.map((r) => [r.native_id, r.active]));
  for (const rule of platform.rules.all()) {
    if (rule.source !== 'native') continue;
    if (known.has(rule.id)) {
      platform.rules.setActive(rule.id, known.get(rule.id) !== 0);
      continue;
    }
    ctx.insert('sys_script', {
      name: rule.name,
      collection: rule.table,
      when: rule.when,
      order: rule.order,
      active: true,
      action_insert: rule.actions.includes('insert'),
      action_update: rule.actions.includes('update'),
      action_delete: rule.actions.includes('delete'),
      action_query: rule.actions.includes('query'),
      filter_condition: typeof rule.condition === 'string' ? rule.condition : '',
      description: rule.description ?? '',
      script: `// Native rule implemented in TypeScript (module ${rule.module ?? 'unknown'})`,
      native_id: rule.id,
      module: rule.module ?? '',
    });
  }
  platform.hooks.on('update', 'sys_script', 'rule-activation', (rec) => {
    const nid = rec.str('native_id');
    if (nid) platform.rules.setActive(nid, rec.bool('active'));
  });
}

export const platformModule: AppModule = {
  id: 'platform',
  name: 'Platform',
  description: 'Users, groups, roles, access control, dictionary, choices, numbering, audit, events and properties.',
  tables: platformTables,
  roles: platformRoles,
  properties: [
    { name: 'glide.product.name', value: 'ResolvrNow', description: 'Product name shown in the UI' },
    { name: 'glide.product.description', value: 'Open-source IT Service Management', description: 'Banner description' },
    { name: 'glide.sys.default.tz', value: 'UTC', description: 'Default system time zone' },
    { name: 'glide.ui.session_timeout', value: '480', type: 'integer', description: 'Session timeout in minutes' },
    { name: 'glide.rest.query.max_limit', value: '10000', type: 'integer', description: 'Maximum sysparm_limit for REST queries' },
    { name: 'glide.invalid_query.returns_no_rows', value: 'false', type: 'boolean', description: 'Invalid encoded query terms return no rows instead of being ignored' },
    { name: 'resolvr.password.min_length', value: '8', type: 'integer', description: 'Minimum password length' },
  ],
  acls: [
    // Reference data readable by every internal user
    ...['sys_user', 'sys_user_group', 'sys_user_grmember', 'sys_user_role', 'core_company', 'cmn_location', 'cmn_department', 'cmn_cost_center', 'cmn_building', 'sys_choice', 'sys_filter_option_dynamic', 'sys_user_group_type'].map(
      (name) => ({ name, operation: 'read' as const, roles: ['snc_internal'] }),
    ),
    { name: 'sys_user.user_password', operation: 'read', roles: ['security_admin'], adminOverrides: false, description: 'Password hashes are never readable' },
    { name: 'sys_user.mfa_secret', operation: 'read', roles: ['security_admin'], adminOverrides: false },
    ...['sys_user', 'sys_user_group', 'sys_user_grmember', 'sys_user_has_role', 'sys_group_has_role'].flatMap((name) =>
      (['write', 'create', 'delete'] as const).map((operation) => ({ name, operation, roles: ['user_admin'] })),
    ),
    { name: 'sys_user_has_role', operation: 'read', roles: ['user_admin'] },
    { name: 'sys_group_has_role', operation: 'read', roles: ['user_admin'] },
    { name: 'sys_user', operation: 'write', condition: 'sys_id=javascript:gs.getUserID()', description: 'Users can update their own profile' },
    ...(['user_name', 'roles', 'active', 'locked_out', 'vip', 'web_service_access_only', 'internal_integration_user'] as const).map((f) => ({
      name: `sys_user.${f}`,
      operation: 'write' as const,
      roles: ['user_admin'],
    })),
    ...(['read', 'write', 'create', 'delete'] as const).map((operation) => ({
      name: 'sys_user_preference',
      operation,
      condition: 'user=javascript:gs.getUserID()',
    })),
    ...(['read', 'write', 'create', 'delete'] as const).map((operation) => ({
      name: 'sys_api_token',
      operation,
      condition: 'user=javascript:gs.getUserID()',
    })),
    {
      name: 'sys_attachment',
      operation: 'read',
      script: (rec, ctx) => !rec || !!ctx.get(rec.str('table_name'), rec.str('table_sys_id')),
      description: 'Attachments follow the read access of the record they belong to',
    },
    {
      name: 'sys_attachment',
      operation: 'create',
      script: (rec, ctx) => {
        if (!rec) return true;
        const parent = ctx.get(rec.str('table_name'), rec.str('table_sys_id'));
        return !!parent;
      },
    },
    {
      name: 'sys_attachment',
      operation: 'delete',
      script: (rec, ctx) => !!rec && (rec.str('sys_created_by') === ctx.user.userName || ctx.hasRole('itil')),
    },
  ],
  rules: [
    {
      name: 'Derive user full name and hash password',
      table: 'sys_user',
      when: 'before',
      actions: ['insert', 'update'],
      order: 50,
      run(cur) {
        if (cur.changed('first_name') || cur.changed('last_name') || cur.changed('middle_name') || !cur.str('name')) {
          const full = [cur.str('first_name'), cur.str('middle_name'), cur.str('last_name')].filter(Boolean).join(' ');
          if (full) cur.setRaw('name', full);
          else if (!cur.str('name')) cur.setRaw('name', cur.str('user_name'));
        }
        const pw = cur.str('user_password');
        if (pw && !isHashed(pw)) cur.setRaw('user_password', hashPassword(pw));
      },
    },
    {
      name: 'Prevent duplicate user name',
      table: 'sys_user',
      when: 'before',
      actions: ['insert', 'update'],
      order: 60,
      condition: (cur) => cur.changed('user_name'),
      run(cur, _prev, ctx) {
        const name = cur.str('user_name');
        if (!name) return;
        const dup = ctx.platform.db.get(`SELECT "sys_id" FROM "sys_user" WHERE "user_name" = ? COLLATE NOCASE AND "sys_id" <> ?`, [
          name,
          cur.sysId,
        ]);
        if (dup) cur.abort(`User name '${name}' is already in use`);
      },
    },
    {
      name: 'Prevent duplicate group membership',
      table: 'sys_user_grmember',
      when: 'before',
      actions: ['insert'],
      run(cur, _prev, ctx) {
        const dup = ctx.platform.db.get(`SELECT "sys_id" FROM "sys_user_grmember" WHERE "user" = ? AND "group" = ?`, [
          cur.str('user'),
          cur.str('group'),
        ]);
        if (dup) cur.abort('User is already a member of this group');
      },
    },
    {
      name: 'Validate choice',
      table: 'sys_choice',
      when: 'before',
      actions: ['insert', 'update'],
      run(cur) {
        if (!cur.str('label')) cur.setRaw('label', cur.str('value'));
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'user_admin',
        title: 'User Administration',
        icon: 'users',
        roles: ['user_admin', 'admin'],
        order: 900,
        modules: [
          { title: 'Users', table: 'sys_user' },
          { title: 'Groups', table: 'sys_user_group' },
          { title: 'Roles', table: 'sys_user_role' },
          { title: 'Locations', table: 'cmn_location' },
          { title: 'Departments', table: 'cmn_department' },
          { title: 'Companies', table: 'core_company' },
        ],
      },
      {
        id: 'system_definition',
        title: 'System Definition',
        icon: 'database',
        roles: ['admin'],
        order: 950,
        modules: [
          { title: 'Tables', table: 'sys_db_object' },
          { title: 'Dictionary', table: 'sys_dictionary' },
          { title: 'Choice Lists', table: 'sys_choice' },
          { title: 'Business Rules', table: 'sys_script' },
          { title: 'Script Includes', table: 'sys_script_include' },
          { title: 'UI Actions', table: 'sys_ui_action' },
          { title: 'Access Control (ACL)', table: 'sys_security_acl' },
          { title: 'Number Maintenance', table: 'sys_number' },
          { title: 'System Properties', table: 'sys_properties' },
          { title: 'Scheduled Jobs', table: 'sysauto_script' },
          { title: 'Scripts - Background', route: '/workspace/admin/scripts' },
        ],
      },
      {
        id: 'system_logs',
        title: 'System Logs',
        icon: 'scroll',
        roles: ['admin'],
        order: 960,
        modules: [
          { title: 'System Log', table: 'syslog', query: 'ORDERBYDESCsys_created_on' },
          { title: 'Events', table: 'sysevent', query: 'ORDERBYDESCsys_created_on' },
          { title: 'Audit History', table: 'sys_audit', query: 'ORDERBYDESCsys_created_on' },
          { title: 'Journal Entries', table: 'sys_journal_field', query: 'ORDERBYDESCsys_created_on' },
        ],
      },
    ],
    forms: [
      {
        table: 'sys_user',
        sections: [
          {
            left: ['user_name', 'first_name', 'last_name', 'title', 'department', 'company', 'manager'],
            right: ['email', 'phone', 'mobile_phone', 'location', 'time_zone', 'active', 'locked_out', 'vip'],
          },
          { caption: 'Security', fields: ['user_password', 'password_needs_reset', 'web_service_access_only', 'internal_integration_user'] },
        ],
        relatedLists: [
          { table: 'sys_user_grmember', field: 'user', label: 'Groups', columns: ['group'] },
          { table: 'sys_user_has_role', field: 'user', label: 'Roles', columns: ['role', 'inherited', 'state'] },
        ],
      },
      {
        table: 'sys_user_group',
        sections: [{ left: ['name', 'manager', 'parent', 'email'], right: ['type', 'active', 'default_assignee', 'cost_center'] }, { fields: ['description'] }],
        relatedLists: [
          { table: 'sys_user_grmember', field: 'group', label: 'Group Members', columns: ['user'] },
          { table: 'sys_group_has_role', field: 'group', label: 'Roles', columns: ['role', 'inherits'] },
          { table: 'sys_user_group', field: 'parent', label: 'Child Groups', columns: ['name', 'manager'] },
        ],
      },
    ],
    lists: [
      { table: 'sys_user', columns: ['user_name', 'name', 'email', 'title', 'department', 'location', 'active'] },
      { table: 'sys_user_group', columns: ['name', 'manager', 'parent', 'email', 'active'] },
      { table: 'sys_choice', columns: ['name', 'element', 'value', 'label', 'sequence', 'dependent_value', 'inactive'] },
      { table: 'sys_dictionary', columns: ['name', 'element', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory'] },
      { table: 'sys_script', columns: ['name', 'collection', 'when', 'order', 'active', 'action_insert', 'action_update', 'module'] },
      { table: 'sys_security_acl', columns: ['name', 'operation', 'type', 'active', 'admin_overrides', 'description'] },
    ],
  },
  register(platform) {
    platform.hooks.on(['insert', 'update', 'delete'], 'sys_dictionary', 'dictionary-change', () => {
      /* runtime dictionary changes are applied by the admin API (schema service) */
    });
  },
  afterBoot(platform) {
    syncPlatformMetadata(platform);
  },
  demo(ctx) {
    seedDemoOrganization(ctx);
  },
  seedVersion: 1,
  seed(ctx) {
    const platform = ctx.platform;
    syncDictionary(platform);
    seedRoles(platform, ctx);
    // Dynamic filter options with their well-known identifiers
    for (const [id, f] of Object.entries(DYNAMIC_FILTERS)) {
      if (!ctx.get('sys_filter_option_dynamic', id)) {
        ctx.insert('sys_filter_option_dynamic', {
          sys_id: id,
          label: f.label,
          script: f.script.replace(/^javascript:/, ''),
          active: true,
          available_for_filter: true,
          available_for_default: true,
          available_for_ref_qual: true,
          field_type: 'reference',
          table: 'sys_user',
        });
      }
    }
    // Initial administrator
    if (!ctx.first('sys_user', 'user_name=admin')) {
      const password = process.env.RESOLVRNOW_ADMIN_PASSWORD || generatePassword();
      const admin = ctx.insert('sys_user', {
        user_name: 'admin',
        first_name: 'System',
        last_name: 'Administrator',
        email: 'admin@example.com',
        user_password: password,
        active: true,
      });
      const adminRole = ctx.getBy('sys_user_role', 'name', 'admin')!;
      ctx.insert('sys_user_has_role', { user: admin.sysId, role: adminRole.sysId });
      if (!process.env.RESOLVRNOW_ADMIN_PASSWORD) {
        platform.log.info(`[resolvrnow] Created user 'admin' with initial password: ${password}  (set RESOLVRNOW_ADMIN_PASSWORD to choose one)`);
        platform.services.set('initialAdminPassword', password);
      }
    }
  },
};

/** Runs on every boot (not just on seed) so new modules get mirrored. */
export function syncPlatformMetadata(platform: Platform): void {
  const ctx = platform.systemContext();
  syncDictionary(platform);
  seedRoles(platform, ctx);
  mirrorAcls(platform, ctx);
  mirrorRules(platform, ctx);
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
