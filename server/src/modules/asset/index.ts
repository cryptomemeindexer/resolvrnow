import type { AppModule } from '../../engine/module.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import type { AclDef } from '../../engine/services/acl.js';
import { ASSET_STATE } from '../cmdb/status.js';
import { contractRules, msUntilNextRun, runContractJob } from './contracts.js';
import { loadAssetDemo } from './demo.js';
import { applyResolvedClass, assetLifecycle, resolveModelCategory } from './lifecycle.js';
import { seedAsset } from './seed.js';
import { runStockRules, stockRules } from './stock.js';
import {
  assetLinkConflict,
  assetToCi,
  categoryForCi,
  ciLinkConflict,
  ciToAsset,
  consumeSkipSync,
  isSync,
} from './sync.js';
import { assetTables } from './tables.js';
import { assetUi } from './ui.js';

export { runContractJob } from './contracts.js';
export { createAssetForCi, isSync, syncContext } from './sync.js';

const syncRules: BusinessRuleDef[] = [
  {
    name: 'Asset: consume skip_sync',
    table: 'alm_asset',
    when: 'before',
    actions: ['insert', 'update'],
    order: 1,
    run: (cur) => consumeSkipSync(cur),
  },
  {
    name: 'Asset: model category and asset class',
    table: 'alm_asset',
    when: 'before',
    actions: ['insert', 'update'],
    order: 20,
    run: (cur, _prev, ctx) => resolveModelCategory(cur, ctx),
  },
  {
    name: 'Asset: one CI per asset',
    table: 'alm_asset',
    when: 'before',
    actions: ['insert', 'update'],
    order: 30,
    run(cur, _prev, ctx) {
      const conflict = assetLinkConflict(ctx, cur);
      if (conflict) cur.abort(conflict);
    },
  },
  {
    name: 'Asset: state, substate and derived fields',
    table: 'alm_asset',
    when: 'before',
    actions: ['insert', 'update'],
    order: 100,
    run: (cur, _prev, ctx) => assetLifecycle(cur, ctx),
  },
  {
    name: 'Asset: store the resolved asset class',
    table: 'alm_asset',
    when: 'after',
    actions: ['insert'],
    order: 1,
    run: (cur, _prev, ctx) => applyResolvedClass(cur, ctx),
  },
  {
    name: 'Asset: synchronize the CI',
    table: 'alm_asset',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    run: assetToCi,
  },
  {
    name: 'Asset: state changed event',
    table: 'alm_asset',
    when: 'after',
    actions: ['update'],
    order: 200,
    condition: (cur) => cur.changed('install_status'),
    run(cur, _prev, ctx) {
      ctx.queueEvent(
        'asset.state.changed',
        cur,
        String(cur.prev('install_status') ?? ''),
        cur.str('install_status'),
      );
    },
  },
  {
    name: 'CI: consume skip_sync',
    table: 'cmdb',
    when: 'before',
    actions: ['insert', 'update'],
    order: 1,
    run: (cur) => consumeSkipSync(cur),
  },
  {
    name: 'CI: one asset per CI',
    table: 'cmdb',
    when: 'before',
    actions: ['insert', 'update'],
    order: 30,
    run(cur, _prev, ctx) {
      const conflict = ciLinkConflict(ctx, cur);
      if (conflict) cur.abort(conflict);
    },
  },
  {
    name: 'CI: verification required by the model category',
    table: 'cmdb_ci',
    when: 'before',
    actions: ['insert'],
    order: 40,
    condition: (_cur, _prev, ctx) => !isSync(ctx),
    run(cur, _prev, ctx) {
      if (categoryForCi(ctx, cur)?.enforce_verification) cur.setRaw('unverified', 1);
    },
  },
  {
    name: 'CI: synchronize the asset',
    table: 'cmdb_ci',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    run: ciToAsset,
  },
];

const crud = (name: string, read: string[], write: string[]): AclDef[] => [
  { name, operation: 'read', roles: read },
  { name, operation: 'write', roles: write },
  { name, operation: 'create', roles: write },
  { name, operation: 'delete', roles: write },
];

