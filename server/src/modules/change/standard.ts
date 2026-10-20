import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import type { ApprovalDecision } from '../contracts.js';
import { MODEL_IDS, PROP, T } from './constants.js';
import { approvalsOf, csv, encodeValues, groupByName, groupMembers, parseValues } from './util.js';

/** Fields a caller can never override when creating a change from a standard template. */
export const PROTECTED_TEMPLATE_FIELDS = ['description', 'backout_plan', 'test_plan', 'implementation_plan'];

export const PROPOSAL = { NEW: 1, IN_PROGRESS: 2, COMPLETE: 3, INCOMPLETE: 4 } as const;
export const PROPOSAL_TYPE = { NEW: 1, MODIFY: 2, RETIRE: 3 } as const;

export function templateValues(ctx: Context, producer: Rec): Record<string, string> {
  const holder = producer.str('template')
    ? ctx.elevated().get(T.stdTemplate, producer.str('template'))
    : null;
  return parseValues(holder?.str('template'));
}

export function stdProperties(ctx: Context): Rec | null {
  return ctx.elevated().first(T.stdProperties, null);
}

/** Published (active, not retired) template by sys_id or name. */
export function findProducer(ctx: Context, idOrName: string): Rec | null {
  const sys = ctx.elevated();
  const rec = /^[0-9a-f]{32}$/.test(idOrName)
    ? sys.get(T.producer, idOrName)
    : sys.first(T.producer, `name=${idOrName}`);
  if (!rec?.bool('active') || rec.bool('retired')) return null;
  return rec;
}

export interface StandardChangeResult {
  change: Rec;
  ignored: string[];
}

/**
 * Creates a standard change from a published template: template values, Standard model,
 * template version and the version's change tasks (in template order). Overrides may not
 * touch the protected planning fields, restricted fields or read-only fields.
 */
export function createStandardChange(
  ctx: Context,
  producerId: string,
  overrides: Record<string, unknown> = {},
  opts: { displayValue?: boolean } = {},
): StandardChangeResult {
  const producer = findProducer(ctx, producerId);
  if (!producer) throw new NotFoundError('No Record found', 'Standard change template not found or retired');
  const values: Record<string, unknown> = { ...templateValues(ctx, producer) };
  const props = stdProperties(ctx);
  const restricted = new Set([
    ...PROTECTED_TEMPLATE_FIELDS,
    ...csv(props?.str('restricted_cr_fields')),
    ...csv(props?.str('readonly_cr_fields')),
  ]);
  const ignored: string[] = [];
  const draft = ctx.newRecord(T.change);
  for (const [field, value] of Object.entries(overrides)) {
    const col = draft.column(field);
    if (
      !col ||
      col.system ||
      restricted.has(field) ||
      ['type', 'chg_model', 'std_change_producer_version', 'number', 'state'].includes(field)
    ) {
      ignored.push(field);
      continue;
    }
    values[field] = value;
  }
  if (!values.short_description)
    values.short_description = producer.str('short_description') || producer.str('name');
  if (!values.description && producer.str('description')) values.description = producer.str('description');
  const change = ctx.insert(
    T.change,
    {
      ...values,
      chg_model: MODEL_IDS.standard,
      type: 'standard',
      std_change_producer_version: producer.str('current_version') || null,
    },
    { displayValue: opts.displayValue },
  );
  const version = producer.str('current_version');
  if (version) {
    const sys = ctx.elevated();
    for (const tpl of sys.query(T.taskTemplate, {
      query: `std_change_producer_version=${version}`,
      orderBy: [{ field: 'order', desc: false }],
    })) {
      sys.insert(T.task, {
        ...parseValues(tpl.str('task_values')),
        change_request: change.sysId,
        short_description: tpl.str('short_description') || tpl.str('name'),
        assignment_group: change.str('assignment_group') || null,
        cmdb_ci: change.str('cmdb_ci') || null,
        order: tpl.num('order') ?? 100,
      });
    }
  }
  return { change: ctx.elevated().get(T.change, change.sysId) ?? change, ignored };
}

