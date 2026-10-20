/**
 * JSON shapes shared by the Service Catalog API and the portal APIs: item
 * summaries and details, variables with their choices, catalogs and categories.
 */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { CatalogAccess } from './access.js';
import { FREQUENCY_LABEL, T, VT } from './constants.js';
import { currencyCode, deliveryLabel, itemKind, money, showPrice, showQuantity } from './util.js';
import {
  choicesOf,
  defaultOf,
  displayAnswer,
  effectiveStates,
  hasPriceVariables,
  type ItemForm,
  loadForm,
  loadPolicies,
  referenceQualifier,
  targetTable,
  type VarDef,
} from './variables.js';

const NO_LABEL = new Set<number>([VT.break, VT.containerEnd, VT.containerSplit]);
const CHOICE_TYPES = new Set<number>([
  VT.select,
  VT.multipleChoice,
  VT.scale,
  VT.yesNo,
  VT.lookupSelect,
  VT.lookupMultiple,
]);
const REFERENCE_TYPES = new Set<number>([VT.reference, VT.requestedFor, VT.listCollector]);

const ref = (rec: Rec | null): { sys_id: string; title: string } | Record<string, never> =>
  rec ? { sys_id: rec.sysId, title: rec.str('title') || rec.displayValue() } : {};

/** Item summary (spec 14.3 ItemSummary). */
export function itemSummary(
  ctx: Context,
  access: CatalogAccess,
  item: Rec,
  form?: ItemForm,
): Record<string, unknown> {
  const platform = ctx.platform;
  const sys = platform.systemContext();
  const f = form ?? loadForm(ctx, item);
  const shown = showPrice(platform, item, hasPriceVariables(ctx, f));
  const kind = itemKind(item);
  const catalogs = access
    .itemCatalogs(item)
    .map((id) => sys.get(T.catalog, id))
    .filter((c): c is Rec => !!c && c.bool('active'))
    .map((c) => ({ sys_id: c.sysId, title: c.str('title') }));
  const category = item.str('category') ? sys.get(T.category, item.str('category')) : null;
  const out: Record<string, unknown> = {
    sys_id: item.sysId,
    name: item.str('name'),
    short_description: item.str('short_description'),
    description: item.str('description'),
    icon: item.str('icon'),
    picture: item.str('picture'),
    url: kind === 'content_item' ? item.str('url') : '',
    content_type: kind === 'content_item' ? item.str('content_type') : '',
    kb_article: kind === 'content_item' ? item.str('kb_article') : '',
    order: item.num('order') ?? 0,
    type: kind,
    sys_class_name: item.className,
    show_price: shown,
    show_quantity: showQuantity(item),
    catalogs,
    category: ref(category),
  };
  if (shown) {
    const code = currencyCode(platform);
    const freq = item.str('recurring_frequency');
    Object.assign(out, {
      price: money(platform, item.num('price') ?? 0),
      localized_price: money(platform, item.num('price') ?? 0),
      price_currency: code,
      local_currency: code,
      recurring_price: money(platform, item.num('recurring_price') ?? 0),
      localized_recurring_price: money(platform, item.num('recurring_price') ?? 0),
      recurring_price_currency: code,
      recurring_frequency: freq ? (FREQUENCY_LABEL[freq] ?? freq) : null,
    });
  }
  return out;
}

/** One variable in the API format (spec 14.3 Variable). */
export function variableJson(
  ctx: Context,
  def: VarDef,
  value?: string,
  state?: { mandatory: boolean; visible: boolean; readOnly: boolean },
): Record<string, unknown> {
  const v = value ?? (def.info.data ? defaultOf(ctx, def) : '');
  const out: Record<string, unknown> = {
    id: def.id,
    name: def.name,
    label: def.label,
    type: def.type,
    friendly_type: def.info.friendly,
    display_type: def.info.label,
    mandatory: state?.mandatory ?? def.mandatory,
    read_only: state?.readOnly ?? def.readOnly,
    visible: state?.visible ?? !def.hidden,
    render_label: !NO_LABEL.has(def.type),
    value: def.type === VT.masked ? '' : v,
    displayvalue: def.type === VT.masked ? '' : displayAnswer(ctx, def, v),
    help_text: def.helpText,
    tooltip: def.tooltip,
    example_text: def.exampleText,
    instructions: def.instructions,
    max_length: Number(def.attributes.max_length) || 0,
    attributes: def.rec.str('attributes'),
    pricing_implications:
      def.pricingImplications ||
      (def.type === VT.checkbox && (def.priceIfChecked !== 0 || def.recPriceIfChecked !== 0)),
    order: def.order,
  };
  if (def.setId) out.variable_set = { sys_id: def.setId, internal_name: def.setName };
  if (CHOICE_TYPES.has(def.type)) {
    out.choices = choicesOf(ctx, def).map((c) => ({
      value: c.value,
      label: c.label,
      price: c.price,
      recurring_price: c.recurringPrice,
    }));
    out.include_none = def.includeNone;
  }
  if (REFERENCE_TYPES.has(def.type)) {
    out.reference = targetTable(def);
    out.reference_qualifier = referenceQualifier(ctx, def);
  }
  if (def.type === VT.checkbox) {
    out.price_if_checked = def.priceIfChecked;
    out.rec_price_if_checked = def.recPriceIfChecked;
  }
  if (def.type === VT.requestedFor) out.enable_also_request_for = def.enableAlsoRequestFor;
  if (def.regex) out.validate_regex = def.regex;
  return out;
}

