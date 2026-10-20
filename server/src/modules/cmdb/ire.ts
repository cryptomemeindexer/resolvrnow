/**
 * Identification and reconciliation engine (cmdb.md section 5), simplified v1:
 * identifier rules with main-table and lookup entries, dependent identification through
 * hosting/containment rules, de-duplication, reclassification and source-priority
 * reconciliation. Every item is processed in its own savepoint so one bad item does not
 * roll back the others.
 */
import type { Context } from '../../engine/context.js';
import { AbortError, AccessError, InvalidError } from '../../engine/errors.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { type ColumnMeta, SYSTEM_COLUMN_NAMES, type TableMeta } from '../../engine/types.js';
import {
  diffMs,
  isSysId,
  nowGlide,
  parseGlideDateTime,
  quoteIdent,
  toGlideDateTime,
} from '../../engine/util.js';
import { type ReclassKind, reclassify, reclassKind } from './reclassify.js';

export interface IreValues {
  className: string;
  values: Record<string, unknown>;
}

export interface IreItem extends IreValues {
  lookup?: IreValues[];
  related?: IreValues[];
  sys_object_source_info?: {
    source_name?: string;
    source_native_key?: string;
    source_recency_timestamp?: string;
  };
  internal_id?: string;
}

/** Relation ends are item indexes, item internal_ids or sys_ids of existing CIs. */
export interface IreRelation {
  parent: number | string;
  child: number | string;
  /** Relationship type name (`Runs on::Runs`) or cmdb_rel_type sys_id. */
  type: string;
  port?: string;
}

export interface IreSettings {
  updateWithoutUpgrade?: boolean;
  updateWithoutDowngrade?: boolean;
  updateWithoutSwitch?: boolean;
  deduplicatePayloads?: boolean;
}

export interface IrePayload {
  items: IreItem[];
  relations?: IreRelation[];
  settings?: IreSettings;
}

export interface IreMessage {
  error: string;
  message: string;
}

export interface IreAttempt {
  identifierName: string;
  attributes: string[];
  searchOnTable: string;
  attemptResult: 'MATCHED' | 'NO_MATCH' | 'SKIPPED' | 'MULTI_MATCH';
}

export type IreOperation =
  | 'INSERT'
  | 'UPDATE'
  | 'UPDATE_WITH_UPGRADE'
  | 'UPDATE_WITH_DOWNGRADE'
  | 'UPDATE_WITH_SWITCH'
  | 'NO_CHANGE'
  | 'NONE';

export interface IreItemResult {
  className: string;
  operation: IreOperation;
  sysId: string | null;
  identifierEntrySysId: string | null;
  identificationAttempts: IreAttempt[];
  errors: IreMessage[];
  warnings: IreMessage[];
  internal_id?: string;
}

export interface IreRelationResult {
  className: 'cmdb_rel_ci';
  operation: 'INSERT' | 'NO_CHANGE' | 'NONE';
  sysId: string | null;
  type: string;
  errors: IreMessage[];
}

export interface IreOutput {
  items: IreItemResult[];
  relations: IreRelationResult[];
}

export interface IreOptions {
  /** Discovery source (a cmdb_ci.discovery_source value). */
  source: string;
  /** Identify only: no writes at all. */
  dryRun?: boolean;
}

interface Rule {
  sys_id: string;
  name: string;
  applies_to: string;
  is_independent: boolean;
}

interface Entry {
  sys_id: string;
  order: number;
  attributes: string[];
  table: string;
  referenced_field: string;
  allow_null_attribute: boolean;
  allow_fallback: boolean;
  exact_count_match: boolean;
  condition: string;
}

interface DependencyFilter {
  typeId: string;
  otherCi: string | null;
  /** True when the identified item is the parent side of the relation. */
  itemIsParent: boolean;
}

interface Identified {
  ciId: string | null;
  entryId: string | null;
  error?: IreMessage;
}

const msg = (error: string, message: string): IreMessage => ({ error, message });

class IreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
const text = (v: unknown) =>
  v === null || v === undefined
    ? ''
    : typeof v === 'object' && 'value' in (v as object)
      ? String((v as { value: unknown }).value ?? '')
      : String(v);

/** One IRE run over a payload. */
export class IreRun {
  private readonly items: IreItem[];
  private readonly relations: IreRelation[];
  private readonly settings: IreSettings;
  private readonly results: IreItemResult[];
  private readonly identified = new Map<number, Identified>();
  private readonly inProgress = new Set<number>();
  private relTypes: { sys_id: string; name: string }[] | null = null;

  constructor(
    private readonly ctx: Context,
    payload: IrePayload,
    private readonly opts: IreOptions,
  ) {
    this.items = Array.isArray(payload.items) ? payload.items : [];
    this.relations = Array.isArray(payload.relations) ? payload.relations : [];
    this.settings = payload.settings ?? {};
    this.results = this.items.map((item) => ({
      className: String(item?.className ?? ''),
      operation: 'NONE',
      sysId: null,
      identifierEntrySysId: null,
      identificationAttempts: [],
      errors: [],
      warnings: [],
      ...(item?.internal_id ? { internal_id: item.internal_id } : {}),
    }));
  }

