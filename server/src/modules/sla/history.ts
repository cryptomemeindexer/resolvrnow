import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { ColumnMeta, Internal, RowData } from '../../engine/types.js';
import { parseGlideDateTime } from '../../engine/util.js';

/** The state of a task after one audited operation. */
export interface TaskVersion {
  at: number;
  data: RowData;
}

interface AuditRow {
  fieldname: string;
  oldvalue: string | null;
  record_checkpoint: number | null;
  sys_created_on: string;
}

function fromAudit(col: ColumnMeta | undefined, v: string | null): Internal {
  if (v === null || v === undefined) return null;
  if (col?.storage === 'INTEGER' || col?.storage === 'REAL') {
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

/**
 * Rebuilds the versions of a task from sys_audit, oldest first: the inserted record, then
 * the record after each audited update. Built backwards from the current values so fields
 * that are not audited keep their current value. Empty when the table is not audited.
 */
export function taskVersions(ctx: Context, task: Rec): TaskVersion[] {
  if (!task.table.audit || !ctx.registry.has('sys_audit')) return [];
  const rows = ctx.platform.db.all<AuditRow>(
    `SELECT "fieldname","oldvalue","record_checkpoint","sys_created_on" FROM "sys_audit" WHERE "documentkey" = ? ORDER BY "record_checkpoint", rowid`,
    [task.sysId],
  );
  if (!rows.length) return [];
  const groups = new Map<number, { at: string; rows: AuditRow[] }>();
  for (const r of rows) {
    const cp = Number(r.record_checkpoint ?? 0);
    const g = groups.get(cp) ?? { at: r.sys_created_on, rows: [] };
    g.rows.push(r);
    groups.set(cp, g);
  }
  const updates = [...groups.keys()].filter((cp) => cp > 0).sort((a, b) => b - a);
  const versions: TaskVersion[] = [];
  // Start from the stored record: `task` may itself be an older version being replayed.
  const data: RowData = { ...(ctx.loadRaw(task.className, task.sysId)?.data ?? task.data) };
  for (const cp of updates) {
    const g = groups.get(cp)!;
    versions.push({ at: parseGlideDateTime(g.at)!.getTime(), data: { ...data } });
    for (const r of g.rows) data[r.fieldname] = fromAudit(task.column(r.fieldname), r.oldvalue);
  }
  const created = groups.get(0)?.at ?? task.str('sys_created_on');
  versions.push({ at: parseGlideDateTime(created)?.getTime() ?? 0, data });
  return versions.reverse();
}