/** Closing a standard change updates the success counters of its template version. */
export function recordTemplateOutcome(ctx: Context, change: Rec): void {
  const versionId = change.str('std_change_producer_version');
  if (!versionId) return;
  const sys = ctx.elevated();
  const version = sys.get(T.version, versionId);
  if (!version) return;
  const code = change.str('close_code');
  const ok = (version.num('successful_count') ?? 0) + (code === 'unsuccessful' ? 0 : 1);
  const ko = (version.num('unsuccessful_count') ?? 0) + (code === 'unsuccessful' ? 1 : 0);
  const total = ok + ko;
  sys.update(version, {
    successful_count: ok,
    unsuccessful_count: ko,
    successful_pct: total ? Math.round((ok / total) * 1000) / 10 : 0,
    unsuccessful_pct: total ? Math.round((ko / total) * 1000) / 10 : 0,
  });
}

// ----------------------------------------------------------------- proposals

/** Proposal approval: Change Management group through the approvals service. */
export function requestProposalApproval(ctx: Context, proposal: Rec): Rec {
  const state = proposal.num('state');
  if (state !== PROPOSAL.NEW) throw new InvalidError('Only new proposals can be submitted for approval');
  if (proposal.num('type') !== PROPOSAL_TYPE.RETIRE && !proposal.str('template_value')) {
    throw new InvalidError('Template values are required before requesting approval');
  }
  if (proposal.num('type') !== PROPOSAL_TYPE.NEW && !proposal.str('std_change_producer')) {
    throw new InvalidError('Select the standard change template to modify or retire');
  }
  ctx.update(proposal, { state: PROPOSAL.IN_PROGRESS, approval: 'requested' });
  const svc = approvalsOf(ctx.platform);
  if (svc) {
    const sys = ctx.elevated();
    const fresh = sys.get(T.proposal, proposal.sysId) ?? proposal;
    const mgmt = groupByName(
      ctx,
      ctx.platform.properties.get(PROP.managementGroup, 'Change Management') ?? 'Change Management',
    );
    if (mgmt && groupMembers(ctx, mgmt.sysId).length) {
      svc.request(sys, fresh, {
        groups: [mgmt.sysId],
        rule: 'first',
        stage: 'Standard change template approval',
      });
    } else {
      decideProposal(ctx, fresh, 'approved', 'No Change Management approvers: approved automatically.');
    }
  }
  return ctx.elevated().get(T.proposal, proposal.sysId) ?? proposal;
}

/** Publishes or rejects a proposal (approval outcome or change manager decision). */
export function decideProposal(ctx: Context, proposal: Rec, decision: ApprovalDecision, comments = ''): Rec {
  const sys = ctx.elevated();
  const fresh = sys.get(T.proposal, proposal.sysId) ?? proposal;
  if (fresh.num('state') !== PROPOSAL.IN_PROGRESS) return fresh;
  if (decision === 'rejected') {
    sys.update(fresh, {
      state: PROPOSAL.NEW,
      approval: 'rejected',
      work_notes: `Proposal rejected${comments ? `: ${comments}` : '.'}`,
    });
    ctx.queueEvent('std_change_proposal.rejected', fresh, null, null);
    return sys.get(T.proposal, fresh.sysId) ?? fresh;
  }
  const producer = publishProposal(ctx, fresh);
  sys.update(fresh, {
    state: PROPOSAL.COMPLETE,
    approval: 'approved',
    std_change_producer: producer.sysId,
    work_notes: `Proposal approved${comments ? `: ${comments}` : '.'} Template "${producer.str('name')}" ${fresh.num('type') === PROPOSAL_TYPE.RETIRE ? 'retired' : 'published'}.`,
  });
  ctx.queueEvent('std_change_proposal.approved', fresh, producer.sysId, null);
  return sys.get(T.proposal, fresh.sysId) ?? fresh;
}

