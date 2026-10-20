/**
 * Order guides (spec section 9): guide variables are answered once, rules pick the
 * items, answers cascade into the items, and everything is ordered as one request.
 */
import { HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { CatalogAccess, type CatalogView } from './access.js';
import { T, VT } from './constants.js';
import {
  addLines,
  CART,
  type CheckoutOptions,
  checkout,
  createTempCart,
  ensureCart,
  type OrderResult,
  throwVariableErrors,
} from './ordering.js';
import { noAccess, propList } from './util.js';
import { type Answers, type ItemForm, loadForm, validateAnswers, variableSubject } from './variables.js';

export interface GuideSelection {
  item: Rec;
  rule: Rec;
  quantity: number;
  position: number;
  ignoreMandatory: boolean;
  showQuantity: boolean;
}

export interface GuideEvaluation {
  guide: Rec;
  form: ItemForm;
  answers: Answers;
  /** Values cascaded into item variables with the same name. */
  cascade: Record<string, string>;
  items: GuideSelection[];
}

export interface GuideOptions {
  view?: CatalogView;
  portal?: boolean;
  /** Validate guide variables (submit_guide checks the flagged mandatory ones). */
  checkMandatory?: boolean;
}

/** Answers guide rules can use: guide variables plus requested_for / requested_by. */
function ruleSubjectValues(ctx: Context, answers: Answers): Record<string, string> {
  return {
    requested_for: answers.requestedFor ?? ctx.user.sysId ?? '',
    requested_by: ctx.user.sysId ?? '',
    opened_by: ctx.user.sysId ?? '',
  };
}

/** Evaluates an order guide's rules against the guide answers. */
export function evaluateGuide(
  ctx: Context,
  guide: Rec,
  input: Record<string, unknown>,
  opts: GuideOptions = {},
): GuideEvaluation {
  const access = new CatalogAccess(ctx);
  if (
    !guide.table.ancestors.includes(T.guide) ||
    !access.canViewItem(guide, { view: opts.view, portal: opts.portal })
  )
    throw noAccess();
  const form = loadForm(ctx, guide);
  const { answers, errors } = validateAnswers(ctx, form, input, {
    checkMandatory: opts.checkMandatory !== false,
  });
  throwVariableErrors(errors);
  const sys = ctx.platform.systemContext();
  const subject = variableSubject(form.vars, answers.values, ruleSubjectValues(ctx, answers));
  const excluded = propList(
    ctx.platform,
    'glide.sc.item.order_guide_exclusion',
    'sc_cat_item_guide,sc_cat_item_content',
  );
  const forUser =
    answers.requestedFor && answers.requestedFor !== ctx.user.sysId
      ? new CatalogAccess(ctx, answers.requestedFor)
      : null;
  const items: GuideSelection[] = [];
  for (const rule of sys.query(T.guideRule, {
    query: `guide=${guide.sysId}`,
    orderBy: [{ field: 'position', desc: false }],
  })) {
    if (rule.str('condition') && !matches(rule.str('condition'), subject, ctx.env)) continue;
    const item = sys.get(T.item, rule.str('item'));
    if (!item || items.some((s) => s.item.sysId === item.sysId)) continue;
    if (!item.bool('active') || (item.get('visible_guide') !== null && !item.bool('visible_guide'))) continue;
    if (item.table.ancestors.some((t) => t !== T.item && excluded.includes(t))) continue;
    if (!access.canViewItem(item, { view: opts.view })) continue;
    if (forUser && item.str('access_type') !== 'delegated' && !forUser.canViewItem(item, { view: opts.view }))
      continue;
    items.push({
      item,
      rule,
      quantity: rule.num('quantity') ?? 1,
      position: rule.num('position') ?? 100,
      ignoreMandatory: rule.bool('ignore_mandatory'),
      showQuantity: rule.bool('show_quantity'),
    });
  }
  const cascade: Record<string, string> = guide.bool('cascade') ? { ...answers.values } : {};
  const rf = form.vars.find((d) => d.type === VT.requestedFor);
  if (rf && answers.requestedFor) cascade[rf.name] = answers.requestedFor;
  return { guide, form, answers, cascade, items };
}

/** Values cascaded into one item: guide answers for same-named variables, Requested For by type. */
export function cascadeFor(ctx: Context, evaluation: GuideEvaluation, item: Rec): Record<string, string> {
  const form = loadForm(ctx, item, { context: 'guide' });
  const out: Record<string, string> = {};
  for (const def of form.vars) {
    if (def.name in evaluation.cascade) out[def.name] = evaluation.cascade[def.name];
    else if (def.type === VT.requestedFor && evaluation.answers.requestedFor)
      out[def.name] = evaluation.answers.requestedFor;
  }
  return out;
}

export interface GuideLine {
  sys_id: string;
  quantity?: number;
  variables?: Record<string, unknown>;
  /** Portal include toggle (default true). */
  include?: boolean;
}

/** Adds the chosen guide items to a cart, each line tagged with the guide. */
function addGuideLines(
  ctx: Context,
  cart: Rec,
  evaluation: GuideEvaluation,
  lines: GuideLine[],
  opts: GuideOptions,
): Rec[] {
  const created: Rec[] = [];
  const allowed = new Map(evaluation.items.map((s) => [s.item.sysId, s]));
  for (const line of lines) {
    if (line.include === false) continue;
    const sel = allowed.get(line.sys_id);
    if (!sel) throw noAccess(`Item ${line.sys_id} is not part of this order guide`);
    created.push(
      ...addLines(ctx, cart, sel.item, {
        quantity: line.quantity ?? sel.quantity,
        variables: line.variables ?? {},
        orderGuide: evaluation.guide.sysId,
        cascade: cascadeFor(ctx, evaluation, sel.item),
        ignoreMandatory: sel.ignoreMandatory,
        view: opts.view,
        portal: opts.portal,
      }),
    );
  }
  if (!created.length)
    throw new HttpError(400, 'No items selected', 'Choose at least one item of the order guide');
  return created;
}

/** Orders the selected guide items as one request (two-step guides and the portal). */
export function orderGuide(
  ctx: Context,
  evaluation: GuideEvaluation,
  lines: GuideLine[],
  opts: GuideOptions & CheckoutOptions = {},
): OrderResult {
  return ctx.platform.db.tx(() => {
    const cart = createTempCart(ctx);
    addGuideLines(ctx, cart, evaluation, lines, opts);
    return checkout(ctx, cart, {
      ...opts,
      requestedFor: opts.requestedFor ?? evaluation.answers.requestedFor ?? null,
    });
  });
}

/** Three-step guides: the selected items go to the default cart. Returns the cart. */
export function guideToCart(
  ctx: Context,
  evaluation: GuideEvaluation,
  lines: GuideLine[],
  opts: GuideOptions = {},
): Rec {
  return ctx.platform.db.tx(() => {
    const cart = ensureCart(ctx, CART.default);
    addGuideLines(ctx, cart, evaluation, lines, opts);
    return cart;
  });
}

/**
 * The guide that a set of checkout_guide lines belongs to, without guide answers:
 * every item the guide's rules can include is allowed (conditions are not re-run).
 */
export function staticEvaluation(
  ctx: Context,
  guide: Rec,
  input: Record<string, unknown> = {},
): GuideEvaluation {
  const access = new CatalogAccess(ctx);
  if (!guide.table.ancestors.includes(T.guide) || !access.canViewItem(guide)) throw noAccess();
  const form = loadForm(ctx, guide);
  const { answers } = validateAnswers(ctx, form, input, { checkMandatory: false });
  const sys = ctx.platform.systemContext();
  const items: GuideSelection[] = [];
  for (const rule of sys.query(T.guideRule, {
    query: `guide=${guide.sysId}`,
    orderBy: [{ field: 'position', desc: false }],
  })) {
    const item = sys.get(T.item, rule.str('item'));
    if (!item || items.some((s) => s.item.sysId === item.sysId) || !access.canViewItem(item)) continue;
    items.push({
      item,
      rule,
      quantity: rule.num('quantity') ?? 1,
      position: rule.num('position') ?? 100,
      ignoreMandatory: rule.bool('ignore_mandatory'),
      showQuantity: rule.bool('show_quantity'),
    });
  }
  const cascade: Record<string, string> = guide.bool('cascade') ? { ...answers.values } : {};
  return { guide, form, answers, cascade, items };
}