/** Variables of a form, with containers nested (children) and multi-row sets as nodes. */
export function variablesJson(
  ctx: Context,
  form: ItemForm,
  values?: Record<string, string>,
): Record<string, unknown>[] {
  const states = effectiveStates(
    ctx,
    form,
    values ??
      Object.fromEntries(form.vars.filter((d) => d.info.data).map((d) => [d.name, defaultOf(ctx, d)])),
  );
  const root: Record<string, unknown>[] = [];
  const stack: Record<string, unknown>[][] = [root];
  for (const def of form.vars) {
    const target = stack[stack.length - 1];
    if (def.type === VT.containerStart) {
      const node = {
        ...variableJson(ctx, def, '', states.get(def.name)),
        type: 0,
        friendly_type: 'container_start',
        children: [] as Record<string, unknown>[],
      };
      target.push(node);
      stack.push(node.children);
      continue;
    }
    if (def.type === VT.containerEnd) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (def.type === VT.containerSplit) continue;
    target.push(variableJson(ctx, def, values?.[def.name], states.get(def.name)));
  }
  for (const set of form.mrvs) {
    root.push({
      id: set.id,
      name: set.internalName,
      label: set.title,
      type: 0,
      friendly_type: 'multi_row_variable_set',
      display_type: 'Multi Row Variable Set',
      mandatory: false,
      read_only: false,
      render_label: true,
      max_rows: set.maxRows,
      value: values?.[set.internalName] ?? '[]',
      children: set.vars.map((d) => variableJson(ctx, d, '')),
    });
  }
  return root;
}

/** Catalog UI policies in the API format. */
export function policiesJson(ctx: Context, form: ItemForm): Record<string, unknown>[] {
  return loadPolicies(ctx, form).map((p) => ({
    sys_id: p.id,
    short_description: p.name,
    condition: p.condition,
    reverse_if_false: p.reverseIfFalse,
    on_load: p.onLoad,
    order: p.order,
    applies_to: p.appliesTo,
    actions: p.actions.map((a) => ({
      name: a.variable,
      mandatory: a.mandatory,
      visible: a.visible,
      disabled: a.disabled,
      value_action: a.valueAction,
      value: a.value,
      field_message_type: a.messageType,
      field_message: a.message,
    })),
  }));
}

/** Catalog client scripts of an item and its sets, grouped by type. */
export function clientScriptsJson(ctx: Context, form: ItemForm): Record<string, Record<string, unknown>[]> {
  const sys = ctx.platform.systemContext();
  const setIds = form.sets.map((s) => s.id);
  const q = `active=true^applies_catalog=true^ui_typeIN1,10^cat_item=${form.item.sysId}${setIds.length ? `^ORvariable_setIN${setIds.join(',')}` : ''}`;
  const out: Record<string, Record<string, unknown>[]> = { onChange: [], onLoad: [], onSubmit: [] };
  for (const s of sys.query(T.clientScript, { query: q })) {
    const type = s.str('type') || 'onLoad';
    (out[type] ??= []).push({
      sys_id: s.sysId,
      name: s.str('name'),
      type,
      fieldName: s.str('cat_variable'),
      script: s.str('script'),
      ui_type: s.str('ui_type'),
      applies_to: s.str('applies_to') || 'item',
      variable_set: s.str('variable_set'),
    });
  }
  return out;
}

