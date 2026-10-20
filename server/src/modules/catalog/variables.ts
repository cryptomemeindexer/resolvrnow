/**
 * Catalog variables: loading item forms (item variables plus variable sets),
 * normalising and validating answers (spec 5.9), re-evaluating catalog UI policies
 * on the server, price effects (6.1) and answer storage (5.6).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import { evalMacro, isMacro } from '../../engine/query/macros.js';
import type { MatchSubject } from '../../engine/query/matcher.js';
import { matches } from '../../engine/query/matcher.js';
import { QueryBuilder } from '../../engine/querybuilder.js';
import type { Rec } from '../../engine/record.js';
import {
  formatDuration,
  isSysId,
  normalizeDate,
  normalizeDateTime,
  parseDuration,
} from '../../engine/util.js';
import { splitList } from './access.js';
import { PROP, T, type VariableTypeInfo, VT, VT_BY_CODE } from './constants.js';

// ---------------------------------------------------------------- definitions

export interface VarChoice {
  value: string;
  label: string;
  price: number;
  recurringPrice: number;
}

export interface VarDef {
  id: string;
  name: string;
  label: string;
  type: number;
  info: VariableTypeInfo;
  order: number;
  mandatory: boolean;
  readOnly: boolean;
  hidden: boolean;
  defaultValue: string;
  tooltip: string;
  exampleText: string;
  helpText: string;
  showHelp: boolean;
  instructions: string;
  /** Referenced table for reference / requested for variables. */
  reference: string;
  listTable: string;
  lookupSource: string;
  lookupTable: string;
  lookupValue: string;
  lookupLabel: string;
  lookupPrice: string;
  lookupRecPrice: string;
  choiceTable: string;
  choiceField: string;
  dependentOn: string;
  includeNone: boolean;
  layout: string;
  scaleMin: number;
  scaleMax: number;
  priceIfChecked: number;
  recPriceIfChecked: number;
  pricingImplications: boolean;
  useEncryption: boolean;
  regex: string;
  attributes: Record<string, string>;
  global: boolean;
  mapToField: boolean;
  field: string;
  selectionRequired: boolean;
  enableAlsoRequestFor: boolean;
  alsoRequestForRoles: string[];
  readRoles: string[];
  writeRoles: string[];
  createRoles: string[];
  visibleSummary: boolean;
  setId: string | null;
  setName: string;
  rec: Rec;
}

export interface VarSet {
  id: string;
  title: string;
  internalName: string;
  type: 'one_to_one' | 'one_to_many';
  order: number;
  maxRows: number;
  vars: VarDef[];
  rec: Rec;
}

export interface ItemForm {
  item: Rec;
  /** Single-row variables in display order (item variables and single-row set variables). */
  vars: VarDef[];
  /** Every variable set linked to the item. */
  sets: VarSet[];
  /** Multi-row variable sets. */
  mrvs: VarSet[];
}

export interface LoadOptions {
  /** Where the form is shown: standalone item page (default) or inside an order guide. */
  context?: 'standalone' | 'guide';
  /** Include inactive variables (variable editor). */
  includeInactive?: boolean;
}

const MRVS_HARD_MAX = 50;

