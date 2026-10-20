import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { quoteIdent } from '../../engine/util.js';
import { cmdbEngine } from './graph.js';
import { applyClassChange, classPath } from './reclassify.js';
import { coupleCiStatus, INSTALL } from './status.js';

// ------------------------------------------------------------ helpers

function duplicateOf(ctx: Context, table: string, cur: Rec, fields: string[]): boolean {
  const where = fields.map((f) => `${quoteIdent(f)} = ?`).join(' AND ');
  const row = ctx.platform.db.get(
    `SELECT "sys_id" FROM ${quoteIdent(table)} WHERE ${where} AND "sys_id" <> ?`,
    [...fields.map((f) => cur.str(f)), cur.sysId],
  );
  return !!row;
}

/** Before rule rejecting a second row with the same values in the given fields. */
function uniqueRule(table: string, fields: string[], message: string): BusinessRuleDef {
  return {
    name: `CMDB: unique ${table}`,
    table,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    condition: (cur) => cur.isNew() || fields.some((f) => cur.changed(f)),
    run(cur, _prev, ctx) {
      if (duplicateOf(ctx, table, cur, fields)) cur.abort(message);
    },
  };
}

function serviceClassification(cur: Rec, ctx: Context): string {
  const isA = (base: string) => ctx.registry.isA(cur.className, base);
  if (isA('service_offering')) {
    const parent = cur.str('parent');
    const parentClass = parent
      ? ctx.platform.db.get<{ c: string }>(`SELECT "sys_class_name" AS c FROM "cmdb" WHERE "sys_id" = ?`, [
          parent,
        ])?.c
      : undefined;
    return parentClass && ctx.registry.isA(parentClass, 'cmdb_ci_service_technical')
      ? 'Technical Service'
      : 'Service Offering';
  }
  if (isA('cmdb_ci_service_technical')) return 'Technical Service';
  if (isA('cmdb_ci_service_auto')) return 'Application Service';
  return 'Business Service';
}

// ------------------------------------------------- dependent CI cascade

interface MetaRule {
  parent_type: string;
  rel_type: string;
  child_type: string;
}

function metaRules(ctx: Context, table: string): MetaRule[] {
  return ctx.platform.db.all<MetaRule>(
    `SELECT "parent_type","rel_type","child_type" FROM ${quoteIdent(table)} WHERE "active" IS NULL OR "active" = 1`,
  );
}

interface Dependent {
  ci: string;
  type: string;
  /** Column of cmdb_rel_ci holding the dependent CI. */
  side: 'parent' | 'child';
}

/** CIs hosted on or contained in a CI (they cannot exist without it). */
function dependentsOf(ctx: Context, ci: Rec): Dependent[] {
  const out: Dependent[] = [];
  const isA = (cls: string, base: string) => ctx.registry.isA(cls, base);
  const rels = ctx.platform.db.all<{ parent: string; child: string; type: string; pc: string; cc: string }>(
    `SELECT r."parent", r."child", r."type", p."sys_class_name" AS pc, c."sys_class_name" AS cc
     FROM "cmdb_rel_ci" r JOIN "cmdb" p ON p."sys_id" = r."parent" JOIN "cmdb" c ON c."sys_id" = r."child"
     WHERE r."parent" = ? OR r."child" = ?`,
    [ci.sysId, ci.sysId],
  );
  const hosting = metaRules(ctx, 'cmdb_metadata_hosting');
  const containment = metaRules(ctx, 'cmdb_metadata_containment');
  for (const r of rels) {
    if (
      r.child === ci.sysId &&
      hosting.some((h) => h.rel_type === r.type && isA(r.pc, h.parent_type) && isA(r.cc, h.child_type))
    ) {
      out.push({ ci: r.parent, type: r.type, side: 'parent' });
    }
    if (
      r.parent === ci.sysId &&
      containment.some((c) => c.rel_type === r.type && isA(r.pc, c.parent_type) && isA(r.cc, c.child_type))
    ) {
      out.push({ ci: r.child, type: r.type, side: 'child' });
    }
  }
  return out;
}

