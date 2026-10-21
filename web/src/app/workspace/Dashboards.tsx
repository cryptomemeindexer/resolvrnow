import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Minus, Table2 } from 'lucide-react';
import { type PointerEvent, useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Card, cx, Empty, Loading, relativeTime, Segmented } from '../../components/ui';
import { api } from '../../lib/api';

/** Analytics dashboards (GET /api/app/analytics/dashboards). Chart specs follow the dataviz method. */

interface Point {
  key: string | null;
  label: string;
  value: number;
  query?: string;
  percent?: number;
}
interface Series {
  name: string;
  key: string | null;
  data: number[];
  points: Point[];
}
interface ReportData {
  type: string;
  kind: string;
  table: string;
  aggregateLabel: string;
  labels: string[];
  series: Series[];
  total: number;
  valueFormat: string;
  generatedAt: string;
  columns?: { field: string; label: string }[];
  rows?: { sysId: string; table: string; values: Record<string, { display_value: string; value: string }> }[];
  error?: string | null;
}
interface KpiData {
  name: string;
  unit: string;
  value: number | null;
  displayValue: string;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  status: 'good' | 'bad' | 'neutral' | string;
  sparkline: { date: string; value: number }[];
  error?: string | null;
}
interface Widget {
  sysId: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  title: string;
  report: { table: string; type: string } | null;
  data: (ReportData & KpiData) | null;
}
interface Dashboard {
  sysId: string;
  name: string;
  description: string;
  widgets: Widget[];
}

const SPAN: Record<number, string> = {
  2: 'xl:col-span-2',
  3: 'xl:col-span-3',
  4: 'xl:col-span-4',
  5: 'xl:col-span-5',
  6: 'xl:col-span-6',
  7: 'xl:col-span-7',
  8: 'xl:col-span-8',
  9: 'xl:col-span-9',
  12: 'xl:col-span-12',
};
const SERIES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)'];
const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function listHref(table: string, query: string | undefined, title: string) {
  const p = new URLSearchParams({ title });
  if (query) p.set('query', query);
  return `/workspace/list/${table}?${p}`;
}

// ---------------------------------------------------------------- KPI tile

function Sparkline({ points }: { points: { value: number }[] }) {
  if (points.length < 2) return null;
  const w = 120;
  const h = 32;
  const max = Math.max(...points.map((p) => p.value), 1);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 8) + 4, h - 4 - (p.value / max) * (h - 8)]);
  const last = xy[xy.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="overflow-visible">
      <polyline points={xy.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--viz-other)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={4} fill="var(--viz-bar)" stroke="var(--app-surface)" strokeWidth={2} />
    </svg>
  );
}