export function parseAttributes(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function toDef(rec: Rec, set: { id: string; name: string } | null): VarDef {
  const type = rec.num('type') ?? VT.singleLine;
  const info = VT_BY_CODE.get(type) ?? VT_BY_CODE.get(VT.singleLine)!;
  const reference = type === VT.requestedFor ? 'sys_user' : rec.str('reference');
  return {
    id: rec.sysId,
    name: rec.str('name') || rec.sysId,
    label: rec.str('question_text') || rec.str('name'),
    type,
    info,
    order: rec.num('order') ?? 100,
    mandatory: rec.bool('mandatory'),
    readOnly: rec.bool('read_only'),
    hidden: rec.bool('hidden'),
    defaultValue: rec.str('default_value'),
    tooltip: rec.str('tooltip'),
    exampleText: rec.str('example_text'),
    helpText: rec.str('help_text'),
    showHelp: rec.bool('show_help'),
    instructions: rec.str('instructions'),
    reference,
    listTable: rec.str('list_table'),
    lookupSource: rec.str('lookup_source') || 'table',
    lookupTable: rec.str('lookup_table'),
    lookupValue: rec.str('lookup_value') || 'sys_id',
    lookupLabel: rec.str('lookup_label'),
    lookupPrice: rec.str('lookup_price'),
    lookupRecPrice: rec.str('lookup_rec_price'),
    choiceTable: rec.str('choice_table'),
    choiceField: rec.str('choice_field'),
    dependentOn: rec.str('dependent_on'),
    includeNone: rec.bool('include_none'),
    layout: rec.str('layout') || 'normal',
    scaleMin: rec.num('scale_min') ?? 1,
    scaleMax: rec.num('scale_max') ?? 5,
    priceIfChecked: rec.num('price_if_checked') ?? 0,
    recPriceIfChecked: rec.num('rec_price_if_checked') ?? 0,
    pricingImplications: rec.bool('pricing_implications'),
    useEncryption: rec.get('use_encryption') === null ? true : rec.bool('use_encryption'),
    regex: rec.str('validate_regex'),
    attributes: parseAttributes(rec.str('attributes')),
    global: rec.bool('global'),
    mapToField: rec.bool('map_to_field'),
    field: rec.str('field'),
    selectionRequired: rec.bool('selection_required'),
    enableAlsoRequestFor: rec.bool('enable_also_request_for'),
    alsoRequestForRoles: splitList(rec.str('also_request_for_roles')),
    readRoles: splitList(rec.str('read_roles')),
    writeRoles: splitList(rec.str('write_roles')),
    createRoles: splitList(rec.str('create_roles')),
    visibleSummary: rec.get('visible_summary') === null ? true : rec.bool('visible_summary'),
    setId: set?.id ?? null,
    setName: set?.name ?? '',
    rec,
  };
}

/** Loads an item's variables and variable sets, in display order. */
export function loadForm(ctx: Context, item: Rec, opts: LoadOptions = {}): ItemForm {
  const sys = ctx.platform.systemContext();
  const visibleFlag = opts.context === 'guide' ? 'visible_guide' : 'visible_standalone';
  const keep = (r: Rec) =>
    (opts.includeInactive || r.get('active') === null || r.bool('active')) &&
    (r.get(visibleFlag) === null || r.bool(visibleFlag));
  const order = [{ field: 'order', desc: false }];
  const blocks: { key: number; tie: number; vars: VarDef[]; set?: VarSet }[] = [];
  for (const r of sys.query(T.variable, { query: `cat_item=${item.sysId}`, orderBy: order })) {
    if (keep(r)) blocks.push({ key: r.num('order') ?? 100, tie: 0, vars: [toDef(r, null)] });
  }
  const sets: VarSet[] = [];
  for (const link of sys.query(T.setItem, { query: `sc_cat_item=${item.sysId}`, orderBy: order })) {
    const setRec = sys.get(T.variableSet, link.str('variable_set'));
    if (!setRec) continue;
    const internalName =
      setRec.str('internal_name') ||
      setRec
        .str('title')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_');
    const attrs = parseAttributes(setRec.str('set_attributes'));
    const set: VarSet = {
      id: setRec.sysId,
      title: setRec.str('title'),
      internalName,
      type: setRec.str('type') === 'one_to_many' ? 'one_to_many' : 'one_to_one',
      order: link.num('order') ?? 100,
      maxRows: Math.min(MRVS_HARD_MAX, Number(attrs.max_rows) > 0 ? Number(attrs.max_rows) : MRVS_HARD_MAX),
      vars: [],
      rec: setRec,
    };
    for (const r of sys.query(T.variable, { query: `variable_set=${setRec.sysId}`, orderBy: order })) {
      if (!keep(r)) continue;
      const def = toDef(r, { id: setRec.sysId, name: internalName });
      if (set.type === 'one_to_many' && !def.info.mrvs) continue;
      set.vars.push(def);
    }
    sets.push(set);
    blocks.push({ key: set.order, tie: 1, vars: set.type === 'one_to_one' ? set.vars : [], set });
  }
  blocks.sort((a, b) => a.key - b.key || a.tie - b.tie);
  return {
    item,
    vars: blocks.flatMap((b) => b.vars),
    sets,
    mrvs: sets.filter((s) => s.type === 'one_to_many'),
  };
}

/** Every variable of a form, including multi-row set columns. */
export function allDefs(form: ItemForm): VarDef[] {
  return [...form.vars, ...form.mrvs.flatMap((s) => s.vars)];
}

// --------------------------------------------------------------------- choices

/** Choices of a choice-style variable (question choices, choice table, numeric scale, yes/no). */
export function choicesOf(ctx: Context, def: VarDef, dependentValue?: string): VarChoice[] {
  const sys = ctx.platform.systemContext();
  if (def.type === VT.yesNo)
    return ['Yes', 'No'].map((v) => ({ value: v, label: v, price: 0, recurringPrice: 0 }));
  if (def.type === VT.scale) {
    const out: VarChoice[] = [];
    for (let i = def.scaleMin; i <= def.scaleMax && out.length < 100; i++)
      out.push({ value: String(i), label: String(i), price: 0, recurringPrice: 0 });
    return out;
  }
  if (def.type === VT.lookupSelect || def.type === VT.lookupMultiple) {
    if (def.lookupSource === 'choices' && def.choiceTable && def.choiceField)
      return platformChoices(ctx, def, dependentValue);
    return lookupChoices(ctx, def);
  }
  const rows = sys.query(T.choice, {
    query: `question=${def.id}^inactive!=true`,
    orderBy: [{ field: 'order', desc: false }],
  });
  if (rows.length) {
    return rows.map((r) => ({
      value: r.str('value'),
      label: r.str('text') || r.str('value'),
      price: r.num('price') ?? 0,
      recurringPrice: r.num('recurring_price') ?? 0,
    }));
  }
  if (def.choiceTable && def.choiceField) return platformChoices(ctx, def, dependentValue);
  return [];
}

function platformChoices(ctx: Context, def: VarDef, dependentValue?: string): VarChoice[] {
  return ctx.platform.choices
    .list(def.choiceTable, def.choiceField, { dependentValue: dependentValue || undefined })
    .map((ch) => ({ value: ch.value, label: ch.label, price: 0, recurringPrice: 0 }));
}

function lookupChoices(ctx: Context, def: VarDef): VarChoice[] {
  if (!def.lookupTable || !ctx.platform.registry.has(def.lookupTable)) return [];
  const qb = new QueryBuilder(def.lookupTable);
  const qual = referenceQualifier(ctx, def);
  if (qual) qb.addEncodedQuery(qual);
  qb.limit = 500;
  const labels = splitList(def.lookupLabel);
  const seen = new Set<string>();
  const out: VarChoice[] = [];
  for (const r of ctx.platform.systemContext().query(def.lookupTable, qb)) {
    const value = def.lookupValue === 'sys_id' ? r.sysId : r.str(def.lookupValue);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = labels.length
      ? labels
          .map((f) => r.display(f))
          .filter(Boolean)
          .join(' | ')
      : r.displayValue();
    out.push({
      value,
      label: label || value,
      price: def.lookupPrice ? (r.num(def.lookupPrice) ?? 0) : 0,
      recurringPrice: def.lookupRecPrice ? (r.num(def.lookupRecPrice) ?? 0) : 0,
    });
  }
  return out;
}

/** Effective reference qualifier of a reference-style variable as an encoded query (or ''). */
export function referenceQualifier(ctx: Context, def: VarDef): string {
  const rec = def.rec;
  const mode = rec.str('use_reference_qualifier') || 'simple';
  if (mode === 'dynamic' && rec.str('dynamic_ref_qual')) return `sys_idDYNAMIC${rec.str('dynamic_ref_qual')}`;
  if (mode === 'advanced') {
    const q = rec.str('reference_qual').trim();
    if (!q) return '';
    if (isMacro(q)) return evalMacro(q, ctx.env) ?? '';
    return q;
  }
  const simple = rec.str('reference_qual_condition').trim();
  if (simple) return simple;
  return def.type === VT.requestedFor ? 'active=true' : '';
}

/** Reference target table of a variable that stores sys_ids. */
export function targetTable(def: VarDef): string {
  if (def.type === VT.listCollector) return def.listTable;
  if (def.type === VT.attachment) return 'sys_attachment';
  return def.reference;
}

// ------------------------------------------------------------- normalisation

export interface VarError {
  variable: string;
  label: string;
  code: 'mandatory' | 'invalid';
  message: string;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off', '']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rawString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v))
    return v
      .map((x) => rawString(x))
      .filter(Boolean)
      .join(',');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o) return rawString(o.value);
    if ('sys_id' in o) return rawString(o.sys_id);
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).trim();
}

