/**
 * Relationship traversal: dependency maps, upstream/downstream closures, impact analysis
 * and the CI links on tasks (cmdb.md sections 6 and 7). Traversal reads cmdb_rel_ci
 * directly through SQL; records returned to callers are loaded through their context.
 */
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { quoteIdent } from '../../engine/util.js';
import type { CmdbService } from '../contracts.js';

export type Direction = 'up' | 'down';

export interface RelEdge {
  sys_id: string;
  parent: string;
  child: string;
  type: string;
  typeName: string;
  parentDescriptor: string;
  childDescriptor: string;
}

export interface CiInfo {
  sys_id: string;
  name: string;
  sys_class_name: string;
  operational_status: string;
  install_status: string;
}

export interface GraphNode {
  sys_id: string;
  name: string;
  class: string;
  classLabel: string;
  operational_status: string;
  operational_status_label: string;
  level: number;
  root: boolean;
}

export interface GraphEdge {
  sys_id: string;
  from: string;
  to: string;
  type: string;
  type_sys_id: string;
  parentDescriptor: string;
  childDescriptor: string;
  contracted: boolean;
}

export interface GraphOptions {
  depth?: number;
  direction?: Direction | 'both';
  maxNodes?: number;
  maxRelsPerNode?: number;
  /** Relationship type names (or sys_ids) to follow; empty follows every type. */
  types?: string[];
  /** "Show All Relationships": do not contract qualifier and endpoint CIs. */
  showAll?: boolean;
}

export interface GraphResult {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const CONTRACTED_CLASSES = ['cmdb_ci_qualifier', 'cmdb_ci_endpoint'];

export class CmdbEngine implements CmdbService {
  constructor(private platform: Platform) {}

  // ----------------------------------------------------------------- reads

  /** Relationship rows of a CI: `down` = the CI is the parent, `up` = the CI is the child. */
  edges(ciId: string, direction: Direction, limit = -1): RelEdge[] {
    const col = direction === 'down' ? 'parent' : 'child';
    return this.platform.db
      .all<Record<string, string | null>>(
        `SELECT r."sys_id", r."parent", r."child", r."type", t."name" AS type_name, t."parent_descriptor", t."child_descriptor"
         FROM "cmdb_rel_ci" r LEFT JOIN "cmdb_rel_type" t ON t."sys_id" = r."type"
         WHERE r.${quoteIdent(col)} = ? ORDER BY t."name", r."sys_id" LIMIT ?`,
        [ciId, limit],
      )
      .map((r) => ({
        sys_id: String(r.sys_id),
        parent: String(r.parent ?? ''),
        child: String(r.child ?? ''),
        type: String(r.type ?? ''),
        typeName: r.type_name ?? '',
        parentDescriptor: r.parent_descriptor ?? '',
        childDescriptor: r.child_descriptor ?? '',
      }));
  }

