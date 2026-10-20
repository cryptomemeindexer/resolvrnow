/**
 * CI status vocabulary and the asset/CI state mapping (asset.md 6.4 to 6.6). The mapping
 * lives here because CIs need it on their own (Status/Hardware Status coupling); the asset
 * module imports it for synchronization.
 */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';

export const INSTALL = {
  INSTALLED: 1,
  ON_ORDER: 2,
  IN_MAINTENANCE: 3,
  PENDING_INSTALL: 4,
  PENDING_REPAIR: 5,
  IN_STOCK: 6,
  RETIRED: 7,
  STOLEN: 8,
  ABSENT: 100,
} as const;
export const OPERATIONAL = { OPERATIONAL: 1, NON_OPERATIONAL: 2, RETIRED: 6 } as const;
export const ASSET_STATE = {
  IN_USE: 1,
  ON_ORDER: 2,
  IN_MAINTENANCE: 3,
  IN_STOCK: 6,
  RETIRED: 7,
  MISSING: 8,
  IN_TRANSIT: 9,
  CONSUMED: 10,
  BUILD: 11,
} as const;

/** Substates allowed for each asset State; '' means "empty is allowed". */
export const ASSET_SUBSTATES: Record<number, string[]> = {
  1: [''],
  2: [''],
  3: [''],
  6: [
    'available',
    'reserved',
    'pre_allocated',
    'defective',
    'pending_repair',
    'pending_install',
    'pending_transfer',
    'pending_disposal',
  ],
  7: ['', 'disposed', 'sold', 'donated', 'vendor_credit', 'rma', 'lease_return', 'buyout'],
  8: ['lost', 'stolen'],
  9: [''],
  10: [''],
  11: [''],
};

/** Substate used when a State is entered without one. */
export const ASSET_DEFAULT_SUBSTATE: Record<number, string> = { 6: 'available', 8: 'lost' };

export interface HwPair {
  hardware_status: string;
  hardware_substatus: string;
}

export interface AssetPair {
  state: number;
  substatus: string;
}

export function isValidSubstate(state: number, substatus: string): boolean {
  return (ASSET_SUBSTATES[state] ?? ['']).includes(substatus);
}

export function defaultSubstate(state: number): string {
  return ASSET_DEFAULT_SUBSTATE[state] ?? '';
}

/** Asset State/Substate to CI install_status (6.4). Consumed assets have no CI status. */
export function assetToInstall(state: number, substatus: string): number | null {
  switch (state) {
    case 1:
    case 2:
    case 3:
    case 7:
      return state;
    case 6:
      if (substatus === 'pending_install') return INSTALL.PENDING_INSTALL;
      if (substatus === 'pending_repair') return INSTALL.PENDING_REPAIR;
      return INSTALL.IN_STOCK;
    case 8:
      return substatus === 'stolen' ? INSTALL.STOLEN : INSTALL.ABSENT;
    case 9:
      return INSTALL.IN_STOCK;
    case 11:
      return INSTALL.PENDING_INSTALL;
    default:
      return null;
  }
}

/** Asset State/Substate to the CI hardware pair (6.4). */
export function assetToHardware(state: number, substatus: string): HwPair | null {
  const pair = (hardware_status: string, hardware_substatus: string): HwPair => ({
    hardware_status,
    hardware_substatus,
  });
  switch (state) {
    case 1:
      return pair('installed', 'in_use');
    case 2:
      return pair('on_order', '');
    case 3:
      return pair('in_maintenance', '');
    case 6:
      return pair('in_stock', substatus);
    case 7:
      return pair('retired', substatus);
    case 8:
      return pair('missing', substatus === 'stolen' ? 'stolen' : 'lost');
    case 9:
      return pair('in_transit', '');
    case 11:
      return pair('build', '');
    default:
      return null;
  }
}

const INSTALL_TO_ASSET: Record<number, AssetPair> = {
  1: { state: 1, substatus: '' },
  2: { state: 2, substatus: '' },
  3: { state: 3, substatus: '' },
  4: { state: 6, substatus: 'pending_install' },
  5: { state: 6, substatus: 'pending_repair' },
  6: { state: 6, substatus: 'available' },
  7: { state: 7, substatus: '' },
  8: { state: 8, substatus: 'stolen' },
  100: { state: 8, substatus: 'lost' },
};

/** CI install_status to asset State/Substate (6.5). */
export function installToAsset(install: number | null): AssetPair | null {
  return install === null ? null : (INSTALL_TO_ASSET[install] ?? null);
}

const HW_TO_STATE: Record<string, number> = {
  installed: 1,
  on_order: 2,
  in_maintenance: 3,
  in_transit: 9,
  build: 11,
  in_stock: 6,
  retired: 7,
  missing: 8,
};