/** Resolves a reference input (sys_id or display value) against a table and qualifier. */
function resolveReference(ctx: Context, table: string, input: string, qualifier: string): string | null {
  const registry = ctx.platform.registry;
  if (!table || !registry.has(table)) return null;
  const sys = ctx.platform.systemContext();
  const lookup = (q: string) => {
    const qb = new QueryBuilder(table).addEncodedQuery(q);
    if (qualifier) qb.addEncodedQuery(qualifier);
    qb.limit = 1;
    return sys.query(table, qb)[0] ?? null;
  };
  if (/^[0-9a-f]{32}$/.test(input)) return lookup(`sys_id=${input}`)?.sysId ?? null;
  const meta = registry.table(table);
  const byDisplay = lookup(`${meta.displayField}=${input.replace(/\^/g, '^^')}`);
  if (byDisplay) return byDisplay.sysId;
  if (meta.root === 'sys_user') return lookup(`user_name=${input}^ORemail=${input}`)?.sysId ?? null;
  return null;
}

/** Normalises one answer to its stored string form; returns an error message when invalid. */
export function normalizeValue(ctx: Context, def: VarDef, input: unknown): { value: string; error?: string } {
  const raw = rawString(input);
  switch (def.type) {
    case VT.yesNo: {
      if (raw === '') return { value: '' };
      const l = raw.toLowerCase();
      if (TRUE_WORDS.has(l)) return { value: 'Yes' };
      if (FALSE_WORDS.has(l)) return { value: 'No' };
      return { value: raw, error: 'must be Yes or No' };
    }
    case VT.checkbox: {
      const l = raw.toLowerCase();
      if (TRUE_WORDS.has(l)) return { value: 'true' };
      if (FALSE_WORDS.has(l)) return { value: 'false' };
      return { value: raw, error: 'must be true or false' };
    }
    case VT.multipleChoice:
    case VT.select:
    case VT.scale:
    case VT.lookupSelect: {
      if (raw === '') return { value: '' };
      const list = choicesOf(ctx, def);
      const hit =
        list.find((c) => c.value === raw) ?? list.find((c) => c.label.toLowerCase() === raw.toLowerCase());
      return hit ? { value: hit.value } : { value: raw, error: 'is not one of the available choices' };
    }
    case VT.lookupMultiple: {
      if (raw === '') return { value: '' };
      const list = choicesOf(ctx, def);
      const out: string[] = [];
      for (const part of splitList(raw)) {
        const hit =
          list.find((c) => c.value === part) ??
          list.find((c) => c.label.toLowerCase() === part.toLowerCase());
        if (!hit) return { value: raw, error: `"${part}" is not one of the available choices` };
        if (!out.includes(hit.value)) out.push(hit.value);
      }
      return { value: out.join(',') };
    }
    case VT.reference:
    case VT.requestedFor: {
      if (raw === '') return { value: '' };
      const id = resolveReference(ctx, def.reference, raw, referenceQualifier(ctx, def));
      return id ? { value: id } : { value: raw, error: 'does not match an allowed record' };
    }
    case VT.listCollector: {
      if (raw === '') return { value: '' };
      const qual = referenceQualifier(ctx, def);
      const out: string[] = [];
      for (const part of splitList(raw)) {
        const id = resolveReference(ctx, def.listTable, part, qual);
        if (!id) return { value: raw, error: `"${part}" does not match an allowed record` };
        if (!out.includes(id)) out.push(id);
      }
      return { value: out.join(',') };
    }
    case VT.date: {
      if (raw === '') return { value: '' };
      const d = normalizeDate(raw);
      return d && /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? { value: d }
        : { value: raw, error: 'is not a valid date (yyyy-MM-dd)' };
    }
    case VT.dateTime: {
      if (raw === '') return { value: '' };
      const d = normalizeDateTime(raw);
      return d ? { value: d } : { value: raw, error: 'is not a valid date and time (yyyy-MM-dd HH:mm:ss)' };
    }
    case VT.email:
      if (raw === '') return { value: '' };
      return EMAIL_RE.test(raw) ? { value: raw } : { value: raw, error: 'is not a valid email address' };
    case VT.url: {
      if (raw === '') return { value: '' };
      try {
        const u = new URL(raw);
        return ['http:', 'https:', 'ftp:', 'mailto:'].includes(u.protocol)
          ? { value: raw }
          : { value: raw, error: 'is not a valid URL' };
      } catch {
        return { value: raw, error: 'is not a valid URL' };
      }
    }
    case VT.ip:
      if (raw === '') return { value: '' };
      return isIP(raw) ? { value: raw } : { value: raw, error: 'is not a valid IPv4 or IPv6 address' };
    case VT.duration: {
      if (raw === '') return { value: '' };
      const m = /^(\d+)\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(raw);
      const ms = m ? ((+m[1] * 24 + +m[2]) * 3600 + +m[3] * 60 + +m[4]) * 1000 : parseDuration(raw);
      if (ms === null || ms < 0) return { value: raw, error: 'is not a valid duration (DD HH:MM:SS)' };
      return { value: durationString(ms) };
    }
    case VT.attachment: {
      if (raw === '') return { value: '' };
      const ok = isSysId(raw) && !!ctx.platform.systemContext().get('sys_attachment', raw);
      return ok ? { value: raw } : { value: raw, error: 'is not an uploaded attachment' };
    }
    case VT.singleLine:
    case VT.wideSingleLine:
    case VT.masked: {
      const max = Number(def.attributes.max_length);
      if (max > 0 && raw.length > max) return { value: raw, error: `is longer than ${max} characters` };
      if (raw && def.regex && !regexOk(def.regex, raw))
        return { value: raw, error: 'does not have the expected format' };
      return { value: raw };
    }
    default:
      if (raw && def.regex && !regexOk(def.regex, raw))
        return { value: raw, error: 'does not have the expected format' };
      return { value: typeof input === 'string' ? input : raw };
  }
}

