/**
 * CMDB Health (cmdb.md section 8): completeness (required, recommended), correctness
 * (orphan, staleness, duplicate), compliance (audit) and relationship checks, scored per
 * class and rolled up into weighted KPIs.
 */
import type { Context } from '../../engine/context.js';
import type { ColumnMeta } from '../../engine/types.js';
import { diffMs, nowGlide, quoteIdent } from '../../engine/util.js';
import { RelationshipGovernance } from './governance.js';

export type Metric = 'required' | 'recommended' | 'orphan' | 'staleness' | 'duplicate' | 'audit';
export type Kpi = 'completeness' | 'correctness' | 'compliance';

export const KPI_METRICS: Record<Kpi, Metric[]> = {
  completeness: ['required', 'recommended'],
  correctness: ['orphan', 'staleness', 'duplicate'],
  compliance: ['audit'],
};

/** Default weights (cmdb.md 8.2); cmdb_health_metric_pref rows override them. */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  required: 60,
  recommended: 40,
  orphan: 33.34,
  staleness: 33.33,
  duplicate: 33.33,
  audit: 100,
  completeness: 33.33,
  correctness: 33.34,
  compliance: 33.33,
};

const DAY_MS = 86_400_000;

export interface MetricScore {
  evaluated: number;
  failed: number;
  score: number;
}

export interface KpiScore {
  score: number;
  weight: number;
  metrics: Partial<Record<Metric, MetricScore & { weight: number }>>;
}

export interface Failure {
  sys_id: string;
  name: string;
  class: string;
  metric: string;
  details: string;
}

export interface ClassHealth {
  class: string;
  label: string;
  total: number;
  metrics: Partial<Record<Metric, MetricScore>>;
}

export interface RelationshipHealth {
  evaluated: number;
  duplicate: number;
  orphan: number;
  stale: number;
  invalid: number;
  score: number;
}

export interface HealthReport {
  computed_at: string;
  total_cis: number;
  overall: number | null;
  kpis: Partial<Record<Kpi, KpiScore>>;
  relationships: RelationshipHealth;
  by_class: ClassHealth[];
  failures: Failure[];
}

interface CiRow {
  sys_id: string;
  name: string;
  sys_class_name: string;
  sys_updated_on: string | null;
  sys_created_on: string | null;
}

export function metricScore(evaluated: number, failed: number): number {
  return evaluated === 0 ? 100 : round((100 * (evaluated - failed)) / evaluated);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Weighted mean of the scores present (weights renormalised over those present). */
export function weightedScore(
  scores: Partial<Record<string, number>>,
  weights: Record<string, number>,
): number | null {
  let total = 0;
  let sum = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score === undefined) continue;
    const w = weights[name] ?? 0;
    total += w;
    sum += w * score;
  }
  return total === 0 ? null : round(sum / total);
}

/** Evaluated/failed sets per metric, keyed by CI. */
class Tally {
  evaluated = new Map<Metric, Set<string>>();
  failed = new Map<Metric, Map<string, string>>();

  evaluate(metric: Metric, ci: string): void {
    let s = this.evaluated.get(metric);
    if (!s) this.evaluated.set(metric, (s = new Set()));
    s.add(ci);
  }

  fail(metric: Metric, ci: string, details: string): void {
    this.evaluate(metric, ci);
    let m = this.failed.get(metric);
    if (!m) this.failed.set(metric, (m = new Map()));
    if (!m.has(ci)) m.set(ci, details);
  }

  score(metric: Metric, filter?: (ci: string) => boolean): MetricScore | undefined {
    const ev = this.evaluated.get(metric);
    if (!ev) return undefined;
    const evaluated = filter ? [...ev].filter(filter).length : ev.size;
    if (filter && evaluated === 0) return undefined;
    const failed = [...(this.failed.get(metric)?.keys() ?? [])].filter((c) => !filter || filter(c)).length;
    return { evaluated, failed, score: metricScore(evaluated, failed) };
  }
}

export class HealthCalculator {
  private readonly cis: CiRow[];
  private readonly byId: Map<string, CiRow>;
  private readonly tally = new Tally();
  private readonly now = nowGlide();
  private inclusion: { applies_to: string; ids: Set<string>; metrics: string[] }[] = [];
  private staleCache = new Map<string, boolean>();

  constructor(private readonly ctx: Context) {
    const scope = ctx.registry.table('cmdb_ci').descendants;
    this.cis = ctx.platform.db.all<CiRow>(
      `SELECT "sys_id","name","sys_class_name","sys_updated_on","sys_created_on" FROM "cmdb" WHERE "sys_class_name" IN (${scope.map(() => '?').join(',')}) ORDER BY "sys_created_on", rowid`,
      scope,
    );
    this.byId = new Map(this.cis.map((c) => [c.sys_id, c]));
  }

