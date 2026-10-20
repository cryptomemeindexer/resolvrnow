/** Asset State/Substate lifecycle, model category resolution and derived fields (asset.md 2 to 4, 6.10). */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { clock, nowGlide, toGlideDate } from '../../engine/util.js';
import { lifeCyclePair } from '../cmdb/seed.js';
import { ASSET_STATE, defaultSubstate, isValidSubstate } from '../cmdb/status.js';
import {
  assetClassOf,
  category,
  isSync,
  isUserWrite,
  lifeCycleSyncEnabled,
  modelInfo,
  setResolvedClass,
} from './sync.js';

const today = () => toGlideDate(clock.now());

/** True when the caller wrote the field in this operation with a new value. */
function callerSet(cur: Rec, field: string): boolean {
  return cur.touched.has(field) && (cur.isNew() ? cur.str(field) !== '' : cur.changed(field));
}

function prevState(cur: Rec): number | null {
  if (cur.isNew()) return null;
  const v = cur.prev('install_status');
  return v === null || v === '' ? null : Number(v);
}

// ------------------------------------------------- category and class

/** Fills or validates model_category and resolves the asset class of base-table inserts (2.4, 4). */
export function resolveModelCategory(cur: Rec, ctx: Context): void {
  const model = modelInfo(ctx, cur.str('model'));
  if (!model) return;
  const userWrite = isUserWrite(ctx);
  if (!cur.str('model_category')) {
    if (model.categories.length === 1) cur.setRaw('model_category', model.categories[0]);
    else if (model.categories.length > 1 && userWrite && cur.isNew()) {
      cur.abort('The model belongs to several categories: choose a model category');
      return;
    }
  } else if (
    (cur.isNew() || cur.changed('model_category') || cur.changed('model')) &&
    model.categories.length &&
    !model.categories.includes(cur.str('model_category')) &&
    userWrite
  ) {
    cur.abort("The model category must be one of the model's categories");
    return;
  }
  if (!cur.isNew() || cur.className !== 'alm_asset') return;
  const target =
    model.strategy === 'track_as_consumable'
      ? 'alm_consumable'
      : category(ctx, cur.str('model_category'))?.asset_class;
  if (target && target !== 'alm_asset' && ctx.registry.isA(target, 'alm_asset'))
    setResolvedClass(cur, target);
}

/** Moves a base-table insert to its resolved class (the engine stores the inserted table's class). */
export function applyResolvedClass(cur: Rec, ctx: Context): void {
  const cls = assetClassOf(cur);
  if (cls === cur.className) return;
  ctx.platform.db.run(`UPDATE "alm_asset" SET "sys_class_name" = ? WHERE "sys_id" = ?`, [cls, cur.sysId]);
  if (cls === 'alm_hardware' || ctx.registry.isA(cls, 'alm_hardware')) {
    ctx.platform.db.run(
      `UPDATE "alm_asset" SET "quantity" = 1, "eligible_for_refresh" = COALESCE("eligible_for_refresh", 0) WHERE "sys_id" = ?`,
      [cur.sysId],
    );
  }
}

// ---------------------------------------------------- the before rule

/** The asset before insert/update rule (3.4); `cur.abort` rejects invalid writes. */
export function assetLifecycle(cur: Rec, ctx: Context): void {
  const userWrite = isUserWrite(ctx);
  const sync = isSync(ctx);
  const cls = assetClassOf(cur);
  const state = cur.num('install_status') ?? ASSET_STATE.IN_USE;
  const before = prevState(cur);
  const entering = (s: number) => state === s && before !== s;

  if (state === ASSET_STATE.CONSUMED && cls !== 'alm_consumable') {
    cur.abort('Invalid State for this asset class');
    return;
  }

  let sub = cur.str('substatus');
  if (!isValidSubstate(state, sub)) {
    if (callerSet(cur, 'substatus') && sub !== '') {
      cur.abort(`Substate ${sub} is not valid for State ${state}`);
      return;
    }
    sub = defaultSubstate(state);
    cur.setRaw('substatus', sub || null);
  }

  if (!cur.isNew() && before !== state) {
    cur.setRaw('old_status', before === null ? null : String(before));
    cur.setRaw('old_substatus', String(cur.prev('substatus') ?? '') || null);
  }

  if (state === ASSET_STATE.IN_STOCK) {
    if (userWrite && !cur.str('stockroom')) {
      cur.abort('Stockroom is mandatory for an asset in stock');
      return;
    }
    if (!sync && cur.str('stockroom') && (cur.isNew() || cur.changed('stockroom'))) {
      const location = ctx.platform.db.get<{ l: string | null }>(
        `SELECT "location" AS l FROM "alm_stockroom" WHERE "sys_id" = ?`,
        [cur.str('stockroom')],
      )?.l;
      if (location) cur.setRaw('location', location);
    }
    if (!sync && !cur.isNew() && entering(ASSET_STATE.IN_STOCK)) {
      cur.setRaw('assigned_to', null);
      cur.setRaw('assigned', null);
    }
  }

  if (sub === 'reserved') {
    if (userWrite && !cur.str('reserved_for')) {
      cur.abort('Reserved for is mandatory when the substate is Reserved');
      return;
    }
  } else if (cur.str('reserved_for')) cur.setRaw('reserved_for', null);

  if (entering(ASSET_STATE.IN_USE)) {
    cur.setRaw('stockroom', null);
    cur.setRaw('reserved_for', null);
    if (!sync && !cur.str('install_date')) cur.setRaw('install_date', nowGlide());
  }

  if (entering(ASSET_STATE.RETIRED)) {
    if (!cur.str('retired')) cur.setRaw('retired', today());
    if (!sync) {
      cur.setRaw('assigned_to', null);
      cur.setRaw('assigned', null);
    }
  } else if (before === ASSET_STATE.RETIRED && state !== ASSET_STATE.RETIRED) cur.setRaw('retired', null);

  derivedFields(cur, ctx, cls, sync);
  if (lifeCycleSyncEnabled(ctx) && (cur.isNew() || before !== state || cur.changed('substatus')))
    setLifeCycle(cur, ctx, state, cur.str('substatus'));
}

