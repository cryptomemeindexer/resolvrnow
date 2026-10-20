import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { tableQuery } from '../../lib/api';
import { cx, Input } from '../ui';

export interface RefValue {
  value: string;
  display_value: string;
}

/** Typeahead over the Table API, honouring the column's reference qualifier. */
export function ReferencePicker({
  table,
  value,
  onChange,
  qualifier,
  disabled,
  invalid,
  placeholder,
  id,
}: {
  table: string;
  value: RefValue;
  onChange: (v: RefValue) => void;
  qualifier?: string | null;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const meta = useQuery({
    queryKey: ['display-field', table],
    queryFn: async () => {
      const r = await fetch(`/api/app/meta/${table}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const d = await r.json();
      return (d.result?.displayField as string) ?? 'name';
    },
    staleTime: 600_000,
  });
  const displayField = meta.data ?? 'name';
  const qual = qualifier && !qualifier.startsWith('javascript:') ? qualifier : '';
  const results = useQuery({
    queryKey: ['ref', table, displayField, term, qual],
    enabled: open && !!meta.data,
    queryFn: async () => {
      const parts = [qual, term ? `${displayField}LIKE${term}` : '', table === 'sys_user' || table === 'sys_user_group' ? 'active=true' : '', `ORDERBY${displayField}`].filter(Boolean);
      const r = await tableQuery(table, { query: parts.join('^'), fields: ['sys_id', displayField], limit: 15, display: 'true' });
      return r.rows.map((row) => ({ value: String(row.sys_id), display_value: String(row[displayField] ?? '') }));
    },
    staleTime: 15_000,
  });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const items = results.data ?? [];
  const choose = (v: RefValue) => {
    onChange(v);
    setOpen(false);
    setTerm('');
  };

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          invalid={invalid}
          placeholder={placeholder ?? 'Search…'}
          value={open ? term : value.display_value}
          onFocus={() => {
            setOpen(true);
            setTerm('');
          }}
          onChange={(e) => {
            setTerm(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && items[active]) {
              e.preventDefault();
              choose(items[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          className="pr-14"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {value.value && !disabled && (
            <button type="button" className="rounded p-0.5 text-subtle hover:text-ink" aria-label="Clear" onClick={() => onChange({ value: '', display_value: '' })}>
              <X className="size-3.5" />
            </button>
          )}
          <Search className="size-3.5 text-subtle" />
        </div>
      </div>
      {open && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-tile border border-line bg-surface p-1 shadow-pop">
          {results.isLoading && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className="px-3 py-2 text-sm text-muted">No matches</li>}
          {items.map((it, i) => (
            <li
              key={it.value}
              role="option"
              aria-selected={i === active}
              className={cx('cursor-pointer px-3 py-1.5 text-sm', i === active ? 'bg-brand-50 dark:bg-brand-900/40' : 'hover:bg-raised')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(it);
              }}
            >
              {it.display_value || it.value}
            </li>
          ))}
        </ul>
      )}
      {value.value && !open && (
        <Link to={`/workspace/record/${table}/${value.value}`} className="mt-0.5 inline-block text-[11px] text-brand-600 hover:underline">
          Open record
        </Link>
      )}
    </div>
  );
}