  private get platform() {
    return this.ctx.platform;
  }

  private ancestors(cls: string): string[] {
    return this.ctx.registry.tryTable(cls)?.ancestors ?? [cls];
  }

  private queryIds(table: string, condition: string): Set<string> {
    if (!this.ctx.registry.has(table)) return new Set();
    return new Set(
      this.ctx
        .elevated()
        .query(table, { query: condition })
        .map((r) => r.sysId),
    );
  }

  private loadInclusion(): void {
    this.inclusion = this.platform.db
      .all<{ applies_to: string; condition: string | null; metrics: string | null }>(
        `SELECT "applies_to","condition","metrics" FROM "cmdb_health_inclusion_rule"`,
      )
      .map((r) => ({
        applies_to: r.applies_to,
        ids: this.queryIds(r.applies_to, r.condition ?? ''),
        metrics: String(r.metrics ?? '')
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
      }));
  }

  /** Nearest inclusion rule of the CI's class decides; child-class rules replace parent ones. */
  private included(ci: CiRow, metric: Metric): boolean {
    for (const cls of this.ancestors(ci.sys_class_name)) {
      const rule = this.inclusion.find((r) => r.applies_to === cls);
      if (!rule) continue;
      if (rule.metrics.length && !rule.metrics.includes(metric)) return true;
      return rule.ids.has(ci.sys_id);
    }
    return true;
  }

  private emptySql(col: ColumnMeta): string {
    const f = quoteIdent(col.physical);
    return col.storage === 'TEXT' ? `(${f} IS NULL OR ${f} = '')` : `${f} IS NULL`;
  }

  /** CIs of each class with any of the given fields empty. */
  private emptyFields(metric: Metric, fieldsFor: (cls: string) => ColumnMeta[]): void {
    const classes = [...new Set(this.cis.map((c) => c.sys_class_name))];
    for (const cls of classes) {
      const cols = fieldsFor(cls);
      const members = this.cis.filter((c) => c.sys_class_name === cls && this.included(c, metric));
      for (const c of members) this.tally.evaluate(metric, c.sys_id);
      if (!cols.length || !members.length) continue;
      for (const col of cols) {
        const rows = this.platform.db.all<{ sys_id: string }>(
          `SELECT "sys_id" FROM "cmdb" WHERE "sys_class_name" = ? AND ${this.emptySql(col)}`,
          [cls],
        );
        for (const r of rows) {
          const ci = this.byId.get(r.sys_id);
          if (ci && this.included(ci, metric))
            this.tally.fail(metric, r.sys_id, `${col.label} (${col.name}) is empty`);
        }
      }
    }
  }

  private required(): void {
    this.emptyFields('required', (cls) => {
      const meta = this.ctx.registry.table(cls);
      return [...meta.columns.values()].filter((c) => c.mandatory && !c.system && c.storage);
    });
  }

  private recommended(): void {
    const rows = this.platform.db.all<{ applies_to: string; element: string }>(
      `SELECT "applies_to","element" FROM "resolvr_cmdb_recommended_field" WHERE "active" IS NULL OR "active" = 1`,
    );
    this.emptyFields('recommended', (cls) => {
      const meta = this.ctx.registry.table(cls);
      const names = new Set(rows.filter((r) => meta.ancestors.includes(r.applies_to)).map((r) => r.element));
      return [...names].map((n) => meta.columns.get(n)).filter((c): c is ColumnMeta => !!c?.storage);
    });
  }

  /** Effective staleness window of a class (nearest rule; 60 days by default). */
  private staleWindow(
    cls: string,
    rules: { applies_to: string; effective_duration: number | null }[],
  ): number {
    for (const a of this.ancestors(cls)) {
      const rule = rules.find((r) => r.applies_to === a);
      if (rule) return Number(rule.effective_duration ?? 60 * DAY_MS);
    }
    return 60 * DAY_MS;
  }

  private isStale(ci: CiRow, rules: { applies_to: string; effective_duration: number | null }[]): boolean {
    const hit = this.staleCache.get(ci.sys_id);
    if (hit !== undefined) return hit;
    const updated = ci.sys_updated_on ?? ci.sys_created_on;
    const stale = !!updated && diffMs(this.now, updated) > this.staleWindow(ci.sys_class_name, rules);
    this.staleCache.set(ci.sys_id, stale);
    return stale;
  }

