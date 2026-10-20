/** Seed data (skill configuration, solution definitions) and demo setup of the AI module. */
import type { Context } from '../../engine/context.js';
import { PROP } from './config.js';
import { aiEngineOf } from './service.js';
import { SKILLS } from './skills/defs.js';

/** Solution definitions shipped for incidents (created only when the incident table exists). */
export const INCIDENT_SOLUTIONS = [
  {
    name: 'ml_incident_categorization',
    label: 'Incident Categorization',
    output_field: 'category',
    input_fields: 'short_description,description',
    confidence_threshold: 60,
  },
  {
    name: 'ml_incident_assignment',
    label: 'Incident Assignment',
    output_field: 'assignment_group',
    input_fields: 'short_description,description',
    confidence_threshold: 70,
  },
] as const;

/** Training filter: incidents resolved or closed in the last 12 months. */
export const INCIDENT_TRAINING_FILTER =
  'sys_created_onONLast 12 months@javascript:gs.monthsAgoStart(12)@javascript:gs.endOfToday()^stateIN6,7';

export function seedAi(ctx: Context): void {
  const reg = ctx.platform.registry;
  for (const def of SKILLS.values()) {
    if (ctx.first('sn_nowassist_skill_config', `skill_id=${def.id}`)) continue;
    ctx.insert('sn_nowassist_skill_config', {
      skill_id: def.id,
      name: def.label,
      description: def.description,
      active: def.defaultActive,
      table: def.table ?? '',
      roles: def.defaultRoles.join(','),
      trigger_mode: 'user',
      display: 'in_product',
    });
  }
  if (reg.has('incident')) {
    for (const s of INCIDENT_SOLUTIONS) {
      if (!reg.table('incident').columns.has(s.output_field)) continue;
      if (ctx.first('ml_solution_definition', `name=${s.name}`)) continue;
      ctx.insert('ml_solution_definition', {
        ...s,
        capability: 'classification',
        table: 'incident',
        filter: INCIDENT_TRAINING_FILTER,
        training_frequency: 'every_30_days',
        target_precision: 80,
        // Predictions are only logged until an administrator chooses autofill.
        prediction_preference: 'monitor_only',
        active: true,
      });
    }
  }
}

/** Gives the MCP role to every user and group that holds the agent (itil) role. */
function grantMcpToAgents(ctx: Context): void {
  const mcp = ctx.first('sys_user_role', 'name=mcp_user');
  const itil = ctx.first('sys_user_role', 'name=itil');
  if (!mcp || !itil) return;
  for (const ur of ctx.query('sys_user_has_role', `role=${itil.sysId}`)) {
    if (!ctx.first('sys_user_has_role', `user=${ur.str('user')}^role=${mcp.sysId}`)) {
      ctx.insert('sys_user_has_role', { user: ur.str('user'), role: mcp.sysId });
    }
  }
  if (ctx.platform.registry.has('sys_group_has_role')) {
    for (const gr of ctx.query('sys_group_has_role', `role=${itil.sysId}`)) {
      if (!ctx.first('sys_group_has_role', `group=${gr.str('group')}^role=${mcp.sysId}`)) {
        ctx.insert('sys_group_has_role', { group: gr.str('group'), role: mcp.sysId });
      }
    }
  }
  ctx.platform.users.invalidate();
}

/**
 * Demo: every skill active, the MCP endpoint enabled for agents, and the incident
 * solutions trained on autofill when incidents exist.
 */
export function demoAi(ctx: Context): void {
  const p = ctx.platform;
  for (const cfg of ctx.query('sn_nowassist_skill_config', 'active=false')) ctx.update(cfg, { active: true });
  p.properties.set(PROP.mcpEnabled, 'true');
  grantMcpToAgents(ctx);
  const engine = aiEngineOf(p);
  if (!engine || !p.registry.has('incident') || ctx.count('incident') === 0) return;
  for (const s of INCIDENT_SOLUTIONS) {
    const def = ctx.first('ml_solution_definition', `name=${s.name}`);
    if (!def) continue;
    // Demo data is mostly open: train on every incident that has a value.
    ctx.update(def, { filter: '', prediction_preference: 'autofill' });
    try {
      const res = engine.predictor.train(ctx, def.sysId);
      if (res.state !== 'solution_complete')
        p.log.info(`[resolvrnow] demo training of ${s.name} skipped: ${res.error}`);
    } catch (e) {
      p.log.warn(
        `[resolvrnow] demo training of ${s.name} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
