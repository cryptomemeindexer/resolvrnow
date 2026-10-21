import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button, Card, cx, Empty, Loading, ValueBadge } from '../../components/ui';
import { api } from '../../lib/api';

/** Change calendar: two weeks of changes on a timeline, with maintenance and blackout windows. */

interface CalendarChange {
  sys_id: string;
  number: string;
  short_description: string;
  type: string;
  type_label: string;
  state: number;
  state_label: string;
  risk_label: string;
  start: string;
  end: string;
  cmdb_ci: { display_value: string };
  assignment_group: { display_value: string };
}
interface Window {
  sys_id: string;
  name: string;
  start: string;
  end: string;
}
interface Calendar {
  changes: CalendarChange[];
  maintenance: Window[];
  blackouts: Window[];
}

const DAY = 86_400_000;
const DAYS = 14;
const TYPE_COLOR: Record<string, string> = { normal: 'var(--viz-1)', standard: 'var(--viz-3)', emergency: 'var(--viz-2)' };

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const utc = (s: string) => new Date(`${s.replace(' ', 'T')}Z`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const time = (d: Date) => d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function ChangeSchedulePage() {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const from = anchor;
  const to = new Date(anchor.getTime() + DAYS * DAY);
  const cal = useQuery({
    queryKey: ['change-calendar', ymd(from)],
    queryFn: async () => (await api.get<{ result: Calendar }>(`/api/app/change/calendar?from=${ymd(from)}&to=${ymd(to)}`)).result,
    placeholderData: (prev) => prev,
  });
  const span = to.getTime() - from.getTime();
  const pos = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - from.getTime()) / span) * 100));
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => new Date(from.getTime() + i * DAY)), [from]);
  const now = new Date();
  const changes = [...(cal.data?.changes ?? [])].sort((a, b) => utc(a.start).getTime() - utc(b.start).getTime());
  const windows = [
    ...(cal.data?.maintenance ?? []).map((w) => ({ ...w, kind: 'maintenance' as const })),
    ...(cal.data?.blackouts ?? []).map((w) => ({ ...w, kind: 'blackout' as const })),
  ];
  const shift = (weeks: number) => setAnchor((a) => new Date(a.getTime() + weeks * 7 * DAY));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-4">
          <h1 className="section-title">Change calendar</h1>
          <span className="text-[11px] tracking-[0.06em] text-subtle">
            {from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} to{' '}
            {new Date(to.getTime() - DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => shift(-1)} aria-label="Previous week">
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAnchor(startOfWeek(new Date()))}>
            This week
          </Button>
          <Button size="sm" variant="secondary" onClick={() => shift(1)} aria-label="Next week">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
        {Object.entries(TYPE_COLOR).map(([k, c]) => (
          <li key={k} className="flex items-center gap-1.5 capitalize">
            <span className="inline-block h-2.5 w-4 rounded-[3px]" style={{ background: c }} aria-hidden /> {k}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-[3px] bg-gold-300/40 ring-1 ring-gold-400/50 ring-inset" aria-hidden /> Maintenance window
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-[3px] bg-[repeating-linear-gradient(45deg,var(--viz-bad)_0_2px,transparent_2px_6px)] opacity-60" aria-hidden /> Blackout
        </li>
      </ul>
      <Card className={cx('overflow-hidden transition-opacity', cal.isFetching && 'opacity-60')}>
        {cal.isLoading ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <div className="min-w-[960px]">
              <div className="grid grid-cols-[300px_minmax(0,1fr)] border-b border-line bg-sunken">
                <div className="micro px-4 py-3 text-subtle">Change</div>
                <div className="relative grid grid-cols-14">
                  {days.map((d) => {
                    const today = ymd(d) === ymd(now);
                    const weekend = d.getDay() === 0 || d.getDay() === 6;
                    return (
                      <div key={ymd(d)} className={cx('border-s border-line px-1.5 py-2 text-center', weekend && 'bg-line/30')}>
                        <div className={cx('micro', today ? 'text-accent' : 'text-subtle')}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                        <div className={cx('text-sm font-bold', today && 'text-accent')}>{d.getDate()}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {changes.length === 0 ? (
                <Empty title="No changes scheduled in these two weeks" />
              ) : (
                <div className="relative grid grid-cols-[300px_minmax(0,1fr)]">
                  <div aria-hidden className="pointer-events-none absolute inset-y-0 start-[300px] end-0">
                    {days.map((d, i) => (
                      <div
                        key={ymd(d)}
                        className={cx('absolute inset-y-0 border-s border-line/70', (d.getDay() === 0 || d.getDay() === 6) && 'bg-line/20')}
                        style={{ insetInlineStart: `${(i / DAYS) * 100}%`, width: `${100 / DAYS}%` }}
                      />
                    ))}
                    {windows.map((w, i) => {
                      const l = pos(utc(w.start));
                      const r = pos(utc(w.end));
                      if (r <= l) return null;
                      return (
                        <div
                          key={`${w.sys_id}-${i}`}
                          title={`${w.name}: ${time(utc(w.start))} to ${time(utc(w.end))}`}
                          className={cx(
                            'absolute inset-y-0',
                            w.kind === 'maintenance' ? 'bg-gold-300/25' : 'bg-[repeating-linear-gradient(45deg,color-mix(in_srgb,var(--viz-bad)_35%,transparent)_0_2px,transparent_2px_8px)]',
                          )}
                          style={{ insetInlineStart: `${l}%`, width: `${r - l}%` }}
                        />
                      );
                    })}
                    {now >= from && now < to && <div className="absolute inset-y-0 w-0.5 bg-brand-500" style={{ insetInlineStart: `${pos(now)}%` }} />}
                  </div>
                  {changes.map((c) => {
                    const start = utc(c.start);
                    const end = utc(c.end);
                    const l = pos(start);
                    const w = Math.max(pos(end) - l, 0.5);
                    const label = `${c.number}: ${c.short_description}. ${time(start)} to ${time(end)}. ${c.type_label}, ${c.state_label}, risk ${c.risk_label}`;
                    return (
                      <div key={c.sys_id} className="contents">
                        <Link to={`/workspace/record/change_request/${c.sys_id}`} className="relative z-10 border-b border-line/70 bg-surface px-4 py-2.5 hover:bg-raised">
                          <div className="flex items-center gap-2">
                            <span className="micro text-accent">{c.number}</span>
                            <ValueBadge field="state" value={String(c.state)} display={c.state_label} />
                          </div>
                          <p className="mt-0.5 truncate text-[13px] font-semibold">{c.short_description}</p>
                          <p className="truncate text-[11px] text-subtle">{[c.cmdb_ci?.display_value, c.assignment_group?.display_value].filter(Boolean).join(' · ')}</p>
                        </Link>
                        <div className="relative border-b border-line/70">
                          {pos(end) > 0 && l < 100 && (
                            <Link
                              to={`/workspace/record/change_request/${c.sys_id}`}
                              title={label}
                              aria-label={label}
                              className="absolute top-1/2 h-4 -translate-y-1/2 rounded-[4px] ring-2 ring-surface transition-[filter] hover:brightness-110"
                              style={{ insetInlineStart: `${l}%`, width: `max(${w}%, 6px)`, background: TYPE_COLOR[c.type] ?? 'var(--viz-other)' }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