const acls: AclDef[] = [
  ...crud('alm_asset', ['itil', 'asset'], ['asset']),
  {
    name: 'alm_asset',
    operation: 'read',
    condition: 'assigned_to=javascript:gs.getUserID()',
    description: 'Users can read the assets assigned to them',
  },
  ...crud('cmdb_model_category', ['snc_internal'], ['asset']),
  ...[
    'alm_stockroom',
    'alm_stockroom_type',
    'alm_stock_rule',
    'alm_transfer_order',
    'alm_transfer_order_line',
    'alm_asset_ci_state_mapping',
    'alm_hardware_state_mapping',
  ].flatMap((t) => crud(t, ['itil', 'asset'], ['asset'])),
  ...crud('ast_contract', ['itil', 'asset', 'contract_manager'], ['asset', 'contract_manager']),
  ...crud('clm_m2m_contract_asset', ['itil', 'asset', 'contract_manager'], ['asset', 'contract_manager']),
];

/** Hardware and software assets, lifecycle and asset/CI synchronization. */
export const assetModule: AppModule = {
  id: 'asset',
  name: 'Asset Management',
  description: 'Hardware and software assets, lifecycle and asset/CI synchronization.',
  dependsOn: ['cmdb'],
  tables: assetTables,
  roles: [
    { name: 'asset', description: 'Manages assets, stockrooms, models and contracts' },
    { name: 'contract_manager', description: 'Manages contracts' },
  ],
  acls,
  rules: [...syncRules, ...contractRules, ...stockRules],
  properties: [
    {
      name: 'resolvr.asset.auto_create_ci',
      value: 'true',
      type: 'boolean',
      description: 'Create a CI when an asset of a CI-tracked category is created',
    },
    {
      name: 'resolvr.asset.auto_create_asset',
      value: 'true',
      type: 'boolean',
      description: 'Create an asset when a CI of an asset-tracked category is created',
    },
    {
      name: 'csdm.lifecycle.migration.activated',
      value: 'false',
      type: 'boolean',
      description: 'Maintain CSDM life cycle stage and status from asset states',
    },
    {
      name: 'csdm.lifecycle.sync.between.ci.and.asset.activated',
      value: 'false',
      type: 'boolean',
      description: 'Synchronize the CSDM pair directly between assets and CIs',
    },
  ],
  events: [
    { name: 'sn_hamp.asset.deploy', table: 'alm_asset', description: 'Deploy an asset (State In use)' },
    {
      name: 'sn_hamp.asset.retire',
      table: 'alm_asset',
      description: 'Start retiring an asset (In stock / Pending disposal)',
    },
    {
      name: 'asset.state.changed',
      table: 'alm_asset',
      description: 'An asset changed State (parm1 old, parm2 new)',
    },
    {
      name: 'contract.expiration_notice',
      table: 'ast_contract',
      description: 'A contract reached its notice date',
    },
    { name: 'contract.expired', table: 'ast_contract', description: 'A contract expired' },
    { name: 'contract.renewed', table: 'ast_contract', description: 'A contract renewed automatically' },
    {
      name: 'stock_rule.threshold_reached',
      table: 'alm_stock_rule',
      description: 'Available stock fell below a stock rule threshold',
    },
  ],
  eventHandlers: [
    {
      event: 'sn_hamp.asset.deploy',
      name: 'Deploy asset',
      run(_ev, rec, ctx) {
        if (rec && rec.num('install_status') !== ASSET_STATE.IN_USE)
          ctx.update(rec, { install_status: ASSET_STATE.IN_USE });
      },
    },
    {
      event: 'sn_hamp.asset.retire',
      name: 'Retire asset',
      run(_ev, rec, ctx) {
        if (rec && rec.num('install_status') !== ASSET_STATE.RETIRED)
          ctx.update(rec, { install_status: ASSET_STATE.IN_STOCK, substatus: 'pending_disposal' });
      },
    },
  ],
  jobs: [
    {
      id: 'asset.contract_state',
      name: 'Contract state management',
      description: 'Activates, renews and expires contracts (daily at 00:05 UTC)',
      intervalMs: 86_400_000,
      get initialDelayMs() {
        return msUntilNextRun();
      },
      run: (ctx) => {
        runContractJob(ctx);
      },
    },
    {
      id: 'asset.stock_rules',
      name: 'Stock rule evaluation',
      description: 'Raises stock_rule.threshold_reached when available stock is below threshold',
      intervalMs: 3_600_000,
      run: (ctx) => {
        runStockRules(ctx);
      },
    },
  ],
  ui: assetUi,
  seedVersion: 1,
  seed: seedAsset,
  demo: loadAssetDemo,
};