  private get platform() {
    return this.ctx.platform;
  }

  private get registry() {
    return this.ctx.registry;
  }

  private prop(name: string, fallback: boolean): boolean {
    return this.platform.properties.getBool(name, fallback);
  }

  run(): IreOutput {
    for (let i = 0; i < this.items.length; i++) this.validate(i);
    for (let i = 0; i < this.items.length; i++) this.identify(i, 0);
    if (!this.opts.dryRun) {
      this.markPayloadDuplicates();
      for (let i = 0; i < this.items.length; i++) this.write(i);
    }
    const relations = this.opts.dryRun ? [] : this.relations.map((r) => this.writeRelation(r));
    return { items: this.results, relations };
  }

  // ------------------------------------------------------------ validation

  private validate(i: number): void {
    const item = this.items[i];
    const res = this.results[i];
    const meta = item?.className ? this.registry.tryTable(item.className) : undefined;
    if (!item || typeof item.values !== 'object' || item.values === null) {
      res.errors.push(msg('INVALID_INPUT_DATA', 'Item has no values'));
    } else if (!item.className) {
      res.errors.push(msg('NO_CLASS_NAME_FOR_INDEPENDENT_CI', 'Item has no className'));
    } else if (!meta?.ancestors.includes('cmdb_ci')) {
      res.errors.push(msg('INVALID_INPUT_DATA', `${item.className} is not a configuration item class`));
    } else {
      const system = Object.keys(item.values).filter((k) => k !== 'sys_id' && SYSTEM_COLUMN_NAMES.has(k));
      if (system.length)
        res.errors.push(msg('INVALID_INPUT_DATA', `System fields are not accepted: ${system.join(', ')}`));
    }
    if (res.errors.length) this.identified.set(i, { ciId: null, entryId: null, error: res.errors[0] });
  }

  // ------------------------------------------------------- identification

  private fail(i: number, code: string, message: string): Identified {
    const out: Identified = { ciId: null, entryId: null, error: msg(code, message) };
    this.results[i].errors.push(out.error!);
    this.identified.set(i, out);
    return out;
  }

  private identify(i: number, depth: number): Identified {
    const done = this.identified.get(i);
    if (done) return done;
    if (this.inProgress.has(i) || depth > 2)
      return this.fail(i, 'QUALIFICATION_LOOP', 'Dependency chain is too deep or circular');
    this.inProgress.add(i);
    try {
      const out = this.identifyItem(i, depth);
      if (!out.error) this.identified.set(i, out);
      return this.identified.get(i) ?? out;
    } catch (e) {
      if (e instanceof IreError) return this.fail(i, e.code, e.message);
      throw e;
    } finally {
      this.inProgress.delete(i);
    }
  }

  private identifyItem(i: number, depth: number): Identified {
    const item = this.items[i];
    const sysId = text(item.values.sys_id);
    if (sysId) {
      const row = this.platform.db.get<{ sys_id: string }>(`SELECT "sys_id" FROM "cmdb" WHERE "sys_id" = ?`, [
        sysId,
      ]);
      if (!row) throw new IreError('INVALID_INPUT_DATA', `No CI with sys_id ${sysId}`);
      return { ciId: sysId, entryId: null };
    }
    const bySource = this.matchObjectSource(item);
    if (bySource) return { ciId: bySource, entryId: null };
    const rule = this.ruleFor(item.className);
    if (!rule)
      throw new IreError(
        'IDENTIFICATION_RULE_MISSING',
        `No identification rule applies to ${item.className}`,
      );
    const dep = rule.is_independent ? null : this.dependency(i, depth);
    const found = this.applyRule(i, rule, dep);
    if (found) return found;
    if (!rule.is_independent && this.entries(rule.sys_id).some((e) => e.allow_fallback)) {
      const parentRule = this.ruleFor(this.registry.table(rule.applies_to).parent ?? '');
      const fallback = parentRule ? this.applyRule(i, parentRule, null) : null;
      if (fallback) return fallback;
    }
    return { ciId: null, entryId: null };
  }

  /** sys_object_source match by source name and native key. */
  private matchObjectSource(item: IreItem): string | null {
    const info = item.sys_object_source_info;
    if (!info?.source_name || !info.source_native_key) return null;
    if (this.prop('glide.identification_engine.skip_sys_object_source_matching', false)) return null;
    const row = this.platform.db.get<{ target_sys_id: string | null }>(
      `SELECT "target_sys_id" FROM "sys_object_source" WHERE "name" = ? AND "id" = ? ORDER BY "sys_updated_on" DESC LIMIT 1`,
      [info.source_name, info.source_native_key],
    );
    if (!row?.target_sys_id) return null;
    const exists = this.platform.db.get(`SELECT "sys_id" FROM "cmdb" WHERE "sys_id" = ?`, [
      row.target_sys_id,
    ]);
    return exists ? row.target_sys_id : null;
  }

