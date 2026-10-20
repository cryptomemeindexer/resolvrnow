/** Contract basics (asset.md section 7): state model, daily state management and asset coverage. */
import type { Context } from '../../engine/context.js';
import type { UiActionDef } from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { clock, toGlideDate } from '../../engine/util.js';

const DAY = 86_400_000;
const today = () => toGlideDate(clock.now());

const SUBSTATES: Record<string, string[]> = {
  draft: ['awaiting_review', 'under_review', 'approved'],
  active: [''],
  expired: [''],
  cancelled: [''],
};

/** Keeps substate consistent with state: draft defaults to awaiting_review, other states have none. */
function normalizeSubstate(cur: Rec): void {
  const state = cur.str('state') || 'draft';
  const allowed = SUBSTATES[state];
  if (!allowed) {
    cur.abort(`Invalid contract state ${state}`);
    return;
  }
  if (allowed.includes(cur.str('substate'))) return;
  if (cur.touched.has('substate') && cur.str('substate') && cur.changed('substate')) {
    cur.abort(`Substate ${cur.str('substate')} is not valid for state ${state}`);
    return;
  }
  cur.setRaw('substate', state === 'draft' ? 'awaiting_review' : null);
}

/** Latest end date of the active warranties covering an asset, written to warranty_expiration. */
export function refreshWarranty(ctx: Context, assetId: string): void {
  const row = ctx.platform.db.get<{ ends: string | null }>(
    `SELECT MAX(c."ends") AS ends FROM "clm_m2m_contract_asset" m JOIN "ast_contract" c ON c."sys_id" = m."contract"
     WHERE m."asset" = ? AND (m."removed" IS NULL OR m."removed" = '') AND c."sys_class_name" = 'ast_warranty' AND c."state" = 'active'`,
    [assetId],
  );
  if (!row?.ends) return;
  const asset = ctx.elevated().get('alm_asset', assetId);
  if (asset && asset.str('warranty_expiration') !== row.ends)
    ctx.elevated().update(asset, { warranty_expiration: row.ends });
}

export const contractRules: BusinessRuleDef[] = [
  {
    name: 'Contract: substate follows state',
    table: 'ast_contract',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run: (cur) => normalizeSubstate(cur),
  },
  {
    name: 'Contract: active flag follows state',
    table: 'ast_contract',
    when: 'before',
    actions: ['insert', 'update'],
    order: 60,
    condition: (cur) => cur.isNew() || cur.changed('state'),
    run(cur) {
      if (cur.str('state') === 'expired' || cur.str('state') === 'cancelled') cur.setRaw('active', 0);
      else if (cur.str('state') === 'active') cur.setRaw('active', 1);
    },
  },
  {
    name: 'Contract: refresh covered warranties',
    table: 'ast_warranty',
    when: 'after',
    actions: ['update'],
    condition: (cur) => cur.changed('ends') || cur.changed('state'),
    run(cur, _prev, ctx) {
      for (const m of ctx.elevated().query('clm_m2m_contract_asset', { query: `contract=${cur.sysId}` }))
        refreshWarranty(ctx, m.str('asset'));
    },
  },
  {
    name: 'Contract coverage: one row per contract and asset',
    table: 'clm_m2m_contract_asset',
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.isNew() || cur.changed('contract') || cur.changed('asset'),
    run(cur, _prev, ctx) {
      const dup = ctx.platform.db.get(
        `SELECT "sys_id" FROM "clm_m2m_contract_asset" WHERE "contract" = ? AND "asset" = ? AND "sys_id" <> ?`,
        [cur.str('contract'), cur.str('asset'), cur.sysId],
      );
      if (dup) {
        cur.abort('This asset is already covered by the contract');
        return;
      }
      if (!cur.str('added')) cur.setRaw('added', today());
    },
  },
  {
    name: 'Contract coverage: refresh warranty expiration',
    table: 'clm_m2m_contract_asset',
    when: 'after',
    actions: ['insert', 'update'],
    run: (cur, _prev, ctx) => refreshWarranty(ctx, cur.str('asset')),
  },
];

