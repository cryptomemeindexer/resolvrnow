import type { Context } from './context.js';
import type { MacroEnv } from './query/macros.js';
import type { MatchSubject } from './query/matcher.js';
import { matches } from './query/matcher.js';
import type { QueryBuilder } from './querybuilder.js';
import type { Rec } from './record.js';
import type { SchemaRegistry } from './registry.js';
import type { ColumnMeta } from './types.js';

export type RuleWhen = 'before' | 'after' | 'async' | 'display';
export type RuleAction = 'insert' | 'update' | 'delete' | 'query';

export type RuleCondition = string | ((current: Rec, previous: Rec | null, ctx: Context) => boolean);

export interface BusinessRuleDef {
  /** Stable identifier; defaults to `<table>:<name>`. */
  id?: string;
  name: string;
  table: string;
  when: RuleWhen;
  actions: RuleAction[];
  /** Lower runs first; default 100. */
  order?: number;
  /** Encoded query evaluated against current/previous, or a predicate. */
  condition?: RuleCondition;
  run?: (current: Rec, previous: Rec | null, ctx: Context) => void;
  /** Query rules (actions: ['query']) restrict queries before they run. */
  query?: (q: QueryBuilder, ctx: Context) => void;
  description?: string;
  module?: string;
  active?: boolean;
}

export interface RegisteredRule extends BusinessRuleDef {
  id: string;
  order: number;
  /** Source of the rule: native TypeScript or a sandboxed script from sys_script. */
  source: 'native' | 'script';
}

/** Builds a matcher subject over a record and its previous state. */
export function recSubject(rec: Rec, previous: Rec | null, registry: SchemaRegistry): MatchSubject {
  const colOf = (path: string): ColumnMeta | null => {
    const parts = path.split('.');
    let table = rec.table;
    for (let i = 0; i < parts.length; i++) {
      const c = table.columns.get(parts[i]);
      if (!c) return null;
      if (i === parts.length - 1) return c;
      if (c.type !== 'reference' || !c.reference) return null;
      const t = registry.tryTable(c.reference);
      if (!t) return null;
      table = t;
    }
    return null;
  };
  return {
    value: (path) => (colOf(path) ? rec.get(path) : undefined),
    previous: (path) => {
      if (!colOf(path)) return undefined;
      if (previous) return previous.get(path);
      return path.includes('.') ? null : rec.prev(path);
    },
    isNew: () => rec.isNew() || rec.operation === 'insert',
    column: colOf,
    display: (path) => rec.display(path),
    classes: () => rec.table.ancestors,
    descendantsOf: (t) => registry.tryTable(t)?.descendants ?? [],
    text: () =>
      ['number', 'short_description', 'description', 'name', 'title', 'text']
        .filter((f) => rec.has(f))
        .map((f) => rec.str(f))
        .join(' '),
  };
}

export class RuleRegistry {
  private rules = new Map<string, RegisteredRule>();
  private byTable = new Map<string, RegisteredRule[]>();
  private disabled = new Set<string>();

  constructor(private registry: SchemaRegistry) {}

  add(def: BusinessRuleDef, source: 'native' | 'script' = 'native'): RegisteredRule {
    const id = def.id ?? `${def.table}:${def.name}`;
    const rule: RegisteredRule = { ...def, id, order: def.order ?? 100, source };
    this.rules.set(id, rule);
    this.byTable.clear();
    return rule;
  }

  remove(id: string): void {
    this.rules.delete(id);
    this.byTable.clear();
  }

  setActive(id: string, active: boolean): void {
    if (active) this.disabled.delete(id);
    else this.disabled.add(id);
  }

  all(): RegisteredRule[] {
    return [...this.rules.values()];
  }

  get(id: string): RegisteredRule | undefined {
    return this.rules.get(id);
  }

  /** Rules applying to a class (rules on ancestors apply to descendants), sorted by order. */
  forTable(table: string): RegisteredRule[] {
    let list = this.byTable.get(table);
    if (!list) {
      const meta = this.registry.tryTable(table);
      const ancestors = new Set(meta?.ancestors ?? [table]);
      list = [...this.rules.values()]
        .filter((r) => ancestors.has(r.table) || r.table === 'global')
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      this.byTable.set(table, list);
    }
    return list.filter((r) => r.active !== false && !this.disabled.has(r.id));
  }

  select(table: string, when: RuleWhen, action: RuleAction): RegisteredRule[] {
    return this.forTable(table).filter((r) => r.when === when && r.actions.includes(action));
  }

  conditionMatches(rule: RegisteredRule, current: Rec, previous: Rec | null, ctx: Context, env: MacroEnv): boolean {
    const c = rule.condition;
    if (!c) return true;
    if (typeof c === 'function') return c(current, previous, ctx);
    return matches(c, recSubject(current, previous, this.registry), env);
  }
}
