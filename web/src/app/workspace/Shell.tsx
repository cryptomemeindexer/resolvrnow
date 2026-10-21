import { useQuery } from '@tanstack/react-query';
import { ChevronRight, LogOut, Menu, Monitor, Moon, Plus, Search, Sun, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Icon } from '../../components/Icon';
import { Logo } from '../../components/Logo';
import { Avatar, cx, Input, Kbd } from '../../components/ui';
import { api, type NavApp, type NavModule } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { currentTheme, setTheme, type ThemeMode } from '../../lib/theme';
import { SearchPalette } from './SearchPalette';

export function moduleHref(m: NavModule): string {
  if (m.route) return m.route;
  if (m.table) {
    const p = new URLSearchParams();
    if (m.query) p.set('query', m.query);
    p.set('title', m.title);
    return `/workspace/list/${m.table}?${p}`;
  }
  return '/workspace';
}

/** Applications that get their own button on the rail, in order. The rest live under "All apps". */
const RAIL: { app: string; label: string }[] = [
  { app: 'my_work', label: 'My work' },
  { app: 'incident', label: 'Incidents' },
  { app: 'problem', label: 'Problems' },
  { app: 'change', label: 'Changes' },
  { app: 'requests', label: 'Requests' },
  { app: 'approvals', label: 'Approvals' },
  { app: 'knowledge', label: 'Knowledge' },
  { app: 'cmdb', label: 'CMDB' },
  { app: 'analytics', label: 'Analytics' },
];

const CREATABLE = [
  { table: 'incident', label: 'Incident' },
  { table: 'problem', label: 'Problem' },
  { table: 'change_request', label: 'Change' },
  { table: 'kb_knowledge', label: 'Knowledge article' },
];

const isCreate = (m: NavModule) => /\/-1(\?|$)/.test(m.route ?? '');

/** The application the current page belongs to: rail apps win, then the rest. */
function activeApp(apps: NavApp[], pathname: string): string | null {
  const ordered = [...apps].sort((a, b) => rank(a.id) - rank(b.id));
  for (const a of ordered) {
    for (const m of a.modules) {
      const route = m.route?.split('?')[0];
      if (route && !isCreate(m) && route !== '/workspace' && pathname.startsWith(route)) return a.id;
    }
  }
  const match = pathname.match(/^\/workspace\/(?:list|record)\/([^/]+)/);
  if (!match) return null;
  return ordered.find((a) => a.modules.some((m) => m.table === match[1]))?.id ?? null;
}

function rank(id: string): number {
  const i = RAIL.findIndex((r) => r.app === id);
  return i === -1 ? RAIL.length : i;
}

function RailItem({ icon, label, active, onClick, to }: { icon?: string; label: string; active?: boolean; onClick?: () => void; to?: string }) {
  const cls = cx(
    'flex w-[72px] shrink-0 flex-col items-center gap-1.5 rounded-[13px] px-1 pt-3 pb-2.5 transition-colors',
    active ? 'bg-brand-100 text-brand-500 dark:bg-brand-500/15 dark:text-brand-300' : 'text-subtle hover:bg-sunken hover:text-ink',
  );
  const body = (
    <>
      <Icon name={icon} className="size-[18px]" strokeWidth={1.6} />
      <span className="text-[9px] leading-[1.2] font-bold tracking-[0.03em] uppercase">{label}</span>
    </>
  );
  return to ? (
    <Link to={to} className={cls} aria-current={active ? 'page' : undefined}>
      {body}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={onClick} aria-expanded={active}>
      {body}
    </button>
  );
}

function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>(currentTheme());
  const next: Record<ThemeMode, ThemeMode> = { light: 'dark', dark: 'system', system: 'light' };
  const IconFor = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  return (
    <button
      type="button"
      className={cx('rounded-[10px] p-2 text-subtle hover:bg-sunken hover:text-ink', className)}
      title={`Theme: ${mode}`}
      aria-label={`Theme: ${mode}`}
      onClick={() => {
        const n = next[mode];
        setMode(n);
        setTheme(n);
      }}
    >
      <IconFor className="size-4" />
    </button>
  );
}