  /** Name, class and status of CIs, keyed by sys_id. */
  info(ids: string[]): Map<string, CiInfo> {
    const out = new Map<string, CiInfo>();
    const unique = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = this.platform.db.all<Record<string, unknown>>(
        `SELECT "sys_id","name","sys_class_name","operational_status","install_status" FROM "cmdb" WHERE "sys_id" IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
      for (const r of rows) {
        out.set(String(r.sys_id), {
          sys_id: String(r.sys_id),
          name: String(r.name ?? ''),
          sys_class_name: String(r.sys_class_name ?? ''),
          operational_status:
            r.operational_status === null || r.operational_status === undefined
              ? ''
              : String(r.operational_status),
          install_status:
            r.install_status === null || r.install_status === undefined ? '' : String(r.install_status),
        });
      }
    }
    return out;
  }

  isA(cls: string, base: string): boolean {
    return this.platform.registry.isA(cls, base);
  }

  /** Owning service of an offering (service_offering.parent), the non-relationship CSDM link. */
  private offeringParent(ciId: string): string | null {
    const meta = this.platform.registry.tryTable('service_offering');
    const col = meta?.columns.get('parent');
    if (!col) return null;
    const row = this.platform.db.get<{ p: string | null; c: string }>(
      `SELECT ${quoteIdent(col.physical)} AS p, "sys_class_name" AS c FROM "cmdb" WHERE "sys_id" = ?`,
      [ciId],
    );
    if (!row?.p || !this.isA(row.c, 'service_offering')) return null;
    return row.p;
  }

  /**
   * Cycle-safe breadth-first closure. Returns reached CI ids (root excluded) with their level.
   * Walking up also follows offering -> owning service.
   */
  closure(roots: string[], direction: Direction, depth = Number.POSITIVE_INFINITY): Map<string, number> {
    const reached = new Map<string, number>();
    const seen = new Set(roots);
    let frontier = [...seen];
    for (let level = 1; frontier.length && level <= depth; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbours = this.edges(id, direction).map((e) => (direction === 'down' ? e.child : e.parent));
        if (direction === 'up') {
          const owner = this.offeringParent(id);
          if (owner) neighbours.push(owner);
        }
        for (const n of neighbours) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          reached.set(n, level);
          next.push(n);
        }
      }
      frontier = next;
    }
    return reached;
  }

  /**
   * Loads CI records in the given id order. This is a server-side service, so records are
   * read without ACLs; REST endpoints check access before calling it.
   */
  private load(ctx: Context, ids: string[]): Rec[] {
    if (!ids.length) return [];
    const sys = ctx.elevated();
    const byId = new Map<string, Rec>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const r of sys.query('cmdb', { query: `sys_idIN${ids.slice(i, i + 500).join(',')}` }))
        byId.set(r.sysId, r);
    }
    return ids.map((id) => byId.get(id)).filter((r): r is Rec => !!r);
  }

  // -------------------------------------------------------- CmdbService API

  upstream(ctx: Context, ciId: string, depth?: number): Rec[] {
    return this.load(ctx, [...this.closure([ciId], 'up', depth).keys()]);
  }

  downstream(ctx: Context, ciId: string, depth?: number): Rec[] {
    return this.load(ctx, [...this.closure([ciId], 'down', depth).keys()]);
  }

  /** Services (offerings excluded) that a CI impacts, for one CI. */
  impactedServices(ctx: Context, ciId: string): Rec[] {
    return this.load(ctx, this.impact([ciId]).services);
  }

  /** Offerings a CI impacts. */
  impactedOfferings(ctx: Context, ciId: string): Rec[] {
    return this.load(ctx, this.impact([ciId]).offerings);
  }

  /** Idempotent: a CI already affected by the task is not added twice. */
  addAffectedCi(ctx: Context, task: Rec, ciId: string): void {
    if (!ciId) return;
    const exists = this.platform.db.get(`SELECT "sys_id" FROM "task_ci" WHERE "task" = ? AND "ci_item" = ?`, [
      task.sysId,
      ciId,
    ]);
    if (exists) return;
    ctx.elevated().insert('task_ci', { task: task.sysId, ci_item: ciId });
  }

  // ------------------------------------------------------------ impact

  /**
   * Impacted services and offerings for a seed set: services linked through svc_ci_assoc
   * plus every service/offering in the upstream closure.
   */
  impact(seed: string[]): { services: string[]; offerings: string[]; closure: string[] } {
    const closure = this.closure(seed, 'up');
    const ids = new Set<string>([...seed, ...closure.keys()]);
    if (this.platform.properties.getBool('change.refresh_impacted.include_affected_cis', true)) {
      for (const s of this.assocServices(seed)) ids.add(s);
    }
    const info = this.info([...ids]);
    const services: string[] = [];
    const offerings: string[] = [];
    for (const id of ids) {
      const ci = info.get(id);
      if (!ci || !this.isA(ci.sys_class_name, 'cmdb_ci_service')) continue;
      if (this.isA(ci.sys_class_name, 'service_offering')) offerings.push(id);
      else services.push(id);
    }
    return { services, offerings, closure: [...closure.keys()] };
  }

  private assocServices(ciIds: string[]): string[] {
    if (!ciIds.length || !this.platform.registry.has('svc_ci_assoc')) return [];
    return this.platform.db
      .all<{ s: string }>(
        `SELECT DISTINCT "service_id" AS s FROM "svc_ci_assoc" WHERE "ci_id" IN (${ciIds.map(() => '?').join(',')})`,
        ciIds,
      )
      .map((r) => r.s);
  }

  /** CIs of a task: the primary CI plus every affected CI. */
  taskCis(task: Rec): string[] {
    const ids = new Set<string>();
    if (task.str('cmdb_ci')) ids.add(task.str('cmdb_ci'));
    for (const r of this.platform.db.all<{ ci: string }>(
      `SELECT "ci_item" AS ci FROM "task_ci" WHERE "task" = ?`,
      [task.sysId],
    )) {
      if (r.ci) ids.add(r.ci);
    }
    return [...ids];
  }

  /**
   * "Refresh Impacted Services": replaces the automatic task_cmdb_ci_service and
   * task_service_offering rows of a task, keeping manually added ones.
   */
  refreshImpactedServices(ctx: Context, task: Rec): { services: number; offerings: number } {
    const { services, offerings } = this.impact(this.taskCis(task));
    const sys = ctx.elevated();
    const services_ = this.replaceLinks(sys, task, 'task_cmdb_ci_service', 'cmdb_ci_service', services);
    const offerings_ = this.platform.registry.has('task_service_offering')
      ? this.replaceLinks(sys, task, 'task_service_offering', 'service_offering', offerings)
      : 0;
    return { services: services_, offerings: offerings_ };
  }

  private replaceLinks(ctx: Context, task: Rec, table: string, field: string, ids: string[]): number {
    for (const r of ctx.query(table, { query: `task=${task.sysId}^manually_added=false` })) ctx.delete(r);
    const kept = new Set(ctx.query(table, { query: `task=${task.sysId}` }).map((r) => r.str(field)));
    let n = 0;
    for (const id of ids) {
      if (kept.has(id)) continue;
      ctx.insert(table, { task: task.sysId, [field]: id, manually_added: false });
      kept.add(id);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------- dependency map

  private typeFilter(types: string[] | undefined): (e: RelEdge) => boolean {
    if (!types?.length) return () => true;
    const wanted = new Set(types);
    return (e) => wanted.has(e.typeName) || wanted.has(e.type);
  }

  private contracted(info: CiInfo | undefined): boolean {
    return !!info && CONTRACTED_CLASSES.some((c) => this.isA(info.sys_class_name, c));
  }

  /** Neighbours in one direction; qualifier/endpoint CIs are skipped through unless showAll. */
  private neighbours(
    id: string,
    dir: Direction,
    opts: Required<Pick<GraphOptions, 'maxRelsPerNode' | 'showAll'>>,
    accept: (e: RelEdge) => boolean,
  ) {
    const out: { edge: RelEdge; other: string; contracted: boolean }[] = [];
    const visit = (from: string, first: RelEdge | null, guard: Set<string>) => {
      for (const e of this.edges(from, dir, opts.maxRelsPerNode).filter(accept)) {
        const other = dir === 'down' ? e.child : e.parent;
        if (!other || guard.has(other)) continue;
        const info = this.info([other]).get(other);
        if (!opts.showAll && this.contracted(info)) {
          visit(other, first ?? e, new Set([...guard, other]));
          continue;
        }
        out.push({ edge: first ?? e, other, contracted: first !== null });
      }
    };
    visit(id, null, new Set([id]));
    return out;
  }

  /** Dependency view around a CI, bounded by depth, node count and relations per node. */
  graph(rootId: string, opts: GraphOptions = {}): GraphResult {
    const props = this.platform.properties;
    const depth = Math.min(
      49,
      Math.max(1, Math.trunc(opts.depth ?? props.getNumber('glide.bsm.max_levels', 3))),
    );
    const maxNodes = Math.max(1, opts.maxNodes ?? props.getNumber('glide.bsm.max_nodes', 1000));
    const settings = {
      maxRelsPerNode: Math.max(1, opts.maxRelsPerNode ?? props.getNumber('glide.bsm.max_num_rels', 100)),
      showAll: !!opts.showAll,
    };
    const accept = this.typeFilter(opts.types);
    const directions: Direction[] =
      opts.direction && opts.direction !== 'both' ? [opts.direction] : ['up', 'down'];
    const levels = new Map<string, number>([[rootId, 0]]);
    const edges = new Map<string, GraphEdge>();
    let truncated = false;
    for (const dir of directions) {
      let frontier = [rootId];
      for (let level = 1; frontier.length && level <= depth; level++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const n of this.neighbours(id, dir, settings, accept)) {
            if (!levels.has(n.other)) {
              if (levels.size >= maxNodes) {
                truncated = true;
                continue;
              }
              levels.set(n.other, level);
              next.push(n.other);
            }
            const [from, to] = dir === 'down' ? [id, n.other] : [n.other, id];
            const key = n.contracted ? `${from}>${to}:${n.edge.type}` : n.edge.sys_id;
            if (!edges.has(key)) {
              edges.set(key, {
                sys_id: n.edge.sys_id,
                from,
                to,
                type: n.edge.typeName,
                type_sys_id: n.edge.type,
                parentDescriptor: n.edge.parentDescriptor,
                childDescriptor: n.edge.childDescriptor,
                contracted: n.contracted,
              });
            }
          }
        }
        frontier = next;
      }
    }
    const info = this.info([...levels.keys()]);
    const nodes: GraphNode[] = [];
    for (const [id, level] of levels) {
      const ci = info.get(id);
      if (!ci || !this.isA(ci.sys_class_name, 'cmdb_ci')) continue;
      nodes.push({
        sys_id: id,
        name: ci.name,
        class: ci.sys_class_name,
        classLabel: this.platform.registry.tryTable(ci.sys_class_name)?.label ?? ci.sys_class_name,
        operational_status: ci.operational_status,
        operational_status_label:
          this.platform.choices.label(ci.sys_class_name, 'operational_status', ci.operational_status) ?? '',
        level,
        root: id === rootId,
      });
    }
    const kept = new Set(nodes.map((n) => n.sys_id));
    return {
      root: rootId,
      nodes,
      edges: [...edges.values()].filter((e) => kept.has(e.from) && kept.has(e.to)),
      truncated,
    };
  }
}

export function cmdbEngine(platform: Platform): CmdbEngine {
  return platform.service<CmdbEngine>('cmdb');
}