const pendingDependents = new WeakMap<Rec, Dependent[]>();

function cascadeDependents(ctx: Context, deleted: Rec): void {
  const props = ctx.platform.properties;
  const remove = props.getBool('cmdb.dependent.ci.cascade.op.enabled', true);
  const retire = props.getBool('cmdb.dependent.ci.cascade.retire.enabled', false);
  if (!remove && !retire) return;
  const sys = ctx.elevated();
  for (const dep of pendingDependents.get(deleted) ?? []) {
    const stillHosted = ctx.platform.db.get(
      `SELECT "sys_id" FROM "cmdb_rel_ci" WHERE ${quoteIdent(dep.side)} = ? AND "type" = ?`,
      [dep.ci, dep.type],
    );
    if (stillHosted) continue;
    const rec = sys.get('cmdb', dep.ci);
    if (!rec) continue;
    if (remove) sys.delete(rec);
    else if (rec.num('install_status') !== INSTALL.RETIRED)
      sys.update(rec, { install_status: INSTALL.RETIRED });
  }
}

// ---------------------------------------------- metadata rule validation

function validateMetadata(cur: Rec, ctx: Context): void {
  const hosting = metaRules(ctx, 'cmdb_metadata_hosting');
  const containment = metaRules(ctx, 'cmdb_metadata_containment');
  const parent = cur.str('parent_type');
  const child = cur.str('child_type');
  for (const t of [parent, child]) {
    if (!ctx.registry.isA(t, 'cmdb_ci')) {
      cur.abort(`${t} is not a configuration item class`);
      return;
    }
  }
  if (cur.className === 'cmdb_metadata_hosting') {
    if (containment.some((c) => c.child_type === parent)) {
      cur.abort(`${parent} is a containment child and cannot be hosted`);
      return;
    }
    if (containment.some((c) => c.child_type === child)) {
      cur.abort(`${child} is a containment child and cannot be a host`);
      return;
    }
    if (hosting.some((h) => h.parent_type === child && h.child_type === parent)) {
      cur.abort('Hosting rules cannot form a loop');
      return;
    }
    return;
  }
  if (hosting.some((h) => h.parent_type === child)) {
    cur.abort(`${child} is hosted and cannot be a containment child`);
    return;
  }
  if (cur.str('root_type') && containment.some((c) => c.child_type === cur.str('root_type'))) {
    cur.abort('A containment child cannot be a containment root');
    return;
  }
}

// ---------------------------------------------------------- the rules

