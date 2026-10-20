import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { isSysId } from '../../engine/util.js';
import type { ScriptRuleInfo, ScriptRuntime } from './service.js';

/**
 * Turns sys_script records (business rules written by administrators) into engine rules with
 * source 'script'. Native rules mirrored into sys_script carry a native_id and are left alone.
 */
export class ScriptRuleLoader {
  constructor(
    private readonly platform: Platform,
    private readonly runtime: ScriptRuntime,
  ) {}

  static ruleId(sysId: string): string {
    return `sys_script:${sysId}`;
  }

  /** Registers every eligible sys_script record (boot). */
  loadAll(): number {
    if (!this.platform.registry.has('sys_script')) return 0;
    let n = 0;
    for (const rec of this.platform
      .systemContext()
      .query('sys_script', 'native_idISEMPTY^collectionISNOTEMPTY')) {
      if (this.sync(rec)) n++;
    }
    return n;
  }

  /** (Re)registers the rule for a sys_script record; returns whether it is active. */
  sync(rec: Rec): boolean {
    const id = ScriptRuleLoader.ruleId(rec.sysId);
    this.platform.rules.remove(id);
    const info = this.info(rec);
    if (!info) return false;
    this.platform.rules.add(this.def(info), 'script');
    return true;
  }

  remove(rec: Rec): void {
    this.platform.rules.remove(ScriptRuleLoader.ruleId(rec.sysId));
  }

  private info(rec: Rec): ScriptRuleInfo | null {
    if (rec.str('native_id')) return null;
    const table = rec.str('collection').trim();
    if (!table || (table !== 'global' && !this.platform.registry.has(table))) return null;
    if (rec.get('active') !== null && !rec.bool('active')) return null;
    const script = rec.str('script');
    const abortAction = rec.bool('abort_action');
    const template = rec.str('template');
    const addMessage = rec.bool('add_message');
    if (!script.trim() && !abortAction && !template.trim() && !addMessage) return null;
    const when = mapWhen(rec.str('when'));
    const actions: ScriptRuleInfo['actions'] = [];
    if (when === 'display') {
      actions.push('insert', 'update', 'delete', 'query');
    } else {
      if (rec.bool('action_insert')) actions.push('insert');
      if (rec.bool('action_update')) actions.push('update');
      if (rec.bool('action_delete')) actions.push('delete');
      if (rec.bool('action_query')) actions.push('query');
    }
    return {
      id: ScriptRuleLoader.ruleId(rec.sysId),
      sysId: rec.sysId,
      name: rec.str('name') || rec.sysId,
      table,
      when,
      actions,
      order: rec.num('order') ?? 100,
      script,
      condition: rec.str('condition'),
      filter: rec.str('filter_condition'),
      roles: this.roles(rec.str('role_conditions')),
      addMessage,
      message: rec.str('message'),
      abortAction,
      template,
    };
  }

  /** role_conditions holds role names or role sys_ids, comma separated. */
  private roles(value: string): string[] {
    return value
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        if (!isSysId(r)) return r;
        const row = this.platform.db.get<{ name: string }>(
          `SELECT "name" FROM "sys_user_role" WHERE "sys_id" = ?`,
          [r],
        );
        return row?.name ?? r;
      });
  }

  private def(info: ScriptRuleInfo): BusinessRuleDef {
    const def: BusinessRuleDef = {
      id: info.id,
      name: info.name,
      table: info.table,
      when: info.when,
      actions: info.actions,
      order: info.order,
      module: 'scripts',
      description: `Script business rule (sys_script ${info.sysId})`,
      condition: (cur, prev, ctx) => this.runtime.ruleCondition(info, cur, prev, ctx),
      run: (cur, prev, ctx) => this.runtime.runRule(info, cur, prev, ctx),
    };
    if (info.when === 'before' && info.actions.includes('query')) {
      def.query = (qb, ctx) => this.runtime.runQueryRule(info, qb, ctx);
    }
    return def;
  }
}

function mapWhen(when: string): ScriptRuleInfo['when'] {
  switch (when.trim()) {
    case 'after':
      return 'after';
    case 'async':
    case 'async_always':
      return 'async';
    case 'display':
    case 'before_display':
      return 'display';
    default:
      return 'before';
  }
}
