import type { Context } from '../../engine/context.js';
import { ATTR, COND, fixedId, MODEL_IDS, MODEL_NAMES, STATE, STATE_LABEL, T } from './constants.js';

type Kind = 'manual' | 'auto';
interface TransitionSeed {
  from: number;
  to: number;
  kind: Kind;
  conditions: string[];
  name?: string;
}

interface ModelSeed {
  key: keyof typeof MODEL_IDS;
  description: string;
  process: string;
  preset: string;
  states: number[];
  initial: number;
  isDefault?: boolean;
  availableInUi?: boolean;
  color: string;
  policies: Record<string, string[]>;
  transitions: TransitionSeed[];
}

const S = STATE;
/** Manual transition (UI action or API); `name` qualifies duplicate from/to pairs. */
const m = (from: number, to: number, conditions: string[] = [], name?: string): TransitionSeed => ({
  from,
  to,
  kind: 'manual',
  conditions,
  name,
});
/** Automatic transition taken by model evaluation when its conditions pass. */
const a = (from: number, to: number, conditions: string[], name?: string): TransitionSeed => ({
  from,
  to,
  kind: 'auto',
  conditions,
  name,
});

const CANCEL_FROM = (states: number[]) => states.map((s) => m(s, S.CANCELED));

/** Base change models (our own wording of the documented behaviour). */
export const BASE_MODELS: ModelSeed[] = [
  {
    key: 'normal',
    description: 'Changes that need a technical assessment and authorization before they are scheduled.',
    process: 'normal',
    preset: 'type=normal^EQ',
    states: [S.NEW, S.ASSESS, S.AUTHORIZE, S.SCHEDULED, S.IMPLEMENT, S.REVIEW, S.CLOSED, S.CANCELED],
    initial: S.NEW,
    isDefault: true,
    color: '#488df4',
    policies: {
      [S.ASSESS]: ['assignment_group'],
      [S.AUTHORIZE]: ['assignment_group'],
      [S.SCHEDULED]: ['assignment_group'],
      [S.IMPLEMENT]: ['assignment_group'],
      [S.REVIEW]: ['assignment_group'],
      [S.CLOSED]: ['assignment_group', 'close_code', 'close_notes'],
    },
    transitions: [
      m(S.NEW, S.ASSESS, [COND.NOT_ON_HOLD]),
      a(S.ASSESS, S.AUTHORIZE, [COND.APPROVED]),
      a(S.ASSESS, S.NEW, [COND.REJECTED], 'rejected'),
      m(S.ASSESS, S.NEW, [], 'revert'),
      a(S.AUTHORIZE, S.SCHEDULED, [COND.APPROVED]),
      a(S.AUTHORIZE, S.NEW, [COND.REJECTED], 'rejected'),
      m(S.SCHEDULED, S.IMPLEMENT),
      m(S.IMPLEMENT, S.REVIEW, [COND.NOT_ON_HOLD]),
      a(S.IMPLEMENT, S.REVIEW, [COND.NO_ACTIVE_TASKS], 'tasks complete'),
      m(S.REVIEW, S.CLOSED, [COND.NO_ACTIVE_TASKS]),
      ...CANCEL_FROM([S.NEW, S.ASSESS, S.AUTHORIZE, S.SCHEDULED, S.IMPLEMENT]),
    ],
  },
  {
    key: 'standard',
    description: 'Pre-approved, low risk, repeatable changes created from a published template.',
    process: 'standard',
    preset: 'type=standard^EQ',
    states: [S.NEW, S.SCHEDULED, S.IMPLEMENT, S.REVIEW, S.CLOSED, S.CANCELED],
    initial: S.NEW,
    color: '#5bb85d',
    policies: {
      [S.SCHEDULED]: ['assignment_group'],
      [S.IMPLEMENT]: ['assignment_group'],
      [S.REVIEW]: ['assignment_group'],
      [S.CLOSED]: ['assignment_group', 'close_code', 'close_notes'],
    },
    transitions: [
      m(S.NEW, S.SCHEDULED, [COND.NOT_ON_HOLD], 'pre-approved'),
      m(S.SCHEDULED, S.IMPLEMENT),
      m(S.IMPLEMENT, S.REVIEW, [COND.NOT_ON_HOLD]),
      a(S.IMPLEMENT, S.REVIEW, [COND.NO_ACTIVE_TASKS], 'tasks complete'),
      m(S.REVIEW, S.CLOSED, [COND.NO_ACTIVE_TASKS]),
      ...CANCEL_FROM([S.NEW, S.SCHEDULED, S.IMPLEMENT]),
    ],
  },
  {
    key: 'emergency',
    description:
      'Urgent changes (fix on fail, imminent failure, security fixes) that go straight to authorization.',
    process: 'emergency',
    preset: 'type=emergency^EQ',
    states: [S.NEW, S.AUTHORIZE, S.SCHEDULED, S.IMPLEMENT, S.REVIEW, S.CLOSED, S.CANCELED],
    initial: S.NEW,
    color: '#ea3423',
    policies: {
      [S.AUTHORIZE]: ['assignment_group'],
      [S.SCHEDULED]: ['assignment_group'],
      [S.IMPLEMENT]: ['assignment_group'],
      [S.REVIEW]: ['assignment_group'],
      [S.CLOSED]: ['close_code', 'close_notes'],
    },
    transitions: [
      m(S.NEW, S.AUTHORIZE, [COND.NOT_ON_HOLD]),
      a(S.AUTHORIZE, S.SCHEDULED, [COND.APPROVED]),
      a(S.AUTHORIZE, S.NEW, [COND.REJECTED], 'rejected'),
      m(S.AUTHORIZE, S.NEW, [], 'revert'),
      m(S.SCHEDULED, S.IMPLEMENT),
      m(S.IMPLEMENT, S.REVIEW, [COND.NOT_ON_HOLD]),
      a(S.IMPLEMENT, S.REVIEW, [COND.NO_ACTIVE_TASKS], 'tasks complete'),
      m(S.REVIEW, S.CLOSED, [COND.NO_ACTIVE_TASKS]),
      ...CANCEL_FROM([S.NEW, S.AUTHORIZE, S.SCHEDULED, S.IMPLEMENT]),
    ],
  },
  {
    key: 'unauthorized',
    description:
      'Changes detected without prior authorization. They start in Review and are authorized after the fact.',
    process: '',
    preset: 'type=emergency^unauthorized=true^EQ',
    states: [S.REVIEW, S.AUTHORIZE, S.CLOSED, S.CANCELED],
    initial: S.REVIEW,
    availableInUi: false,
    color: '#8e44ad',
    policies: {
      [S.REVIEW]: ['assignment_group'],
      [S.AUTHORIZE]: ['assignment_group', 'cmdb_ci', 'short_description', 'description'],
      [S.CLOSED]: ['assignment_group', 'close_code', 'close_notes'],
    },
    transitions: [
      m(S.REVIEW, S.AUTHORIZE),
      a(S.AUTHORIZE, S.REVIEW, [COND.APPROVED], 'approved'),
      a(S.AUTHORIZE, S.REVIEW, [COND.REJECTED], 'rejected'),
      m(S.AUTHORIZE, S.CANCELED),
      m(S.REVIEW, S.CLOSED, [COND.NO_ACTIVE_TASKS]),
    ],
  },
  {
    key: 'registration',
    description: 'Records an automated change after it happened. No approvals.',
    process: '',
    preset: 'type=normal^short_description=Automated : Change^EQ',
    states: [S.REVIEW, S.CLOSED, S.CANCELED],
    initial: S.REVIEW,
    availableInUi: false,
    color: '#7f8c8d',
    policies: {
      [S.REVIEW]: ['assignment_group'],
      [S.CLOSED]: ['assignment_group', 'description', 'close_code', 'close_notes'],
      [S.CANCELED]: ['description'],
    },
    transitions: [m(S.REVIEW, S.CLOSED), m(S.REVIEW, S.CANCELED)],
  },
];