export const cmdbRules: BusinessRuleDef[] = [
  {
    name: 'CMDB: reclassify on class change',
    table: 'cmdb',
    when: 'before',
    actions: ['update'],
    order: 5,
    condition: (cur) => cur.changed('sys_class_name'),
    run(cur, _prev, ctx) {
      applyClassChange(cur, ctx.registry);
    },
  },
  {
    name: 'CMDB: maintain class path',
    table: 'cmdb',
    when: 'before',
    actions: ['insert', 'update'],
    order: 6,
    condition: (cur) => cur.isNew() || cur.changed('sys_class_name') || !cur.str('sys_class_path'),
    run(cur, _prev, ctx) {
      cur.setRaw('sys_class_path', classPath(ctx.registry, cur.str('sys_class_name') || cur.className));
    },
  },
  {
    name: 'CMDB: couple status and operational status',
    table: 'cmdb_ci',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur, _prev, ctx) {
      coupleCiStatus(cur, ctx);
    },
  },
  {
    name: 'CMDB: a CI cannot be its own duplicate',
    table: 'cmdb_ci',
    when: 'before',
    actions: ['insert', 'update'],
    order: 60,
    condition: (cur) => cur.changed('duplicate_of') && cur.str('duplicate_of') === cur.sysId,
    run(cur) {
      cur.setRaw('duplicate_of', null);
    },
  },
  {
    name: 'CMDB: derive service classification',
    table: 'cmdb_ci_service',
    when: 'before',
    actions: ['insert'],
    order: 20,
    condition: (cur) => !cur.touched.has('service_classification'),
    run(cur, _prev, ctx) {
      cur.setRaw('service_classification', serviceClassification(cur, ctx));
    },
  },
  {
    name: 'CMDB: collect dependent CIs before delete',
    table: 'cmdb_ci',
    when: 'before',
    actions: ['delete'],
    order: 100,
    run(cur, _prev, ctx) {
      pendingDependents.set(cur, dependentsOf(ctx, cur));
    },
  },
  {
    name: 'CMDB: cascade orphan dependent CIs',
    table: 'cmdb_ci',
    when: 'after',
    actions: ['delete'],
    order: 100,
    run(cur, _prev, ctx) {
      cascadeDependents(ctx, cur);
    },
  },
  {
    name: 'CMDB: validate relationship',
    table: 'cmdb_rel_ci',
    when: 'before',
    actions: ['insert', 'update'],
    order: 10,
    run(cur, _prev, ctx) {
      if (!cur.str('parent') || !cur.str('child') || !cur.str('type')) {
        cur.abort('Parent, child and type are mandatory');
        return;
      }
      if (cur.str('parent') === cur.str('child')) {
        cur.abort('A CI cannot be related to itself');
        return;
      }
      const dup = ctx.platform.db.get(
        `SELECT "sys_id" FROM "cmdb_rel_ci" WHERE "parent" = ? AND "child" = ? AND "type" = ? AND COALESCE("port", '') = ? AND "sys_id" <> ?`,
        [cur.str('parent'), cur.str('child'), cur.str('type'), cur.str('port'), cur.sysId],
      );
      if (dup) cur.abort('This relationship already exists');
    },
  },
  {
    name: 'CMDB: relationship type name from descriptors',
    table: 'cmdb_rel_type',
    when: 'before',
    actions: ['insert', 'update'],
    order: 10,
    run(cur) {
      const p = cur.str('parent_descriptor');
      const c = cur.str('child_descriptor');
      if (p && c) {
        cur.setRaw('name', `${p}::${c}`);
        return;
      }
      const [pd, cd] = cur.str('name').split('::');
      if (pd && cd) {
        cur.setRaw('parent_descriptor', pd.trim());
        cur.setRaw('child_descriptor', cd.trim());
      } else cur.abort('Relationship type needs a parent and a child descriptor');
    },
  },
  {
    name: 'CMDB: validate hosting and containment rules',
    table: 'cmdb_metadata_hosting',
    when: 'before',
    actions: ['insert', 'update'],
    run: (cur, _prev, ctx) => validateMetadata(cur, ctx),
  },
  {
    name: 'CMDB: validate hosting and containment rules',
    table: 'cmdb_metadata_containment',
    when: 'before',
    actions: ['insert', 'update'],
    run: (cur, _prev, ctx) => validateMetadata(cur, ctx),
  },
  {
    name: 'CMDB: model display name',
    table: 'cmdb_model',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    condition: (cur) =>
      cur.isNew() || cur.changed('name') || cur.changed('manufacturer') || !cur.str('display_name'),
    run(cur) {
      const maker = cur.display('manufacturer');
      const name = cur.str('name');
      cur.setRaw(
        'display_name',
        maker && !name.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${name}` : name,
      );
    },
  },
  {
    name: 'CMDB: add primary CI to affected CIs',
    table: 'task',
    when: 'after',
    actions: ['insert', 'update'],
    order: 500,
    condition: (cur) => cur.changed('cmdb_ci') && !!cur.str('cmdb_ci'),
    run(cur, _prev, ctx) {
      cmdbEngine(ctx.platform).addAffectedCi(ctx.elevated(), cur, cur.str('cmdb_ci'));
    },
  },
  uniqueRule('task_ci', ['task', 'ci_item'], 'This CI is already an affected CI of the task'),
  uniqueRule(
    'task_cmdb_ci_service',
    ['task', 'cmdb_ci_service'],
    'This service is already impacted by the task',
  ),
  uniqueRule(
    'task_service_offering',
    ['task', 'service_offering'],
    'This offering is already linked to the task',
  ),
  uniqueRule('svc_ci_assoc', ['service_id', 'ci_id'], 'This CI is already associated with the service'),
];
