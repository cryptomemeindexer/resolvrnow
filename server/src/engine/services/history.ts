import type { Database } from '../db.js';
import type { Rec } from '../record.js';
import type { SchemaRegistry } from '../registry.js';
import { newSysId, nowGlide } from '../util.js';

/** sys_audit.fieldname marking the compact "record created" entry. */
export const CREATED_FIELD = '__created';

export interface JournalRow {
  sys_id: string;
  element: string;
  value: string;
  sys_created_on: string;
  sys_created_by: string;
}

export interface AuditRow {
  sys_id: string;
  fieldname: string;
  oldvalue: string | null;
  newvalue: string | null;
  sys_created_on: string;
  user: string;
  record_checkpoint: number;
}

/**
 * Field history (sys_audit) and journal entries (sys_journal_field) that feed the
 * activity stream. Journal fields such as `comments` and `work_notes` are not stored
 * on the record row; each entry is its own row.
 */
export class HistoryService {
  constructor(
    private db: Database,
    private registry: SchemaRegistry,
  ) {}

  private get enabled(): boolean {
    return this.registry.has('sys_audit') && this.registry.has('sys_journal_field');
  }

  writeJournal(rec: Rec, userName: string): void {
    if (!this.enabled || rec.journal.length === 0) return;
    const now = nowGlide();
    for (const j of rec.journal) {
      this.db.run(
        `INSERT INTO "sys_journal_field" ("sys_id","sys_class_name","name","element_id","element","value","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [newSysId(), 'sys_journal_field', rec.table.name, rec.sysId, j.field, j.value, now, userName, now, userName],
      );
    }
  }

  private auditable(rec: Rec): string[] {
    const out: string[] = [];
    for (const [name, col] of rec.table.columns) {
      if (!col.storage || col.noAudit || col.system || col.type === 'password2') continue;
      out.push(name);
    }
    return out;
  }

  /** Initial values are stored compactly as one row (fieldname `__created`, JSON of the non-empty fields). */
  auditInsert(rec: Rec, userName: string): void {
    if (!this.enabled || !rec.table.audit) return;
    const initial: Record<string, string> = {};
    for (const f of this.auditable(rec)) {
      const v = rec.data[f];
      if (v === null || v === undefined || v === '') continue;
      initial[f] = String(v);
    }
    this.insertAudit(rec, CREATED_FIELD, null, JSON.stringify(initial), userName, nowGlide(), 0);
  }

  auditUpdate(rec: Rec, userName: string): void {
    if (!this.enabled || !rec.table.audit) return;
    const now = nowGlide();
    const checkpoint = Number(rec.data.sys_mod_count ?? 0);
    for (const f of this.auditable(rec)) {
      if (!rec.changed(f)) continue;
      const before = rec.prev(f);
      const after = rec.data[f];
      this.insertAudit(
        rec,
        f,
        before === null || before === undefined ? null : String(before),
        after === null || after === undefined ? null : String(after),
        userName,
        now,
        checkpoint,
      );
    }
  }

  auditDelete(rec: Rec, userName: string): void {
    if (!this.registry.has('sys_audit_delete')) return;
    const now = nowGlide();
    this.db.run(
      `INSERT INTO "sys_audit_delete" ("sys_id","sys_class_name","tablename","documentkey","display_value","payload","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
      [newSysId(), 'sys_audit_delete', rec.table.name, rec.sysId, rec.displayValue(), JSON.stringify(rec.data), now, userName, now, userName],
    );
  }

  private insertAudit(
    rec: Rec,
    field: string,
    oldValue: string | null,
    newValue: string | null,
    userName: string,
    now: string,
    checkpoint: number,
  ): void {
    this.db.run(
      `INSERT INTO "sys_audit" ("sys_id","sys_class_name","tablename","documentkey","fieldname","oldvalue","newvalue","user","record_checkpoint","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [newSysId(), 'sys_audit', rec.table.name, rec.sysId, field, oldValue, newValue, userName, checkpoint, now, userName, now, userName],
    );
  }

  journal(table: string, sysId: string, fields?: string[]): JournalRow[] {
    if (!this.enabled) return [];
    const meta = this.registry.tryTable(table);
    const names = meta ? meta.ancestors.concat(meta.descendants) : [table];
    const params: (string | number)[] = [sysId, ...names];
    let sql = `SELECT "sys_id","element","value","sys_created_on","sys_created_by" FROM "sys_journal_field" WHERE "element_id" = ? AND "name" IN (${names.map(() => '?').join(',')})`;
    if (fields?.length) {
      sql += ` AND "element" IN (${fields.map(() => '?').join(',')})`;
      params.push(...fields);
    }
    sql += ` ORDER BY "sys_created_on" DESC, rowid DESC`;
    return this.db.all<JournalRow>(sql, params);
  }

  /** Field history, newest first; the compact creation row is expanded into one entry per field. */
  audit(table: string, sysId: string): AuditRow[] {
    if (!this.enabled) return [];
    const rows = this.db.all<AuditRow>(
      `SELECT "sys_id","fieldname","oldvalue","newvalue","sys_created_on","user","record_checkpoint" FROM "sys_audit" WHERE "documentkey" = ? ORDER BY "sys_created_on" DESC, rowid DESC`,
      [sysId],
    );
    const out: AuditRow[] = [];
    for (const r of rows) {
      if (r.fieldname !== CREATED_FIELD) {
        out.push(r);
        continue;
      }
      let initial: Record<string, string> = {};
      try {
        initial = JSON.parse(r.newvalue ?? '{}');
      } catch {
        /* malformed entry */
      }
      for (const [f, v] of Object.entries(initial)) out.push({ ...r, fieldname: f, oldvalue: null, newvalue: v });
    }
    return out;
  }

  /**
   * Formats journal entries like the platform's journal display value:
   * "<created on> - <user> (<field label>)\n<text>\n\n".
   */
  formatJournal(entries: JournalRow[], labelOf: (field: string) => string, userDisplay: (u: string) => string): string {
    return entries
      .map((e) => `${e.sys_created_on} - ${userDisplay(e.sys_created_by)} (${labelOf(e.element)})\n${e.value}\n\n`)
      .join('');
  }
}