function publishProposal(ctx: Context, proposal: Rec): Rec {
  const sys = ctx.elevated();
  const type = proposal.num('type') ?? PROPOSAL_TYPE.NEW;
  if (type === PROPOSAL_TYPE.RETIRE) {
    const producer = sys.get(T.producer, proposal.str('std_change_producer'));
    if (!producer) throw new InvalidError('The template to retire no longer exists');
    sys.update(producer, { retired: true, active: false });
    return producer;
  }
  const name = proposal.str('short_description') || `Standard change ${proposal.str('number')}`;
  let producer =
    type === PROPOSAL_TYPE.MODIFY ? sys.get(T.producer, proposal.str('std_change_producer')) : null;
  if (type === PROPOSAL_TYPE.MODIFY && !producer)
    throw new InvalidError('The template to modify no longer exists');
  const holder = producer?.str('template') ? sys.get(T.stdTemplate, producer.str('template')) : null;
  const values = proposal.str('template_value');
  let holderId: string;
  if (holder) {
    sys.update(holder, { template: values });
    holderId = holder.sysId;
  } else {
    holderId = sys.insert(T.stdTemplate, { name, table: T.change, template: values }).sysId;
  }
  if (!producer) {
    producer = sys.insert(T.producer, {
      name,
      short_description: parseValues(values).short_description || name,
      description: proposal.str('description'),
      category: proposal.str('category'),
      active: true,
      template: holderId,
    });
  } else {
    sys.update(producer, {
      template: holderId,
      category: proposal.str('category') || producer.str('category'),
    });
  }
  const last = sys.first(T.version, `std_change_producer=${producer.sysId}`, [
    { field: 'version', desc: true },
  ]);
  const number = (last?.num('version') ?? 0) + 1;
  const version = sys.insert(T.version, {
    std_change_producer: producer.sysId,
    std_change_proposal: proposal.sysId,
    name: `${producer.str('name')} v${number}`,
    version: number,
  });
  const copyFrom = sys.query(T.taskTemplate, {
    query: `std_change_proposal=${proposal.sysId}`,
    orderBy: [{ field: 'order', desc: false }],
  });
  for (const tpl of copyFrom) {
    sys.insert(T.taskTemplate, {
      std_change_producer_version: version.sysId,
      name: tpl.str('name'),
      order: tpl.num('order') ?? 100,
      short_description: tpl.str('short_description'),
      task_values: tpl.str('task_values'),
    });
  }
  sys.update(producer, { current_version: version.sysId });
  return sys.get(T.producer, producer.sysId) ?? producer;
}

/** Builds a proposal from an existing change (Propose a Standard Change Template). */
export function proposalFromChange(ctx: Context, change: Rec): Rec {
  const fields = [
    'short_description',
    'description',
    'category',
    'implementation_plan',
    'backout_plan',
    'test_plan',
    'risk_impact_analysis',
    'justification',
    'assignment_group',
    'risk',
    'impact',
  ];
  const values: Record<string, unknown> = {};
  for (const f of fields) if (change.str(f)) values[f] = change.str(f);
  return ctx.insert(T.proposal, {
    type: PROPOSAL_TYPE.NEW,
    short_description: change.str('short_description'),
    description: change.str('description'),
    category: change.str('category'),
    template_value: encodeValues(values),
    sample_change_requests: change.sysId,
  });
}

export interface TemplateDef {
  name: string;
  short_description?: string;
  description?: string;
  category?: string;
  /** Change field values applied to changes created from the template. */
  values: Record<string, unknown>;
  tasks?: { name: string; short_description?: string; order?: number; values?: Record<string, unknown> }[];
}

/** Publishes a standard change template directly (seed and demo data); returns the producer. */
export function createTemplate(ctx: Context, def: TemplateDef): Rec {
  const sys = ctx.elevated();
  const existing = sys.first(T.producer, `name=${def.name}`);
  if (existing) return existing;
  const holder = sys.insert(T.stdTemplate, {
    name: def.name,
    table: T.change,
    template: encodeValues(def.values),
  });
  const producer = sys.insert(T.producer, {
    name: def.name,
    short_description: def.short_description ?? String(def.values.short_description ?? def.name),
    description: def.description ?? '',
    category: def.category ?? '',
    active: true,
    template: holder.sysId,
  });
  const version = sys.insert(T.version, {
    std_change_producer: producer.sysId,
    name: `${def.name} v1`,
    version: 1,
  });
  (def.tasks ?? []).forEach((t, i) => {
    sys.insert(T.taskTemplate, {
      std_change_producer_version: version.sysId,
      name: t.name,
      order: t.order ?? (i + 1) * 100,
      short_description: t.short_description ?? t.name,
      task_values: encodeValues(t.values ?? {}),
    });
  });
  sys.update(producer, { current_version: version.sysId });
  return sys.get(T.producer, producer.sysId) ?? producer;
}
