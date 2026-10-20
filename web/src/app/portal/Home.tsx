import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Megaphone, X } from 'lucide-react';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { cx, IconTile, Loading, SectionHeader, StatTile, type Tint } from '../../components/ui';
import { api } from '../../lib/api';
import { contentHref, PORTAL, usePortalHome } from './data';
import { useI18n } from './i18n';
import { LinkCard, SearchBox, TicketList } from './parts';

const LINK_TINTS: Tint[] = ['coral', 'blue', 'green', 'violet'];

export function PortalHome() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const home = usePortalHome();
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`${PORTAL}/announcements/${id}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', 'home'] }),
  });
  if (home.isLoading || !home.data) return <Loading label={t('common.loading')} />;
  const h = home.data;

  return (
    <div className="space-y-12">
      <section className="pt-4">
        <div className="eyebrow">{t('home.eyebrow')}</div>
        <h1 className="display mt-4">{h.greeting.text}</h1>
        <p className="mt-3.5 max-w-2xl text-base leading-[1.7] text-muted">{t('home.subtitle')}</p>
        <div className="mt-8 max-w-3xl">
          <SearchBox large />
        </div>
        <div className="mt-8 flex flex-wrap gap-2.5">
          <StatTile value={h.counts.open_tickets} label={t('home.open_tickets')} to="/portal/tickets" />
          <StatTile value={h.counts.pending_approvals} label={t('home.approvals')} to="/portal/todos" />
          {h.counts.pending_surveys > 0 && <StatTile value={h.counts.pending_surveys} label={t('home.surveys')} to="/portal/tickets?view=closed" />}
        </div>
      </section>

      {h.announcements.length > 0 && (
        <section className="space-y-3" aria-label={t('home.announcements')}>
          {h.announcements.map((a) => (
            <div
              key={a.sys_id}
              className={cx(
                'flex items-start gap-4 rounded-card border bg-surface p-5 shadow-card',
                a.style === 'urgent' ? 'border-brand-300' : 'border-line',
              )}
            >
              <IconTile tint={a.style === 'urgent' ? 'coral' : 'amber'} icon={<Megaphone className="size-[18px]" strokeWidth={1.8} />} />
              <div className="min-w-0 flex-1">
                <p className="font-bold">{a.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{a.summary}</p>
              </div>
              {a.dismissible && (
                <button type="button" onClick={() => dismiss.mutate(a.sys_id)} className="rounded-lg p-1.5 text-subtle hover:bg-sunken" aria-label="Dismiss">
                  <X className="size-4" />
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {h.quick_links.length > 0 && (
        <section>
          <SectionHeader title={t('home.quick_links')} />
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {h.quick_links.map((l, i) => (
              <LinkCard key={l.sys_id} to={contentHref(l)} icon={l.icon} tint={LINK_TINTS[i % LINK_TINTS.length]} title={l.name} text={l.short_description} />
            ))}
          </div>
        </section>
      )}

      {h.featured_topics.length > 0 && (
        <section>
          <SectionHeader title={t('home.featured_topics')} aside={`${String(h.featured_topics.length).padStart(2, '0')}`} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {h.featured_topics.map((tp) => (
              <Link
                key={tp.sys_id}
                to={`/portal/topic/${tp.sys_id}`}
                className="group flex items-start gap-4 rounded-card border border-line bg-surface p-5 shadow-card transition-shadow hover:shadow-pop"
              >
                <IconTile tint="sand" icon={<Icon name={tp.icon} className="size-[18px]" strokeWidth={1.8} />} className="group-hover:bg-brand-50 group-hover:text-brand-600" />
                <div className="min-w-0">
                  <p className="font-bold">{tp.name}</p>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">{tp.description}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeader
          title={t('home.recent_items')}
          aside={
            <Link to="/portal/tickets" className="font-semibold text-accent hover:underline">
              {t('home.view_all')}
            </Link>
          }
        />
        <div className="mt-5">
          <TicketList tickets={h.recent_items} empty={t('tickets.empty')} />
        </div>
      </section>
    </div>
  );
}
