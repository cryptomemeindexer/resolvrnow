import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { APPROVAL_TABLE, ST, STEP_TABLE } from './constants.js';
import { ApprovalNotPendingError, approvalEngine } from './engine.js';

/** Target fields summarised for approvers when present on the record's table. */
const SUMMARY_FIELDS = [
  'number',
  'short_description',
  'description',
  'state',
  'priority',
  'risk',
  'impact',
  'category',
  'type',
  'opened_by',
  'requested_by',
  'requested_for',
  'assignment_group',
  'assigned_to',
  'start_date',
  'end_date',
  'price',
  'due_date',
  'title',
  'name',
];

const pair = (rec: Rec, field: string) => ({ value: rec.str(field), display_value: rec.display(field) });

/** Approval row with the summary of the record being approved (read without ACLs so approvers see what they decide). */
export function approvalSummary(ctx: Context, row: Rec): Record<string, unknown> {
  const sys = ctx.elevated();
  const table = row.str('source_table');
  const id = row.str('document_id');
  const target = table && id && ctx.platform.registry.has(table) ? sys.get(table, id) : null;
  const step = row.str('resolvr_step') ? sys.get(STEP_TABLE, row.str('resolvr_step')) : null;
  const me = ctx.user.sysId;
  const fields: Record<string, { value: string; display_value: string }> = {};
  if (target) for (const f of SUMMARY_FIELDS) if (target.column(f)?.storage) fields[f] = pair(target, f);
  return {
    sys_id: row.sysId,
    state: pair(row, 'state'),
    approver: pair(row, 'approver'),
    delegated: !!me && row.str('approver') !== me,
    group: pair(row, 'group'),
    stage: step?.str('label') ?? '',
    due_date: row.str('due_date'),
    created_on: row.str('sys_created_on'),
    decided_by: pair(row, 'resolvr_decided_by'),
    decided_on: row.str('resolvr_decided_on'),
    record: target
      ? {
          table: target.className,
          table_label: target.table.label,
          sys_id: target.sysId,
          display_value: target.displayValue(),
          fields,
        }
      : {
          table,
          table_label: ctx.platform.registry.tryTable(table)?.label ?? table,
          sys_id: id,
          display_value: '',
          fields,
        },
  };
}

export function registerApprovalApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;

  /** Pending approvals of the caller, including those delegated to them. */
  app.get('/api/app/approvals/mine', async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '200', 10) || 200, 1), 1000);
    const rows = approvalEngine(platform).pendingFor(ctx, { limit });
    return { result: rows.map((r) => approvalSummary(ctx, r)) };
  });

  const decide = (decision: 'approved' | 'rejected') => async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { comments?: unknown };
    const comments = typeof body.comments === 'string' ? body.comments.trim() : '';
    const engine = approvalEngine(platform);
    // Approvers may not be able to read the record itself; an approval routed to them (or a delegator) is enough.
    const row = ctx.elevated().get(APPROVAL_TABLE, id);
    if (!row || (!engine.canDecide(ctx, row) && !ctx.get(APPROVAL_TABLE, id))) throw new NotFoundError();
    if (decision === ST.rejected && !comments)
      throw new HttpError(400, 'Comments are required to reject an approval');
    try {
      engine.decide(ctx, row, decision, comments, { source: 'api' });
    } catch (e) {
      if (e instanceof ApprovalNotPendingError) throw new HttpError(409, e.message);
      throw e;
    }
    platform.scheduleWork();
    const fresh = ctx.elevated().get(APPROVAL_TABLE, id) ?? row;
    return { result: approvalSummary(ctx, fresh) };
  };

  app.post('/api/app/approvals/:id/approve', decide('approved'));
  app.post('/api/app/approvals/:id/reject', decide('rejected'));
}
