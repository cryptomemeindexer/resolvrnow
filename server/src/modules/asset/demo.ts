/**
 * Northwind Labs assets: stockrooms, hardware assets for the demo laptops, servers and
 * network gear (linked to their CIs), spare laptops in stock, a retired laptop, contracts
 * and a stock rule.
 */
import type { Context } from '../../engine/context.js';
import { clock, toGlideDate } from '../../engine/util.js';
import { DEMO_MODELS } from '../cmdb/demo.js';
import { category, createAssetForCi } from './sync.js';

const DAY = 86_400_000;
const day = (offsetDays: number) => toGlideDate(new Date(clock.now().getTime() + offsetDays * DAY));

/** Category of each demo model (by model name). */
const MODEL_CATEGORY: Record<string, string> = {
  'Latitude 7440': 'Computer',
  'ThinkPad X1 Carbon Gen 11': 'Computer',
  'MacBook Pro 14 (M3)': 'Computer',
  'PowerEdge R650': 'Server',
  'ProLiant DL380 Gen10': 'Server',
  'Catalyst 9300-48P': 'Network Gear',
  'ISR 4451': 'Network Gear',
  'Firepower 2130': 'Network Gear',
  'Catalyst 9120 Access Point': 'Network Gear',
  'PowerStore 1200T': 'Storage Device',
};

const MODEL_COST: Record<string, number> = {
  'Latitude 7440': 1650,
  'ThinkPad X1 Carbon Gen 11': 1890,
  'MacBook Pro 14 (M3)': 2399,
  'PowerEdge R650': 11800,
  'ProLiant DL380 Gen10': 14250,
  'Catalyst 9300-48P': 9400,
  'ISR 4451': 12100,
  'Firepower 2130': 16900,
  'Catalyst 9120 Access Point': 1150,
  'PowerStore 1200T': 68000,
};

const id = (ctx: Context, table: string, query: string) => ctx.first(table, query)?.sysId ?? null;

function stockrooms(ctx: Context): Record<string, string> {
  const rooms: [string, string, string, string][] = [
    ['Austin HQ IT Stockroom', 'Austin HQ', 'jamal.wright', 'Central'],
    ['London IT Stockroom', 'London Office', 'lucas.moreau', 'Field'],
  ];
  const out: Record<string, string> = {};
  for (const [name, location, manager, type] of rooms) {
    const rec =
      ctx.first('alm_stockroom', `name=${name}`) ??
      ctx.insert('alm_stockroom', {
        name,
        location: id(ctx, 'cmn_location', `name=${location}`),
        manager: id(ctx, 'sys_user', `user_name=${manager}`),
        assignment_group: id(ctx, 'sys_user_group', 'name=Hardware Support'),
        type: id(ctx, 'alm_stockroom_type', `name=${type}`),
        company: id(ctx, 'core_company', 'name=Northwind Labs'),
      });
    out[name] = rec.sysId;
  }
  return out;
}

/** Puts the demo models in their categories. */
function categorizeModels(ctx: Context): void {
  for (const [name] of DEMO_MODELS) {
    const model = ctx.first('cmdb_model', `name=${name}`);
    const cat = id(ctx, 'cmdb_model_category', `name=${MODEL_CATEGORY[name]}`);
    if (model && cat && !model.str('cmdb_model_category').includes(cat))
      ctx.update(model, { cmdb_model_category: cat });
  }
}

/** Hardware assets for every demo hardware CI that has a categorized model and no asset yet. */
function assetsForCis(ctx: Context): number {
  let n = 0;
  let tag = 2000;
  const byModel = new Map(DEMO_MODELS.map(([name]) => [id(ctx, 'cmdb_model', `name=${name}`), name]));
  for (const ci of ctx.query('cmdb_ci_hardware', { query: 'assetISEMPTY^model_idISNOTEMPTY^ORDERBYname' })) {
    const plain = byModel.get(ci.str('model_id'));
    const cat = plain
      ? category(ctx, id(ctx, 'cmdb_model_category', `name=${MODEL_CATEGORY[plain]}`) ?? '')
      : null;
    if (!plain || !cat) continue;
    const extra: Record<string, unknown> = {
      cost: MODEL_COST[plain] ?? null,
      invoice_number: `INV-${ci.str('po_number').slice(3) || tag}`,
    };
    if (!ci.str('asset_tag')) extra.asset_tag = `NWL-HW-${++tag}`;
    if (createAssetForCi(ci, ctx, cat, extra)) n++;
  }
  return n;
}