const CONDITION_TYPES: { name: string; kind: string; description: string; condition?: string }[] = [
  { name: COND.MANDATORY, kind: 'mandatory_fields', description: 'The listed fields must have a value.' },
  { name: COND.CONDITION, kind: 'condition', description: 'An encoded condition on the change must match.' },
  { name: COND.SCRIPT, kind: 'script', description: 'A sandboxed script must return true.' },
  { name: COND.NO_ACTIVE_TASKS, kind: 'condition', description: 'Every change task is closed or canceled.' },
  {
    name: COND.NOT_ON_HOLD,
    kind: 'condition',
    description: 'The change is not on hold.',
    condition: 'on_hold!=true',
  },
  {
    name: COND.APPROVED,
    kind: 'condition',
    description: 'The approvals of the current stage are approved.',
    condition: 'approval=approved',
  },
  {
    name: COND.REJECTED,
    kind: 'condition',
    description: 'An approval of the current stage was rejected.',
    condition: 'approval=rejected',
  },
];

function seedConditionTypes(ctx: Context): Map<string, string> {
  const ids = new Map<string, string>();
  for (const ct of CONDITION_TYPES) {
    const existing = ctx.first(T.conditionType, `name=${ct.name}`);
    const rec =
      existing ??
      ctx.insert(T.conditionType, {
        sys_id: fixedId(`condition_type:${ct.name}`),
        name: ct.name,
        condition_type: ct.kind,
        description: ct.description,
        condition: ct.condition ?? '',
      });
    ids.set(ct.name, rec.sysId);
  }
  return ids;
}

