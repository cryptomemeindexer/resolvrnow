/** Stockrooms, stock rules and transfer orders (asset.md section 5). */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { nowGlide } from '../../engine/util.js';

/** Asset effects of a transfer order line stage. */
function applyLineStage(line: Rec, ctx: Context): void {
  const sys = ctx.elevated();
  const asset = line.str('asset') ? sys.get('alm_asset', line.str('asset')) : null;
  if (!asset) return;
  switch (line.str('stage')) {
    case 'requested':
      sys.update(asset, { install_status: 6, substatus: 'pending_transfer', active_to: true });
      break;
    case 'in_transit':
      sys.update(asset, { install_status: 9, active_to: true });
      break;
    case 'received': {
      const order = sys.get('alm_transfer_order', line.str('transfer_order'));
      sys.update(asset, {
        install_status: 6,
        substatus: 'available',
        stockroom: order?.str('to_stockroom') || asset.str('stockroom'),
        active_to: false,
      });
      break;
    }
    case 'cancelled':
      if (asset.bool('active_to')) sys.update(asset, { active_to: false });
      break;
  }
}

export const stockRules: BusinessRuleDef[] = [
  {
    name: 'Stockroom: flag the location as a stock room',
    table: 'alm_stockroom',
    when: 'after',
    actions: ['insert', 'update'],
    condition: (cur) => cur.changed('location') && !!cur.str('location'),
    run(cur, _prev, ctx) {
      const loc = ctx.elevated().get('cmn_location', cur.str('location'));
      if (loc?.has('stock_room') && !loc.bool('stock_room')) ctx.elevated().update(loc, { stock_room: true });
    },
  },
  {
    name: 'Stockroom: keep stockrooms that hold assets',
    table: 'alm_stockroom',
    when: 'before',
    actions: ['delete'],
    run(cur, _prev, ctx) {
      const n =
        ctx.platform.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "alm_asset" WHERE "stockroom" = ?`, [
          cur.sysId,
        ])?.n ?? 0;
      if (n > 0) cur.abort(`The stockroom still holds ${n} asset(s)`);
    },
  },
  {
    name: 'Transfer order: shipping and receipt dates',
    table: 'alm_transfer_order',
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.changed('stage'),
    run(cur) {
      if (cur.str('stage') === 'in_transit' && !cur.str('ship_date')) cur.setRaw('ship_date', nowGlide());
      if (cur.str('stage') === 'received' && !cur.str('received_date'))
        cur.setRaw('received_date', nowGlide());
    },
  },
  {
    name: 'Transfer order: lines follow the order stage',
    table: 'alm_transfer_order',
    when: 'after',
    actions: ['update'],
    condition: (cur) => cur.changed('stage'),
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      const stage = cur.str('stage');
      for (const line of sys.query('alm_transfer_order_line', {
        query: `transfer_order=${cur.sysId}^stage!=cancelled`,
      })) {
        if (line.str('stage') !== stage) sys.update(line, { stage });
      }
    },
  },
  {
    name: 'Transfer order line: move the asset',
    table: 'alm_transfer_order_line',
    when: 'after',
    actions: ['insert', 'update'],
    condition: (cur) => cur.changed('stage'),
    run: (cur, _prev, ctx) => applyLineStage(cur, ctx),
  },
];

/** Hourly stock rule evaluation: fires stock_rule.threshold_reached once per breach. */
export function runStockRules(ctx: Context): number {
  const sys = ctx.elevated();
  let fired = 0;
  for (const rule of sys.query('alm_stock_rule', 'active=true')) {
    const available =
      ctx.platform.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM "alm_asset" WHERE "install_status" = 6 AND "substatus" = 'available' AND "stockroom" = ? AND "model" = ?`,
        [rule.str('stockroom'), rule.str('model')],
      )?.n ?? 0;
    const breached = available < (rule.num('threshold') ?? 0);
    if (breached && !rule.bool('breach_active')) {
      sys.queueEvent('stock_rule.threshold_reached', rule, rule.sysId, String(available));
      sys.update(rule, { breach_active: true });
      fired++;
    } else if (!breached && rule.bool('breach_active')) sys.update(rule, { breach_active: false });
  }
  return fired;
}
