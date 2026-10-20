/**
 * Record producers (spec section 8): a catalog form that creates a record in its
 * target table (for example an incident) with the answers mapped onto fields.
 */
import { HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import { optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { CatalogAccess, type CatalogView, hasCode } from './access.js';
import { PRODUCER_FORBIDDEN_TABLES, T, VT } from './constants.js';
import { catalogListeners } from './listeners.js';
import { throwVariableErrors } from './ordering.js';
import { noAccess } from './util.js';
import { type Answers, encryptMasked, type ItemForm, loadForm, validateAnswers } from './variables.js';

export interface ProducerInput {
  variables?: Record<string, unknown>;
  view?: CatalogView;
  portal?: boolean;
  /** sys_attachment ids uploaded by the caller to move onto the generated record. */
  attachments?: string[];
}

export interface ProducerResult {
  record: Rec;
  table: string;
  produced: Rec | null;
}

/** True when a producer may not target the table (requests, requested items, catalog tasks and their children). */
export function isForbiddenTarget(platform: Platform, table: string): boolean {
  const meta = platform.registry.tryTable(table);
  if (!meta) return PRODUCER_FORBIDDEN_TABLES.includes(table as (typeof PRODUCER_FORBIDDEN_TABLES)[number]);
  return meta.ancestors.some((t) => (PRODUCER_FORBIDDEN_TABLES as readonly string[]).includes(t));
}

/** Applies `field=value^field=value` assignments to a new record. */
export function applyTemplate(rec: Rec, template: string): void {
  for (const part of template.split('^')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const field = part.slice(0, idx).trim();
    if (rec.has(field) && !rec.column(field)?.system) rec.set(field, part.slice(idx + 1));
  }
}

const BOOLEAN_TYPES = new Set(['boolean']);

/** Maps answers onto fields: a variable named like a field, or with Map to field + Field. */
export function mapAnswers(rec: Rec, form: ItemForm, answers: Answers): string[] {
  const mapped: string[] = [];
  for (const def of form.vars) {
    if (!def.info.data) continue;
    const value = answers.values[def.name] ?? '';
    if (value === '') continue;
    const field = def.mapToField && def.field ? def.field : def.name;
    const col = rec.column(field);
    if (!col || col.system || field === 'number' || field === 'sys_id') continue;
    let v: unknown = value;
    if (BOOLEAN_TYPES.has(col.type)) v = value === 'Yes' || value === 'true';
    rec.set(field, v);
    mapped.push(field);
  }
  return mapped;
}

function runScript(
  ctx: Context,
  script: string,
  current: Rec,
  producer: Rec,
  answers: Answers,
  where: string,
): void {
  if (!hasCode(script)) return;
  const scripts = optionalService<ScriptService>(ctx.platform, SERVICES.scripts);
  if (!scripts) return;
  try {
    scripts.run(ctx, script, {
      current,
      vars: { producer: { ...answers.values }, cat_item: producer.sysId },
    });
  } catch (e) {
    throw new HttpError(400, 'Record producer script failed', `${where}: ${(e as Error).message}`);
  }
}

/** Runs a record producer (spec 8, submit algorithm). */
export function submitProducer(ctx: Context, producer: Rec, input: ProducerInput = {}): ProducerResult {
  const access = new CatalogAccess(ctx);
  if (!access.canViewItem(producer, { view: input.view, portal: input.portal })) throw noAccess();
  const table = producer.str('table_name');
  const platform = ctx.platform;
  if (!table || !platform.registry.has(table))
    throw new HttpError(400, 'Invalid record producer', `Target table "${table}" is not installed`);
  if (isForbiddenTarget(platform, table))
    throw new HttpError(
      400,
      'Invalid record producer',
      'Record producers cannot create requests, requested items or catalog tasks',
    );
  const form = loadForm(ctx, producer);
  const { answers, errors } = validateAnswers(ctx, form, input.variables ?? {});
  throwVariableErrors(errors);
  return platform.db.tx(() => {
    const sys = ctx.elevated();
    const rec = sys.newRecord(table);
    applyTemplate(rec, producer.str('resolvr_template'));
    mapAnswers(rec, form, answers);
    if (rec.has('contact_type') && !rec.str('contact_type')) rec.set('contact_type', 'self-service');
    runScript(sys, producer.str('script'), rec, producer, answers, 'Script');
    if (rec.abortMessage) throw new HttpError(400, 'Record producer aborted', rec.abortMessage);
    sys.insert(rec);
    for (const def of form.vars) {
      if (!def.info.data) continue;
      const value = answers.values[def.name] ?? '';
      sys.insert(T.answer, {
        table_name: table,
        table_sys_id: rec.sysId,
        question: def.id,
        value: def.type === VT.masked && def.useEncryption ? encryptMasked(platform, value) : value,
        order: def.order,
      });
    }
    for (const set of form.mrvs) {
      (answers.rows[set.internalName] ?? []).forEach((row, i) => {
        for (const def of set.vars) {
          sys.insert(T.mrvsAnswer, {
            parent_table_name: table,
            parent_id: rec.sysId,
            variable_set: set.id,
            item_option_new: def.id,
            row_index: `${String(i).padStart(4, '0')}${rec.sysId.slice(0, 28)}`,
            value: row[def.name] ?? '',
            order: def.order,
          });
        }
      });
    }
    const produced = sys.insert(T.produced, {
      producer: producer.sysId,
      record_table: table,
      record_key: rec.sysId,
      task: rec.table.ancestors.includes('task') ? rec.sysId : null,
    });
    if (platform.registry.has('sys_attachment')) {
      for (const id of input.attachments ?? []) {
        const a = isSysId(id) ? sys.get('sys_attachment', id) : null;
        if (a && a.str('sys_created_by') === ctx.user.userName)
          sys.update(a, { table_name: table, table_sys_id: rec.sysId });
      }
    }
    const fresh = sys.get(table, rec.sysId) ?? rec;
    if (hasCode(producer.str('post_insert_script'))) {
      runScript(sys, producer.str('post_insert_script'), fresh, producer, answers, 'Post-insert script');
      if (fresh.changes().length) sys.update(fresh);
    }
    const result = { record: sys.get(table, rec.sysId) ?? fresh, table, produced };
    catalogListeners(platform).emit({ kind: 'producer', ctx, item: producer, record: result.record });
    return result;
  });
}

/** Service Catalog API response of submit_producer (spec 14.3). */
export function producerResponse(result: ProducerResult, producer: Rec): Record<string, unknown> {
  const { record, table } = result;
  const home = producer.str('redirect_url') === 'catalog_home';
  return {
    sys_id: record.sysId,
    number: record.has('number') ? record.str('number') : '',
    table,
    record: `api/now/table/${table}/${record.sysId}`,
    redirect_url: home
      ? 'catalog_home.do?sysparm_view=catalog_default'
      : `${table}.do?sys_id=${record.sysId}&sysparm_view=ess`,
    redirect_portal_url: '',
    redirect_to: home ? 'catalog_home' : 'generated_record',
    parent_id: null,
    parent_table: 'task',
  };
}