/** CI hardware pair to asset State/Substate (6.5). */
export function hardwareToAsset(status: string, substatus: string): AssetPair | null {
  const state = HW_TO_STATE[status];
  if (state === undefined) return null;
  if (state === 6 || state === 7 || state === 8) {
    return { state, substatus: isValidSubstate(state, substatus) ? substatus : defaultSubstate(state) };
  }
  return { state, substatus: '' };
}

export function hardwareFromInstall(install: number | null): HwPair | null {
  const a = installToAsset(install);
  return a ? assetToHardware(a.state, a.substatus) : null;
}

export function installFromHardware(status: string, substatus: string): number | null {
  const a = hardwareToAsset(status, substatus);
  return a ? assetToInstall(a.state, a.substatus) : null;
}

export function isHardwareClass(rec: Rec): boolean {
  return rec.table.ancestors.includes('cmdb_ci_hardware');
}

/** A field counts as set by the caller: explicitly written on insert, or changed on update. */
function callerSet(cur: Rec, field: string): boolean {
  if (cur.isNew()) return cur.touched.has(field) && cur.str(field) !== '';
  return cur.changed(field);
}

function setPair(cur: Rec, pair: HwPair | null): void {
  if (!pair) return;
  cur.setRaw('hardware_status', pair.hardware_status || null);
  cur.setRaw('hardware_substatus', pair.hardware_substatus || null);
}

/** State/Substate of the asset linked to a CI, read straight from storage. */
function linkedAssetPair(cur: Rec, ctx: Context): AssetPair | null {
  const assetId = cur.str('asset');
  if (!assetId || !ctx.registry.has('alm_asset')) return null;
  const row = ctx.platform.db.get<{ install_status: number | null; substatus: string | null }>(
    `SELECT "install_status","substatus" FROM "alm_asset" WHERE "sys_id" = ?`,
    [assetId],
  );
  if (!row || row.install_status === null) return null;
  return { state: Number(row.install_status), substatus: row.substatus ?? '' };
}

/** Keeps install_status and the hardware pair of a hardware CI consistent (6.6, first part). */
function alignHardware(cur: Rec, ctx: Context, installSet: boolean, pairSet: boolean): void {
  if (pairSet && !installSet) {
    const install = installFromHardware(cur.str('hardware_status'), cur.str('hardware_substatus'));
    if (install !== null) cur.setRaw('install_status', install);
    return;
  }
  if (pairSet) return;
  if (!installSet && cur.str('hardware_status')) return;
  const install = cur.num('install_status');
  const asset = linkedAssetPair(cur, ctx);
  const keepAssetDetail = asset !== null && assetToInstall(asset.state, asset.substatus) === install;
  setPair(
    cur,
    keepAssetDetail ? assetToHardware(asset.state, asset.substatus) : hardwareFromInstall(install),
  );
}

/**
 * Status / Hardware Status / Operational Status coupling around Retired (6.6). Runs as a
 * CI before rule on every write, sync writes included.
 */
export function coupleCiStatus(cur: Rec, ctx: Context): void {
  const hardware = isHardwareClass(cur);
  const installSet = callerSet(cur, 'install_status');
  const pairSet = hardware && (callerSet(cur, 'hardware_status') || callerSet(cur, 'hardware_substatus'));
  const statusTouched = installSet || pairSet;
  const opTouched = callerSet(cur, 'operational_status');
  if (hardware) alignHardware(cur, ctx, installSet, pairSet);
  const install = cur.num('install_status');
  const prevInstall = cur.isNew() ? null : Number(cur.prev('install_status'));
  if (statusTouched && !opTouched) {
    if (install === INSTALL.RETIRED) cur.setRaw('operational_status', OPERATIONAL.RETIRED);
    else if (prevInstall === INSTALL.RETIRED) cur.setRaw('operational_status', OPERATIONAL.NON_OPERATIONAL);
    return;
  }
  if (!opTouched || statusTouched) return;
  const op = cur.num('operational_status');
  const prevOp = cur.isNew() ? null : Number(cur.prev('operational_status'));
  if (op === OPERATIONAL.RETIRED && install !== INSTALL.RETIRED) {
    cur.setRaw('install_status', INSTALL.RETIRED);
    if (hardware) setPair(cur, { hardware_status: 'retired', hardware_substatus: '' });
  } else if (prevOp === OPERATIONAL.RETIRED && op !== OPERATIONAL.RETIRED) {
    cur.setRaw('install_status', INSTALL.INSTALLED);
    if (hardware) setPair(cur, { hardware_status: 'installed', hardware_substatus: 'in_use' });
  }
}