function seedAttributes(ctx: Context): void {
  const attrs: [string, string, string][] = [
    [
      ATTR.CI_MODIFICATION,
      'Allow CI Modification',
      'The configuration item and affected CIs can change in states with this attribute.',
    ],
    [
      ATTR.IMPLEMENTATION,
      'Allow Implementation',
      'Proposed CI changes may be applied in states with this attribute.',
    ],
    [
      ATTR.CONFLICT_DETECTION,
      'Allow Conflict Detection',
      'When any state has it, automatic conflict detection only runs in those states.',
    ],
    [
      ATTR.CHILD_CHANGES,
      'Allow Child Change Creation',
      'Child changes are generated when the change enters a state with this attribute.',
    ],
  ];
  for (const [name, label, description] of attrs) {
    if (!ctx.first(T.attribute, `name=${name}`)) ctx.insert(T.attribute, { name, label, description });
  }
}

/** Seeds one base model with its states, policies, transitions and conditions (idempotent). */
export function seedModel(ctx: Context, def: ModelSeed, types: Map<string, string>): void {
  const modelId = MODEL_IDS[def.key];
  if (ctx.get(T.model, modelId)) return;
  const name = MODEL_NAMES[def.key];
  ctx.insert(T.model, {
    sys_id: modelId,
    name,
    sys_name: name,
    description: def.description,
    active: true,
    default_change_model: !!def.isDefault,
    available_in_ui: def.availableInUi !== false,
    color: def.color,
    record_preset: def.preset,
    itil_change_process: def.process,
    implementation_states: String(S.IMPLEMENT),
    table_name: T.change,
    state_field: 'state',
  });
  const stateIds = new Map<number, string>();
  def.states.forEach((value, i) => {
    const st = ctx.insert(T.state, {
      sys_id: fixedId(`state:${def.key}:${value}`),
      model: modelId,
      state: value,
      label: STATE_LABEL[String(value)],
      initial_state: value === def.initial,
      order: (i + 1) * 100,
    });
    stateIds.set(value, st.sysId);
  });
  for (const [state, fields] of Object.entries(def.policies)) {
    const stateId = stateIds.get(Number(state));
    if (!stateId) continue;
    for (const field of fields) ctx.insert(T.fieldPolicy, { model_state: stateId, field, mandatory: true });
  }
  def.transitions.forEach((t, i) => {
    const from = stateIds.get(t.from);
    const to = stateIds.get(t.to);
    if (!from || !to) return;
    const base = `${STATE_LABEL[String(t.from)]} to ${STATE_LABEL[String(t.to)]}`;
    const tr = ctx.insert(T.transition, {
      sys_id: fixedId(`transition:${def.key}:${t.from}:${t.to}:${t.kind}:${i}`),
      model: modelId,
      name: t.name ? `${base} (${t.name})` : base,
      from_state: from,
      to_state: to,
      automatic_transition: t.kind === 'auto',
      order: (i + 1) * 10,
    });
    for (const cond of t.conditions) {
      ctx.insert(T.transitionCondition, {
        state_transition: tr.sysId,
        name: cond,
        requires: types.get(cond),
      });
    }
    // Transitions into a state with mandatory fields carry a policy-managed condition.
    if ((def.policies[String(t.to)] ?? []).length) {
      ctx.insert(T.transitionCondition, {
        state_transition: tr.sysId,
        name: COND.POLICY,
        description: 'Mandatory fields of the target state are populated',
        requires: types.get(COND.MANDATORY),
        fields: (def.policies[String(t.to)] ?? []).join(','),
        policy_managed: true,
      });
    }
  });
}

const RISK_CONDITIONS = [
  {
    order: 100,
    name: 'Insufficient lead time (Normal)',
    description: 'Normal changes planned to start within 7 days are high risk.',
    condition: 'chg_model.name=Normal^start_date<javascript:gs.daysAgo(-7)',
    risk: 2,
  },
  {
    order: 110,
    name: 'Insufficient lead time (Standard)',
    description: 'Standard changes planned to start within 3 days are moderate risk.',
    condition: 'chg_model.name=Standard^start_date<javascript:gs.daysAgo(-3)',
    risk: 3,
  },
  {
    order: 150,
    name: 'Many dependent services',
    description: 'The configuration item supports three or more business or application services.',
    condition: 'cmdb_ciISNOTEMPTY',
    min: 3,
    risk: 2,
    impact: 1,
  },
  {
    order: 200,
    name: 'Critical service affected',
    description: 'The affected service is business critical.',
    condition: 'business_service.busines_criticalityIN1 - most critical,2 - somewhat critical',
    risk: 2,
    impact: 1,
  },
  {
    order: 900,
    name: 'Pipeline committer risk',
    description: 'Placeholder for pipeline based risk scoring (inactive).',
    condition: 'category=DevOps',
    risk: 3,
    active: false,
  },
];