  private dependentClass(cls: string): boolean {
    for (const a of this.ancestors(cls)) {
      const row = this.platform.db.get<{ i: number | null }>(
        `SELECT "is_independent" AS i FROM "cmdb_identifier" WHERE "applies_to" = ? AND ("active" IS NULL OR "active" = 1) LIMIT 1`,
        [a],
      );
      if (row) return row.i === 0;
    }
    return false;
  }

  private stalenessRules() {
    return this.platform.db.all<{ applies_to: string; effective_duration: number | null }>(
      `SELECT "applies_to","effective_duration" FROM "cmdb_health_staleness_rule"`,
    );
  }

  private staleness(): void {
    const rules = this.stalenessRules();
    const excludeDependent = this.platform.properties.getBool(
      'glide.cmdb.health.staleness_exclude_dependent_cis',
      false,
    );
    for (const ci of this.cis) {
      if (!this.included(ci, 'staleness')) continue;
      if (excludeDependent && this.dependentClass(ci.sys_class_name)) continue;
      if (this.isStale(ci, rules)) {
        const days = Math.round(this.staleWindow(ci.sys_class_name, rules) / DAY_MS);
        this.tally.fail(
          'staleness',
          ci.sys_id,
          `Not updated since ${ci.sys_updated_on} (window ${days} days)`,
        );
      } else this.tally.evaluate('staleness', ci.sys_id);
    }
  }

  private orphan(): void {
    const rules = this.platform.db.all<Record<string, unknown>>(`SELECT * FROM "cmdb_health_orphan_rule"`);
    if (!rules.length) return;
    const attrMatches = new Map<string, Set<string>>();
    for (const ci of this.cis) {
      if (!this.included(ci, 'orphan')) continue;
      const rule = this.ancestors(ci.sys_class_name)
        .map((a) => rules.find((r) => r.applies_to === a))
        .find((r) => !!r);
      if (!rule) continue;
      const ruleId = String(rule.sys_id);
      const attributes = String(rule.attributes ?? '');
      if (attributes && !attrMatches.has(ruleId))
        attrMatches.set(ruleId, this.queryIds(String(rule.applies_to), attributes));
      const relType = String(rule.relationship_type ?? '');
      const relClass = String(rule.related_class ?? '');
      const hasRelPart = !!(relType || relClass) || !attributes;
      const relOrphan = hasRelPart ? !this.hasRelationship(ci.sys_id, relType, relClass) : false;
      const attrOrphan = attributes ? attrMatches.get(ruleId)!.has(ci.sys_id) : false;
      let orphan: boolean;
      if (!attributes) orphan = relOrphan;
      else if (!(relType || relClass)) orphan = attrOrphan;
      else orphan = rule.operator === 'or' ? attrOrphan || relOrphan : attrOrphan && relOrphan;
      if (orphan) this.tally.fail('orphan', ci.sys_id, this.orphanDetails(relType, relClass));
      else this.tally.evaluate('orphan', ci.sys_id);
    }
  }

  private orphanDetails(relType: string, relClass: string): string {
    if (!relType && !relClass) return 'Matches the orphan rule of its class';
    const typeName = relType
      ? (this.platform.db.get<{ name: string }>(`SELECT "name" FROM "cmdb_rel_type" WHERE "sys_id" = ?`, [
          relType,
        ])?.name ?? relType)
      : 'any';
    return `No ${typeName} relationship${relClass ? ` with a ${relClass}` : ''}`;
  }

  private hasRelationship(ciId: string, relType: string, relClass: string): boolean {
    const rows = this.platform.db.all<{ parent: string; child: string; type: string }>(
      `SELECT "parent","child","type" FROM "cmdb_rel_ci" WHERE "parent" = ? OR "child" = ?`,
      [ciId, ciId],
    );
    return rows.some((r) => {
      if (relType && r.type !== relType) return false;
      if (!relClass) return true;
      const other = this.byId.get(r.parent === ciId ? r.child : r.parent);
      return !!other && this.ctx.registry.isA(other.sys_class_name, relClass);
    });
  }

