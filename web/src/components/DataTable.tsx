import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ColumnInfo, FieldValue } from '../lib/api';
import { cx, localDateTime, relativeTime, ValueBadge } from './ui';

export interface SortState {
  field: string;
  desc: boolean;
}

function Cell({ field, col, v }: { field: string; col?: ColumnInfo; v?: FieldValue }) {
  if (!v) return null;
  const badge = <ValueBadge field={field} value={v.value} display={v.display_value} />;
  if (badge && (field === 'priority' || field === 'state' || field === 'approval' || field === 'incident_state' || field === 'risk' || field === 'stage' || field === 'workflow_state')) return badge;
  if (col && (col.type === 'glide_date_time' || col.type === 'due_date') && v.value) {
    return (
      <span title={localDateTime(v.value)} className="text-muted">
        {relativeTime(v.value)}
      </span>
    );
  }
  if (col?.type === 'boolean') return <span className="text-muted">{v.value === 'true' ? 'Yes' : 'No'}</span>;
  return <span className="line-clamp-2">{v.display_value || v.value}</span>;
}

/** Record list table rendering display values with type-aware formatting. */
export function DataTable({
  columns,
  meta,
  rows,
  sort,
  onSort,
  onOpen,
  selectable,
  selected,
  onSelect,
  emptyState,
}: {
  columns: string[];
  meta: Record<string, ColumnInfo>;
  rows: { sys_id: string; table?: string; values: Record<string, FieldValue> }[];
  sort?: SortState | null;
  onSort?: (s: SortState) => void;
  onOpen: (row: { sys_id: string; table?: string }) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelect?: (ids: Set<string>) => void;
  emptyState?: ReactNode;
}) {
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(r.sys_id));
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-well-line bg-well text-left">
            {selectable && (
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  className="accent-brand-600"
                  checked={!!allSelected}
                  onChange={(e) => onSelect?.(new Set(e.target.checked ? rows.map((r) => r.sys_id) : []))}
                />
              </th>
            )}
            {columns.map((c) => {
              const label = meta[c.split('.')[0]]?.label ?? c;
              const active = sort?.field === c;
              return (
                <th key={c} className="micro px-4 py-3 text-[9px] whitespace-nowrap text-muted">
                  <button
                    type="button"
                    className={cx('inline-flex items-center gap-1 tracking-[inherit] uppercase hover:text-ink', active && 'text-ink')}
                    onClick={() => onSort?.({ field: c, desc: active ? !sort?.desc : false })}
                  >
                    {label}
                    {active && (sort?.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (selectable ? 1 : 0)}>{emptyState}</td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={r.sys_id}
              className="cursor-pointer border-b border-line/70 transition-colors last:border-0 hover:bg-raised"
              onClick={() => onOpen(r)}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(r)}
              tabIndex={0}
            >
              {selectable && (
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label="Select row"
                    className="accent-brand-600"
                    checked={!!selected?.has(r.sys_id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(r.sys_id);
                      else next.delete(r.sys_id);
                      onSelect?.(next);
                    }}
                  />
                </td>
              )}
              {columns.map((c, i) => (
                <td key={c} className={cx('px-4 py-3 align-top', i === 0 && 'font-semibold whitespace-nowrap text-accent')}>
                  <Cell field={c} col={meta[c]} v={r.values[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