function KpiTile({ title, data }: { title: string; data: KpiData }) {
  const up = (data.delta ?? 0) > 0;
  const flat = !data.delta;
  const tone = data.status === 'good' ? 'var(--viz-good)' : data.status === 'bad' ? 'var(--viz-bad)' : 'var(--app-subtle)';
  const DeltaIcon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className="flex h-full flex-col justify-between p-5">
      <p className="micro text-subtle">{title}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="text-[32px] leading-none font-bold tracking-[-0.02em]">{data.displayValue ?? (data.value === null ? '–' : fmt.format(data.value))}</div>
        <Sparkline points={data.sparkline ?? []} />
      </div>
      {data.delta !== null && (
        <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-xs">
          <span className="inline-flex items-center gap-0.5 font-semibold" style={{ color: tone }}>
            <DeltaIcon className="size-3.5" aria-hidden />
            {up ? '+' : ''}
            {fmt.format(data.delta)}
            {data.deltaPct !== null && ` (${up ? '+' : ''}${fmt.format(data.deltaPct)}%)`}
          </span>
          <span className="text-subtle">vs previous day{data.status === 'good' ? ', better' : data.status === 'bad' ? ', worse' : ''}</span>
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- category bars

function BarList({ data, title }: { data: ReportData; title: string }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo(() => {
    const all = [...(data.series[0]?.points ?? [])].sort((a, b) => b.value - a.value);
    if (all.length <= 8) return all;
    const rest = all.slice(7);
    return [...all.slice(0, 7), { key: null, label: `Other (${rest.length})`, value: rest.reduce((s, p) => s + p.value, 0), percent: rest.reduce((s, p) => s + (p.percent ?? 0), 0) }];
  }, [data]);
  const max = Math.max(...points.map((p) => p.value), 1);
  const showPct = data.type === 'pie' || data.type === 'donut';
  if (!points.length) return <Empty title="No data" />;
  return (
    <ul className="space-y-1 p-5">
      {points.map((p, i) => {
        const pct = (p.value / max) * 100;
        const text = `${p.label}: ${fmt.format(p.value)}${p.percent !== undefined ? ` (${fmt.format(p.percent)}%)` : ''}`;
        return (
          <li key={`${p.key}-${p.label}`}>
            <button
              type="button"
              className={cx('grid w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-start', hover === i && 'bg-sunken')}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => p.query && navigate(listHref(data.table, p.query, `${title}: ${p.label}`))}
              aria-label={text}
              title={text}
            >
              <span className="truncate text-[13px] text-muted">{p.label}</span>
              <span className="relative h-3.5">
                <span
                  className="absolute inset-y-0 start-0 rounded-e-[4px] transition-[filter]"
                  style={{ width: `${Math.max(pct, 1.5)}%`, background: p.key === null ? 'var(--viz-other)' : 'var(--viz-bar)', filter: hover === i ? 'brightness(1.08)' : undefined }}
                />
              </span>
              <span className="text-end text-[13px] font-semibold tabular-nums">
                {compact.format(p.value)}
                {showPct && p.percent !== undefined && <span className="ms-1.5 font-normal text-subtle">{fmt.format(p.percent)}%</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- trend lines

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** About six evenly spaced x ticks; the last one replaces its neighbour when they would collide. */
function tickIndexes(n: number): number[] {
  if (n <= 1) return n ? [0] : [];
  const step = Math.ceil(n / 6);
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  const last = out[out.length - 1];
  if (last !== n - 1) {
    if (n - 1 - last < step * 0.6) out[out.length - 1] = n - 1;
    else out.push(n - 1);
  }
  return out;
}

function shortDate(s: string): string {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Width of an element, kept current with a ResizeObserver, so charts draw at real pixel size. */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    observer.current = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    observer.current.observe(el);
  }, []);
  return [ref, width];
}

function LineChart({ data }: { data: ReportData }) {
  const [hx, setHx] = useState<number | null>(null);
  const [box, measured] = useWidth();
  const series = useMemo(() => {
    const ranked = [...data.series].sort((a, b) => b.data.reduce((s, v) => s + v, 0) - a.data.reduce((s, v) => s + v, 0)).filter((s) => s.data.some((v) => v > 0));
    const top = ranked.slice(0, 4).map((s, i) => ({ name: s.name, data: s.data, color: SERIES[i] }));
    const rest = ranked.slice(4);
    if (rest.length) top.push({ name: `Other (${rest.length})`, data: data.labels.map((_, i) => rest.reduce((s, r) => s + (r.data[i] ?? 0), 0)), color: 'var(--viz-other)' });
    return top;
  }, [data]);
  if (!series.length) return <Empty title="No data in this period" />;
  const W = Math.max(measured, 280);
  const H = 220;
  const pad = { l: 36, r: 12, t: 12, b: 26 };
  const n = data.labels.length;
  const max = niceMax(Math.max(...series.flatMap((s) => s.data), 1));
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ticks = [0, max / 2, max];
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1));
    setHx(Math.min(n - 1, Math.max(0, i)));
  };
  return (
    <div className="p-5">
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3.5 rounded" style={{ background: s.color }} aria-hidden />
            {s.name}
          </li>
        ))}
      </ul>
      <div className="relative" ref={box}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block touch-none" onPointerMove={onMove} onPointerLeave={() => setHx(null)} role="img" aria-label={`${data.aggregateLabel} over time`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--app-subtle)" className="tabular-nums">
                {compact.format(t)}
              </text>
            </g>
          ))}
          {tickIndexes(n).map((i) => (
            <text key={data.labels[i]} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--app-subtle)">
              {shortDate(data.labels[i])}
            </text>
          ))}
          {series.map((s) => (
            <polyline key={s.name} points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hx !== null && (
            <g>
              <line x1={x(hx)} x2={x(hx)} y1={pad.t} y2={H - pad.b} stroke="var(--viz-axis)" strokeWidth={1} />
              {series.map((s) => (
                <circle key={s.name} cx={x(hx)} cy={y(s.data[hx] ?? 0)} r={4} fill={s.color} stroke="var(--app-surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hx !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-tile border border-line bg-surface px-3 py-2 text-xs shadow-pop"
            style={{ [x(hx) > W / 2 ? 'right' : 'left']: `${x(hx) > W / 2 ? ((W - x(hx)) / W) * 100 + 2 : (x(hx) / W) * 100 + 2}%` }}
          >
            <p className="mb-1 text-subtle">{shortDate(data.labels[hx])}</p>
            {series.map((s) => (
              <p key={s.name} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-muted">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                  {s.name}
                </span>
                <b className="tabular-nums">{fmt.format(s.data[hx] ?? 0)}</b>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tables

function DataTableView({ data }: { data: ReportData }) {
  const series = data.series;
  return (
    <div className="max-h-80 overflow-auto px-5 py-3 scrollbar-thin">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-start">
            <th className="micro py-2 text-start text-subtle">{data.kind === 'series' ? 'Period' : 'Group'}</th>
            {series.map((s) => (
              <th key={s.name} className="micro py-2 text-end text-subtle">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((l, i) => (
            <tr key={`${l}-${i}`} className="border-t border-line/70">
              <td className="py-1.5 pe-3">{data.kind === 'series' ? shortDate(l) : l}</td>
              {series.map((s) => (
                <td key={s.name} className="py-1.5 text-end tabular-nums">
                  {fmt.format(s.data[i] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordList({ data }: { data: ReportData }) {
  const cols = (data.columns ?? []).slice(0, 5);
  if (!data.rows?.length) return <Empty title="Nothing to show" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line bg-sunken">
            {cols.map((c) => (
              <th key={c.field} className="micro px-4 py-2.5 text-start text-subtle">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.sysId} className="border-b border-line/70 last:border-0">
              {cols.map((c, i) => (
                <td key={c.field} className="px-4 py-2.5">
                  {i === 0 ? (
                    <Link to={`/workspace/record/${r.table}/${r.sysId}`} className="font-semibold text-accent hover:underline">
                      {r.values[c.field]?.display_value}
                    </Link>
                  ) : (
                    r.values[c.field]?.display_value
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- widgets

function ReportWidget({ w }: { w: Widget }) {
  const [table, setTable] = useState(false);
  const d = w.data;
  const chartable = d && (d.kind === 'category' || d.kind === 'series');
  let body = <Empty title="No data" />;
  if (d?.error) body = <Empty title="This report could not run">{d.error}</Empty>;
  else if (d && chartable && table) body = <DataTableView data={d} />;
  else if (d?.kind === 'series') body = <LineChart data={d} />;
  else if (d?.kind === 'category') body = <BarList data={d} title={w.title} />;
  else if (d?.kind === 'list') body = <RecordList data={d} />;
  else if (d) body = <div className="p-5 text-[40px] leading-none font-bold tracking-[-0.02em]">{fmt.format(d.total ?? 0)}</div>;
  return (
    <Card
      className="h-full"
      title={w.title}
      actions={
        chartable ? (
          <button type="button" onClick={() => setTable((s) => !s)} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs', table ? 'bg-sunken text-ink' : 'text-subtle hover:text-ink')} aria-pressed={table}>
            <Table2 className="size-3.5" /> Table
          </button>
        ) : null
      }
    >
      {body}
    </Card>
  );
}

export function DashboardsPage() {
  const [params, setParams] = useSearchParams();
  const list = useQuery({
    queryKey: ['dashboards'],
    queryFn: async () => (await api.get<{ result: { sysId: string; name: string }[] }>('/api/app/analytics/dashboards')).result,
  });
  const selected = params.get('d') ?? list.data?.find((d) => /overview/i.test(d.name))?.sysId ?? list.data?.[0]?.sysId ?? '';
  const dash = useQuery({
    queryKey: ['dashboard', selected],
    enabled: !!selected,
    queryFn: async () => (await api.get<{ result: Dashboard }>(`/api/app/analytics/dashboards/${selected}?include_data=true`)).result,
    placeholderData: (prev) => prev,
  });
  if (list.isLoading) return <Loading />;
  if (!list.data?.length) return <Empty title="No dashboards yet" />;
  const widgets = [...(dash.data?.widgets ?? [])].sort((a, b) => a.y - b.y || a.x - b.x);
  const generated = widgets.find((w) => w.data?.generatedAt)?.data?.generatedAt;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="section-title">Dashboards</h1>
        {generated && <span className="text-[11px] tracking-[0.06em] text-subtle">Updated {relativeTime(generated)}</span>}
      </div>
      <Segmented value={selected} onChange={(id) => setParams({ d: id })} options={list.data.map((d) => ({ id: d.sysId, label: d.name }))} />
      {dash.data?.description && <p className="text-sm text-muted">{dash.data.description}</p>}
      <div className={cx('grid gap-5 md:grid-cols-2 xl:grid-cols-12 transition-opacity', dash.isFetching && 'opacity-60')}>
        {widgets.map((w) => (
          <div key={w.sysId} className={cx(SPAN[w.w] ?? 'xl:col-span-6', w.w >= 8 && 'md:col-span-2')}>
            {w.kind === 'kpi_scorecard' && w.data ? <KpiTile title={w.title} data={w.data} /> : <ReportWidget w={w} />}
          </div>
        ))}
      </div>
    </div>
  );
}
