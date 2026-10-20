import type { Database } from '../db.js';
import type { SchemaRegistry } from '../registry.js';
import { newSysId, nowGlide } from '../util.js';

export interface PropertyDef {
  name: string;
  value: string;
  type?: 'string' | 'integer' | 'boolean' | 'choicelist' | 'password' | 'color';
  description?: string;
  choices?: string;
}

/** System properties (sys_properties) with code-registered defaults. */
export class PropertyService {
  private defaults = new Map<string, PropertyDef>();
  private cache = new Map<string, string | null>();

  constructor(
    private db: Database,
    private registry: SchemaRegistry,
  ) {}

  define(def: PropertyDef): void {
    this.defaults.set(def.name, def);
  }

  definitions(): PropertyDef[] {
    return [...this.defaults.values()];
  }

  invalidate(): void {
    this.cache.clear();
  }

  get(name: string, fallback?: string): string | undefined {
    if (!this.cache.has(name)) {
      let v: string | null = null;
      if (this.registry.has('sys_properties')) {
        const row = this.db.get<{ value: string | null }>(`SELECT "value" FROM "sys_properties" WHERE "name" = ?`, [name]);
        if (row) v = row.value ?? '';
      }
      this.cache.set(name, v);
    }
    const v = this.cache.get(name);
    if (v !== null && v !== undefined) return v;
    return this.defaults.get(name)?.value ?? fallback;
  }

  getNumber(name: string, fallback: number): number {
    const v = Number(this.get(name));
    return Number.isFinite(v) && this.get(name) !== '' ? v : fallback;
  }

  getBool(name: string, fallback = false): boolean {
    const v = this.get(name);
    if (v === undefined || v === '') return fallback;
    return v === 'true' || v === '1';
  }

  set(name: string, value: string): void {
    const now = nowGlide();
    const def = this.defaults.get(name);
    const exists = this.db.get(`SELECT "sys_id" FROM "sys_properties" WHERE "name" = ?`, [name]);
    if (exists) {
      this.db.run(`UPDATE "sys_properties" SET "value" = ?, "sys_updated_on" = ? WHERE "name" = ?`, [value, now, name]);
    } else {
      this.db.run(
        `INSERT INTO "sys_properties" ("sys_id","sys_class_name","name","value","type","description","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [newSysId(), 'sys_properties', name, value, def?.type ?? 'string', def?.description ?? null, now, 'system', now, 'system'],
      );
    }
    this.cache.delete(name);
  }

  /** Writes code defaults into sys_properties when absent so admins can see and edit them. */
  seed(): void {
    if (!this.registry.has('sys_properties')) return;
    this.db.tx(() => {
      for (const d of this.defaults.values()) {
        const exists = this.db.get(`SELECT "sys_id" FROM "sys_properties" WHERE "name" = ?`, [d.name]);
        if (exists) continue;
        const now = nowGlide();
        this.db.run(
          `INSERT INTO "sys_properties" ("sys_id","sys_class_name","name","value","type","description","choices","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
          [newSysId(), 'sys_properties', d.name, d.value, d.type ?? 'string', d.description ?? null, d.choices ?? null, now, 'system', now, 'system'],
        );
      }
    });
    this.invalidate();
  }
}
