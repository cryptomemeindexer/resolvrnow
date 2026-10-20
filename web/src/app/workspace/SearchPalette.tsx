import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { cx, Kbd, Spinner } from '../../components/ui';
import { api } from '../../lib/api';

interface SearchGroup {
  table: string;
  label: string;
  results: { sys_id: string; table: string; display_value: string; short_description: string; state: string }[];
}

/** Global search palette (Cmd/Ctrl+K): records by number or text across indexed tables. */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 180);
    return () => clearTimeout(t);
  }, [term]);
  useEffect(() => {
    if (open) {
      setTerm('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const q = useQuery({
    queryKey: ['search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: async () => (await api.get<{ result: SearchGroup[] }>(`/api/app/search?q=${encodeURIComponent(debounced)}`)).result,
  });
  const flat = (q.data ?? []).flatMap((g) => g.results.map((r) => ({ ...r, group: g.label })));

  if (!open) return null;
  const go = (i: number) => {
    const r = flat[i];
    if (!r) return;
    onClose();
    navigate(`/workspace/record/${r.table}/${r.sys_id}`);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-subtle" />
          <input
            ref={inputRef}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
            placeholder="Search incidents, changes, articles, people… (try a number like INC0010001)"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') go(active);
            }}
          />
          {q.isFetching && <Spinner className="size-4" />}
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[55vh] overflow-y-auto py-2 scrollbar-thin">
          {debounced.length < 2 && <p className="px-4 py-6 text-center text-sm text-muted">Type at least two characters</p>}
          {debounced.length >= 2 && !q.isFetching && flat.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No results for “{debounced}”</p>}
          {(q.data ?? []).map((g) => (
            <div key={g.table} className="mb-1">
              <div className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{g.label}</div>
              {g.results.map((r) => {
                const i = flat.findIndex((f) => f.sys_id === r.sys_id);
                return (
                  <button
                    type="button"
                    key={r.sys_id}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(i)}
                    className={cx('flex w-full items-center gap-3 px-4 py-2 text-left text-sm', i === active ? 'bg-brand-50 dark:bg-brand-900/40' : '')}
                  >
                    <span className="w-32 shrink-0 truncate font-medium text-brand-700 dark:text-brand-300">{r.display_value}</span>
                    <span className="min-w-0 flex-1 truncate">{r.short_description}</span>
                    {r.state && <span className="shrink-0 text-xs text-muted">{r.state}</span>}
                    {i === active && <CornerDownLeft className="size-3.5 text-subtle" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
