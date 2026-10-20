import type { Database } from '../db.js';
import type { SchemaRegistry } from '../registry.js';
import type { TableMeta } from '../types.js';
import { newSysId, nowGlide } from '../util.js';

/**
 * Record numbering (sys_number): per-table prefix and counter, zero padded to a
 * fixed number of digits (INC0010001). A table without its own definition uses
 * the nearest ancestor's (a custom task extension gets TASK numbers).
 */
export class NumberService {
  constructor(
    private db: Database,
    private registry: SchemaRegistry,
  ) {}

  /** The table whose numbering applies to records of `table`, if any. */
  numberingTable(table: TableMeta): TableMeta | null {
    for (const name of table.ancestors) {
      const t = this.registry.tryTable(name);
      if (t?.number) return t;
    }
    return null;
  }

  private ensureRow(t: TableMeta): void {
    const row = this.db.get(`SELECT "sys_id" FROM "sys_number" WHERE "category" = ?`, [t.name]);
    if (!row) {
      const now = nowGlide();
      this.db.run(
        `INSERT INTO "sys_number" ("sys_id","sys_class_name","category","prefix","number","maximum_digits","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [newSysId(), 'sys_number', t.name, t.number!.prefix, t.number!.start, t.number!.digits, now, 'system', now, 'system'],
      );
    }
  }

  /** Atomically allocates the next number for a record of `table`. */
  next(table: TableMeta): string | null {
    const nt = this.numberingTable(table);
    if (!nt?.number) return null;
    if (!this.registry.has('sys_number')) return null;
    return this.db.tx(() => {
      this.ensureRow(nt);
      const row = this.db.get<{ prefix: string; number: number; maximum_digits: number }>(
        `UPDATE "sys_number" SET "number" = "number" + 1 WHERE "category" = ? RETURNING "prefix","number","maximum_digits"`,
        [nt.name],
      )!;
      const digits = Number(row.maximum_digits) || nt.number!.digits;
      return `${row.prefix}${String(row.number).padStart(digits, '0')}`;
    });
  }

  /** Seeds sys_number rows for every numbered table. */
  seed(): void {
    if (!this.registry.has('sys_number')) return;
    this.db.tx(() => {
      for (const t of this.registry.tables()) if (t.number) this.ensureRow(t);
    });
  }
}
