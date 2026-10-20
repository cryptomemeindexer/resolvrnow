import { HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { formatDuration, parseDuration } from '../../engine/util.js';
import { splitList } from './access.js';
import { DEFAULT_DELIVERY_MS, PROP, T } from './constants.js';

export function prop(platform: Platform, name: string, fallback = ''): string {
  return platform.properties.get(name, fallback) ?? fallback;
}

export function propList(platform: Platform, name: string, fallback = ''): string[] {
  return splitList(prop(platform, name, fallback));
}

export function currencyCode(platform: Platform): string {
  const c = prop(platform, PROP.currency, 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'USD';
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Money as the API's display string, e.g. `$1,598.00`. */
export function money(platform: Platform, amount: number | null | undefined): string {
  const code = currencyCode(platform);
  let f = formatters.get(code);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(code, f);
  }
  return f.format(Number.isFinite(amount ?? Number.NaN) ? (amount as number) : 0);
}

export type ItemKind = 'catalog_item' | 'record_producer' | 'order_guide' | 'content_item';

export function itemKind(item: Rec): ItemKind {
  const anc = item.table.ancestors;
  if (anc.includes(T.producer)) return 'record_producer';
  if (anc.includes(T.guide)) return 'order_guide';
  if (anc.includes(T.content)) return 'content_item';
  return 'catalog_item';
}

/** Classes that never become normal cart lines (glide.sc.item.not_normal_cart_item, plus content items). */
export function isOrderable(platform: Platform, item: Rec): boolean {
  if (itemKind(item) === 'content_item') return false;
  const excluded = propList(
    platform,
    'glide.sc.item.not_normal_cart_item',
    'sc_cat_item_guide,sc_cat_item_producer,sc_cat_item_wizard',
  );
  return !item.table.ancestors.some((t) => t !== T.item && excluded.includes(t));
}

/** Whether the price of an item should be shown (spec 6.1 display rules). */
export function showPrice(platform: Platform, item: Rec, hasPriceVars = false): boolean {
  if (item.bool('omit_price')) return false;
  const hidden = propList(
    platform,
    'glide.sc.item.cannot_show_price',
    'sc_cat_item_guide,sc_cat_item_producer',
  );
  if (item.table.ancestors.some((t) => t !== T.item && hidden.includes(t))) return false;
  if (itemKind(item) === 'content_item') return false;
  const mode = prop(platform, 'glide.sc.price.display', 'nonzero').toLowerCase();
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return (item.num('price') ?? 0) !== 0 || (item.num('recurring_price') ?? 0) !== 0 || hasPriceVars;
}

/** Whether the quantity selector applies to an item. */
export function showQuantity(item: Rec): boolean {
  if (item.bool('no_quantity') || item.bool('no_quantity_v2')) return false;
  const method = item.str('request_method');
  if (method === 'request' || method === 'submit') return false;
  return itemKind(item) === 'catalog_item';
}

/** Delivery estimate of an item in milliseconds (execution plan total, item delivery time, or 2 days). */
export function deliveryMs(ctx: Context, item: Rec): number {
  const planId = item.str('delivery_plan');
  if (planId && ctx.platform.registry.has(T.deliveryPlan)) {
    const plan = ctx.platform.systemContext().get(T.deliveryPlan, planId);
    const total = plan ? plan.num('total_delivery_time') : null;
    if (total && total > 0) return roundDelivery(ctx, total);
  }
  const raw = item.get('delivery_time');
  const ms = typeof raw === 'number' ? raw : parseDuration(raw);
  return roundDelivery(ctx, ms === null || ms === undefined ? DEFAULT_DELIVERY_MS : ms);
}

function roundDelivery(ctx: Context, ms: number): number {
  if (!ctx.platform.properties.getBool('glide.sc.round.delivery.times', false) || ms <= 86_400_000) return ms;
  return Math.round(ms / 86_400_000) * 86_400_000;
}

/** "2 Days" style delivery label. */
export function deliveryLabel(ctx: Context, item: Rec): string {
  if (item.bool('no_delivery_time_v2')) return '';
  return formatDuration(deliveryMs(ctx, item));
}

/** Parses `sysparm_quantity`: a non-negative whole number (spec 14.4). */
export function parseQuantity(v: unknown, fallback?: number): number {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s))
    throw new HttpError(
      400,
      'Invalid quantity value',
      `Quantity must be a non-negative whole number, got "${s}"`,
    );
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n > 1_000_000)
    throw new HttpError(400, 'Invalid quantity value', `Quantity ${s} is out of range`);
  return n;
}

/** Error thrown when an item is unknown, inactive or not visible to the caller. */
export function noAccess(detail = 'The item does not exist or you do not have access to it'): HttpError {
  return new HttpError(400, 'Security constraints prevent ordering of Item', detail);
}

/** Error thrown when mandatory variables are missing or answers are invalid. */
export class VariableError extends HttpError {
  constructor(
    message: string,
    detail: string,
    readonly fields: { variable: string; label: string; code: string; message: string }[],
  ) {
    super(400, message, detail);
  }
}

/** Glide-list helper: adds an id to a comma separated list. */
export function addToList(list: string, id: string): string {
  const ids = splitList(list);
  if (!ids.includes(id)) ids.push(id);
  return ids.join(',');
}