/** display_name, assigned and hardware quantity (section 2). */
function derivedFields(cur: Rec, ctx: Context, cls: string, sync: boolean): void {
  if (cur.isNew() || cur.changed('asset_tag') || cur.changed('model') || !cur.str('display_name')) {
    const model = cur.str('model')
      ? ctx.platform.db.get<{ d: string | null; n: string | null }>(
          `SELECT "display_name" AS d, "name" AS n FROM "cmdb_model" WHERE "sys_id" = ?`,
          [cur.str('model')],
        )
      : undefined;
    const modelName = model?.d || model?.n || '';
    const tag = cur.str('asset_tag');
    const name = tag && modelName ? `${tag} - ${modelName}` : tag || modelName;
    if (name) cur.setRaw('display_name', name);
  }
  if (!sync && cur.changed('assigned_to') && !callerSet(cur, 'assigned')) {
    cur.setRaw('assigned', cur.str('assigned_to') ? nowGlide() : null);
  }
  if (cls === 'alm_hardware' || ctx.registry.isA(cls, 'alm_hardware')) cur.setRaw('quantity', 1);
}

// ------------------------------------------------- CSDM life cycle (6.10)

/** CSDM stage/status pairs for asset State/Substate; '*' matches any substate. */
const ASSET_CSDM: [number, string, string, string][] = [
  [1, '*', 'Operational', 'In Use'],
  [2, '*', 'Purchase', 'On Order'],
  [3, '*', 'Operational', 'In Maintenance'],
  [6, 'available', 'Inventory', 'Available'],
  [6, 'reserved', 'Inventory', 'Reserved'],
  [6, 'pre_allocated', 'Inventory', 'Preallocated'],
  [6, 'defective', 'Defective', 'In Stock'],
  [6, 'pending_repair', 'Inventory', 'Pending Repair'],
  [6, 'pending_install', 'Deploy', 'In Stock'],
  [6, 'pending_transfer', 'Deploy', 'Pending Transfer'],
  [6, 'pending_disposal', 'End of Life', 'Pending Disposal'],
  [7, 'disposed', 'End of Life', 'Disposed'],
  [7, 'sold', 'End of Life', 'Sold'],
  [7, 'donated', 'End of Life', 'Donated'],
  [7, 'vendor_credit', 'End of Life', 'Vendor Credit'],
  [7, 'rma', 'End of Life', 'RMA'],
  [7, 'lease_return', 'End of Life', 'Lease Return'],
  [7, 'buyout', 'End of Life', 'Buyout'],
  [7, '', 'End of Life', 'Disposed'],
  [8, 'lost', 'Missing', 'Lost'],
  [8, 'stolen', 'Missing', 'Stolen'],
  [9, '*', 'Deploy', 'In Transit'],
  [11, '*', 'Design', 'Build'],
];

function setLifeCycle(cur: Rec, ctx: Context, state: number, sub: string): void {
  const hit = ASSET_CSDM.find(([s, ss]) => s === state && (ss === '*' || ss === sub));
  const pair = (hit ? lifeCyclePair(ctx, hit[2], hit[3]) : null) ?? lifeCyclePair(ctx, 'TBD', 'TBD');
  if (!pair) return;
  cur.setRaw('life_cycle_stage', pair.stage);
  cur.setRaw('life_cycle_stage_status', pair.status);
}
