/**
 * Asset and CI synchronization (asset.md section 6): 1:1 links, creation of the missing
 * side, field copy in both directions and State/Status mapping. Writes made by these
 * routines run in a "sync" context so the other side's propagation rule does not echo
 * them back.
 */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { Internal } from '../../engine/types.js';
import {
  type AssetPair,
  assetToHardware,
  assetToInstall,
  hardwareToAsset,
  installToAsset,
  isHardwareClass,
} from '../cmdb/status.js';

const syncContexts = new WeakSet<Context>();
const skipRequested = new WeakSet<Rec>();

/** Context for writes issued by the sync routines (no ACLs, no propagation). */
export function syncContext(ctx: Context): Context {
  const c = ctx.derive({ acl: false });
  syncContexts.add(c);
  return c;
}

export function isSync(ctx: Context): boolean {
  return syncContexts.has(ctx);
}

/** REST and UI writes: a real user with ACLs enforced. Jobs, events and sync writes are system writes. */
export function isUserWrite(ctx: Context): boolean {
  return !ctx.user.isSystem && ctx.enforceAcl && !isSync(ctx);
}

/** `skip_sync = true` suppresses propagation for this write only; the stored value goes back to false. */
export function consumeSkipSync(cur: Rec): void {
  if (!cur.bool('skip_sync')) return;
  skipRequested.add(cur);
  cur.setRaw('skip_sync', 0);
}

export function skipRequestedFor(cur: Rec): boolean {
  return skipRequested.has(cur);
}

/** Asset classes that never create or link CIs. */
export const NO_CI_CLASSES = ['alm_consumable', 'alm_license'];

/** Synchronized fields: [asset field, CI field] (6.3). */
export const FIELD_SYNC: [string, string][] = [
  ['asset_tag', 'asset_tag'],
  ['serial_number', 'serial_number'],
  ['assigned_to', 'assigned_to'],
  ['assigned', 'assigned'],
  ['owned_by', 'owned_by'],
  ['managed_by', 'managed_by'],
  ['support_group', 'support_group'],
  ['supported_by', 'supported_by'],
  ['company', 'company'],
  ['department', 'department'],
  ['cost_center', 'cost_center'],
  ['location', 'location'],
  ['vendor', 'vendor'],
  ['cost', 'cost'],
  ['po_number', 'po_number'],
  ['invoice_number', 'invoice_number'],
  ['purchase_date', 'purchase_date'],
  ['order_date', 'order_date'],
  ['delivery_date', 'delivery_date'],
  ['install_date', 'install_date'],
  ['checked_in', 'checked_in'],
  ['checked_out', 'checked_out'],
  ['due', 'due'],
  ['due_in', 'due_in'],
  ['gl_account', 'gl_account'],
  ['justification', 'justification'],
  ['lease_id', 'lease_id'],
  ['warranty_expiration', 'warranty_expiration'],
  ['model', 'model_id'],
  ['product_instance_id', 'product_instance_id'],
];

const LIFE_CYCLE_SYNC: [string, string][] = [
  ['life_cycle_stage', 'life_cycle_stage'],
  ['life_cycle_stage_status', 'life_cycle_stage_status'],
];

export function lifeCycleSyncEnabled(ctx: Context): boolean {
  return ctx.platform.properties.getBool('csdm.lifecycle.migration.activated', false);
}

function syncPairs(ctx: Context): [string, string][] {
  return lifeCycleSyncEnabled(ctx) ? [...FIELD_SYNC, ...LIFE_CYCLE_SYNC] : FIELD_SYNC;
}

const isEmpty = (v: Internal | undefined) => v === null || v === undefined || v === '';

// ---------------------------------------------------- models and categories

export interface Category {
  sys_id: string;
  name: string;
  asset_class: string;
  cmdb_ci_class: string;
  enforce_verification: boolean;
}

export function category(ctx: Context, id: string): Category | null {
  if (!id) return null;
  const r = ctx.platform.db.get<Record<string, unknown>>(
    `SELECT * FROM "cmdb_model_category" WHERE "sys_id" = ?`,
    [id],
  );
  return r
    ? {
        sys_id: String(r.sys_id),
        name: String(r.name ?? ''),
        asset_class: String(r.asset_class ?? ''),
        cmdb_ci_class: String(r.cmdb_ci_class ?? ''),
        enforce_verification: r.enforce_verification === 1,
      }
    : null;
}

export interface ModelInfo {
  sys_id: string;
  manufacturer: string | null;
  categories: string[];
  cmdb_ci_class: string;
  strategy: string;
}

