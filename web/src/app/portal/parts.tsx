import DOMPurify from 'dompurify';
import { ArrowRight, ChevronRight, Search } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon } from '../../components/Icon';
import { Badge, cx, IconTile, relativeTime, type Tint, type Tone } from '../../components/ui';
import type { Badge as BadgeKind, TicketRow, TicketState } from './data';
import { useI18n } from './i18n';

const BADGE_TONE: Record<BadgeKind, Tone> = {
  submitted: 'blue',
  awaiting_approval: 'amber',
  in_progress: 'brand',
  action_needed: 'orange',
  closed: 'green',
  cancelled: 'gray',
};

export function StateBadge({ state }: { state: TicketState }) {
  return <Badge tone={BADGE_TONE[state.badge] ?? 'gray'}>{state.badge_label || state.label}</Badge>;
}

/** Large rounded search field that opens the portal search page. */
export function SearchBox({ initial = '', source, large }: { initial?: string; source?: string; large?: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    const p = new URLSearchParams({ q: q.trim() });
    if (source) p.set('source', source);
    navigate(`/portal/search?${p}`);
  };
  return (
    <form onSubmit={submit} className="relative w-full" role="search">
      <Search className={cx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-subtle', large ? 'start-5 size-5' : 'start-4 size-4')} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        className={cx(
          'w-full rounded-full border border-line bg-surface text-ink shadow-card outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10',
          large ? 'h-14 ps-13 pe-36 text-base' : 'h-11 ps-11 pe-4 text-sm',
        )}
      />
      {large && (
        <button
          type="submit"
          className="absolute end-2 top-1/2 inline-flex h-10 -translate-y-1/2 items-center gap-2 rounded-full bg-brand-600 px-5 text-[13px] font-semibold text-white hover:bg-brand-700"
        >
          {t('search.button')}
          <ArrowRight className="size-4 rtl:rotate-180" />
        </button>
      )}
    </form>
  );
}

/** Card with an icon tile, title, description and an arrow, used for links and topics. */
export function LinkCard({ to, icon, tint = 'coral', title, text, meta }: { to: string; icon?: string; tint?: Tint; title: string; text?: string; meta?: ReactNode }) {
  return (
    <Link
      to={to}
      className="group flex h-full flex-col rounded-card border border-line bg-surface p-[22px] shadow-card transition-shadow hover:shadow-pop"
    >
      <div className="flex items-center gap-3">
        <IconTile tint={tint} icon={<Icon name={icon} className="size-[18px]" strokeWidth={1.8} />} />
        <h3 className="text-base leading-snug font-bold tracking-[-0.01em]">{title}</h3>
      </div>
      {text && <p className="mt-3.5 line-clamp-3 flex-1 text-[13px] leading-[1.62] text-muted">{text}</p>}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3.5">
        <span className="text-xs text-subtle">{meta}</span>
        <span className="inline-flex size-8 items-center justify-center rounded-lg border border-brand-500 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white dark:text-brand-300">
          <ArrowRight className="size-4 rtl:rotate-180" />
        </span>
      </div>
    </Link>
  );
}

/** The user's tickets as a list card. */
export function TicketList({ tickets, empty }: { tickets: TicketRow[]; empty: string }) {
  if (!tickets.length) return <p className="rounded-card border border-dashed border-line-strong px-6 py-10 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
      {tickets.map((tk) => (
        <li key={`${tk.table}:${tk.sys_id}`}>
          <Link to={`/portal/ticket/${tk.table}/${tk.sys_id}`} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-raised">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="micro text-accent">{tk.number}</span>
                <span className="text-xs text-subtle">{tk.module.label}</span>
              </div>
              <p className="mt-1 truncate text-[15px] font-semibold">{tk.title}</p>
            </div>
            <div className="hidden text-end text-xs text-subtle sm:block">{relativeTime(tk.updated)}</div>
            <StateBadge state={tk.state} />
            <ChevronRight className="size-4 shrink-0 text-subtle rtl:rotate-180" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Knowledge and catalog HTML, sanitized. */
export function RichText({ html, className }: { html: string; className?: string }) {
  return <div className={cx('prose-app', className)} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
}

/** Search snippets carry <B> highlights and nothing else. */
export function Snippet({ html }: { html: string }) {
  return (
    <p
      className="line-clamp-2 text-[13px] leading-relaxed text-muted [&_b]:font-semibold [&_b]:text-ink"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, { ALLOWED_TAGS: ['b'], ALLOWED_ATTR: [] }) }}
    />
  );
}

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="py-20 text-center">
      <p className="display text-[40px]">404</p>
      <p className="mt-3 text-muted">{t('error.not_found')}</p>
      <Link to="/portal" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">
        {t('nav.home')}
      </Link>
    </div>
  );
}