  /** Runs the entries of a rule; null means no entry matched. */
  private applyRule(i: number, rule: Rule, dep: DependencyFilter | null): Identified | null {
    const item = this.items[i];
    const scope = this.registry.table(rule.applies_to).descendants;
    let usable = false;
    for (const entry of this.entries(rule.sys_id)) {
      const attempt: IreAttempt = {
        identifierName: rule.name,
        attributes: entry.attributes,
        searchOnTable: entry.table || rule.applies_to,
        attemptResult: 'SKIPPED',
      };
      this.results[i].identificationAttempts.push(attempt);
      const candidates = entry.table
        ? this.lookupCandidates(item, entry, scope, dep)
        : this.mainCandidates(item, entry, rule, scope, dep);
      if (candidates === null) continue;
      usable = true;
      if (candidates.length === 0) {
        attempt.attemptResult = 'NO_MATCH';
        continue;
      }
      if (candidates.length === 1) {
        attempt.attemptResult = 'MATCHED';
        return { ciId: candidates[0], entryId: entry.sys_id };
      }
      attempt.attemptResult = 'MULTI_MATCH';
      return { ciId: this.dedupe(i, candidates), entryId: entry.sys_id };
    }
    if (!usable) {
      throw new IreError(
        'MISSING_MATCHING_ATTRIBUTES',
        `None of the identifier entries of ${rule.name} has values in the payload`,
      );
    }
    return null;
  }

  private ruleFor(className: string): Rule | null {
    const meta = this.registry.tryTable(className);
    for (const cls of meta?.ancestors ?? []) {
      const row = this.platform.db.get<Record<string, unknown>>(
        `SELECT "sys_id","name","applies_to","is_independent" FROM "cmdb_identifier" WHERE "applies_to" = ? AND ("active" IS NULL OR "active" = 1) ORDER BY "sys_created_on" LIMIT 1`,
        [cls],
      );
      if (row) {
        return {
          sys_id: String(row.sys_id),
          name: String(row.name ?? ''),
          applies_to: String(row.applies_to),
          is_independent: row.is_independent !== 0,
        };
      }
    }
    return null;
  }

  private entries(ruleId: string): Entry[] {
    return this.platform.db
      .all<Record<string, unknown>>(
        `SELECT * FROM "cmdb_identifier_entry" WHERE "identifier" = ? AND ("active" IS NULL OR "active" = 1) ORDER BY "order", "sys_created_on"`,
        [ruleId],
      )
      .map((r) => ({
        sys_id: String(r.sys_id),
        order: Number(r.order ?? 100),
        attributes: String(r.attributes ?? '')
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        table: String(r.table ?? ''),
        referenced_field: String(r.referenced_field ?? ''),
        allow_null_attribute: r.allow_null_attribute === 1,
        allow_fallback: r.allow_fallback === 1,
        exact_count_match: r.exact_count_match === 1,
        condition: String(r.condition ?? ''),
      }));
  }

  /** Values of an entry are usable when at least one is set and empties are allowed if any. */
  private usableValues(values: string[], allowNull: boolean): boolean {
    if (values.every((v) => v === '')) return false;
    return allowNull || values.every((v) => v !== '');
  }

  private physical(meta: TableMeta, field: string): ColumnMeta | null {
    const c = meta.columns.get(field);
    return c?.storage ? c : null;
  }

  private equalsSql(alias: string, col: ColumnMeta, value: string, params: unknown[]): string {
    const f = `${alias}.${quoteIdent(col.physical)}`;
    if (value === '') return `(${f} IS NULL OR ${f} = '')`;
    params.push(col.storage === 'TEXT' ? value : Number(value));
    return col.storage === 'TEXT' && col.type !== 'reference' ? `${f} = ? COLLATE NOCASE` : `${f} = ?`;
  }

  private dependencySql(dep: DependencyFilter | null, params: unknown[]): string {
    if (!dep) return '';
    params.push(dep.typeId, dep.otherCi);
    return dep.itemIsParent
      ? ` AND EXISTS (SELECT 1 FROM "cmdb_rel_ci" r WHERE r."type" = ? AND r."parent" = t0."sys_id" AND r."child" = ?)`
      : ` AND EXISTS (SELECT 1 FROM "cmdb_rel_ci" r WHERE r."type" = ? AND r."child" = t0."sys_id" AND r."parent" = ?)`;
  }

  /** Optional entry condition, applied only when the platform property enables it. */
  private conditionFilter(table: string, condition: string, ids: string[]): string[] {
    if (
      !condition ||
      !ids.length ||
      !this.prop('glide.identification_engine.enable_identifier_optional_condition', false)
    )
      return ids;
    const ok = new Set(
      this.ctx
        .elevated()
        .query(table, { query: `${condition}^sys_idIN${ids.join(',')}` })
        .map((r) => r.sysId),
    );
    return ids.filter((id) => ok.has(id));
  }