export function modelInfo(ctx: Context, id: string): ModelInfo | null {
  if (!id) return null;
  const r = ctx.platform.db.get<Record<string, unknown>>(
    `SELECT "sys_id","manufacturer","cmdb_model_category","cmdb_ci_class","asset_tracking_strategy" FROM "cmdb_model" WHERE "sys_id" = ?`,
    [id],
  );
  if (!r) return null;
  return {
    sys_id: String(r.sys_id),
    manufacturer: (r.manufacturer as string) || null,
    categories: String(r.cmdb_model_category ?? '')
      .split(',')
      .filter(Boolean),
    cmdb_ci_class: String(r.cmdb_ci_class ?? ''),
    strategy: String(r.asset_tracking_strategy ?? '') || 'leave_to_category',
  };
}

/** The seeded "Unknown" hardware model used for CIs without a model. */
export function unknownModel(ctx: Context): string | null {
  return (
    ctx.platform.db.get<{ sys_id: string }>(
      `SELECT "sys_id" FROM "cmdb_model" WHERE "name" = 'Unknown' ORDER BY "sys_created_on" LIMIT 1`,
    )?.sys_id ?? null
  );
}

/** Category for a CI without asset (4): through its model's categories, else by exact CI class. */
export function categoryForCi(ctx: Context, ci: Rec): Category | null {
  const model = modelInfo(ctx, ci.str('model_id'));
  if (model) {
    for (const id of model.categories) {
      const cat = category(ctx, id);
      if (cat && cat.cmdb_ci_class === ci.className) return cat;
    }
    return null;
  }
  const row = ctx.platform.db.get<{ sys_id: string }>(
    `SELECT "sys_id" FROM "cmdb_model_category" WHERE "cmdb_ci_class" = ? ORDER BY "name" LIMIT 1`,
    [ci.className],
  );
  return row ? category(ctx, row.sys_id) : null;
}

/** CI class for an asset: the model's override, else its category's class. */
export function ciClassForAsset(ctx: Context, asset: Rec): string | null {
  const model = modelInfo(ctx, asset.str('model'));
  const cls = model?.cmdb_ci_class || category(ctx, asset.str('model_category'))?.cmdb_ci_class || '';
  return cls && ctx.registry.isA(cls, 'cmdb_ci') ? cls : null;
}

// ------------------------------------------------------------ mapping

/** Asset State/Substate that a CI's status implies (6.5). */
export function assetPairForCi(ci: Rec, useHardwarePair: boolean): AssetPair | null {
  if (useHardwarePair && isHardwareClass(ci) && ci.str('hardware_status')) {
    return hardwareToAsset(ci.str('hardware_status'), ci.str('hardware_substatus'));
  }
  return installToAsset(ci.num('install_status'));
}

/** CI status fields that an asset State/Substate implies (6.4). */
export function ciStatusForAsset(ci: Rec | null, state: number, substatus: string): Record<string, Internal> {
  const out: Record<string, Internal> = {};
  const install = assetToInstall(state, substatus);
  if (install !== null) out.install_status = install;
  if (!ci || isHardwareClass(ci)) {
    const pair = assetToHardware(state, substatus);
    if (pair) {
      out.hardware_status = pair.hardware_status || null;
      out.hardware_substatus = pair.hardware_substatus || null;
    }
  }
  return out;
}

/** The asset already maps to the CI's current status: nothing to write (6.5 no-op rule). */
function alreadyEquivalent(asset: Rec, ci: Rec): boolean {
  const state = asset.num('install_status') ?? 0;
  const sub = asset.str('substatus');
  if (assetToInstall(state, sub) !== ci.num('install_status')) return false;
  if (!isHardwareClass(ci)) return true;
  const pair = assetToHardware(state, sub);
  return (
    !!pair &&
    pair.hardware_status === ci.str('hardware_status') &&
    pair.hardware_substatus === ci.str('hardware_substatus')
  );
}

// ---------------------------------------------------------- writes

/** Applies stored values to a record; writes only when something differs. */
function updateIfDifferent(ctx: Context, rec: Rec, patch: Record<string, Internal>): void {
  let dirty = false;
  for (const [field, value] of Object.entries(patch)) {
    if (!rec.has(field)) continue;
    const v = value === '' ? null : value;
    if (String(rec.get(field) ?? '') === String(v ?? '')) continue;
    rec.setRaw(field, v);
    dirty = true;
  }
  if (dirty) ctx.update(rec);
}

function load(ctx: Context, table: string, id: string): Rec | null {
  return id ? ctx.derive({ acl: false }).get(table, id) : null;
}

