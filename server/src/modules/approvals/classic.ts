/**
 * Classic approval rules (sysrule_approvals): when a task table's approval engine is
 * set to `approval_engine` (property glide.approval_engine.<table>, off by default),
 * matching rules add approvers while nothing has been requested yet. Rules that run
 * before the save may also set the record's approval value.
 */
import type { Context } from '../../engine/context.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import type { ColumnDef, TableDef } from '../../engine/types.js';
import { isSysId } from '../../engine/util.js';
import { optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { APPROVAL_STATE_CHOICES, ST } from './constants.js';
import { approvalEngine } from './engine.js';

export const RULE_TABLE = 'sysrule_approvals';

const bool = (name: string, label: string, defaultValue: string): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue,
});

export const approvalRuleTable: TableDef = {
  name: RULE_TABLE,
  label: 'Approval Rule',
  plural: 'Approval Rules',
  displayField: 'name',
  description: 'Classic approval rules, used when a table runs the approval rules engine.',
  columns: [
    { name: 'name', label: 'Name', type: 'string', maxLength: 100, mandatory: true },
    { name: 'table', label: 'Table', type: 'table_name', maxLength: 80, mandatory: true },
    bool('active', 'Active', 'true'),
    bool('run_before', 'Run rule before', 'true'),
    { name: 'user', label: 'User', type: 'reference', reference: 'sys_user' },
    { name: 'group', label: 'Group', type: 'reference', reference: 'sys_user_group' },
    { name: 'set_state', label: 'Set state', type: 'string', maxLength: 40, choices: APPROVAL_STATE_CHOICES },
    { name: 'condition', label: 'Condition', type: 'conditions', maxLength: 4000 },
    { name: 'script', label: 'Script', type: 'script', maxLength: 100000 },
    { name: 'order', label: 'Order', type: 'integer', defaultValue: 100 },
    { name: 'description', label: 'Description', type: 'string', maxLength: 1000 },
  ],
};

/** Saves where the engine applies, with the approvers found before the save (created once the record exists). */
const pending = new WeakMap<Rec, string[]>();

/** Engine selected for a class: glide.approval_engine.<table> on the class or its nearest ancestor. */
export function approvalEngineFor(ctx: Context, table: string): string {
  const meta = ctx.platform.registry.tryTable(table);
  for (const t of meta?.ancestors ?? [table]) {
    const v = ctx.platform.properties.get(`glide.approval_engine.${t}`);
    if (v) return v;
  }
  return 'off';
}

function matchingRules(ctx: Context, rec: Rec, runBefore: boolean): Rec[] {
  const tables = rec.table.ancestors.join(',');
  const sys = ctx.elevated();
  return sys
    .query(RULE_TABLE, {
      query: `active=true^tableIN${tables}^run_before=${runBefore}`,
      orderBy: [{ field: 'order', desc: false }],
    })
    .filter(
      (rule) =>
        !rule.str('condition') ||
        matches(rule.str('condition'), recSubject(rec, null, ctx.platform.registry), ctx.env),
    );
}

function usersOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(usersOf);
  if (typeof value === 'object' && 'sysId' in (value as object)) return [String((value as Rec).sysId)];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(isSysId);
}

function approversOf(ctx: Context, rules: Rec[], rec: Rec): string[] {
  const out: string[] = [];
  const scripts = optionalService<ScriptService>(ctx.platform, SERVICES.scripts);
  for (const rule of rules) {
    if (rule.str('user')) out.push(rule.str('user'));
    if (rule.str('group')) {
      out.push(
        ...ctx.platform.db
          .all<{ user: string }>(`SELECT "user" FROM "sys_user_grmember" WHERE "group" = ?`, [
            rule.str('group'),
          ])
          .map((r) => r.user),
      );
    }
    if (rule.str('script') && scripts) {
      try {
        out.push(...usersOf(scripts.run(ctx.elevated(), rule.str('script'), { current: rec })));
      } catch (e) {
        ctx.platform.reportError(`approval rule ${rule.str('name')}`, e);
      }
    }
  }
  return [...new Set(out)];
}

function applies(ctx: Context, cur: Rec): boolean {
  if (approvalEngineFor(ctx, cur.className) !== 'approval_engine') return false;
  const approval = cur.str('approval');
  return !approval || approval === ST.notRequested;
}

/** Before engine: run-before rules collect approvers and may set the approval value. */
export function runRulesBefore(cur: Rec, ctx: Context): void {
  if (!applies(ctx, cur)) return;
  const rules = matchingRules(ctx, cur, true);
  pending.set(cur, approversOf(ctx, rules, cur));
  for (const rule of rules) if (rule.str('set_state')) cur.setRaw('approval', rule.str('set_state'));
}

/** After engine: creates the approvals (run-before approvers plus the after rules). */
export function runRulesAfter(cur: Rec, ctx: Context): void {
  const early = pending.get(cur);
  if (!early) return;
  pending.delete(cur);
  const late = approversOf(ctx, matchingRules(ctx, cur, false), cur);
  const users = [...new Set([...early, ...late])];
  if (!users.length) return;
  approvalEngine(ctx.platform).requestStep(ctx, cur, {
    users,
    rule: 'all',
    source: 'rule',
    stage: 'Approval rules',
  });
}