// ------------------------------------------------------------ the job

/** Daily contract state management (asset.md 7). */
export function runContractJob(ctx: Context): {
  activated: number;
  notified: number;
  renewed: number;
  expired: number;
} {
  const sys = ctx.elevated();
  const day = today();
  const out = { activated: 0, notified: 0, renewed: 0, expired: 0 };
  for (const c of sys.query('ast_contract', `state=draft^substate=approved^starts<=${day}`)) {
    sys.update(c, { state: 'active', substate: '', active: true });
    out.activated++;
  }
  for (const c of sys.query('ast_contract', `state=active^notice_date<=${day}^expiration_notified!=true`)) {
    sys.queueEvent('contract.expiration_notice', c, c.str('ends'), c.str('number'));
    sys.update(c, { expiration_notified: true });
    out.notified++;
  }
  for (const c of sys.query('ast_contract', `state=active^ends<${day}`)) {
    if (c.bool('renewable') && c.str('renewal_end_date') && c.str('renewal_end_date') >= day) {
      const starts =
        c.str('renewal_date') || toGlideDate(new Date(Date.parse(`${c.str('ends')}T00:00:00Z`) + DAY));
      const ends = c.str('renewal_end_date');
      sys.update(c, {
        starts,
        ends,
        renewal_date: null,
        renewal_end_date: null,
        expiration_notified: false,
        work_notes: `Contract renewed automatically: new term ${starts} to ${ends}.`,
      });
      sys.queueEvent('contract.renewed', c, starts, ends);
      out.renewed++;
    } else {
      sys.update(c, { state: 'expired', active: false });
      sys.queueEvent('contract.expired', c, c.str('ends'), null);
      out.expired++;
    }
  }
  return out;
}

/** Milliseconds until the next 00:05 UTC, so the daily job runs just after midnight. */
export function msUntilNextRun(): number {
  const now = clock.now();
  let next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5, 0);
  if (next <= now.getTime()) next += DAY;
  return next - now.getTime();
}

// --------------------------------------------------------- UI actions

export const contractActions: UiActionDef[] = [
  {
    id: 'contract.submit_review',
    table: 'ast_contract',
    label: 'Submit for review',
    style: 'primary',
    roles: ['asset', 'contract_manager'],
    condition: 'state=draft^substate=awaiting_review',
    prompt: [{ field: 'approver', mandatory: true }],
    run(rec, ctx, input) {
      ctx.update(rec, { approver: input.approver ?? rec.str('approver'), substate: 'under_review' });
      return { message: 'Contract submitted for review' };
    },
  },
  {
    id: 'contract.approve',
    table: 'ast_contract',
    label: 'Approve',
    style: 'primary',
    roles: ['asset', 'contract_manager'],
    condition: 'state=draft^substate=under_review',
    run(rec, ctx) {
      ctx.update(rec, { substate: 'approved' });
      return { message: 'Contract approved; it becomes active on its start date' };
    },
  },
  {
    id: 'contract.reject',
    table: 'ast_contract',
    label: 'Reject',
    style: 'destructive',
    roles: ['asset', 'contract_manager'],
    condition: 'state=draft^substate=under_review',
    prompt: [{ field: 'work_notes', label: 'Reason', mandatory: true }],
    run(rec, ctx, input) {
      ctx.update(rec, {
        substate: 'awaiting_review',
        work_notes: `Review rejected: ${String(input.work_notes ?? '')}`,
      });
      return { message: 'Contract sent back for changes' };
    },
  },
  {
    id: 'contract.cancel',
    table: 'ast_contract',
    label: 'Cancel contract',
    style: 'destructive',
    roles: ['asset', 'contract_manager'],
    condition: 'stateNOT INexpired,cancelled',
    confirm: 'Cancel this contract?',
    run(rec, ctx) {
      ctx.update(rec, { state: 'cancelled', substate: '', active: false });
      return { message: 'Contract cancelled' };
    },
  },
];