/** Clears the back-reference of a record that pointed at `from`. */
function clearBackRef(ctx: Context, table: string, id: string, field: string, from: string): void {
  const rec = load(ctx, table, id);
  if (rec && rec.str(field) === from) updateIfDifferent(syncContext(ctx), rec, { [field]: null });
}

/** Effective class of an asset record (the class resolved for base-table inserts). */
const resolvedClass = new WeakMap<Rec, string>();

export function setResolvedClass(rec: Rec, cls: string): void {
  resolvedClass.set(rec, cls);
}

export function assetClassOf(rec: Rec): string {
  return resolvedClass.get(rec) ?? rec.className;
}

// --------------------------------------------------------- asset -> CI

export function assetToCi(cur: Rec, prev: Rec | null, ctx: Context): void {
  if (isSync(ctx) || skipRequested.has(cur) || NO_CI_CLASSES.includes(assetClassOf(cur))) return;
  const prevCi = prev?.str('ci') ?? '';
  const ciId = cur.str('ci');
  if (prevCi && prevCi !== ciId) clearBackRef(ctx, 'cmdb', prevCi, 'asset', cur.sysId);
  if (!ciId) {
    if (!prev) createCiForAsset(cur, ctx);
    return;
  }
  const ci = load(ctx, 'cmdb', ciId);
  if (!ci) return;
  const linking = !prev || prevCi !== ciId;
  const patch: Record<string, Internal> = linking ? { asset: cur.sysId } : {};
  for (const [af, cf] of syncPairs(ctx)) {
    if (!ci.has(cf)) continue;
    if (linking ? !isEmpty(cur.get(af)) : cur.changed(af)) patch[cf] = cur.get(af);
  }
  if ('model_id' in patch) {
    const maker = modelInfo(ctx, cur.str('model'))?.manufacturer;
    if (maker) patch.manufacturer = maker;
  }
  if ('cost' in patch && !ci.str('cost_cc')) patch.cost_cc = 'USD';
  if (linking || cur.changed('install_status') || cur.changed('substatus')) {
    Object.assign(patch, ciStatusForAsset(ci, cur.num('install_status') ?? 0, cur.str('substatus')));
  }
  updateIfDifferent(syncContext(ctx), ci, patch);
}

/** Asset -> CI creation (6.2). */
function createCiForAsset(asset: Rec, ctx: Context): void {
  if (!ctx.platform.properties.getBool('resolvr.asset.auto_create_ci', true)) return;
  const cls = ciClassForAsset(ctx, asset);
  if (!cls) return;
  const values: Record<string, unknown> = {
    name: asset.str('display_name') || asset.str('serial_number') || asset.str('asset_tag'),
    asset: asset.sysId,
  };
  for (const [af, cf] of syncPairs(ctx)) if (!isEmpty(asset.get(af))) values[cf] = asset.get(af);
  const maker = modelInfo(ctx, asset.str('model'))?.manufacturer;
  if (maker) values.manufacturer = maker;
  Object.assign(values, ciStatusForAsset(null, asset.num('install_status') ?? 0, asset.str('substatus')));
  if (!ctx.registry.isA(cls, 'cmdb_ci_hardware')) {
    delete values.hardware_status;
    delete values.hardware_substatus;
  }
  const sync = syncContext(ctx);
  const ci = sync.insert(cls, values);
  const fresh = load(ctx, assetClassOf(asset), asset.sysId) ?? load(ctx, 'alm_asset', asset.sysId);
  if (fresh) updateIfDifferent(sync, fresh, { ci: ci.sysId });
  asset.setRaw('ci', ci.sysId);
}

// --------------------------------------------------------- CI -> asset

function statusChanged(ci: Rec): boolean {
  return ci.changed('install_status') || ci.changed('hardware_status') || ci.changed('hardware_substatus');
}