  private duplicate(): void {
    const rules = this.platform.db.all<{ sys_id: string; applies_to: string }>(
      `SELECT "sys_id","applies_to" FROM "cmdb_identifier" WHERE "is_independent" = 1 AND ("active" IS NULL OR "active" = 1)`,
    );
    for (const rule of rules) {
      if (!this.ctx.registry.has(rule.applies_to)) continue;
      const scope = new Set(this.ctx.registry.table(rule.applies_to).descendants);
      const members = this.cis.filter((c) => scope.has(c.sys_class_name) && this.included(c, 'duplicate'));
      for (const c of members) this.tally.evaluate('duplicate', c.sys_id);
      const entries = this.platform.db.all<{ attributes: string }>(
        `SELECT "attributes" FROM "cmdb_identifier_entry" WHERE "identifier" = ? AND ("table" IS NULL OR "table" = '') AND ("active" IS NULL OR "active" = 1)`,
        [rule.sys_id],
      );
      for (const e of entries)
        this.duplicateSets(
          rule.applies_to,
          members,
          e.attributes
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        );
    }
  }

  /** Groups CIs sharing the same non-empty identifier values; all but the oldest fail. */
  private duplicateSets(appliesTo: string, members: CiRow[], attrs: string[]): void {
    const meta = this.ctx.registry.table(appliesTo);
    const cols = attrs.map((a) => meta.columns.get(a));
    if (!attrs.length || cols.some((c) => !c?.storage) || !members.length) return;
    const ids = new Set(members.map((m) => m.sys_id));
    const rows = this.platform.db.all<Record<string, unknown>>(
      `SELECT "sys_id", ${cols.map((c, i) => `${quoteIdent(c!.physical)} AS a${i}`).join(', ')} FROM "cmdb" WHERE "sys_class_name" IN (${meta.descendants.map(() => '?').join(',')}) ORDER BY "sys_created_on", rowid`,
      meta.descendants,
    );
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      if (!ids.has(String(r.sys_id))) continue;
      const values = attrs.map((_, i) =>
        String(r[`a${i}`] ?? '')
          .trim()
          .toLowerCase(),
      );
      if (values.some((v) => v === '')) continue;
      const key = values.join('\u0000');
      groups.set(key, [...(groups.get(key) ?? []), String(r.sys_id)]);
    }
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      const main = this.byId.get(group[0]);
      for (const id of group.slice(1))
        this.tally.fail('duplicate', id, `Same ${attrs.join(', ')} as ${main?.name || group[0]}`);
    }
  }

  private audit(): boolean {
    const rules = this.platform.db.all<{ name: string; applies_to: string; condition: string | null }>(
      `SELECT "name","applies_to","condition" FROM "resolvr_cmdb_compliance_rule" WHERE "active" IS NULL OR "active" = 1`,
    );
    if (!rules.length) return false;
    for (const rule of rules) {
      if (!this.ctx.registry.has(rule.applies_to)) continue;
      const scope = new Set(this.ctx.registry.table(rule.applies_to).descendants);
      const compliant = rule.condition ? this.queryIds(rule.applies_to, rule.condition) : null;
      for (const ci of this.cis) {
        if (!scope.has(ci.sys_class_name) || !this.included(ci, 'audit')) continue;
        if (compliant && !compliant.has(ci.sys_id))
          this.tally.fail('audit', ci.sys_id, `Fails compliance rule "${rule.name}"`);
        else this.tally.evaluate('audit', ci.sys_id);
      }
    }
    return true;
  }

  private relationships(): RelationshipHealth & {
    failures: { rel: string; metric: string; details: string }[];
  } {
    const rows = this.platform.db.all<{
      sys_id: string;
      parent: string | null;
      child: string | null;
      type: string;
      port: string | null;
    }>(`SELECT "sys_id","parent","child","type","port" FROM "cmdb_rel_ci" ORDER BY "sys_created_on", rowid`);
    const governance = new RelationshipGovernance(this.platform);
    const staleRules = this.stalenessRules();
    const seen = new Set<string>();
    const failures: { rel: string; metric: string; details: string }[] = [];
    const failed = new Set<string>();
    let duplicate = 0;
    let orphan = 0;
    let stale = 0;
    let invalid = 0;
    for (const r of rows) {
      const key = `${r.parent}|${r.child}|${r.type}|${r.port ?? ''}`;
      const parent = r.parent ? this.byId.get(r.parent) : undefined;
      const child = r.child ? this.byId.get(r.child) : undefined;
      const flag = (metric: string, details: string) => {
        failures.push({ rel: r.sys_id, metric, details });
        failed.add(r.sys_id);
      };
      if (seen.has(key)) {
        duplicate++;
        flag('rel_duplicate', 'Same parent, child, type and port as another relationship');
      }
      seen.add(key);
      if (!parent || !child) {
        orphan++;
        flag('rel_orphan', 'Parent or child CI is missing');
        continue;
      }
      if (this.isStale(parent, staleRules) || this.isStale(child, staleRules)) {
        stale++;
        flag('rel_stale', 'Parent or child CI is stale');
      }
      if (!governance.isValid(parent.sys_class_name, r.type, child.sys_class_name)) invalid++;
    }
    return {
      evaluated: rows.length,
      duplicate,
      orphan,
      stale,
      invalid,
      score: metricScore(rows.length, failed.size),
      failures,
    };
  }

  private weights(): Record<string, number> {
    const out = { ...DEFAULT_WEIGHTS };
    for (const r of this.platform.db.all<{ name: string; weight: number | null }>(
      `SELECT "name","weight" FROM "cmdb_health_metric_pref" WHERE "active" IS NULL OR "active" = 1`,
    )) {
      if (r.weight !== null && r.weight !== undefined) out[r.name] = Number(r.weight);
    }
    return out;
  }

  compute(): HealthReport & { relFailures: { rel: string; metric: string; details: string }[] } {
    this.loadInclusion();
    this.required();
    this.recommended();
    this.orphan();
    this.staleness();
    this.duplicate();
    const hasAudit = this.audit();
    const weights = this.weights();
    const kpis: Partial<Record<Kpi, KpiScore>> = {};
    for (const kpi of Object.keys(KPI_METRICS) as Kpi[]) {
      if (kpi === 'compliance' && !hasAudit) continue;
      const metrics: KpiScore['metrics'] = {};
      const scores: Record<string, number> = {};
      for (const m of KPI_METRICS[kpi]) {
        const s = this.tally.score(m) ?? { evaluated: 0, failed: 0, score: 100 };
        metrics[m] = { ...s, weight: weights[m] ?? 0 };
        scores[m] = s.score;
      }
      kpis[kpi] = { score: weightedScore(scores, weights) ?? 100, weight: weights[kpi] ?? 0, metrics };
    }
    const overall = weightedScore(
      Object.fromEntries(Object.entries(kpis).map(([k, v]) => [k, v!.score])),
      weights,
    );
    const { failures: relFailures, ...relationships } = this.relationships();
    return {
      computed_at: this.now,
      total_cis: this.cis.length,
      overall,
      kpis,
      relationships,
      by_class: this.byClass(),
      failures: this.failures(),
      relFailures,
    };
  }

  private byClass(): ClassHealth[] {
    const classes = [...new Set(this.cis.map((c) => c.sys_class_name))].sort();
    return classes.map((cls) => {
      const members = new Set(this.cis.filter((c) => c.sys_class_name === cls).map((c) => c.sys_id));
      const metrics: ClassHealth['metrics'] = {};
      for (const m of Object.values(KPI_METRICS).flat()) {
        const s = this.tally.score(m, (id) => members.has(id));
        if (s) metrics[m] = s;
      }
      return {
        class: cls,
        label: this.ctx.registry.tryTable(cls)?.label ?? cls,
        total: members.size,
        metrics,
      };
    });
  }

  private failures(): Failure[] {
    const out: Failure[] = [];
    for (const [metric, map] of this.tally.failed) {
      for (const [id, details] of map) {
        const ci = this.byId.get(id);
        out.push({ sys_id: id, name: ci?.name ?? '', class: ci?.sys_class_name ?? '', metric, details });
      }
    }
    return out;
  }
}