  private mainCandidates(
    item: IreItem,
    entry: Entry,
    rule: Rule,
    scope: string[],
    dep: DependencyFilter | null,
  ): string[] | null {
    const meta = this.registry.table(rule.applies_to);
    const values = entry.attributes.map((a) => text(item.values[a]).trim());
    if (!this.usableValues(values, entry.allow_null_attribute)) return null;
    if (dep && !dep.otherCi) return [];
    const params: unknown[] = [...scope];
    const where = [`t0."sys_class_name" IN (${scope.map(() => '?').join(',')})`];
    for (let k = 0; k < entry.attributes.length; k++) {
      const col = this.physical(meta, entry.attributes[k]);
      if (!col) return [];
      where.push(this.equalsSql('t0', col, values[k], params));
    }
    const sql = `SELECT t0."sys_id" FROM "cmdb" t0 WHERE ${where.join(' AND ')}${this.dependencySql(dep, params)} ORDER BY t0."sys_created_on", t0.rowid`;
    const ids = this.platform.db.all<{ sys_id: string }>(sql, params as never[]).map((r) => r.sys_id);
    return this.conditionFilter(rule.applies_to, entry.condition, ids);
  }

  private lookupCandidates(
    item: IreItem,
    entry: Entry,
    scope: string[],
    dep: DependencyFilter | null,
  ): string[] | null {
    const meta = this.registry.tryTable(entry.table);
    const refCol = meta ? this.physical(meta, entry.referenced_field) : null;
    if (!meta || !refCol) return null;
    const rows = (item.lookup ?? [])
      .filter((l) => l && this.registry.isA(String(l.className), entry.table))
      .map((l) => entry.attributes.map((a) => text(l.values?.[a]).trim()))
      .filter((vals) => this.usableValues(vals, entry.allow_null_attribute));
    if (!rows.length) return null;
    if (dep && !dep.otherCi) return [];
    const perRow: Set<string>[] = rows.map((vals) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (meta.name !== meta.root || meta.parent) {
        where.push(`t0."sys_class_name" IN (${meta.descendants.map(() => '?').join(',')})`);
        params.push(...meta.descendants);
      }
      for (let k = 0; k < entry.attributes.length; k++) {
        const col = this.physical(meta, entry.attributes[k]);
        if (!col) return new Set<string>();
        where.push(this.equalsSql('t0', col, vals[k], params));
      }
      const found = this.platform.db
        .all<{ sys_id: string; ci: string | null }>(
          `SELECT t0."sys_id", t0.${quoteIdent(refCol.physical)} AS ci FROM ${quoteIdent(meta.physical)} t0 WHERE ${where.join(' AND ') || '1=1'}`,
          params as never[],
        )
        .filter((r) => r.ci);
      const kept = new Set(
        this.conditionFilter(
          meta.name,
          entry.condition,
          found.map((r) => r.sys_id),
        ),
      );
      return new Set(found.filter((r) => kept.has(r.sys_id)).map((r) => r.ci!));
    });
    const counts = new Map<string, number>();
    for (const set of perRow) for (const ci of set) counts.set(ci, (counts.get(ci) ?? 0) + 1);
    let ids: string[];
    if (entry.exact_count_match) ids = [...counts].filter(([, n]) => n === rows.length).map(([ci]) => ci);
    else {
      const max = Math.max(0, ...counts.values());
      ids = max ? [...counts].filter(([, n]) => n === max).map(([ci]) => ci) : [];
    }
    return this.inScope(ids, scope, dep);
  }

  private inScope(ids: string[], scope: string[], dep: DependencyFilter | null): string[] {
    if (!ids.length) return [];
    const params: unknown[] = [...ids, ...scope];
    const sql = `SELECT t0."sys_id" FROM "cmdb" t0 WHERE t0."sys_id" IN (${ids.map(() => '?').join(',')}) AND t0."sys_class_name" IN (${scope.map(() => '?').join(',')})${this.dependencySql(dep, params)} ORDER BY t0."sys_created_on", t0.rowid`;
    return this.platform.db.all<{ sys_id: string }>(sql, params as never[]).map((r) => r.sys_id);
  }

  // ------------------------------------------------- dependent identification

  private relType(ref: string): { sys_id: string; name: string } | null {
    if (!this.relTypes) {
      this.relTypes = this.platform.db.all<{ sys_id: string; name: string }>(
        `SELECT "sys_id","name" FROM "cmdb_rel_type"`,
      );
    }
    return (
      this.relTypes.find((t) => t.sys_id === ref) ??
      this.relTypes.find((t) => t.name.toLowerCase() === String(ref).toLowerCase()) ??
      null
    );
  }

  /** Resolves a relation end to an item index or an existing CI sys_id. */
  private end(ref: number | string): { index: number } | { ciId: string } | null {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const n = Number(ref);
      return n >= 0 && n < this.items.length ? { index: n } : null;
    }
    const byInternal = this.items.findIndex((it) => it?.internal_id === ref);
    if (byInternal >= 0) return { index: byInternal };
    if (isSysId(ref) && this.platform.db.get(`SELECT "sys_id" FROM "cmdb" WHERE "sys_id" = ?`, [ref]))
      return { ciId: ref };
    return null;
  }

  private classOfEnd(e: { index: number } | { ciId: string }): string {
    if ('index' in e) return String(this.items[e.index]?.className ?? '');
    return (
      this.platform.db.get<{ c: string }>(`SELECT "sys_class_name" AS c FROM "cmdb" WHERE "sys_id" = ?`, [
        e.ciId,
      ])?.c ?? ''
    );
  }

  private metadataRules(table: 'cmdb_metadata_hosting' | 'cmdb_metadata_containment') {
    return this.platform.db.all<{ parent_type: string; rel_type: string; child_type: string }>(
      `SELECT "parent_type","rel_type","child_type" FROM ${quoteIdent(table)} WHERE "active" IS NULL OR "active" = 1`,
    );
  }

  /** Finds the hosting/containment relation that a dependent item relies on, identifying the other end. */
  private dependency(i: number, depth: number): DependencyFilter {
    const itemClass = this.items[i].className;
    const hosting = this.metadataRules('cmdb_metadata_hosting');
    const containment = this.metadataRules('cmdb_metadata_containment');
    const found: { typeId: string; other: { index: number } | { ciId: string }; itemIsParent: boolean }[] =
      [];
    for (const rel of this.relations) {
      const type = this.relType(String(rel?.type ?? ''));
      const parent = this.end(rel?.parent);
      const child = this.end(rel?.child);
      if (!type || !parent || !child) continue;
      const isItem = (e: { index: number } | { ciId: string }) => 'index' in e && e.index === i;
      if (isItem(parent)) {
        const hostClass = this.classOfEnd(child);
        const ok = hosting.some(
          (h) =>
            h.rel_type === type.sys_id &&
            this.registry.isA(itemClass, h.parent_type) &&
            this.registry.isA(hostClass, h.child_type),
        );
        if (ok) found.push({ typeId: type.sys_id, other: child, itemIsParent: true });
      }
      if (isItem(child)) {
        const containerClass = this.classOfEnd(parent);
        const ok = containment.some(
          (c) =>
            c.rel_type === type.sys_id &&
            this.registry.isA(itemClass, c.child_type) &&
            this.registry.isA(containerClass, c.parent_type),
        );
        if (ok) found.push({ typeId: type.sys_id, other: parent, itemIsParent: false });
      }
    }
    if (!found.length)
      throw new IreError(
        'MISSING_DEPENDENCY',
        `${itemClass} needs a hosting or containment relation to identify it`,
      );
    if (found.length > 1)
      throw new IreError(
        'MULTIPLE_DEPENDENCIES',
        `${itemClass} has more than one hosting or containment relation`,
      );
    const dep = found[0];
    let otherCi: string | null;
    if ('ciId' in dep.other) otherCi = dep.other.ciId;
    else {
      const res = this.identify(dep.other.index, depth + 1);
      if (res.error)
        throw new IreError(
          'MISSING_DEPENDENCY',
          `The CI this item depends on could not be identified (${res.error.error})`,
        );
      otherCi = res.ciId;
    }
    return { typeId: dep.typeId, otherCi, itemIsParent: dep.itemIsParent };
  }

  // ------------------------------------------------------- de-duplication

  /** Picks the oldest of a duplicate set (or fails), flags the others and opens a de-duplication task. */
  private dedupe(i: number, candidates: string[]): string {
    const ordered = this.platform.db
      .all<{ sys_id: string }>(
        `SELECT "sys_id" FROM "cmdb" WHERE "sys_id" IN (${candidates.map(() => '?').join(',')}) ORDER BY "sys_created_on", rowid`,
        candidates,
      )
      .map((r) => r.sys_id);
    const main = ordered[0];
    if (!this.opts.dryRun) this.deduplicationTask(main, ordered);
    const threshold = this.platform.properties.getNumber(
      'glide.identification_engine.skip_duplicates.threshold',
      5,
    );
    if (!this.prop('glide.identification_engine.skip_duplicates', true) || ordered.length >= threshold) {
      throw new IreError(
        'MULTIPLE_DUPLICATE_RECORDS',
        `${ordered.length} CIs match ${this.items[i].className} with the same identifier values`,
      );
    }
    if (!this.opts.dryRun) {
      const sys = this.ctx.elevated();
      for (const id of ordered.slice(1)) {
        const dup = sys.get('cmdb', id);
        if (dup && dup.str('duplicate_of') !== main) sys.update(dup, { duplicate_of: main });
      }
    }
    this.results[i].warnings.push(
      msg('MULTI_MATCH', `Matched ${ordered.length} duplicate CIs; using the oldest`),
    );
    return main;
  }

  private deduplicationTask(main: string, all: string[]): void {
    if (!this.registry.has('reconcile_duplicate_task')) return;
    const sys = this.ctx.elevated();
    const open = sys.first('reconcile_duplicate_task', `active=true^cmdb_ci=${main}`);
    const list = [...new Set([...(open?.str('duplicates').split(',').filter(Boolean) ?? []), ...all])].join(
      ',',
    );
    if (open) {
      if (open.str('duplicates') !== list) sys.update(open, { duplicates: list });
      return;
    }
    const name =
      this.platform.db.get<{ name: string }>(`SELECT "name" FROM "cmdb" WHERE "sys_id" = ?`, [main])?.name ??
      main;
    sys.insert('reconcile_duplicate_task', {
      short_description: `Duplicate configuration items found for ${name}`,
      description: `Identification matched ${all.length} configuration items with the same identifier values. Review and merge or retire the duplicates.`,
      cmdb_ci: main,
      duplicates: list,
    });
  }

  /** Two payload items that resolve to the same existing CI. */
  private markPayloadDuplicates(): void {
    const seen = new Map<string, number>();
    this.items.forEach((_, i) => {
      const id = this.identified.get(i)?.ciId;
      if (!id) return;
      const first = seen.get(id);
      if (first === undefined) {
        seen.set(id, i);
        return;
      }
      if (this.settings.deduplicatePayloads) return;
      this.fail(i, 'DUPLICATE_PAYLOAD_RECORDS', `Item ${i} identifies the same CI as item ${first}`);
    });
  }

  // ------------------------------------------------------------- writes

  private write(i: number): void {
    const id = this.identified.get(i);
    const res = this.results[i];
    if (!id || id.error || res.errors.length) return;
    try {
      this.platform.db.tx(() => {
        const ci = id.ciId ? this.update(i, id.ciId) : this.insert(i);
        res.sysId = ci.sysId;
        res.className = ci.className;
        res.identifierEntrySysId = id.entryId;
        this.identified.set(i, { ...id, ciId: ci.sysId });
        this.upsertChildren(i, ci);
        this.recordSource(i, ci);
      });
    } catch (e) {
      res.operation = 'NONE';
      res.sysId = null;
      if (e instanceof IreError) res.errors.push(msg(e.code, e.message));
      else if (e instanceof AbortError || e instanceof AccessError || e instanceof InvalidError)
        res.errors.push(msg('INVALID_INPUT_DATA', e.message));
      else throw e;
    }
  }

  /** Values limited to the columns of a class (unknown and system fields dropped). */
  private columnValues(meta: TableMeta, values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const col = meta.columns.get(k);
      if (!col || col.system || !col.storage) continue;
      out[k] = v;
    }
    return out;
  }

  private insert(i: number): Rec {
    const item = this.items[i];
    const meta = this.registry.table(item.className);
    const values = this.columnValues(meta, item.values);
    if (this.prop('glide.required.attribute.enabled', true)) {
      const missing = [...meta.columns.values()].filter(
        (c) => c.mandatory && !c.system && !c.readOnly && c.storage && isEmpty(values[c.name]),
      );
      if (missing.length)
        throw new IreError(
          'REQUIRED_ATTRIBUTE_EMPTY',
          `Mandatory attributes are empty: ${missing.map((c) => c.name).join(', ')}`,
        );
    }
    const now = nowGlide();
    values.discovery_source = this.opts.source;
    values.first_discovered = isEmpty(values.first_discovered) ? now : values.first_discovered;
    values.last_discovered = isEmpty(values.last_discovered) ? now : values.last_discovered;
    delete values.duplicate_of;
    const ci = this.ctx.insert(item.className, values);
    this.touchSource(ci.sysId);
    this.results[i].operation = 'INSERT';
    return ci;
  }

  private reclassAllowed(kind: ReclassKind): boolean {
    const flag = {
      upgrade: this.settings.updateWithoutUpgrade,
      downgrade: this.settings.updateWithoutDowngrade,
      switch: this.settings.updateWithoutSwitch,
    }[kind];
    if (typeof flag === 'boolean') return !flag;
    return this.prop(`glide.class.${kind}.enabled`, true);
  }

  private update(i: number, ciId: string): Rec {
    const item = this.items[i];
    let ci = this.ctx.get('cmdb', ciId);
    if (!ci) throw new IreError('INVALID_INPUT_DATA', `CI ${ciId} is not accessible`);
    let operation: IreOperation = 'UPDATE';
    if (ci.className !== item.className) {
      const kind = reclassKind(this.registry, ci.className, item.className);
      if (this.reclassAllowed(kind)) {
        ci = reclassify(this.ctx, ci, item.className);
        operation = `UPDATE_WITH_${kind.toUpperCase()}` as IreOperation;
      } else {
        this.results[i].warnings.push(
          msg(
            'RECLASSIFICATION_NOT_ALLOWED',
            `Class ${kind} from ${ci.className} to ${item.className} is not allowed`,
          ),
        );
        this.reclassificationTask(ci, item.className, kind);
      }
    }
    const values = this.columnValues(ci.table, item.values);
    delete values.first_discovered;
    delete values.discovery_source;
    delete values.duplicate_of;
    const incomingLast = values.last_discovered;
    delete values.last_discovered;
    const allowed = this.reconcile(ci, values);
    const changed = Object.keys(allowed).filter((f) => this.differs(ci!, f, allowed[f]));
    const patch: Record<string, unknown> = {};
    for (const f of changed) patch[f] = allowed[f];
    if (changed.length && ci.str('duplicate_of')) patch.duplicate_of = null;
    patch.discovery_source = this.opts.source;
    patch.last_discovered = this.lastDiscovered(ci, incomingLast);
    this.ctx.update(ci, patch);
    this.touchSource(ci.sysId);
    if (operation === 'UPDATE' && !changed.length) operation = 'NO_CHANGE';
    this.results[i].operation = operation;
    return ci;
  }

  /** A payload last_discovered is applied only when newer; without one the CI is stamped now. */
  private lastDiscovered(ci: Rec, incoming: unknown): string {
    const current = ci.str('last_discovered');
    if (isEmpty(incoming)) return nowGlide();
    const parsed = parseGlideDateTime(text(incoming));
    if (!parsed) return nowGlide();
    const value = toGlideDateTime(parsed);
    if (current && diffMs(value, current) <= 0) return current;
    return value;
  }

  private differs(ci: Rec, field: string, value: unknown): boolean {
    const probe = this.ctx.newRecord(ci.className);
    probe.set(field, value);
    const a = ci.get(field);
    const b = probe.get(field);
    return String(a ?? '') !== String(b ?? '');
  }

  private reclassificationTask(ci: Rec, target: string, kind: string): void {
    if (!this.registry.has('resolvr_reclassification_task')) return;
    const sys = this.ctx.elevated();
    if (sys.first('resolvr_reclassification_task', `active=true^cmdb_ci=${ci.sysId}^target_class=${target}`))
      return;
    sys.insert('resolvr_reclassification_task', {
      short_description: `Reclassify ${ci.str('name') || ci.sysId} from ${ci.className} to ${target}`,
      description: `Discovery source ${this.opts.source} reported this CI as ${target}, but a class ${kind} is not allowed by configuration.`,
      cmdb_ci: ci.sysId,
      current_class: ci.className,
      target_class: target,
      reclassification_type: kind,
      source: this.opts.source,
    });
  }

  // ------------------------------------------------------- reconciliation

  private definitions(): Record<string, unknown>[] {
    return this.platform.db.all<Record<string, unknown>>(
      `SELECT * FROM "cmdb_reconciliation_definition" WHERE "active" IS NULL OR "active" = 1`,
    );
  }

  private listed(v: unknown): string[] {
    return String(v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Static rules governing one attribute of a CI (nearest class first, attribute-specific first). */
  private governing(ci: Rec, attr: string, defs: Record<string, unknown>[]): Record<string, unknown>[] {
    const applicable = defs.filter((d) => {
      const filter = String(d.filter_condition ?? '');
      return !filter || matches(filter, recSubject(ci, null, this.registry), this.ctx.env);
    });
    for (const cls of ci.table.ancestors) {
      const atLevel = applicable.filter((d) => d.applies_to === cls);
      const specific = atLevel.filter((d) => this.listed(d.attributes).includes(attr));
      if (specific.length) return specific;
      const all = atLevel.filter((d) => this.listed(d.attributes).length === 0);
      if (all.length) return all;
    }
    return [];
  }

  private lastUpdate(ciId: string, source: string): string | null {
    return (
      this.platform.db.get<{ t: string | null }>(
        `SELECT MAX("last_updated") AS t FROM "cmdb_datasource_last_update" WHERE "ci" = ? AND "source" = ?`,
        [ciId, source],
      )?.t ?? null
    );
  }

  /** A source's claim on a CI is stale once its data refresh rule duration has elapsed. */
  private stale(ci: Rec, source: string, lastUpdated: string): boolean {
    for (const cls of ci.table.ancestors) {
      const rule = this.platform.db.get<{ d: number | null }>(
        `SELECT "effective_duration" AS d FROM "cmdb_data_refresh_rule" WHERE "applies_to" = ? AND "discovery_source" = ? AND ("active" IS NULL OR "active" = 1) LIMIT 1`,
        [cls, source],
      );
      if (rule) return diffMs(nowGlide(), lastUpdated) >= Number(rule.d ?? 0);
    }
    return false;
  }

  /** Returns the subset of values the source may write. */
  reconcile(ci: Rec, values: Record<string, unknown>): Record<string, unknown> {
    const defs = this.definitions();
    if (!defs.length) return values;
    const src = this.opts.source;
    const out: Record<string, unknown> = {};
    for (const [attr, value] of Object.entries(values)) {
      const governing = this.governing(ci, attr, defs);
      if (!governing.length) {
        out[attr] = value;
        continue;
      }
      const own = governing.find((d) => d.discovery_source === src);
      if (!own) continue;
      const currentEmpty = isEmpty(ci.get(attr));
      if (isEmpty(value) && !currentEmpty && !this.listed(own.update_with_null).includes(attr)) continue;
      const blocked = governing.some((d) => {
        if (d.discovery_source === src || Number(d.priority ?? 100) >= Number(own.priority ?? 100))
          return false;
        const last = this.lastUpdate(ci.sysId, String(d.discovery_source));
        return !!last && !this.stale(ci, String(d.discovery_source), last);
      });
      if (blocked && !(currentEmpty && this.prop('glide.reconciliation.override.null', true))) continue;
      out[attr] = value;
    }
    return out;
  }

  private touchSource(ciId: string): void {
    const sys = this.ctx.elevated();
    const existing = sys.first('cmdb_datasource_last_update', `ci=${ciId}^source=${this.opts.source}`);
    if (existing) sys.update(existing, { last_updated: nowGlide() });
    else
      sys.insert('cmdb_datasource_last_update', {
        ci: ciId,
        source: this.opts.source,
        last_updated: nowGlide(),
      });
  }

  // ------------------------------------------------ lookup / related rows

  private upsertChildren(i: number, ci: Rec): void {
    const item = this.items[i];
    const rule = this.ruleFor(ci.className);
    const entries = rule ? this.entries(rule.sys_id).filter((e) => e.table) : [];
    const related = rule
      ? this.platform.db.all<Record<string, unknown>>(
          `SELECT * FROM "cmdb_related_entry" WHERE "identifier" = ? AND ("active" IS NULL OR "active" = 1) ORDER BY "order"`,
          [rule.sys_id],
        )
      : [];
    for (const l of item.lookup ?? []) {
      const entry = entries.find((e) => this.registry.isA(String(l?.className), e.table));
      if (!entry) {
        this.results[i].warnings.push(
          msg('IDENTIFICATION_RULE_FOR_LOOKUP_MISSING', `No lookup entry for ${l?.className}`),
        );
        continue;
      }
      this.upsertChild(
        String(l.className),
        entry.referenced_field,
        entry.attributes,
        l.values ?? {},
        ci.sysId,
      );
    }
    for (const r of item.related ?? []) {
      const entry = related.find((e) => this.registry.isA(String(r?.className), String(e.table)));
      if (!entry) {
        this.results[i].warnings.push(
          msg('IDENTIFICATION_RULE_FOR_RELATED_ITEM_MISSING', `No related entry for ${r?.className}`),
        );
        continue;
      }
      this.upsertChild(
        String(r.className),
        String(entry.referenced_field),
        this.listed(entry.attributes),
        r.values ?? {},
        ci.sysId,
      );
    }
  }

  private upsertChild(
    table: string,
    refField: string,
    keys: string[],
    values: Record<string, unknown>,
    ciId: string,
  ): void {
    if (!this.registry.has(table) || !refField) return;
    const sys = this.ctx.elevated();
    const query = [
      `${refField}=${ciId}`,
      ...keys.map((k) => `${k}=${text(values[k]).replace(/\^/g, '^^')}`),
    ].join('^');
    const existing = sys.first(table, query);
    const meta = this.registry.table(table);
    const clean = this.columnValues(meta, values);
    if (existing) sys.update(existing, clean);
    else sys.insert(table, { ...clean, [refField]: ciId });
  }

  private recordSource(i: number, ci: Rec): void {
    const info = this.items[i].sys_object_source_info;
    if (!info?.source_name || !info.source_native_key) return;
    const sys = this.ctx.elevated();
    const existing = sys.first('sys_object_source', `name=${info.source_name}^id=${info.source_native_key}`);
    const values = { target_table: ci.className, target_sys_id: ci.sysId, last_scan: nowGlide() };
    if (existing) sys.update(existing, values);
    else sys.insert('sys_object_source', { name: info.source_name, id: info.source_native_key, ...values });
  }

  // ------------------------------------------------------------ relations

  private resolveEnd(ref: number | string): string | null {
    const e = this.end(ref);
    if (!e) return null;
    if ('ciId' in e) return e.ciId;
    return this.results[e.index].sysId;
  }

  private writeRelation(rel: IreRelation): IreRelationResult {
    const out: IreRelationResult = {
      className: 'cmdb_rel_ci',
      operation: 'NONE',
      sysId: null,
      type: String(rel?.type ?? ''),
      errors: [],
    };
    const type = this.relType(String(rel?.type ?? ''));
    const parent = this.resolveEnd(rel?.parent);
    const child = this.resolveEnd(rel?.child);
    if (!type) out.errors.push(msg('INVALID_INPUT_DATA', `Unknown relationship type ${rel?.type}`));
    else if (!parent || !child)
      out.errors.push(msg('INVALID_INPUT_DATA', 'A relation end was not identified'));
    if (out.errors.length) return out;
    try {
      const { rel: row, created } = upsertRelation(this.ctx, parent!, child!, type!.sys_id, rel.port ?? '');
      out.sysId = row;
      out.operation = created ? 'INSERT' : 'NO_CHANGE';
      if (this.prop('glide.identification_engine.populate_sys_rel_source', false)) {
        this.ctx
          .elevated()
          .insert('sys_rel_source', { rel: row, source: this.opts.source, last_scan: nowGlide() });
      }
    } catch (e) {
      if (e instanceof AbortError || e instanceof AccessError || e instanceof InvalidError)
        out.errors.push(msg('INVALID_INPUT_DATA', e.message));
      else throw e;
    }
    return out;
  }
}

/** Finds or creates a relationship row; returns its sys_id. */
export function upsertRelation(
  ctx: Context,
  parent: string,
  child: string,
  type: string,
  port = '',
): { rel: string; created: boolean } {
  const existing = ctx.platform.db.get<{ sys_id: string }>(
    `SELECT "sys_id" FROM "cmdb_rel_ci" WHERE "parent" = ? AND "child" = ? AND "type" = ? AND COALESCE("port", '') = ?`,
    [parent, child, type, port],
  );
  if (existing) return { rel: existing.sys_id, created: false };
  const rec = ctx.insert('cmdb_rel_ci', { parent, child, type, port: port || null });
  return { rel: rec.sysId, created: true };
}

export function runIre(ctx: Context, payload: IrePayload, opts: IreOptions): IreOutput {
  return ctx.platform.db.tx(() => new IreRun(ctx, payload, opts).run());
}
