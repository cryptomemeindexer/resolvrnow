import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { MODEL_IDS, MODEL_NAMES, T } from './constants.js';

/** A transition condition as loaded from sttrm_transition_condition + sttrm_condition_type. */
export interface ModelCondition {
  sysId: string;
  name: string;
  description: string;
  /** Name of the condition type (built-in types are evaluated natively). */
  typeName: string;
  /** mandatory_fields | condition | script */
  kind: string;
  condition: string;
  script: string;
  fields: string[];
  policyManaged: boolean;
}

export interface ModelTransition {
  sysId: string;
  name: string;
  from: number;
  to: number;
  automatic: boolean;
  order: number;
  conditions: ModelCondition[];
}

export interface ModelState {
  sysId: string;
  value: number;
  label: string;
  initial: boolean;
  order: number;
  attributes: Set<string>;
  mandatory: string[];
  readOnly: string[];
}

export interface ChangeModel {
  sysId: string;
  name: string;
  active: boolean;
  process: string;
  preset: string;
  isDefault: boolean;
  availableInUi: boolean;
  color: string;
  readRoles: string[];
  states: Map<number, ModelState>;
  initial: number | null;
  transitions: ModelTransition[];
  implementationStates: number[];
}

const MODEL_TABLES = [
  T.model,
  T.state,
  T.transition,
  T.conditionType,
  T.transitionCondition,
  T.fieldPolicy,
  T.attribute,
  T.stateAttribute,
];

/**
 * Change models (state model engine). Models, states, transitions, conditions, state
 * field policies and state attributes are data; this service caches them in memory and
 * is invalidated whenever one of the model tables changes.
 */
export class ChangeModelService {
  private cache: Map<string, ChangeModel> | null = null;

  constructor(private platform: Platform) {}