/** Item detail (spec 14.3 ItemDetail). */
export function itemDetail(
  ctx: Context,
  access: CatalogAccess,
  item: Rec,
  values?: Record<string, string>,
): Record<string, unknown> {
  const sys = ctx.platform.systemContext();
  const form = loadForm(ctx, item);
  const categories = access
    .itemCategories(item)
    .map((id) => sys.get(T.category, id))
    .filter((c): c is Rec => !!c)
    .map((c) => {
      const parent = c.str('parent') ? sys.get(T.category, c.str('parent')) : null;
      return {
        sys_id: c.sysId,
        title: c.str('title'),
        active: c.bool('active'),
        category: parent
          ? { sys_id: parent.sysId, title: parent.str('title'), active: parent.bool('active') }
          : {},
      };
    });
  const kind = itemKind(item);
  return {
    ...itemSummary(ctx, access, item, form),
    categories,
    variables: kind === 'content_item' ? [] : variablesJson(ctx, form, values),
    ui_policy: policiesJson(ctx, form),
    client_script: clientScriptsJson(ctx, form),
    data_lookup: [],
    mandatory_attachment: item.bool('mandatory_attachment'),
    request_method: item.str('request_method') || 'order',
    no_cart: item.bool('no_cart') || item.bool('no_cart_v2') || kind !== 'catalog_item',
    no_quantity: !showQuantity(item),
    no_order_now: item.bool('no_order_now'),
    delivery_time: kind === 'catalog_item' ? deliveryLabel(ctx, item) : '',
  };
}

/** Number of items visible to the user in a category and its descendants. */
export function categoryItemCount(ctx: Context, access: CatalogAccess, categoryId: string): number {
  const sys = ctx.platform.systemContext();
  const ids = [categoryId];
  for (let i = 0; i < ids.length && ids.length < 500; i++) {
    for (const c of sys.query(T.category, { query: `parent=${ids[i]}^active=true` }))
      if (!ids.includes(c.sysId)) ids.push(c.sysId);
  }
  const seen = new Set<string>();
  for (const it of sys.query(T.item, { query: `categoryIN${ids.join(',')}^active=true` })) seen.add(it.sysId);
  for (const l of sys.query(T.itemCategory, { query: `sc_categoryIN${ids.join(',')}` }))
    seen.add(l.str('sc_cat_item'));
  let n = 0;
  for (const id of seen) {
    const it = sys.get(T.item, id);
    if (it && access.canViewItem(it, { search: true })) n++;
  }
  return n;
}

/** Category in the API format. */
export function categoryJson(ctx: Context, access: CatalogAccess, cat: Rec): Record<string, unknown> {
  const sys = ctx.platform.systemContext();
  const subs = sys
    .query(T.category, {
      query: `parent=${cat.sysId}^active=true`,
      orderBy: [
        { field: 'order', desc: false },
        { field: 'title', desc: false },
      ],
    })
    .filter((c) => access.canViewCategory(c));
  return {
    sys_id: cat.sysId,
    title: cat.str('title'),
    description: cat.str('description'),
    full_description: cat.str('description'),
    icon: cat.str('icon'),
    header_icon: cat.str('header_icon'),
    homepage_image: cat.str('homepage_image'),
    count: categoryItemCount(ctx, access, cat.sysId),
    subcategories: subs.map((s) => ({ sys_id: s.sysId, title: s.str('title') })),
  };
}

/** Visible categories of a catalog in display order. */
export function catalogCategories(
  ctx: Context,
  access: CatalogAccess,
  catalogId: string,
  topLevelOnly: boolean,
): Rec[] {
  const q = `sc_catalog=${catalogId}^active=true${topLevelOnly ? '^parentISEMPTY' : ''}`;
  return ctx.platform
    .systemContext()
    .query(T.category, {
      query: q,
      orderBy: [
        { field: 'order', desc: false },
        { field: 'title', desc: false },
      ],
    })
    .filter((c) => access.canViewCategory(c));
}

/** Answers of a requested item (or cart line) for display: label, value and display value. */
export function answersJson(
  ctx: Context,
  form: ItemForm,
  values: Record<string, string>,
  rows: Record<string, Record<string, string>[]>,
  opts: { reveal?: boolean } = {},
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const def of form.vars) {
    if (!def.info.data) continue;
    const v = values[def.name] ?? '';
    out.push({
      name: def.name,
      label: def.label,
      type: def.info.friendly,
      value: def.type === VT.masked && !opts.reveal ? (v ? '********' : '') : v,
      display_value: displayAnswer(ctx, def, v, { reveal: opts.reveal }),
      order: def.order,
    });
  }
  for (const set of form.mrvs) {
    out.push({
      name: set.internalName,
      label: set.title,
      type: 'multi_row_variable_set',
      columns: set.vars.map((d) => ({ name: d.name, label: d.label })),
      rows: (rows[set.internalName] ?? []).map((row) =>
        Object.fromEntries(
          set.vars.map((d) => [
            d.name,
            {
              value: d.type === VT.masked && !opts.reveal ? '********' : (row[d.name] ?? ''),
              display_value: displayAnswer(ctx, d, row[d.name] ?? '', { reveal: opts.reveal }),
            },
          ]),
        ),
      ),
    });
  }
  return out;
}