export function ciToAsset(cur: Rec, prev: Rec | null, ctx: Context): void {
  if (isSync(ctx) || skipRequested.has(cur) || !ctx.registry.has('alm_asset')) return;
  const prevAsset = prev?.str('asset') ?? '';
  const assetId = cur.str('asset');
  if (prevAsset && prevAsset !== assetId) clearBackRef(ctx, 'alm_asset', prevAsset, 'ci', cur.sysId);
  if (!assetId) {
    if (!prev) createAssetForCi(cur, ctx);
    return;
  }
  const asset = load(ctx, 'alm_asset', assetId);
  if (!asset || NO_CI_CLASSES.includes(asset.className)) return;
  const linking = !prev || prevAsset !== assetId;
  const patch: Record<string, Internal> = linking ? { ci: cur.sysId } : {};
  for (const [af, cf] of syncPairs(ctx)) {
    if (!cur.has(cf)) continue;
    if (linking ? !isEmpty(cur.get(cf)) : cur.changed(cf)) patch[af] = cur.get(cf);
  }
  if ((linking || statusChanged(cur)) && !alreadyEquivalent(asset, cur)) {
    const hwChanged =
      isHardwareClass(cur) && (cur.changed('hardware_status') || cur.changed('hardware_substatus'));
    const target = assetPairForCi(cur, hwChanged || linking);
    if (target) {
      patch.install_status = target.state;
      patch.substatus = target.substatus || null;
    }
  }
  const sync = syncContext(ctx);
  updateIfDifferent(sync, asset, patch);
  if (lifeCycleSyncEnabled(ctx) && 'install_status' in patch)
    copyLifeCycleBack(ctx, sync, asset.sysId, cur.sysId);
}

/** The asset recomputes its CSDM pair on a state change; the CI takes the same pair. */
function copyLifeCycleBack(ctx: Context, sync: Context, assetId: string, ciId: string): void {
  const asset = load(ctx, 'alm_asset', assetId);
  const ci = load(ctx, 'cmdb', ciId);
  if (!asset || !ci) return;
  updateIfDifferent(sync, ci, Object.fromEntries(LIFE_CYCLE_SYNC.map(([af, cf]) => [cf, asset.get(af)])));
}

/**
 * CI -> asset creation (6.2). Also used by demo loading with an explicit category for CI
 * classes that no category maps exactly.
 */
export function createAssetForCi(
  ci: Rec,
  ctx: Context,
  explicit?: Category | null,
  extra: Record<string, unknown> = {},
): Rec | null {
  if (!explicit && !ctx.platform.properties.getBool('resolvr.asset.auto_create_asset', true)) return null;
  const cat = explicit ?? categoryForCi(ctx, ci);
  if (
    !cat?.asset_class ||
    NO_CI_CLASSES.includes(cat.asset_class) ||
    !ctx.registry.isA(cat.asset_class, 'alm_asset')
  )
    return null;
  const modelId = ci.str('model_id') || unknownModel(ctx);
  const model = modelInfo(ctx, modelId ?? '');
  if (!model || model.strategy === 'do_not_track' || model.strategy === 'track_as_consumable') return null;
  const values: Record<string, unknown> = {
    model: model.sys_id,
    model_category: cat.sys_id,
    ci: ci.sysId,
    ...extra,
  };
  for (const [af, cf] of syncPairs(ctx))
    if (af !== 'model' && ci.has(cf) && !isEmpty(ci.get(cf)) && values[af] === undefined)
      values[af] = ci.get(cf);
  const pair = assetPairForCi(ci, true);
  if (pair) {
    values.install_status = pair.state;
    values.substatus = pair.substatus || null;
  }
  const sync = syncContext(ctx);
  const asset = sync.insert(cat.asset_class, values);
  const fresh = load(ctx, 'cmdb', ci.sysId);
  if (fresh) {
    const back: Record<string, Internal> = { asset: asset.sysId };
    if (!fresh.str('model_id')) back.model_id = model.sys_id;
    for (const [af, cf] of syncPairs(ctx))
      if (extra[af] !== undefined && fresh.has(cf)) back[cf] = asset.get(af);
    updateIfDifferent(sync, fresh, back);
  }
  ci.setRaw('asset', asset.sysId);
  return asset;
}

// -------------------------------------------------------- link guards

/** A CI may be linked to one asset and an asset to one CI. */
export function assetLinkConflict(ctx: Context, asset: Rec): string | null {
  const ciId = asset.str('ci');
  if (!ciId || !asset.changed('ci')) return null;
  const row = ctx.platform.db.get<{ asset: string | null }>(`SELECT "asset" FROM "cmdb" WHERE "sys_id" = ?`, [
    ciId,
  ]);
  return row?.asset && row.asset !== asset.sysId
    ? 'The configuration item is already linked to another asset'
    : null;
}

export function ciLinkConflict(ctx: Context, ci: Rec): string | null {
  const assetId = ci.str('asset');
  if (!assetId || !ci.changed('asset') || !ctx.registry.has('alm_asset')) return null;
  const row = ctx.platform.db.get<{ ci: string | null }>(`SELECT "ci" FROM "alm_asset" WHERE "sys_id" = ?`, [
    assetId,
  ]);
  return row?.ci && row.ci !== ci.sysId ? 'The asset is already linked to another configuration item' : null;
}
