import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button, Card, cx, Empty, Loading, relativeTime, SectionHeader, Segmented, useToast } from '../../components/ui';
import { api, type ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';

// ---------------------------------------------------------------- dependency map

interface GraphNode {
  sys_id: string;
  name: string;
  class: string;
  classLabel: string;
  operational_status: string;
  operational_status_label: string;
  level: number;
  root?: boolean;
}
interface GraphEdge {
  sys_id: string;
  from: string;
  to: string;
  type: string;
  parentDescriptor: string;
}
interface Graph {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const NODE_W = 200;
const NODE_H = 64;
const COL_GAP = 18;
const ROW_GAP = 72;

/** Rows by distance from the root (service at the top); each row ordered by its neighbours' average position. */
function layout(g: Graph) {
  const levels = [...new Set(g.nodes.map((n) => n.level))].sort((a, b) => a - b);
  const rows = levels.map((l) => g.nodes.filter((n) => n.level === l));
  const index = new Map<string, number>();
  rows[0]?.forEach((n, i) => index.set(n.sys_id, i));
  for (let r = 1; r < rows.length; r++) {
    const score = (n: GraphNode) => {
      const linked = g.edges.flatMap((e) => (e.from === n.sys_id ? [e.to] : e.to === n.sys_id ? [e.from] : [])).filter((id) => index.has(id));
      return linked.length ? linked.reduce((s, id) => s + index.get(id)!, 0) / linked.length : Number.POSITIVE_INFINITY;
    };
    rows[r].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    rows[r].forEach((n, i) => index.set(n.sys_id, i));
  }
  const widest = Math.max(...rows.map((r) => r.length), 1);
  const width = widest * (NODE_W + COL_GAP) - COL_GAP;
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((row, r) => {
    const left = (width - (row.length * (NODE_W + COL_GAP) - COL_GAP)) / 2;
    row.forEach((n, i) => pos.set(n.sys_id, { x: left + i * (NODE_W + COL_GAP), y: r * (NODE_H + ROW_GAP) }));
  });
  return { pos, width, height: rows.length * (NODE_H + ROW_GAP) - ROW_GAP, levels };
}

const OPERATIONAL = new Set(['1', '']);

export function CmdbMapPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [depth, setDepth] = useState('3');
  const [direction, setDirection] = useState('both');
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const graph = useQuery({
    queryKey: ['cmdb-graph', id, depth, direction],
    queryFn: async () => {
      const r = await api.get<Graph | { result: Graph }>(`/api/app/cmdb/graph/${id}?depth=${depth}&direction=${direction}`);
      return 'result' in r ? r.result : r;
    },
    placeholderData: (prev) => prev,
  });
  const impact = useQuery({
    queryKey: ['cmdb-impact', id],
    queryFn: async () => (await api.get<{ result: { services: { sys_id: string; name: string }[]; offerings: { sys_id: string; name: string }[] } }>(`/api/app/cmdb/impact/${id}`)).result,
  });
  const g = graph.data;
  const l = useMemo(() => (g ? layout(g) : null), [g]);
  if (graph.isLoading) return <Loading />;
  if (!g || !l) return <Empty title="This configuration item could not be loaded" />;
  const root = g.nodes.find((n) => n.sys_id === g.root);
  const edge = (e: GraphEdge) => {
    const a = l.pos.get(e.from);
    const b = l.pos.get(e.to);
    if (!a || !b) return null;
    const [p, q] = a.y <= b.y ? [a, b] : [b, a];
    if (p.y === q.y) {
      const [m, n] = p.x <= q.x ? [p, q] : [q, p];
      return `M${m.x + NODE_W},${m.y + NODE_H / 2} C${m.x + NODE_W + 24},${m.y - 30} ${n.x - 24},${n.y - 30} ${n.x},${n.y + NODE_H / 2}`;
    }
    const x1 = p.x + NODE_W / 2;
    const y1 = p.y + NODE_H;
    const x2 = q.x + NODE_W / 2;
    const y2 = q.y;
    return `M${x1},${y1} C${x1},${y1 + ROW_GAP / 2} ${x2},${y2 - ROW_GAP / 2} ${x2},${y2}`;
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Dependency map</div>
          <h1 className="mt-3 text-[28px] leading-tight font-bold tracking-[-0.02em]">{root?.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {root?.classLabel} · {g.nodes.length} items, {g.edges.length} relationships{g.truncated ? ' (truncated)' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={direction} onChange={setDirection} options={[{ id: 'both', label: 'Both ways' }, { id: 'up', label: 'Depends on it' }, { id: 'down', label: 'It depends on' }]} />
          <Segmented value={depth} onChange={setDepth} options={['1', '2', '3', '4'].map((d) => ({ id: d, label: `${d} ${d === '1' ? 'level' : 'levels'}` }))} />
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card className={cx('overflow-auto p-6 scrollbar-thin transition-opacity', graph.isFetching && 'opacity-60')}>
          <div className="relative mx-auto" style={{ width: l.width, height: l.height }}>
            <svg width={l.width} height={l.height} className="absolute inset-0 overflow-visible" aria-hidden>
              {g.edges.map((e) => {
                const d = edge(e);
                if (!d) return null;
                const on = hoverEdge === e.sys_id;
                return (
                  <g key={e.sys_id} onPointerEnter={() => setHoverEdge(e.sys_id)} onPointerLeave={() => setHoverEdge(null)}>
                    <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
                    <path d={d} fill="none" stroke={on ? 'var(--viz-bar)' : 'var(--viz-axis)'} strokeWidth={on ? 2 : 1.5} />
                    <title>{e.type.replace('::', ' / ')}</title>
                  </g>
                );
              })}
            </svg>
            {g.nodes.map((n) => {
              const p = l.pos.get(n.sys_id)!;
              const up = OPERATIONAL.has(n.operational_status);
              return (
                <div
                  key={n.sys_id}
                  className={cx(
                    'group absolute flex flex-col justify-center rounded-tile border bg-surface px-3.5 shadow-card transition-shadow hover:shadow-pop',
                    n.sys_id === g.root ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-line',
                  )}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                >
                  <button type="button" onClick={() => navigate(`/workspace/cmdb/map/${n.sys_id}`)} className="truncate text-start text-[13px] font-bold hover:text-accent" title={`Center the map on ${n.name}`}>
                    {n.name}
                  </button>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle">
                    <span className={cx('inline-block size-1.5 rounded-full', up ? 'bg-emerald-500' : 'bg-red-500')} aria-hidden />
                    <span className="truncate">
                      {n.classLabel}
                      {!up && ` · ${n.operational_status_label}`}
                    </span>
                    <Link to={`/workspace/record/${n.class}/${n.sys_id}`} className="ms-auto text-subtle opacity-0 group-hover:opacity-100 hover:text-ink" aria-label={`Open ${n.name}`}>
                      <ExternalLink className="size-3.5" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="Impacted services">
            <div className="space-y-1 p-4">
              {impact.data?.services.length ? (
                impact.data.services.map((s) => (
                  <Link key={s.sys_id} to={`/workspace/cmdb/map/${s.sys_id}`} className="block truncate rounded-lg px-2 py-1.5 text-[13px] font-semibold hover:bg-sunken">
                    {s.name}
                  </Link>
                ))
              ) : (
                <p className="px-2 text-sm text-muted">No business services depend on this item.</p>
              )}
            </div>
          </Card>
          {root && (
            <Link to={`/workspace/record/${root.class}/${root.sys_id}`} className="block text-center text-sm font-semibold text-accent hover:underline">
              Open {root.name}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- health

interface Metric {
  evaluated: number;
  failed: number;
  score: number;
}
interface Health {
  computed_at: string;
  total_cis: number;
  overall: number;
  kpis: Record<string, { score: number; metrics: Record<string, Metric> }>;
  failures: { sys_id: string; name: string; class: string; metric: string; details: string }[];
  failure_count: number;
}

function Meter({ value }: { value: number }) {
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-brand-100 dark:bg-brand-500/15" aria-hidden>
      <span className="absolute inset-y-0 start-0 rounded-full bg-brand-500" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

const label = (k: string) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');

export function CmdbHealthPage() {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const health = useQuery({ queryKey: ['cmdb-health'], queryFn: async () => (await api.get<{ result: Health }>('/api/app/cmdb/health?failures=50')).result });
  const run = useMutation({
    mutationFn: () => api.post('/api/app/cmdb/health/run'),
    onSuccess: () => {
      toast('Health scores recalculated', 'success');
      qc.invalidateQueries({ queryKey: ['cmdb-health'] });
    },
    onError: (e: ApiError) => toast(e.message, 'error'),
  });
  if (health.isLoading) return <Loading />;
  if (!health.data) return <Empty title="Health scores are not available" />;
  const h = health.data;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">CMDB health</div>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-[56px] leading-none font-bold tracking-[-0.03em]">{Math.round(h.overall)}</span>
            <span className="text-lg font-semibold text-subtle">/ 100</span>
          </div>
          <p className="mt-2 text-sm text-muted">
            {h.total_cis} configuration items · computed {relativeTime(h.computed_at)}
          </p>
        </div>
        {hasRole('cmdb_admin') && (
          <Button icon={<Play className="size-4" />} onClick={() => run.mutate()} loading={run.isPending}>
            Recalculate
          </Button>
        )}
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {Object.entries(h.kpis).map(([k, kpi]) => (
          <Card key={k} className="p-5">
            <p className="micro text-subtle">{label(k)}</p>
            <p className="mt-2 text-[32px] leading-none font-bold">{Math.round(kpi.score)}</p>
            <div className="mt-4 space-y-3">
              {Object.entries(kpi.metrics).map(([m, v]) => (
                <div key={m}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted">{label(m)}</span>
                    <span className="text-subtle tabular-nums">
                      {v.failed} of {v.evaluated} failing
                    </span>
                  </div>
                  <Meter value={v.score} />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <section>
        <SectionHeader title="Items that need attention" aside={`${h.failure_count}`} />
        <Card className="mt-4 overflow-hidden">
          {h.failures.length === 0 ? (
            <Empty title="Every item passes its checks" />
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-sunken">
                  {['Item', 'Check', 'Details'].map((c) => (
                    <th key={c} className="micro px-4 py-2.5 text-start text-subtle">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {h.failures.map((f, i) => (
                  <tr key={`${f.sys_id}-${f.metric}-${i}`} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5">
                      <Link to={`/workspace/record/${f.class}/${f.sys_id}`} className="font-semibold text-accent hover:underline">
                        {f.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">{label(f.metric)}</td>
                    <td className="px-4 py-2.5 text-muted">{f.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}
