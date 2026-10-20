/** Suggested relationships and relationship governance (cmdb.md 4.3). */
import type { Platform } from '../../engine/platform.js';

export interface Suggestion {
  sys_id: string;
  base_class: string;
  relation_type: string;
  relation_type_name: string;
  dependent_class: string;
  /** True when the base class is the parent side. */
  parent: boolean;
}

/** Relationship types that are always valid (service model internals). */
const BUILT_IN_VALID = [
  'Applicative Flow To::Applicative Flow From',
  'Implement End Point To::Implement End Point From',
  'Use End Point To::Use End Point From',
];

export function allSuggestions(platform: Platform): Suggestion[] {
  return platform.db
    .all<Record<string, unknown>>(
      `SELECT s."sys_id", s."base_class", s."cmdb_rel_type", s."dependent_class", s."parent", t."name" AS type_name
       FROM "cmdb_rel_type_suggest" s LEFT JOIN "cmdb_rel_type" t ON t."sys_id" = s."cmdb_rel_type"
       ORDER BY s."base_class", t."name"`,
    )
    .map((r) => ({
      sys_id: String(r.sys_id),
      base_class: String(r.base_class ?? ''),
      relation_type: String(r.cmdb_rel_type ?? ''),
      relation_type_name: String(r.type_name ?? ''),
      dependent_class: String(r.dependent_class ?? ''),
      parent: r.parent !== 0,
    }));
}

/** Suggestions for a class: rows whose base class is the class or one of its ancestors. */
export function suggestionsFor(platform: Platform, className: string): Suggestion[] {
  const ancestors = platform.registry.tryTable(className)?.ancestors ?? [className];
  return allSuggestions(platform).filter((s) => ancestors.includes(s.base_class));
}

/** Meta API relationship rules: suggestions whose base class is exactly the class, as parent/child. */
export function relationshipRules(
  platform: Platform,
  className: string,
): { parent: string; relation_type: string; child: string }[] {
  return allSuggestions(platform)
    .filter((s) => s.base_class === className)
    .map((s) => ({
      parent: s.parent ? s.base_class : s.dependent_class,
      relation_type: s.relation_type,
      child: s.parent ? s.dependent_class : s.base_class,
    }));
}

interface MetaRow {
  parent_type: string;
  rel_type: string;
  child_type: string;
}

function metadata(platform: Platform, table: string): MetaRow[] {
  return platform.db.all<MetaRow>(
    `SELECT "parent_type","rel_type","child_type" FROM "${table}" WHERE "active" IS NULL OR "active" = 1`,
  );
}

/** Governance check that remembers rule tables for a batch of relationships. */
export class RelationshipGovernance {
  private suggestions: Suggestion[];
  private hosting: MetaRow[];
  private containment: MetaRow[];
  private builtIn: Set<string>;

  constructor(private platform: Platform) {
    this.suggestions = allSuggestions(platform);
    this.hosting = metadata(platform, 'cmdb_metadata_hosting');
    this.containment = metadata(platform, 'cmdb_metadata_containment');
    this.builtIn = new Set(
      platform.db
        .all<{ sys_id: string }>(
          `SELECT "sys_id" FROM "cmdb_rel_type" WHERE "name" IN (${BUILT_IN_VALID.map(() => '?').join(',')})`,
          BUILT_IN_VALID,
        )
        .map((r) => r.sys_id),
    );
  }

  /** A relationship is valid when any rule (inherited by subclasses) allows it. */
  isValid(parentClass: string, typeId: string, childClass: string): boolean {
    const isA = (cls: string, base: string) => this.platform.registry.isA(cls, base);
    if (this.builtIn.has(typeId)) return true;
    const byMeta = (rows: MetaRow[]) =>
      rows.some(
        (r) => r.rel_type === typeId && isA(parentClass, r.parent_type) && isA(childClass, r.child_type),
      );
    if (byMeta(this.hosting) || byMeta(this.containment)) return true;
    return this.suggestions.some((s) => {
      if (s.relation_type !== typeId) return false;
      return s.parent
        ? isA(parentClass, s.base_class) && isA(childClass, s.dependent_class)
        : isA(childClass, s.base_class) && isA(parentClass, s.dependent_class);
    });
  }
}
