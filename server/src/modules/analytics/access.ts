import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { term } from './grouping.js';
import { formulaRefs } from './kpis.js';

/**
 * Who sees and edits reports, dashboards and scores.
 *
 * Reports (ResolvrNow mapping of the documented Me / Everyone / Groups and Users sharing):
 * `user` holds the owner's sys_id for personal reports or `GLOBAL` for everyone, `group`
 * shares with one group, `sys_report_users_groups` rows share with users and groups,
 * `roles` restricts viewers to role holders and `is_published` also shares with everyone.
 * Owners, report_admin and admin always see and edit.
 *
 * Dashboards: owner and requester edit; `par_dashboard_permission` rows grant view or
 * edit to a user, a group or a role; report_admin and dashboard_admin manage all.
 */

export const GLOBAL = 'GLOBAL';
export const REPORT_CREATOR_ROLES = ['itil', 'report_user', 'report_group', 'report_global', 'report_admin'];
export const DASHBOARD_CREATOR_ROLES = [
  'report_user',
  'report_group',
  'report_global',
  'report_admin',
  'dashboard_admin',
  'pa_admin',
];
export const PA_ADMIN_ROLES = ['pa_admin', 'report_admin'];

export type ReportVisibility = 'everyone' | 'group' | 'users' | 'me';
export type DashboardAccess = 'edit' | 'view' | null;

export function isReportAdmin(ctx: Context): boolean {
  return ctx.user.isSystem || ctx.hasRole('report_admin');
}

const roleList = (v: string): string[] =>
  v
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

export function isReportOwner(ctx: Context, rec: Rec): boolean {
  const me = ctx.user.sysId;
  if (!me) return false;
  if (rec.str('created_by_user') === me || rec.str('user') === me) return true;
  return !rec.str('created_by_user') && rec.str('sys_created_by') === ctx.user.userName;
}

function reportShares(ctx: Context, rec: Rec): Rec[] {
  if (!rec.sysId || !ctx.registry.has('sys_report_users_groups')) return [];
  return ctx.elevated().query('sys_report_users_groups', { query: `report_id=${rec.sysId}` });
}

export function reportVisibility(ctx: Context, rec: Rec): ReportVisibility {
  if (rec.str('user').toUpperCase() === GLOBAL || rec.bool('is_published')) return 'everyone';
  if (rec.str('group')) return 'group';
  if (reportShares(ctx, rec).length) return 'users';
  return rec.str('user') ? 'me' : 'everyone';
}

export function canViewReport(ctx: Context, rec: Rec): boolean {
  if (isReportAdmin(ctx) || isReportOwner(ctx, rec)) return true;
  const roles = roleList(rec.str('roles'));
  if (roles.length && !ctx.hasAnyRole(roles)) return false;
  const user = rec.str('user');
  if (user.toUpperCase() === GLOBAL || rec.bool('is_published')) return true;
  const group = rec.str('group');
  if (group && ctx.user.groups.includes(group)) return true;
  const shares = reportShares(ctx, rec);
  const me = ctx.user.sysId;
  if (
    shares.some(
      (s) =>
        (!!me && s.str('user_id') === me) ||
        (!!s.str('group_id') && ctx.user.groups.includes(s.str('group_id'))),
    )
  ) {
    return true;
  }
  // Definitions without any sharing information (imported or legacy) are visible to everyone.
  return !user && !group && shares.length === 0;
}

export function canEditReport(ctx: Context, rec: Rec | null): boolean {
  if (isReportAdmin(ctx)) return true;
  if (!ctx.hasAnyRole(REPORT_CREATOR_ROLES)) return false;
  return !rec || rec.isNew() || isReportOwner(ctx, rec);
}

/** Validates sharing changes: everyone needs report_global, groups need report_group. */
export function sharingError(ctx: Context, rec: Rec): string | null {
  if (ctx.user.isSystem || isReportAdmin(ctx)) return null;
  const shared =
    (rec.changed('user') && rec.str('user').toUpperCase() === GLOBAL) ||
    (rec.changed('is_published') && rec.bool('is_published'));
  if (shared && !ctx.hasRole('report_global'))
    return 'Sharing a report with everyone requires the report_global role';
  if (rec.changed('group') && rec.str('group') && !ctx.hasAnyRole(['report_group', 'report_global'])) {
    return 'Sharing a report with a group requires the report_group role';
  }
  return null;
}

export function dashboardAccess(ctx: Context, dash: Rec): DashboardAccess {
  if (ctx.user.isSystem || ctx.hasAnyRole(['report_admin', 'dashboard_admin'])) return 'edit';
  const me = ctx.user.sysId;
  if (me && (dash.str('owner') === me || dash.str('requester') === me)) return 'edit';
  if (!dash.bool('active')) return null;
  let access: DashboardAccess = null;
  for (const p of ctx.elevated().query('par_dashboard_permission', { query: `dashboard=${dash.sysId}` })) {
    const role = p.str('role') ? p.display('role') : '';
    const matches =
      (!!me && p.str('user') === me) ||
      (!!p.str('group') && ctx.user.groups.includes(p.str('group'))) ||
      (!!role && ctx.hasRole(role));
    if (!matches) continue;
    if (p.str('access') === 'edit') return 'edit';
    access = 'view';
  }
  return access;
}

/** Access to a dashboard child row (tab, widget, filter, permission) follows its dashboard. */
export function parentDashboardAccess(ctx: Context, rec: Rec | null): DashboardAccess | 'table' {
  if (!rec) return 'table';
  const dash = ctx.elevated().get('par_dashboard', rec.str('dashboard'));
  return dash ? dashboardAccess(ctx, dash) : null;
}

const scoreAccess = new WeakMap<Context, Map<string, boolean>>();

/** Scores are readable when every facts table behind the indicator is readable. */
export function canReadIndicatorScores(ctx: Context, indicatorId: string): boolean {
  if (ctx.user.isSystem || ctx.user.isAdmin) return true;
  let memo = scoreAccess.get(ctx);
  if (!memo) {
    memo = new Map();
    scoreAccess.set(ctx, memo);
  }
  const hit = memo.get(indicatorId);
  if (hit !== undefined) return hit;
  const sys = ctx.elevated();
  const tables = new Set<string>();
  const seen = new Set<string>();
  const walk = (rec: Rec | null) => {
    if (!rec || seen.has(rec.sysId)) return;
    seen.add(rec.sysId);
    const formula = rec.str('formula');
    if (rec.str('type') === 'formula' || rec.str('aggregate') === 'FORMULA') {
      for (const ref of formulaRefs(formula)) {
        walk(
          sys.first('pa_indicators', term('resolvr_key', '=', ref)) ??
            sys.first('pa_indicators', term('name', '=', ref)),
        );
      }
      return;
    }
    const cube = rec.ref('cube');
    if (cube?.str('facts_table')) tables.add(cube.str('facts_table'));
  };
  walk(sys.get('pa_indicators', indicatorId));
  const ok = [...tables].every(
    (t) => !ctx.registry.has(t) || ctx.platform.acl.canTable(ctx, t, 'read').allowed,
  );
  memo.set(indicatorId, ok);
  return ok;
}