function ModuleLink({ m, current }: { m: NavModule; current: string }) {
  const href = moduleHref(m);
  const active = current === href;
  return (
    <Link
      to={href}
      className={cx(
        'group flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-[13px]',
        active ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'text-ink hover:bg-sunken',
      )}
    >
      <span className="truncate">{m.title}</span>
      <ChevronRight className="size-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

/** Floating panel next to the rail: one application's modules, or every application. */
function AppPanel({ apps, panel, onClose }: { apps: NavApp[]; panel: string; onClose: () => void }) {
  const location = useLocation();
  const [filter, setFilter] = useState('');
  const current = `${location.pathname}${location.search}`;
  const app = apps.find((a) => a.id === panel);
  const f = filter.trim().toLowerCase();
  const groups = app
    ? [app]
    : apps
        .map((a) => ({ ...a, modules: f ? a.modules.filter((m) => m.title.toLowerCase().includes(f) || a.title.toLowerCase().includes(f)) : a.modules }))
        .filter((a) => a.modules.length > 0);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-sand-950/10 lg:bg-transparent" onMouseDown={onClose} aria-hidden />
      <div className="fixed inset-y-2.5 left-2.5 z-50 flex w-[min(320px,calc(100vw-20px))] flex-col rounded-card border border-line bg-surface shadow-pop lg:left-[112px]">
        <div className="flex items-start justify-between gap-2 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <div className="eyebrow">{app ? 'Application' : 'All applications'}</div>
            <h2 className="mt-2 truncate text-xl font-bold tracking-[-0.01em]">{app ? app.title : `${apps.length} applications`}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-subtle hover:bg-sunken" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        {!app && (
          <div className="px-5 pb-3">
            <Input autoFocus placeholder="Filter applications and modules" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 scrollbar-thin">
          {groups.map((a) => {
            const creates = a.modules.filter(isCreate);
            const rest = a.modules.filter((m) => !isCreate(m));
            return (
              <div key={a.id} className={cx(!app && 'mb-3')}>
                {!app && (
                  <div className="micro flex items-center gap-2 px-3 pt-2 pb-1.5 text-subtle">
                    <Icon name={a.icon} className="size-3.5" /> {a.title}
                  </div>
                )}
                {creates.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-2 pb-2">
                    {creates.map((m) => (
                      <Link
                        key={m.title}
                        to={moduleHref(m)}
                        className="inline-flex items-center gap-1 rounded-lg border border-brand-500 px-2.5 py-1.5 text-xs font-semibold text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
                      >
                        <Plus className="size-3.5" /> {m.title.replace(/^Create New( - )?/, '') || 'New'}
                      </Link>
                    ))}
                  </div>
                )}
                {rest.map((m) => (
                  <ModuleLink key={`${a.id}-${m.title}`} m={m} current={current} />
                ))}
              </div>
            );
          })}
          {groups.length === 0 && <p className="px-3 py-6 text-sm text-muted">Nothing matches “{filter}”.</p>}
        </div>
      </div>
    </>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function WorkspaceShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const nav = useQuery({
    queryKey: ['navigation'],
    queryFn: async () => (await api.get<{ result: NavApp[] }>('/api/app/navigation')).result,
    staleTime: 300_000,
  });
  const apps = nav.data ?? [];
  const railApps = RAIL.filter((r) => apps.some((a) => a.id === r.app));
  const current = activeApp(apps, location.pathname);
  const creatable = useMemo(() => {
    const tables = new Set(apps.flatMap((a) => a.modules.map((m) => m.table)));
    return CREATABLE.filter((c) => tables.has(c.table));
  }, [apps]);

  useEffect(() => setPanel(null), [location.pathname, location.search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (e.key === 'Escape') setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const firstName = me?.name.split(' ')[0] ?? '';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div className="min-h-full">
      <aside className="fixed inset-y-2.5 left-2.5 z-30 hidden w-[92px] flex-col rounded-2xl bg-surface shadow-float lg:flex dark:border dark:border-line">
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2.5 pt-2.5 pb-2 scrollbar-none" aria-label="Applications">
          <RailItem to="/workspace" icon="home" label="Home" active={location.pathname === '/workspace' && !panel} />
          <span className="my-1.5 h-px w-9 shrink-0 bg-line" aria-hidden />
          {railApps.map((r) => {
            const app = apps.find((a) => a.id === r.app)!;
            return <RailItem key={r.app} icon={app.icon} label={r.label} active={panel ? panel === r.app : current === r.app} onClick={() => setPanel(panel === r.app ? null : r.app)} />;
          })}
          <span className="my-1.5 h-px w-9 shrink-0 bg-line" aria-hidden />
          <RailItem icon="layout-grid" label="All apps" active={panel === 'all' || (!panel && !!current && !railApps.some((r) => r.app === current))} onClick={() => setPanel(panel === 'all' ? null : 'all')} />
        </nav>
        <div className="flex justify-center border-t border-line py-2">
          <ThemeToggle />
        </div>
      </aside>
      {panel && <AppPanel key={panel} apps={apps} panel={panel} onClose={() => setPanel(null)} />}

      <div className="lg:pl-[102px]">
        <div className="mx-auto flex min-h-screen max-w-[1480px] flex-col px-4 sm:px-6 lg:px-8">
          <header className="flex h-[76px] shrink-0 items-center gap-3">
            <button type="button" className="rounded-[10px] p-2 text-muted hover:bg-sunken lg:hidden" onClick={() => setPanel('all')} aria-label="Open navigation">
              <Menu className="size-5" />
            </button>
            <NavLink to="/workspace" className="shrink-0">
              <Logo size={30} />
            </NavLink>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden h-10 w-[320px] items-center gap-2.5 rounded-full border border-line bg-surface px-4 text-[13px] text-subtle shadow-card transition-colors hover:border-line-strong md:flex"
            >
              <Search className="size-4" />
              <span className="flex-1 text-left">Search records, articles, people…</span>
              <Kbd>⌘K</Kbd>
            </button>
            <button type="button" onClick={() => setPaletteOpen(true)} className="rounded-[10px] p-2 text-muted hover:bg-sunken md:hidden" aria-label="Search">
              <Search className="size-5" />
            </button>
            {creatable.length > 0 && (
              <details className="relative">
                <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-full bg-brand-600 px-4 text-[13px] font-semibold text-white shadow-card hover:bg-brand-700 [&::-webkit-details-marker]:hidden">
                  <Plus className="size-4" /> <span className="hidden sm:inline">New</span>
                </summary>
                <div className="absolute right-0 z-30 mt-2 w-52 rounded-tile border border-line bg-surface p-1.5 shadow-pop">
                  {creatable.map((c) => (
                    <button
                      key={c.table}
                      type="button"
                      className="block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-sunken"
                      onClick={(e) => {
                        (e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
                        navigate(`/workspace/record/${c.table}/-1`);
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </details>
            )}
            <div className="ml-2 hidden text-right xl:block">
              <div className="text-xs font-bold text-ink">
                {greeting()}, {firstName}
              </div>
              <div className="mt-0.5 text-[9px] tracking-[0.12em] text-subtle uppercase">{today}</div>
            </div>
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center rounded-full [&::-webkit-details-marker]:hidden" aria-label="Account">
                <Avatar name={me?.name ?? '?'} size={38} tone="brand" />
              </summary>
              <div className="absolute right-0 z-30 mt-2 w-64 rounded-tile border border-line bg-surface p-1.5 shadow-pop">
                <div className="mb-1 border-b border-line px-3 pt-2 pb-3">
                  <div className="text-sm font-bold">{me?.name}</div>
                  <div className="truncate text-xs text-muted">{me?.email ?? me?.user_name}</div>
                </div>
                <Link to={`/workspace/record/sys_user/${me?.sys_id}`} className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-sunken">
                  <UserRound className="size-4 text-subtle" /> Profile
                </Link>
                <Link to="/portal" className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-sunken">
                  <Monitor className="size-4 text-subtle" /> Employee portal
                </Link>
                <button type="button" onClick={() => logout().then(() => navigate('/login'))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-sunken">
                  <LogOut className="size-4 text-subtle" /> Sign out
                </button>
                <div className="mt-1 flex items-center justify-between border-t border-line px-3 pt-2 text-xs text-muted lg:hidden">
                  Theme <ThemeToggle />
                </div>
              </div>
            </details>
          </header>
          <main className="min-w-0 flex-1 pt-12 pb-10">
            <Outlet />
          </main>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-5 text-[13px] text-muted">
            <span>
              © {new Date().getFullYear()} ResolvrNow contributors <span className="mx-1.5 text-line-strong">·</span> Open source, MIT licensed
            </span>
            <span className="flex gap-6 font-semibold text-ink/80">
              <a href="/api/now/table/sys_db_object?sysparm_limit=1" className="hover:text-ink">
                API
              </a>
              <a href="https://github.com/cryptomemeindexer/resolvrnow" target="_blank" rel="noreferrer" className="hover:text-ink">
                GitHub
              </a>
            </span>
          </footer>
        </div>
      </div>
      <SearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