  /** Wires cache invalidation on every model table. */
  watch(): void {
    for (const t of MODEL_TABLES) {
      this.platform.hooks.on(['insert', 'update', 'delete'], t, 'change-model-cache', () =>
        this.invalidate(),
      );
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  all(): ChangeModel[] {
    return [...this.load().values()];
  }

  get(sysId: string | null | undefined): ChangeModel | undefined {
    if (!sysId) return undefined;
    return this.load().get(sysId);
  }

  byName(name: string): ChangeModel | undefined {
    const n = name.trim().toLowerCase();
    return this.all().find((m) => m.name.toLowerCase() === n);
  }

  /** Active model designated for an ITIL process (type); falls back to the seeded base model. */
  forType(type: string): ChangeModel | undefined {
    const t = type.trim().toLowerCase();
    const designated = this.all().find((m) => m.active && m.process === t);
    if (designated) return designated;
    const base = MODEL_IDS[t as keyof typeof MODEL_IDS];
    return base ? this.get(base) : this.byName(MODEL_NAMES[t as keyof typeof MODEL_NAMES] ?? type);
  }

  defaultModel(): ChangeModel | undefined {
    return this.all().find((m) => m.active && m.isDefault) ?? this.get(MODEL_IDS.normal);
  }

  /** Model governing a change: its chg_model, else the model of its type, else the default. */
  forRecord(rec: Rec): ChangeModel | undefined {
    return (
      this.get(rec.str('chg_model')) ??
      (rec.str('type') ? this.forType(rec.str('type')) : undefined) ??
      this.defaultModel()
    );
  }

  transitionsFrom(model: ChangeModel, from: number): ModelTransition[] {
    return model.transitions.filter((t) => t.from === from);
  }

  hasAttribute(model: ChangeModel, state: number, attribute: string): boolean {
    return model.states.get(state)?.attributes.has(attribute) ?? false;
  }

  modelHasAttribute(model: ChangeModel, attribute: string): boolean {
    return [...model.states.values()].some((s) => s.attributes.has(attribute));
  }

  private load(): Map<string, ChangeModel> {
    if (this.cache) return this.cache;
    const map = new Map<string, ChangeModel>();
    const reg = this.platform.registry;
    if (!reg.has(T.model)) return map;
    const ctx = this.platform.systemContext();
    const stateById = new Map<string, ModelState & { model: string }>();
    for (const m of ctx.query(T.model)) {
      map.set(m.sysId, {
        sysId: m.sysId,
        name: m.str('name'),
        active: m.bool('active'),
        process: m.str('itil_change_process'),
        preset: m.str('record_preset'),
        isDefault: m.bool('default_change_model'),
        availableInUi: m.bool('available_in_ui'),
        color: m.str('color'),
        readRoles: m
          .str('read_roles')
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
        states: new Map(),
        initial: null,
        transitions: [],
        implementationStates: m
          .str('implementation_states')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^-?\d+$/.test(s))
          .map(Number),
      });
    }
    for (const s of ctx.query(T.state, {
      query: 'active=true',
      orderBy: [{ field: 'order', desc: false }],
    })) {
      const model = map.get(s.str('model'));
      if (!model) continue;
      const value = s.num('state');
      if (value === null) continue;
      const st = {
        sysId: s.sysId,
        value,
        label: s.str('label') || s.display('state'),
        initial: s.bool('initial_state'),
        order: s.num('order') ?? 100,
        attributes: new Set<string>(),
        mandatory: [] as string[],
        readOnly: [] as string[],
        model: model.sysId,
      };
      model.states.set(value, st);
      stateById.set(s.sysId, st);
      if (st.initial && model.initial === null) model.initial = value;
    }
    for (const model of map.values()) {
      if (model.initial === null && model.states.size) {
        model.initial = [...model.states.values()].sort((a, b) => a.order - b.order)[0].value;
      }
    }
    if (reg.has(T.fieldPolicy)) {
      for (const p of ctx.query(T.fieldPolicy, 'active=true')) {
        const st = stateById.get(p.str('model_state'));
        if (!st) continue;
        if (p.bool('mandatory')) st.mandatory.push(p.str('field'));
        if (p.bool('read_only')) st.readOnly.push(p.str('field'));
      }
    }
    if (reg.has(T.stateAttribute)) {
      const attrNames = new Map(ctx.query(T.attribute).map((a) => [a.sysId, a.str('name')]));
      for (const a of ctx.query(T.stateAttribute, 'active=true')) {
        const st = stateById.get(a.str('model_state'));
        const name = attrNames.get(a.str('attribute'));
        if (st && name) st.attributes.add(name);
      }
    }
    const types = new Map(
      ctx.query(T.conditionType, 'active=true').map((t) => [
        t.sysId,
        {
          name: t.str('name'),
          kind: t.str('condition_type'),
          condition: t.str('condition'),
          script: t.str('script'),
        },
      ]),
    );
    const conditionsByTransition = new Map<string, ModelCondition[]>();
    for (const c of ctx.query(T.transitionCondition, {
      query: 'active=true',
      orderBy: [{ field: 'sys_created_on', desc: false }],
    })) {
      const type = types.get(c.str('requires'));
      if (!type) continue;
      const list = conditionsByTransition.get(c.str('state_transition')) ?? [];
      list.push({
        sysId: c.sysId,
        name: c.str('name'),
        description: c.str('description'),
        typeName: type.name,
        kind: type.kind,
        condition: c.str('condition') || type.condition,
        script: c.str('script') || type.script,
        fields: c
          .str('fields')
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        policyManaged: c.bool('policy_managed'),
      });
      conditionsByTransition.set(c.str('state_transition'), list);
    }
    for (const t of ctx.query(T.transition, {
      query: 'active=true',
      orderBy: [{ field: 'order', desc: false }],
    })) {
      const model = map.get(t.str('model'));
      const from = stateById.get(t.str('from_state'));
      const to = stateById.get(t.str('to_state'));
      if (!model || !from || !to) continue;
      model.transitions.push({
        sysId: t.sysId,
        name: t.str('name') || `${from.label} to ${to.label}`,
        from: from.value,
        to: to.value,
        automatic: t.bool('automatic_transition'),
        order: t.num('order') ?? 100,
        conditions: conditionsByTransition.get(t.sysId) ?? [],
      });
    }
    this.cache = map;
    return map;
  }
}

export function changeModels(platform: Platform): ChangeModelService {
  let svc = platform.services.get('change.models') as ChangeModelService | undefined;
  if (!svc) {
    svc = new ChangeModelService(platform);
    platform.services.set('change.models', svc);
  }
  return svc;
}

/** Parses a record preset (`field=value^field2=value2^EQ`) into field values. */
export function parsePreset(preset: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const term of preset.split('^')) {
    if (!term || term === 'EQ') continue;
    const i = term.indexOf('=');
    if (i <= 0) continue;
    out[term.slice(0, i).trim()] = term.slice(i + 1);
  }
  return out;
}