const ASSESSMENT = {
  name: 'Change Risk Assessment',
  description: 'Five questions that score how risky a normal or emergency change is.',
  condition: 'typeINnormal,emergency',
  questions: [
    {
      question: 'What would be affected if the change failed?',
      weight: 2,
      options: [
        'A single user or device',
        'One team or site',
        'Several teams or sites',
        'The whole company or customers',
      ],
    },
    {
      question: 'How often has this kind of change been done before?',
      weight: 1,
      options: ['Many times, without issues', 'A few times', 'Never'],
    },
    {
      question: 'How long would it take to back out the change?',
      weight: 1.5,
      options: ['Under 30 minutes', 'A few hours', 'More than a day, or not possible'],
    },
    {
      question: 'Has the change been tested outside production?',
      weight: 1,
      options: ['Yes, fully tested', 'Partially tested', 'Not tested'],
    },
    {
      question: 'Will the change cause downtime?',
      weight: 1,
      options: ['No downtime', 'Downtime outside business hours', 'Downtime during business hours'],
    },
  ],
  thresholds: [
    { risk: 4, score_greater_than: 0 },
    { risk: 3, score_greater_than: 9 },
    { risk: 2, score_greater_than: 13 },
    { risk: 1, score_greater_than: 18 },
  ],
};

const RISK_MATRIX: [number, string, number][] = [
  [1, 'high', 3],
  [1, 'medium', 2],
  [1, 'low', 2],
  [2, 'high', 4],
  [2, 'medium', 3],
  [2, 'low', 2],
  [3, 'high', 4],
  [3, 'medium', 4],
  [3, 'low', 3],
];

export const CHANGE_GROUPS = [
  {
    name: 'CAB Approval',
    description: 'Change Advisory Board members who authorize normal and emergency changes',
  },
  {
    name: 'Change Management',
    description:
      'Change managers: unauthorized changes, standard change templates and post-implementation reviews',
  },
];

function seedRisk(ctx: Context): void {
  for (const rc of RISK_CONDITIONS) {
    if (ctx.first(T.riskCondition, `name=${rc.name}`)) continue;
    ctx.insert(T.riskCondition, {
      name: rc.name,
      description: rc.description,
      order: rc.order,
      condition: rc.condition,
      risk: rc.risk,
      impact: rc.impact ?? null,
      resolvr_min_impacted_services: rc.min ?? null,
      active: rc.active !== false,
    });
  }
  if (!ctx.first(T.assessment, `name=${ASSESSMENT.name}`)) {
    const asmt = ctx.insert(T.assessment, {
      name: ASSESSMENT.name,
      description: ASSESSMENT.description,
      condition: ASSESSMENT.condition,
      state: 'published',
      category_weight: 1,
    });
    ASSESSMENT.questions.forEach((q, i) => {
      ctx.insert(T.question, {
        risk_assessment: asmt.sysId,
        question: q.question,
        order: (i + 1) * 100,
        weight: q.weight,
        mandatory: true,
        options: JSON.stringify(q.options.map((label, j) => ({ label, value: j + 1 }))),
      });
    });
    for (const t of ASSESSMENT.thresholds) ctx.insert(T.threshold, { risk_assessment: asmt.sysId, ...t });
  }
  if (ctx.count(T.riskLookup) === 0) {
    for (const [impact, success_probability, risk] of RISK_MATRIX)
      ctx.insert(T.riskLookup, { impact, success_probability, risk });
  }
}

function seedGroups(ctx: Context): void {
  const itil = ctx.getBy('sys_user_role', 'name', 'itil');
  for (const g of CHANGE_GROUPS) {
    const group =
      ctx.first('sys_user_group', `name=${g.name}`) ??
      ctx.insert('sys_user_group', { name: g.name, description: g.description });
    if (itil && !ctx.first('sys_group_has_role', `group=${group.sysId}^role=${itil.sysId}`)) {
      ctx.insert('sys_group_has_role', { group: group.sysId, role: itil.sysId });
    }
  }
}

/** Required reference data of the change module. */
export function seedChange(ctx: Context): void {
  const types = seedConditionTypes(ctx);
  seedAttributes(ctx);
  for (const def of BASE_MODELS) seedModel(ctx, def, types);
  seedRisk(ctx);
  seedGroups(ctx);
  if (ctx.count(T.stdProperties) === 0) ctx.insert(T.stdProperties, { two_step: true });
}
