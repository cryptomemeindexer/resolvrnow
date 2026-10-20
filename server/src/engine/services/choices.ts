import type { Database } from '../db.js';
import type { SchemaRegistry } from '../registry.js';
import type { ChoiceDef } from '../types.js';
import { newSysId, nowGlide } from '../util.js';

export interface Choice {
  value: string;
  label: string;
  sequence: number;
  dependentValue: string | null;
  inactive: boolean;
  hint?: string | null;
}

/**
 * Choice lists (sys_choice). Code-defined choices are seeded into sys_choice on
 * boot so they can be listed and customised; lookups walk up the class hierarchy
 * so a child table inherits its parent's list unless it defines its own.
 */
export class ChoiceService {
  private cache: Map<string, Choice[]> | null = null;

  constructor(
    private db: Database,
    private registry: SchemaRegistry,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  private load(): Map<string, Choice[]> {
    if (this.cache) return this.cache;
    const map = new Map<string, Choice[]>();
    if (this.registry.has('sys_choice')) {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT "name","element","value","label","sequence","dependent_value","inactive","hint" FROM "sys_choice" WHERE "language" IS NULL OR "language" = 'en'`,
      );
      for (const r of rows) {
        const key = `${r.name}.${r.element}`;
        const list = map.get(key) ?? [];
        list.push({
          value: String(r.value ?? ''),
          label: String(r.label ?? r.value ?? ''),
          sequence: Number(r.sequence ?? 0),
          dependentValue: (r.dependent_value as string) || null,
          inactive: r.inactive === 1,
          hint: (r.hint as string) ?? null,
        });
        map.set(key, list);
      }
    }
    // Code choices not yet seeded (e.g. before sys_choice exists) are still visible.
    for (const [key, defs] of this.registry.codeChoices) {
      if (!map.has(key)) map.set(key, defs.map(toChoice));
    }
    for (const list of map.values()) list.sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label));
    this.cache = map;
    return map;
  }

  /** Seeds code-defined choices into sys_choice when a (table, element) has no rows yet. */
  seed(): number {
    if (!this.registry.has('sys_choice')) return 0;
    let n = 0;
    const existing = new Set(
      this.db
        .all<{ k: string }>(`SELECT DISTINCT "name" || '.' || "element" AS k FROM "sys_choice"`)
        .map((r) => r.k),
    );
    const now = nowGlide();
    this.db.tx(() => {
      for (const [key, defs] of this.registry.codeChoices) {
        if (existing.has(key)) continue;
        const [table, element] = key.split('.');
        defs.forEach((d, i) => {
          this.db.run(
            `INSERT INTO "sys_choice" ("sys_id","sys_class_name","name","element","value","label","sequence","dependent_value","inactive","hint","language","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
            [
              newSysId(),
              'sys_choice',
              table,
              element,
              d.value,
              d.label,
              d.sequence ?? i + 1,
              d.dependentValue ?? null,
              d.inactive ? 1 : 0,
              d.hint ?? null,
              'en',
              now,
              'system',
              now,
              'system',
            ],
          );
          n++;
        });
      }
    });
    this.invalidate();
    return n;
  }

  /** Choice list for a field, walking up the hierarchy. */
  list(table: string, field: string, opts: { dependentValue?: string | null; includeInactive?: boolean } = {}): Choice[] {
    const map = this.load();
    const meta = this.registry.tryTable(table);
    const chain = meta ? meta.ancestors : [table];
    for (const t of chain) {
      const list = map.get(`${t}.${field}`);
      if (list?.length) {
        return list.filter(
          (c) =>
            (opts.includeInactive || !c.inactive) &&
            (opts.dependentValue === undefined ||
              opts.dependentValue === null ||
              !c.dependentValue ||
              c.dependentValue === opts.dependentValue),
        );
      }
    }
    return [];
  }

  hasChoices(table: string, field: string): boolean {
    return this.list(table, field, { includeInactive: true }).length > 0;
  }

  label(table: string, field: string, value: string): string | undefined {
    const c = this.list(table, field, { includeInactive: true }).find((x) => x.value === value);
    return c?.label;
  }

  /** Accepts either a stored value or a label and returns the stored value. */
  resolve(table: string, field: string, input: string): string | undefined {
    const list = this.list(table, field, { includeInactive: true });
    if (!list.length) return undefined;
    const byValue = list.find((c) => c.value === input);
    if (byValue) return byValue.value;
    const lower = input.trim().toLowerCase();
    const byLabel = list.find((c) => c.label.toLowerCase() === lower);
    if (byLabel) return byLabel.value;
    // "3 - Low" style labels: allow matching the numeric prefix
    const prefix = /^(-?\d+)\s*-/.exec(input);
    if (prefix) return list.find((c) => c.value === prefix[1])?.value;
    return undefined;
  }
}

function toChoice(d: ChoiceDef, i: number): Choice {
  return {
    value: d.value,
    label: d.label,
    sequence: d.sequence ?? i + 1,
    dependentValue: d.dependentValue ?? null,
    inactive: !!d.inactive,
    hint: d.hint ?? null,
  };
}
