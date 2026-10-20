import type { Context } from '../../engine/context.js';
import { AbortError, AccessError, InvalidError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { SchemaError } from '../../engine/registry.js';
import type { ColumnMeta, TableMeta } from '../../engine/types.js';
import { isSysId, nowGlide } from '../../engine/util.js';

export const IMPORT_SET_SERVICE = 'importset';
export const STAGING_BASE = 'sys_import_set_row';

export type RowStatus = 'inserted' | 'updated' | 'ignored' | 'skipped' | 'error';

/** Outcome of one transform map for one staging row (the Import Set API `result[]` entry). */
export interface TransformResult {
  transform_map: string;
  table: string;
  display_name: string;
  display_value: string;
  status: RowStatus;
  sys_id: string;
  status_message?: string;
  error_message?: string;
  [extra: string]: unknown;
}

export interface TransformHookArgs {
  ctx: Context;
  map: Rec;
  source: Rec;
  target: Rec | null;
  result: TransformResult;
}

/** Native transform logic: may set status_message, error_message or extra response fields. */
export type TransformHook = (args: TransformHookArgs) => void;

const esc = (v: string) => v.replace(/\^/g, '^^');

/**
 * Loads staging rows into import sets and transforms them into target tables with
 * transform maps. Field maps support coalesce keys (update instead of insert), reference
 * lookups by display value or a named field, and the create / reject / ignore actions for
 * unknown choice and reference values.
 */
export class ImportSetService {
  private hooks = new Map<string, TransformHook[]>();

  constructor(private platform: Platform) {}

  onTransform(mapName: string, hook: TransformHook): void {
    const list = this.hooks.get(mapName) ?? [];
    list.push(hook);
    this.hooks.set(mapName, list);
  }

  isStagingTable(table: string): boolean {
    return table !== STAGING_BASE && this.platform.registry.isA(table, STAGING_BASE);
  }

  /** The open synchronous import set of a staging table (created on first use each day). */
  syncImportSet(ctx: Context, staging: string): Rec {
    const sys = ctx.asSystem();
    const open = sys.first(
      'sys_import_set',
      `table_name=${esc(staging)}^mode=synchronous^state=loading^sys_created_on>=javascript:gs.daysAgoStart(0)`,
      [{ field: 'sys_created_on', desc: true }],
    );
    return open ?? this.createImportSet(ctx, staging, 'synchronous');
  }

  createImportSet(
    ctx: Context,
    staging: string,
    mode: 'synchronous' | 'asynchronous',
    opts: { multiImportSet?: string; runAfter?: string } = {},
  ): Rec {
    return ctx.elevated().insert('sys_import_set', {
      table_name: staging,
      mode,
      state: 'loading',
      short_description: `REST import into ${staging}`,
      multi_import_set: opts.multiImportSet ?? null,
      run_after: opts.runAfter ?? null,
      row_count: 0,
    });
  }

  createMultiImportSet(ctx: Context, staging: string): Rec {
    return ctx
      .elevated()
      .insert('sys_multi_import_set', {
        state: 'loading',
        short_description: `REST insertMultiple into ${staging}`,
      });
  }

  /** Inserts one staging row into an import set. */
  insertRow(ctx: Context, importSet: Rec, staging: string, values: Record<string, string>): Rec {
    const n = (importSet.num('row_count') ?? 0) + 1;
    const row = ctx.elevated().insert(staging, {
      ...values,
      sys_import_set: importSet.sysId,
      sys_import_row: n,
      sys_import_state: 'pending',
    });
    ctx.asSystem().update(importSet, { row_count: n });
    return row;
  }

  markLoaded(ctx: Context, importSet: Rec): void {
    ctx
      .asSystem()
      .update(importSet, {
        state: importSet.str('mode') === 'synchronous' ? 'loading' : 'loaded',
        load_completed: nowGlide(),
      });
  }

  /** Transforms every pending row of an import set, then marks the set processed. */
  transformSet(ctx: Context, importSetId: string): void {
    const sys = ctx.asSystem();
    const set = sys.get('sys_import_set', importSetId);
    if (!set) return;
    const rows = sys.query(STAGING_BASE, {
      query: `sys_import_set=${importSetId}^sys_import_state=pending^ORDERBYsys_import_row`,
    });
    for (const row of rows) this.transformRow(ctx, row);
    sys.update(set, { state: 'processed', processed: nowGlide() });
  }

  /** Runs the active transform maps of the row's staging table, in order, and records the results. */
  transformRow(ctx: Context, row: Rec): TransformResult[] {
    const sys = ctx.asSystem();
    const maps = sys.query('sys_transform_map', {
      query: `source_table=${esc(row.className)}^active=true^ORDERBYorder^ORDERBYname`,
    });
    const results = maps.map((m) => this.applyMap(ctx, m, row));
    const last = results[results.length - 1];
    const lastMap = maps[maps.length - 1];
    sys.update(row, {
      sys_import_state: last?.status ?? 'ignored',
      sys_import_state_comment: last
        ? (last.status_message ?? last.error_message ?? '')
        : 'No active transform map for this staging table',
      sys_target_table: last?.table ?? '',
      sys_target_sys_id: last?.sys_id ?? '',
      sys_transform_map: lastMap?.sysId ?? '',
      sys_row_error: last?.error_message ?? '',
      resolvr_transform_results: JSON.stringify(results),
    });
    return results;
  }

  /** Results recorded on a staging row by its last transform. */
  results(row: Rec): TransformResult[] {
    try {
      const v = JSON.parse(row.str('resolvr_transform_results') || '[]');
      return Array.isArray(v) ? (v as TransformResult[]) : [];
    } catch {
      return [];
    }
  }

  private resolveReference(
    wctx: Context,
    target: TableMeta,
    col: ColumnMeta,
    raw: string,
    valueField: string,
    action: string,
  ): string | null | 'reject' {
    const refTable = col.reference ? this.platform.registry.tryTable(col.reference) : undefined;
    if (!refTable) return null;
    const byField = valueField && refTable.columns.get(valueField)?.storage ? valueField : '';
    let id: string | undefined;
    if (byField) {
      id = wctx.asSystem().first(refTable.name, `${byField}=${esc(raw)}`)?.sysId;
    } else {
      const r = wctx.resolveInput(target, col, raw);
      if (typeof r === 'string') id = r;
    }
    if (id) return id;
    if (action === 'reject') return 'reject';
    if (action === 'ignore') return null;
    const field = byField || refTable.displayField;
    if (!refTable.columns.get(field)?.storage) return null;
    return wctx.insert(refTable.name, { [field]: raw }).sysId;
  }

  private applyMap(ctx: Context, map: Rec, row: Rec): TransformResult {
    const sys = ctx.asSystem();
    const target = this.platform.registry.tryTable(map.str('target_table'));
    const result: TransformResult = {
      transform_map: map.str('name'),
      table: map.str('target_table'),
      display_name: target?.displayField ?? '',
      display_value: '',
      status: 'error',
      sys_id: '',
    };
    if (!target)
      return { ...result, error_message: `Target table ${map.str('target_table')} does not exist` };
    const wctx = ctx.elevated();
    wctx.workflow = map.get('run_business_rules') === null ? true : map.bool('run_business_rules');
    const copyEmpty = map.bool('copy_empty_fields');
    const entries = sys.query('sys_transform_entry', { query: `map=${map.sysId}` });
    const values: Record<string, unknown> = {};
    const coalesce: string[] = [];
    for (const e of entries) {
      const tgt = e.str('target_field');
      const col = target.columns.get(tgt);
      if (!col || col.system) continue;
      const src = e.str('source_field');
      const raw = src && (src.includes('.') || row.has(src)) ? row.str(src) : '';
      if (e.bool('coalesce')) coalesce.push(tgt);
      if (raw === '' && !copyEmpty) continue;
      const action = e.str('choice_action') || 'create';
      if (raw !== '' && col.type === 'reference' && !isSysId(raw)) {
        const id = this.resolveReference(wctx, target, col, raw, e.str('reference_value_field'), action);
        if (id === 'reject') {
          return {
            ...result,
            status: 'skipped',
            status_message: `No ${col.reference} record matches '${raw}' for ${tgt}`,
          };
        }
        if (id !== null) values[tgt] = id;
        continue;
      }
      if (raw !== '' && this.platform.choices.hasChoices(target.name, tgt)) {
        const resolved = this.platform.choices.resolve(target.name, tgt, raw);
        if (resolved !== undefined) {
          values[tgt] = resolved;
          continue;
        }
        if (action === 'reject')
          return {
            ...result,
            status: 'skipped',
            status_message: `'${raw}' is not a valid choice for ${tgt}`,
          };
        if (action === 'ignore') continue;
      }
      values[tgt] = raw;
    }

    const keys = coalesce.filter((k) => values[k] !== undefined && values[k] !== '');
    const existing = keys.length
      ? sys.first(target.name, keys.map((k) => `${k}=${esc(String(values[k]))}`).join('^'))
      : null;

    const mandatory = map.str('enforce_mandatory_fields');
    if (mandatory === 'onlyMappedFields' || mandatory === 'allFields') {
      const mapped = new Set(entries.map((e) => e.str('target_field')));
      const missing = [...target.columns.values()]
        .filter((c) => c.mandatory && !c.system && (mandatory === 'allFields' || mapped.has(c.name)))
        .filter((c) => {
          const v = values[c.name] ?? existing?.get(c.name);
          return v === undefined || v === null || v === '';
        })
        .map((c) => c.name);
      if (missing.length)
        return { ...result, error_message: `Mandatory fields are not populated: ${missing.join(', ')}` };
    }

    let rec: Rec | null = null;
    try {
      if (existing) {
        const cur = wctx.derive({ acl: false }).get(existing.className, existing.sysId) ?? existing;
        cur.setMany(values);
        const changed = cur.changes().filter((f) => !cur.column(f)?.system).length > 0;
        if (changed) {
          wctx.update(cur);
          result.status = 'updated';
        } else {
          result.status = 'ignored';
          result.status_message = 'No field values changed';
        }
        rec = cur;
      } else {
        rec = wctx.insert(target.name, values);
        result.status = 'inserted';
      }
      result.sys_id = rec.sysId;
      result.display_value = rec.displayValue();
    } catch (e) {
      if (
        e instanceof AbortError ||
        e instanceof InvalidError ||
        e instanceof AccessError ||
        e instanceof SchemaError
      ) {
        return { ...result, status: 'error', error_message: e.message };
      }
      throw e;
    }
    for (const hook of [...(this.hooks.get(map.str('name')) ?? []), ...(this.hooks.get('*') ?? [])]) {
      try {
        hook({ ctx: wctx, map, source: row, target: rec, result });
      } catch (e) {
        result.status = 'error';
        result.error_message = e instanceof Error ? e.message : String(e);
      }
    }
    return result;
  }
}

export function importSets(platform: Platform): ImportSetService {
  return platform.service<ImportSetService>(IMPORT_SET_SERVICE);
}
