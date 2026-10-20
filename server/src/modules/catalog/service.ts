/**
 * CatalogService: the catalog's programmatic API for other modules (portal,
 * virtual agent, flows), registered as `platform.services.get('catalog')`.
 */
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { CatalogAccess } from './access.js';
import { T } from './constants.js';
import { Fulfillment } from './fulfillment.js';
import { evaluateGuide, type GuideLine, orderGuide } from './guide.js';
import { CatalogListeners, type SubmissionListener } from './listeners.js';
import {
  addLines,
  CART,
  type CheckoutOptions,
  checkout,
  ensureCart,
  type LineInput,
  type OrderResult,
  orderNow,
} from './ordering.js';
import { myRequests, ticketDetail } from './portal.js';
import { type ProducerInput, type ProducerResult, submitProducer } from './producer.js';
import { type ItemForm, loadForm } from './variables.js';

export class CatalogService {
  readonly fulfillment: Fulfillment;
  readonly listeners = new CatalogListeners();

  constructor(readonly platform: Platform) {
    this.fulfillment = new Fulfillment(platform);
  }

  /** Visibility checks for the context user (or another user). */
  access(ctx: Context, userId?: string): CatalogAccess {
    return new CatalogAccess(ctx, userId);
  }

  item(ctx: Context, id: string): Rec | null {
    return ctx.platform.systemContext().get(T.item, id);
  }

  form(ctx: Context, item: Rec): ItemForm {
    return loadForm(ctx, item);
  }

  /** Orders one item (temporary cart); answers keyed by variable name. */
  orderNow(ctx: Context, item: Rec, input: LineInput, opts: CheckoutOptions = {}): OrderResult {
    return orderNow(ctx, item, input, opts);
  }

  addToCart(ctx: Context, item: Rec, input: LineInput): Rec[] {
    return ctx.platform.db.tx(() => addLines(ctx, ensureCart(ctx, CART.default), item, input));
  }

  checkout(ctx: Context, opts: CheckoutOptions = {}): OrderResult {
    return checkout(ctx, ensureCart(ctx, CART.default), opts);
  }

  submitProducer(ctx: Context, producer: Rec, input: ProducerInput): ProducerResult {
    return submitProducer(ctx, producer, input);
  }

  orderGuide(
    ctx: Context,
    guide: Rec,
    guideVariables: Record<string, unknown>,
    lines?: GuideLine[],
    opts: CheckoutOptions = {},
  ): OrderResult {
    const evaluation = evaluateGuide(ctx, guide, guideVariables);
    const chosen =
      lines ?? evaluation.items.map((s) => ({ sys_id: s.item.sysId, quantity: s.quantity, variables: {} }));
    return orderGuide(ctx, evaluation, chosen, opts);
  }

  /** Cancels a request or requested item (requester or fulfiller, while waiting for approval). */
  cancel(ctx: Context, rec: Rec, reason: string): void {
    if (rec.table.ancestors.includes(T.request)) this.fulfillment.cancelRequest(ctx, rec, reason);
    else this.fulfillment.cancelItem(ctx, rec, reason);
  }

  myRequests(ctx: Context, opts: { filter?: string; q?: string; limit?: number; offset?: number } = {}) {
    return myRequests(ctx, opts);
  }

  ticket(ctx: Context, table: string, id: string): Record<string, unknown> {
    return ticketDetail(ctx, table, id);
  }

  /** Subscribes to catalog submissions (requests placed, records produced). */
  onSubmitted(fn: SubmissionListener): void {
    this.listeners.on(fn);
  }
}