function regexOk(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

/** Duration answers use the documented `DD HH:MM:SS` form. */
export function durationString(ms: number): string {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const rest = total - days * 86400;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(days)} ${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}`;
}

/** Default answer of a variable (literal, allow-listed `javascript:` macro, or the caller for Requested For). */
export function defaultOf(ctx: Context, def: VarDef, requestedFor?: string | null): string {
  const d = def.defaultValue.trim();
  if (d) {
    if (isMacro(d)) {
      const v = evalMacro(d, ctx.env);
      if (v !== null) return normalizeValue(ctx, def, v).value;
      return '';
    }
    return normalizeValue(ctx, def, d).value;
  }
  if (def.type === VT.requestedFor) return requestedFor ?? ctx.user.sysId ?? '';
  if (def.type === VT.checkbox) return 'false';
  return '';
}

// -------------------------------------------------------------- UI policies

export interface VarState {
  mandatory: boolean;
  visible: boolean;
  readOnly: boolean;
}

/** Condition subject over variable answers (names; `IO:<sys_id>` references are translated). */
export function variableSubject(
  defs: VarDef[],
  values: Record<string, string>,
  extra: Record<string, string> = {},
): MatchSubject {
  const known = new Set(defs.map((d) => d.name));
  const value = (path: string) => {
    if (path in extra) return extra[path];
    if (path in values) return values[path];
    return known.has(path) ? '' : undefined;
  };
  return {
    value,
    previous: value,
    isNew: () => false,
    column: () => null,
    display: (path) => String(value(path) ?? ''),
    classes: () => [],
    descendantsOf: () => [],
    text: () => Object.values(values).join(' '),
  };
}

/** Replaces `IO:<sys_id>` variable references in a catalog condition with variable names. */
export function translateCondition(condition: string, defs: VarDef[]): string {
  const byId = new Map(defs.map((d) => [d.id, d.name]));
  return condition.replace(/IO:([0-9a-f]{32})/g, (m, id: string) => byId.get(id) ?? m);
}

interface PolicyAction {
  variable: string;
  mandatory: string;
  visible: string;
  disabled: string;
  valueAction: string;
  value: string;
  messageType: string;
  message: string;
}

export interface PolicyDef {
  id: string;
  name: string;
  condition: string;
  order: number;
  reverseIfFalse: boolean;
  onLoad: boolean;
  appliesTo: 'item' | 'set';
  actions: PolicyAction[];
}

/** Active catalog UI policies of an item and its variable sets, in run order. */
export function loadPolicies(
  ctx: Context,
  form: ItemForm,
  where: 'catalog' | 'req_item' | 'sc_task' = 'catalog',
): PolicyDef[] {
  const sys = ctx.platform.systemContext();
  const flag =
    where === 'catalog' ? 'applies_catalog' : where === 'req_item' ? 'applies_req_item' : 'applies_sc_task';
  const defs = allDefs(form);
  const nameOf = (v: string) => {
    const m = /^IO:([0-9a-f]{32})$/.exec(v) ?? /^([0-9a-f]{32})$/.exec(v);
    return m ? (defs.find((d) => d.id === m[1])?.name ?? v) : v;
  };
  const load = (query: string, appliesTo: 'item' | 'set'): PolicyDef[] =>
    sys
      .query(T.uiPolicy, {
        query: `${query}^active=true^${flag}=true`,
        orderBy: [{ field: 'order', desc: false }],
      })
      .map((p) => ({
        id: p.sysId,
        name: p.str('short_description'),
        condition: translateCondition(p.str('catalog_conditions'), defs),
        order: p.num('order') ?? 100,
        reverseIfFalse: p.get('reverse_if_false') === null ? true : p.bool('reverse_if_false'),
        onLoad: p.get('on_load') === null ? true : p.bool('on_load'),
        appliesTo,
        actions: sys
          .query(T.uiPolicyAction, {
            query: `ui_policy=${p.sysId}`,
            orderBy: [{ field: 'order', desc: false }],
          })
          .map((a) => ({
            variable: nameOf(a.str('catalog_variable')),
            mandatory: a.str('mandatory') || 'ignore',
            visible: a.str('visible') || 'ignore',
            disabled: a.str('disabled') || 'ignore',
            valueAction: a.str('value_action') || 'ignore',
            value: a.str('value'),
            messageType: a.str('field_message_type') || 'none',
            message: a.str('field_message'),
          })),
      }));
  const itemPolicies = load(`catalog_item=${form.item.sysId}^applies_to!=set`, 'item');
  const setIds = form.sets.map((s) => s.id);
  const setPolicies = setIds.length ? load(`variable_setIN${setIds.join(',')}^applies_to=set`, 'set') : [];
  const setsFirst = ctx.platform.properties.getBool('glide.sc.ui_policy.variable_set_run_first', false);
  return setsFirst ? [...setPolicies, ...itemPolicies] : [...itemPolicies, ...setPolicies];
}

const tri = (v: string, holds: boolean): boolean | null => {
  if (v === 'true') return holds;
  if (v === 'false') return !holds;
  return null;
};

/**
 * Effective mandatory / visible / read-only state of each variable after the UI
 * policies run against the answers (server-side re-evaluation, spec 5.7).
 */
export function effectiveStates(
  ctx: Context,
  form: ItemForm,
  values: Record<string, string>,
  policies?: PolicyDef[],
): Map<string, VarState> {
  const states = new Map<string, VarState>();
  for (const d of allDefs(form))
    states.set(d.name, { mandatory: d.mandatory, visible: !d.hidden, readOnly: d.readOnly });
  const list = policies ?? loadPolicies(ctx, form);
  const subject = variableSubject(allDefs(form), values);
  // Within each group lower orders run last so that they win conflicts.
  const groups = [
    list.filter((p) => p.appliesTo === list[0]?.appliesTo),
    list.filter((p) => p.appliesTo !== list[0]?.appliesTo),
  ];
  for (const group of groups) {
    for (const p of [...group].sort((a, b) => b.order - a.order)) {
      const holds = matches(p.condition, subject, ctx.env);
      if (!holds && !p.reverseIfFalse) continue;
      for (const a of p.actions) {
        const st = states.get(a.variable);
        if (!st) continue;
        const m = tri(a.mandatory, holds);
        const v = tri(a.visible, holds);
        const r = tri(a.disabled, holds);
        if (m !== null) st.mandatory = m;
        if (v !== null) st.visible = v;
        if (r !== null) st.readOnly = r;
      }
    }
  }
  for (const [name, st] of states) {
    if (st.mandatory && !values[name]) {
      st.visible = true;
      st.readOnly = false;
    }
  }
  return states;
}

// ---------------------------------------------------------------- validation

export interface Answers {
  /** Variable name -> stored answer, for every data-collecting single-row variable. */
  values: Record<string, string>;
  /** Multi-row set internal name -> rows (variable name -> stored answer). */
  rows: Record<string, Record<string, string>[]>;
  /** Value of the Requested For variable, if the item has one. */
  requestedFor: string | null;
}

export interface ValidateOptions {
  /** Answers given by the caller are merged over these (cart line edits, cascaded guide values). */
  base?: Record<string, string>;
  /** Fill unanswered variables with their defaults (default true). */
  applyDefaults?: boolean;
  /** Check mandatory variables (default true). */
  checkMandatory?: boolean;
  /** Requested For used for Requested For defaults. */
  requestedFor?: string | null;
}

function keyedInput(defs: VarDef[], sets: VarSet[], input: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const byId = new Map(defs.map((d) => [d.id, d.name]));
  const bySet = new Map(sets.map((s) => [s.id, s.internalName]));
  for (const [k, v] of Object.entries(input ?? {})) {
    const id = /^IO:([0-9a-f]{32})$/.exec(k)?.[1] ?? (isSysId(k) ? k : null);
    const name = id ? (byId.get(id) ?? bySet.get(id) ?? k) : k;
    out.set(name, v);
  }
  return out;
}

function hasRoleIn(ctx: Context, roles: string[]): boolean {
  return roles.length === 0 || ctx.user.isSystem || ctx.hasAnyRole(roles);
}

/** Validates and normalises answers for an item form (spec 5.9). */
export function validateAnswers(
  ctx: Context,
  form: ItemForm,
  input: Record<string, unknown>,
  opts: ValidateOptions = {},
): { answers: Answers; errors: VarError[] } {
  const errors: VarError[] = [];
  const keyed = keyedInput(allDefs(form), form.sets, input);
  const values: Record<string, string> = {};
  const applyDefaults = opts.applyDefaults !== false;
  for (const def of form.vars) {
    if (!def.info.data) continue;
    const provided = keyed.has(def.name) && hasRoleIn(ctx, def.createRoles) && hasRoleIn(ctx, def.writeRoles);
    if (provided) {
      const n = normalizeValue(ctx, def, keyed.get(def.name));
      values[def.name] = n.value;
      if (n.error)
        errors.push({
          variable: def.name,
          label: def.label,
          code: 'invalid',
          message: `${def.label} ${n.error}`,
        });
    } else if (opts.base && def.name in opts.base) {
      values[def.name] = opts.base[def.name];
    } else {
      values[def.name] = applyDefaults ? defaultOf(ctx, def, opts.requestedFor) : '';
    }
  }
  const rows: Record<string, Record<string, string>[]> = {};
  for (const set of form.mrvs) {
    let raw = keyed.get(set.internalName);
    if (raw === undefined && opts.base && set.internalName in opts.base) raw = opts.base[set.internalName];
    let list: unknown[] = [];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        errors.push({
          variable: set.internalName,
          label: set.title,
          code: 'invalid',
          message: `${set.title} must be a JSON array of rows`,
        });
      }
    } else if (Array.isArray(raw)) list = raw;
    if (list.length > set.maxRows) {
      errors.push({
        variable: set.internalName,
        label: set.title,
        code: 'invalid',
        message: `${set.title} allows at most ${set.maxRows} rows`,
      });
    }
    rows[set.internalName] = list.slice(0, MRVS_HARD_MAX).map((row, i) => {
      const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const def of set.vars) {
        if (!def.info.data) continue;
        const n =
          def.name in r
            ? normalizeValue(ctx, def, r[def.name])
            : { value: applyDefaults ? defaultOf(ctx, def) : '' };
        out[def.name] = n.value;
        if ('error' in n && n.error)
          errors.push({
            variable: `${set.internalName}.${def.name}`,
            label: def.label,
            code: 'invalid',
            message: `${set.title} row ${i + 1}: ${def.label} ${n.error}`,
          });
        if (opts.checkMandatory !== false && def.mandatory && !out[def.name]) {
          errors.push({
            variable: `${set.internalName}.${def.name}`,
            label: def.label,
            code: 'mandatory',
            message: `${set.title} row ${i + 1}: ${def.label} is required`,
          });
        }
      }
      return out;
    });
  }
  if (opts.checkMandatory !== false) {
    const states = effectiveStates(ctx, form, values);
    for (const def of form.vars) {
      if (!def.info.data) continue;
      const st = states.get(def.name);
      const v = values[def.name] ?? '';
      if (def.type === VT.checkbox) {
        if (def.selectionRequired && v !== 'true')
          errors.push({
            variable: def.name,
            label: def.label,
            code: 'mandatory',
            message: `${def.label} must be selected`,
          });
        continue;
      }
      if (st?.mandatory && !v)
        errors.push({
          variable: def.name,
          label: def.label,
          code: 'mandatory',
          message: `${def.label} is required`,
        });
    }
  }
  const rf = form.vars.find((d) => d.type === VT.requestedFor);
  return { answers: { values, rows, requestedFor: rf ? values[rf.name] || null : null }, errors };
}

// -------------------------------------------------------------------- prices

export interface LinePrice {
  price: number;
  recurringPrice: number;
}

function refPrice(ctx: Context, table: string, id: string, recurring: boolean): number {
  if (!table || !ctx.platform.registry.has(table)) return 0;
  const r = ctx.platform.systemContext().get(table, id);
  if (!r) return 0;
  const fields = recurring ? ['recurring_price', 'u_recurring_price'] : ['price', 'u_price'];
  for (const f of fields) if (r.has(f)) return r.num(f) ?? 0;
  return 0;
}

/** Unit price of a line: item price plus the price effects of the answers (spec 6.1). */
export function computePrice(ctx: Context, form: ItemForm, answers: Answers): LinePrice {
  let price = form.item.num('price') ?? 0;
  let recurringPrice = form.item.num('recurring_price') ?? 0;
  for (const def of form.vars) {
    const v = answers.values[def.name] ?? '';
    if (!v) continue;
    switch (def.type) {
      case VT.checkbox:
        if (v === 'true') {
          price += def.priceIfChecked;
          recurringPrice += def.recPriceIfChecked;
        }
        break;
      case VT.select:
      case VT.multipleChoice:
      case VT.lookupSelect:
      case VT.lookupMultiple: {
        const list = choicesOf(ctx, def);
        for (const part of def.type === VT.lookupMultiple ? splitList(v) : [v]) {
          const ch = list.find((c) => c.value === part);
          if (ch) {
            price += ch.price;
            recurringPrice += ch.recurringPrice;
          }
        }
        break;
      }
      case VT.reference:
      case VT.listCollector:
        if (def.pricingImplications) {
          for (const id of splitList(v)) {
            price += refPrice(ctx, targetTable(def), id, false);
            recurringPrice += refPrice(ctx, targetTable(def), id, true);
          }
        }
        break;
      default:
        break;
    }
  }
  return { price: round2(price), recurringPrice: round2(recurringPrice) };
}

/** True when any variable of the form can change the price. */
export function hasPriceVariables(ctx: Context, form: ItemForm): boolean {
  return form.vars.some((d) => {
    if (d.type === VT.checkbox) return d.priceIfChecked !== 0 || d.recPriceIfChecked !== 0;
    if (d.type === VT.reference || d.type === VT.listCollector) return d.pricingImplications;
    if (
      d.type === VT.select ||
      d.type === VT.multipleChoice ||
      d.type === VT.lookupSelect ||
      d.type === VT.lookupMultiple
    ) {
      return choicesOf(ctx, d).some((c) => c.price !== 0 || c.recurringPrice !== 0);
    }
    return false;
  });
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ display

/** Human readable answer (choice labels, record display values, masked values hidden). */
export function displayAnswer(
  ctx: Context,
  def: VarDef,
  stored: string,
  opts: { reveal?: boolean } = {},
): string {
  if (stored === '' || stored === null || stored === undefined) return '';
  const sys = ctx.platform.systemContext();
  switch (def.type) {
    case VT.masked:
      return opts.reveal ? decryptMasked(ctx.platform, stored) : '********';
    case VT.checkbox:
      return stored === 'true' ? 'true' : 'false';
    case VT.select:
    case VT.multipleChoice:
    case VT.scale:
    case VT.lookupSelect:
    case VT.lookupMultiple: {
      const list = choicesOf(ctx, def);
      return splitList(stored)
        .map((v) => list.find((c) => c.value === v)?.label ?? v)
        .join(', ');
    }
    case VT.reference:
    case VT.requestedFor:
    case VT.listCollector:
    case VT.attachment: {
      const table = targetTable(def);
      if (!table || !ctx.platform.registry.has(table)) return stored;
      return splitList(stored)
        .map((id) => {
          const r = sys.get(table, id);
          return r ? (def.type === VT.attachment ? r.str('file_name') : r.displayValue()) : id;
        })
        .join(', ');
    }
    case VT.dateTime:
      return stored;
    case VT.duration: {
      const m = /^(\d+)\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(stored);
      return m ? formatDuration(((+m[1] * 24 + +m[2]) * 3600 + +m[3] * 60 + +m[4]) * 1000) : stored;
    }
    default:
      return stored;
  }
}

// ---------------------------------------------------------- masked values

function maskKey(platform: Platform): Buffer {
  const env = process.env.RESOLVRNOW_ENCRYPTION_KEY;
  let secret = env?.trim() ? env.trim() : (platform.properties.get(PROP.maskedKey) ?? '');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    platform.properties.set(PROP.maskedKey, secret);
  }
  return createHash('sha256').update(secret).digest();
}

/** Encrypts a masked answer (AES-256-GCM). */
export function encryptMasked(platform: Platform, value: string): string {
  if (!value || value.startsWith('enc:v1:')) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', maskKey(platform), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decryptMasked(platform: Platform, stored: string): string {
  if (!stored.startsWith('enc:v1:')) return stored;
  const [, , iv, tag, data] = stored.split(':');
  try {
    const decipher = createDecipheriv('aes-256-gcm', maskKey(platform), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ storage

export type AnswerOwner = { table: 'sc_cart_item' | 'sc_req_item'; id: string };

function storedValue(platform: Platform, def: VarDef, value: string): string {
  return def.type === VT.masked && def.useEncryption ? encryptMasked(platform, value) : value;
}

/** Stores answers for a cart line or requested item (sc_item_option + sc_item_option_mtom, multi-row answers). */
export function storeAnswers(ctx: Context, form: ItemForm, answers: Answers, owner: AnswerOwner): void {
  const sys = ctx.elevated();
  const linkField = owner.table === T.ritm ? 'request_item' : 'cart_item';
  for (const def of form.vars) {
    if (!def.info.data) continue;
    const opt = sys.insert(T.option, {
      item_option_new: def.id,
      value: storedValue(ctx.platform, def, answers.values[def.name] ?? ''),
      order: def.order,
    });
    sys.insert(T.optionLink, { [linkField]: owner.id, sc_item_option: opt.sysId });
  }
  for (const set of form.mrvs) {
    (answers.rows[set.internalName] ?? []).forEach((row, i) => {
      const rowIndex = `${String(i).padStart(4, '0')}${owner.id.slice(0, 28)}`;
      for (const def of set.vars) {
        if (!def.info.data) continue;
        sys.insert(T.mrvsAnswer, {
          parent_table_name: owner.table,
          parent_id: owner.id,
          variable_set: set.id,
          item_option_new: def.id,
          row_index: rowIndex,
          value: storedValue(ctx.platform, def, row[def.name] ?? ''),
          order: def.order,
        });
      }
    });
  }
}

/** Deletes the stored answers of a cart line or requested item. */
export function deleteAnswers(ctx: Context, owner: AnswerOwner): void {
  const sys = ctx.elevated();
  const linkField = owner.table === T.ritm ? 'request_item' : 'cart_item';
  for (const link of sys.query(T.optionLink, { query: `${linkField}=${owner.id}` })) {
    const opt = sys.get(T.option, link.str('sc_item_option'));
    sys.delete(link);
    if (opt && sys.count(T.optionLink, `sc_item_option=${opt.sysId}`) === 0) sys.delete(opt);
  }
  for (const r of sys.query(T.mrvsAnswer, {
    query: `parent_table_name=${owner.table}^parent_id=${owner.id}`,
  }))
    sys.delete(r);
}

/** Moves the answers of a cart line to the requested item created from it (checkout). */
export function relinkAnswers(ctx: Context, cartItemId: string, ritmId: string): void {
  const sys = ctx.elevated();
  for (const link of sys.query(T.optionLink, { query: `cart_item=${cartItemId}` }))
    sys.update(link, { request_item: ritmId, cart_item: null });
  for (const r of sys.query(T.mrvsAnswer, {
    query: `parent_table_name=${T.cartItem}^parent_id=${cartItemId}`,
  })) {
    sys.update(r, { parent_table_name: T.ritm, parent_id: ritmId });
  }
}

export interface StoredAnswer {
  def: VarDef | null;
  questionId: string;
  optionId: string;
  value: string;
}

/** Stored single-row answers of a cart line or requested item, keyed by variable sys_id. */
export function readAnswerRows(ctx: Context, owner: AnswerOwner): StoredAnswer[] {
  const sys = ctx.platform.systemContext();
  const linkField = owner.table === T.ritm ? 'request_item' : 'cart_item';
  const out: StoredAnswer[] = [];
  for (const link of sys.query(T.optionLink, { query: `${linkField}=${owner.id}` })) {
    const opt = sys.get(T.option, link.str('sc_item_option'));
    if (!opt) continue;
    out.push({
      def: null,
      questionId: opt.str('item_option_new'),
      optionId: opt.sysId,
      value: opt.str('value'),
    });
  }
  return out;
}

/** Answers of an owner as an `Answers` object (masked values decrypted) for re-validation and pricing. */
export function readAnswers(ctx: Context, form: ItemForm, owner: AnswerOwner): Answers {
  const rows = readAnswerRows(ctx, owner);
  const byId = new Map(rows.map((r) => [r.questionId, r.value]));
  const values: Record<string, string> = {};
  for (const def of form.vars) {
    if (!def.info.data) continue;
    const v = byId.get(def.id);
    if (v !== undefined) values[def.name] = def.type === VT.masked ? decryptMasked(ctx.platform, v) : v;
  }
  const mrvs: Record<string, Record<string, string>[]> = {};
  if (form.mrvs.length) {
    const sys = ctx.platform.systemContext();
    const all = sys.query(T.mrvsAnswer, {
      query: `parent_table_name=${owner.table}^parent_id=${owner.id}`,
      orderBy: [{ field: 'row_index', desc: false }],
    });
    for (const set of form.mrvs) {
      const grouped = new Map<string, Record<string, string>>();
      for (const r of all.filter((x) => x.str('variable_set') === set.id)) {
        const def = set.vars.find((d) => d.id === r.str('item_option_new'));
        if (!def) continue;
        const row = grouped.get(r.str('row_index')) ?? {};
        row[def.name] = def.type === VT.masked ? decryptMasked(ctx.platform, r.str('value')) : r.str('value');
        grouped.set(r.str('row_index'), row);
      }
      mrvs[set.internalName] = [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, row]) => row);
    }
  }
  const rf = form.vars.find((d) => d.type === VT.requestedFor);
  return { values, rows: mrvs, requestedFor: rf ? values[rf.name] || null : null };
}

/** Converts answers back into API input (variable name -> value; multi-row sets as JSON). */
export function answersAsInput(answers: Answers): Record<string, string> {
  const out: Record<string, string> = { ...answers.values };
  for (const [k, rows] of Object.entries(answers.rows)) out[k] = JSON.stringify(rows);
  return out;
}
