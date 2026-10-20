import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Filter, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DataTable, type SortState } from '../../components/DataTable';
import { FilterBuilder } from '../../components/FilterBuilder';
import { Button, Card, Empty, Input, Loading, Select } from '../../components/ui';
import { type FieldValue, fv, tableQuery } from '../../lib/api';
import { parseQuery, stringifyQuery } from '../../lib/encoded';
import { useTableMeta } from './RecordPage';

function conditionLabel(meta: ReturnType<typeof useTableMeta>['data'], field: string, op: string, value: string): string {
  const col = meta?.columns[field.split('.')[0]];
  const label = col?.label ?? field;
  const choice = col?.choices?.find((c) => c.value === value)?.label;
  const v = value.startsWith('javascript:') ? value.replace(/^javascript:/, '').replace(/gs\.getUserID\(\)/, 'me') : value;
  const ops: Record<string, string> = {
    '=': '=',
    '!=': '!=',
    LIKE: 'contains',
    'NOT LIKE': 'does not contain',
    STARTSWITH: 'starts with',
    ISEMPTY: 'is empty',
    ISNOTEMPTY: 'is not empty',
    IN: 'in',
    DYNAMIC: 'is',
    ON: 'on',
  };
  const dyn = value === '90d1921e5f510100a9ad2572f2b477fe' ? 'Me' : value === 'd6435e965f510100a9ad2572f2b47744' ? 'one of my groups' : null;
  const shown = op === 'ON' ? v.split('@')[0] : (dyn ?? choice ?? v);
  return `${label} ${ops[op] ?? op} ${['ISEMPTY', 'ISNOTEMPTY'].includes(op) ? '' : shown}`.trim();
}

function toCsv(columns: string[], labels: string[], rows: Record<string, FieldValue>[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [labels.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(fv(r[c]).display_value || fv(r[c]).value)).join(','))].join('\n');
}

export function ListPage() {
  const { table = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const meta = useTableMeta(table);
  const query = params.get('query') ?? meta.data?.list.defaultQuery ?? '';
  const title = params.get('title');
  const page = Number(params.get('page') ?? '0');
  const [pageSize, setPageSize] = useState(Number(localStorage.getItem('app.pageSize') ?? 25));
  const [showFilter, setShowFilter] = useState(false);
  const [search, setSearch] = useState('');

  const parsed = useMemo(() => parseQuery(query), [query]);
  const sort: SortState | null = parsed.orderBy[0] ?? null;
  const columns = useMemo(() => (meta.data ? meta.data.list.columns.filter((c) => meta.data!.columns[c.split('.')[0]]) : []), [meta.data]);

  const setQuery = (q: string) => {
    const next = new URLSearchParams(params);
    if (q) next.set('query', q);
    else next.delete('query');
    next.delete('page');
    setParams(next);
  };

  const fullQuery = search.trim() ? [query.replace(/\^?ORDERBY.*$/, ''), `123TEXTQUERY321=${search.trim()}`, ...parsed.orderBy.map((o) => `${o.desc ? 'ORDERBYDESC' : 'ORDERBY'}${o.field}`)].filter(Boolean).join('^') : query;
  const data = useQuery({
    queryKey: ['list', table, fullQuery, page, pageSize, columns.join(',')],
    enabled: !!meta.data,
    queryFn: () => tableQuery(table, { query: fullQuery, fields: ['sys_id', 'sys_class_name', ...columns], limit: pageSize, offset: page * pageSize }),
    placeholderData: (prev) => prev,
  });

  if (meta.isLoading) return <Loading />;
  if (!meta.data) return <Empty title="Unknown table">{table}</Empty>;
  const m = meta.data;
  const total = data.data?.total ?? 0;
  const rows = (data.data?.rows ?? []).map((r) => ({ sys_id: fv(r.sys_id).value, table: fv(r.sys_class_name).value || table, values: r }));

  const removeCondition = (bi: number, ci: number) => {
    const blocks = parsed.blocks.map((b) => [...b]);
    blocks[bi].splice(ci, 1);
    setQuery(stringifyQuery({ blocks: blocks.filter((b) => b.length), orderBy: parsed.orderBy }));
  };
  const setSort = (s: SortState) => setQuery(stringifyQuery({ blocks: parsed.blocks, orderBy: [s] }));
  const setPage = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };

  const exportCsv = async () => {
    const all = await tableQuery(table, { query: fullQuery, fields: columns, limit: 10000 });
    const blob = new Blob([toCsv(columns, columns.map((c) => m.columns[c]?.label ?? c), all.rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${table}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-4 lg:px-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{title ?? m.plural}</h1>
          <p className="text-xs text-muted">
            {total.toLocaleString()} {total === 1 ? 'record' : 'records'}
            {title ? ` · ${m.plural}` : ''}
          </p>
        </div>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input className="pl-8" placeholder={`Search ${m.plural.toLowerCase()}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button icon={<Filter className="size-4" />} variant={showFilter ? 'outline' : 'secondary'} onClick={() => setShowFilter((s) => !s)}>
          Filter
        </Button>
        <Button icon={<Download className="size-4" />} onClick={exportCsv}>
          Export
        </Button>
        {m.canCreate && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate(`/workspace/record/${table}/-1`)}>
            New
          </Button>
        )}
      </div>

      {parsed.blocks.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => setQuery(stringifyQuery({ blocks: [], orderBy: parsed.orderBy }))}>
            All
          </button>
          {parsed.blocks.map((block, bi) =>
            block.map((cluster, ci) => (
              <span key={`${bi}-${ci}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5">
                {bi > 0 && ci === 0 && <span className="font-semibold text-ember-600">OR</span>}
                {cluster.map((c) => conditionLabel(m, c.field, c.op, c.value)).join(' or ')}
                <button type="button" aria-label="Remove condition" onClick={() => removeCondition(bi, ci)} className="text-subtle hover:text-ink">
                  <X className="size-3" />
                </button>
              </span>
            )),
          )}
        </div>
      )}

      {showFilter && (
        <Card className="mb-3 p-4">
          <FilterBuilder
            meta={m}
            query={query}
            onApply={(q) => {
              setQuery(q);
              setShowFilter(false);
            }}
          />
        </Card>
      )}

      <Card>
        {data.isLoading ? (
          <Loading />
        ) : (
          <DataTable
            columns={columns}
            meta={m.columns}
            rows={rows}
            sort={sort}
            onSort={setSort}
            onOpen={(r) => navigate(`/workspace/record/${r.table ?? table}/${r.sys_id}`)}
            emptyState={<Empty title="No records match" icon={<Search className="size-6" />}>Try removing a condition or changing your search.</Empty>}
          />
        )}
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <div className="flex items-center gap-2 whitespace-nowrap">
            Rows per page
            <Select
              className="h-7 w-20 text-xs"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                localStorage.setItem('app.pageSize', e.target.value);
                setPage(0);
              }}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span>
              {total === 0 ? 0 : page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total.toLocaleString()}
            </span>
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" disabled={(page + 1) * pageSize >= total} onClick={() => setPage(page + 1)} aria-label="Next page">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