/** Computes the health report without storing anything. */
export function computeHealth(ctx: Context): HealthReport {
  const { relFailures: _rels, ...report } = new HealthCalculator(ctx).compute();
  return report;
}

/** Scheduled job body: recomputes health and replaces the stored failure results. */
export function runHealthJob(ctx: Context): HealthReport {
  const calc = new HealthCalculator(ctx);
  const { relFailures, ...report } = calc.compute();
  const sys = ctx.derive({ acl: false, audit: false });
  const db = ctx.platform.db;
  db.tx(() => {
    db.run(`DELETE FROM "cmdb_health_result"`);
    const now = report.computed_at;
    for (const f of report.failures) {
      sys.insert('cmdb_health_result', {
        ci: f.sys_id,
        metric: f.metric,
        state: 'fail',
        details: f.details.slice(0, 4000),
        last_run: now,
      });
    }
    for (const f of relFailures) {
      sys.insert('cmdb_health_result', {
        relationship: f.rel,
        metric: f.metric,
        state: 'fail',
        details: f.details,
        last_run: now,
      });
    }
  });
  ctx.platform.properties.set('resolvr.cmdb.health.last_run', report.computed_at);
  ctx.platform.properties.set(
    'resolvr.cmdb.health.last_overall',
    report.overall === null ? '' : String(report.overall),
  );
  return report;
}
