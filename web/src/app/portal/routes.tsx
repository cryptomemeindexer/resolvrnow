import { LogOut, Monitor } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router';
import { Logo } from '../../components/Logo';
import { Avatar, cx } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { Assistant } from './Assistant';
import { ArticlePage, CatalogPage, KnowledgeHome, SearchPage, TopicPage } from './Browse';
import { usePortalHome } from './data';
import { PortalHome } from './Home';
import { I18nProvider, useI18n } from './i18n';
import { NotFound } from './parts';
import { ItemPage, ReportPage, TicketsPage, TicketView, TodosPage } from './Requests';

function PortalLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const home = usePortalHome();
  const approvals = home.data?.counts.pending_approvals ?? 0;
  const links = [
    { to: '/portal', label: t('nav.home'), end: true },
    { to: '/portal/catalog', label: t('nav.catalog') },
    { to: '/portal/kb', label: t('nav.knowledge') },
    { to: '/portal/tickets', label: t('nav.my_tickets') },
    { to: '/portal/todos', label: t('nav.todos'), count: approvals },
  ];
  const nav = (mobile?: boolean) =>
    links.map((l) => (
      <NavLink
        key={l.to}
        to={l.to}
        end={l.end}
        className={({ isActive }) =>
          cx(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors',
            isActive ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'text-muted hover:bg-sunken hover:text-ink',
            mobile && 'text-xs',
          )
        }
      >
        {l.label}
        {!!l.count && <span className="rounded-full bg-brand-500 px-1.5 text-[10px] leading-4 text-white">{l.count}</span>}
      </NavLink>
    ));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--app-surface)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-5 px-4 sm:px-6">
          <Link to="/portal" className="shrink-0">
            <Logo size={28} />
          </Link>
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Portal">
            {nav()}
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <Link
              to="/portal/report"
              className="hidden h-9 items-center rounded-full bg-brand-600 px-4 text-[13px] font-semibold text-white shadow-card hover:bg-brand-700 sm:inline-flex"
            >
              {t('nav.report')}
            </Link>
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center rounded-full [&::-webkit-details-marker]:hidden" aria-label={t('nav.profile')}>
                <Avatar name={me?.name ?? '?'} size={36} tone="brand" />
              </summary>
              <div className="absolute end-0 z-30 mt-2 w-60 rounded-tile border border-line bg-surface p-1.5 shadow-pop">
                <div className="mb-1 border-b border-line px-3 pt-2 pb-3">
                  <div className="text-sm font-bold">{me?.name}</div>
                  <div className="truncate text-xs text-muted">{me?.email ?? me?.user_name}</div>
                </div>
                {(me?.is_agent || me?.is_admin) && (
                  <Link to="/workspace" className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-sunken">
                    <Monitor className="size-4 text-subtle" /> {t('nav.workspace')}
                  </Link>
                )}
                <button type="button" onClick={() => logout().then(() => navigate('/login'))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-[13px] hover:bg-sunken">
                  <LogOut className="size-4 text-subtle rtl:-scale-x-100" /> {t('nav.logout')}
                </button>
              </div>
            </details>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2.5 scrollbar-none lg:hidden" aria-label="Portal">
          {nav(true)}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 sm:px-6">{children}</main>
      <Assistant />
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-5 text-[13px] text-muted sm:px-6">
          <span>{t('app.title')}</span>
          <span>ResolvrNow</span>
        </div>
      </footer>
    </div>
  );
}

/** Employee self-service portal. */
export function PortalRoutes() {
  return (
    <I18nProvider lang="en">
      <PortalLayout>
        <Routes>
          <Route index element={<PortalHome />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="topic/:id" element={<TopicPage />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="item/:id" element={<ItemPage />} />
          <Route path="kb" element={<KnowledgeHome />} />
          <Route path="kb/:id" element={<ArticlePage />} />
          <Route path="report" element={<ReportPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="ticket/:table/:id" element={<TicketView />} />
          <Route path="todos" element={<TodosPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </PortalLayout>
    </I18nProvider>
  );
}
