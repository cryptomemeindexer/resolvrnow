/** Reference data for asset management (asset.md 4, 5, 6.4, 7). */
import type { Context } from '../../engine/context.js';
import { assetToHardware, assetToInstall } from '../cmdb/status.js';

/** [name, asset class, CI class] */
export const MODEL_CATEGORIES: [string, string, string][] = [
  ['Computer', 'alm_hardware', 'cmdb_ci_computer'],
  ['Server', 'alm_hardware', 'cmdb_ci_server'],
  ['Network Gear', 'alm_hardware', 'cmdb_ci_netgear'],
  ['Storage Device', 'alm_hardware', 'cmdb_ci_storage_device'],
  ['Rack', 'alm_hardware', 'cmdb_ci_rack'],
  ['Computer Peripheral', 'alm_hardware', 'cmdb_ci_peripheral'],
  ['Printer', 'alm_hardware', 'cmdb_ci_printer'],
  ['Consumable', 'alm_consumable', ''],
  ['Software License', 'alm_license', ''],
];

const CONTRACT_MODELS = [
  'Warranty',
  'Lease',
  'Service Contract',
  'Maintenance Agreement',
  'Software License Agreement',
];
const STOCKROOM_TYPES: [string, string][] = [
  ['Central', 'Main stockroom serving a site'],
  ['Field', 'Small stock kept close to users'],
  ['Repair depot', 'Equipment waiting for or returning from repair'],
];

/** Mapping rows: [asset state, substate ('' = any), CI install status, hardware status, hardware substatus]. */
function mappingRows(): [number, string][] {
  return [
    [1, ''],
    [2, ''],
    [3, ''],
    [6, 'pending_install'],
    [6, 'pending_repair'],
    [6, ''],
    [7, ''],
    [8, 'stolen'],
    [8, ''],
    [9, ''],
    [11, ''],
  ];
}

function seedMappings(ctx: Context): void {
  if (ctx.count('alm_asset_ci_state_mapping') > 0) return;
  for (const [state, sub] of mappingRows()) {
    const install = assetToInstall(state, sub);
    const hw = assetToHardware(state, sub);
    ctx.insert('alm_asset_ci_state_mapping', {
      asset_state: state,
      asset_substatus: sub || null,
      ci_install_status: install,
      active: true,
    });
    if (hw) {
      ctx.insert('alm_hardware_state_mapping', {
        asset_state: state,
        asset_substatus: sub || null,
        hardware_status: hw.hardware_status,
        hardware_substatus:
          state === 6 || state === 7 ? (sub ? hw.hardware_substatus : '=') : hw.hardware_substatus || null,
        active: true,
      });
    }
  }
}

export function seedAsset(ctx: Context): void {
  for (const [name, assetClass, ciClass] of MODEL_CATEGORIES) {
    if (ctx.first('cmdb_model_category', `name=${name}`)) continue;
    ctx.insert('cmdb_model_category', {
      name,
      asset_class: assetClass || null,
      cmdb_ci_class: ciClass || null,
    });
  }
  if (!ctx.first('cmdb_model', 'name=Unknown')) {
    ctx.insert('cmdb_hardware_product_model', {
      name: 'Unknown',
      status: 'In Production',
      short_description: 'Placeholder model for configuration items without a known model',
    });
  }
  for (const name of CONTRACT_MODELS) {
    if (!ctx.first('cmdb_model', `name=${name}^sys_class_name=cmdb_contract_product_model`))
      ctx.insert('cmdb_contract_product_model', { name, status: 'In Production' });
  }
  for (const [name, description] of STOCKROOM_TYPES) {
    if (!ctx.first('alm_stockroom_type', `name=${name}`))
      ctx.insert('alm_stockroom_type', { name, description });
  }
  seedMappings(ctx);
}