function spareLaptops(ctx: Context, austin: string): void {
  const latitude = id(ctx, 'cmdb_model', 'name=Latitude 7440');
  const thinkpad = id(ctx, 'cmdb_model', 'name=ThinkPad X1 Carbon Gen 11');
  const computer = id(ctx, 'cmdb_model_category', 'name=Computer');
  const spares: [string, string | null, string][] = [
    ['NWL-LT-1013', latitude, 'available'],
    ['NWL-LT-1014', latitude, 'available'],
    ['NWL-LT-1015', thinkpad, 'reserved'],
  ];
  const reservedFor = id(ctx, 'sys_user', 'user_name=priya.nair');
  for (const [tag, model, sub] of spares) {
    if (ctx.first('alm_asset', `asset_tag=${tag}`)) continue;
    ctx.insert('alm_hardware', {
      asset_tag: tag,
      serial_number: `NWLSP${tag.slice(-4)}`,
      model,
      model_category: computer,
      install_status: 6,
      substatus: sub,
      reserved_for: sub === 'reserved' ? reservedFor : null,
      stockroom: austin,
      cost: 1650,
      purchase_date: day(-30),
      warranty_expiration: day(3 * 365 - 30),
      company: id(ctx, 'core_company', 'name=Northwind Labs'),
    });
  }
  if (!ctx.first('alm_asset', 'asset_tag=NWL-LT-0907')) {
    ctx.insert('alm_hardware', {
      asset_tag: 'NWL-LT-0907',
      serial_number: 'NWLOLD0907',
      model: thinkpad,
      model_category: computer,
      install_status: 7,
      substatus: 'donated',
      disposal_reason: 'Donated to a local school after refresh',
      purchase_date: day(-4 * 365),
      cost: 1720,
      company: id(ctx, 'core_company', 'name=Northwind Labs'),
    });
  }
}

function contracts(ctx: Context): void {
  if (ctx.first('ast_contract', 'vendor_contract=DELL-PS-88231')) return;
  const model = (name: string) =>
    id(ctx, 'cmdb_model', `name=${name}^sys_class_name=cmdb_contract_product_model`);
  const vendor = (name: string) => id(ctx, 'core_company', `name=${name}`);
  const admin = id(ctx, 'sys_user', 'user_name=lucas.moreau');
  const warranty = ctx.insert('ast_warranty', {
    short_description: 'Dell ProSupport Plus for laptops and servers',
    vendor: vendor('Dell'),
    vendor_contract: 'DELL-PS-88231',
    contract_model: model('Warranty'),
    contract_administrator: admin,
    starts: day(-420),
    ends: day(675),
    state: 'active',
    renewable: false,
    yearly_cost: 18400,
  });
  for (const asset of ctx.query('alm_hardware', 'model.manufacturer.name=Dell')) {
    ctx.insert('clm_m2m_contract_asset', { contract: warranty.sysId, asset: asset.sysId, added: day(-400) });
  }
  ctx.insert('ast_service', {
    short_description: 'Cisco network support and software updates',
    vendor: vendor('Cisco'),
    vendor_contract: 'CSCO-SN-55120',
    contract_model: model('Service Contract'),
    contract_administrator: id(ctx, 'sys_user', 'user_name=marcus.chen'),
    starts: day(-340),
    ends: day(25),
    notice_date: day(-5),
    renewable: true,
    renewal_date: day(26),
    renewal_end_date: day(391),
    state: 'active',
    yearly_cost: 26500,
  });
  ctx.insert('ast_lease', {
    short_description: 'MacBook Pro lease for the design team',
    vendor: vendor('Apple'),
    vendor_contract: 'APL-LS-2026-014',
    contract_model: model('Lease'),
    contract_administrator: admin,
    starts: day(14),
    ends: day(14 + 3 * 365),
    state: 'draft',
    substate: 'under_review',
    approver: id(ctx, 'sys_user', 'user_name=henry.anderson'),
    monthly_cost: 1890,
  });
}

function stockRule(ctx: Context, austin: string): void {
  const latitude = id(ctx, 'cmdb_model', 'name=Latitude 7440');
  if (!latitude || ctx.first('alm_stock_rule', `stockroom=${austin}^model=${latitude}`)) return;
  ctx.insert('alm_stock_rule', {
    stockroom: austin,
    model: latitude,
    threshold: 3,
    restocking_option: 'vendor',
    order_size: 5,
  });
}

export function loadAssetDemo(ctx: Context): void {
  if (ctx.first('alm_stockroom', 'name=Austin HQ IT Stockroom')) return;
  const rooms = stockrooms(ctx);
  categorizeModels(ctx);
  assetsForCis(ctx);
  spareLaptops(ctx, rooms['Austin HQ IT Stockroom']);
  contracts(ctx);
  stockRule(ctx, rooms['Austin HQ IT Stockroom']);
}
