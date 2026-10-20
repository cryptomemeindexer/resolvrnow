import { useQuery } from '@tanstack/react-query';
import { ChevronDown, LogOut, Menu, Monitor, Moon, PanelLeftClose, Plus, Search, Sun, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Icon } from '../../components/Icon';
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

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 64 64" className="size-7 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="14" className="fill-brand-700" />
        <path d="M18 40c0-9 7-16 16-16h12v8H34c-4.4 0-8 3.6-8 8s3.6 8 8 8h12v8H34c-8.8 0-16-7.2-16-16z" className="fill-ember-500" />
        <circle cx="46" cy="20" r="5" fill="#fff" />
      </svg>
      {!compact && (
        <span>
          Resolvr<span className="text-brand-600 dark:text-brand-300">Now</span>
        </span>
      )}
    </span>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(currentTheme());
  const next: Record<ThemeMode, ThemeMode> = { light: 'dark', dark: 'system', system: 'light' };
  const IconFor = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  return (
    <button
      type="button"
      className="rounded-lg p-2 text-muted hover:bg-raised hover:text-ink"
      title={`Theme: ${mode}`}
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

function Navigator({ apps, filter }: { apps: NavApp[]; filter: string }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('app.nav.collapsed') ?? '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('app.nav.collapsed', JSON.stringify(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  const f = filter.trim().toLowerCase();
  const shown = apps
    .map((a) => ({ ...a, modules: f ? a.modules.filter((m) => m.title.toLowerCase().includes(f) || a.title.toLowerCase().includes(f)) : a.modules }))
    .filter((a) => a.modules.length > 0);
  const current = `${location.pathname}${location.search}`;
  return (
    <nav className="space-y-1 pb-6" aria-label="Applications">
      {shown.map((a) => {
        const isCollapsed = !f && collapsed[a.id];
        return (
          <div key={a.id}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-semibold text-ink hover:bg-raised"
            >
              <Icon name={a.icon} className="size-4 text-brand-600 dark:text-brand-300" />
              <span className="flex-1 truncate">{a.title}</span>
              <ChevronDown className={cx('size-3.5 text-subtle transition-transform', isCollapsed && '-rotate-90')} />
            </button>
            {!isCollapsed && (
              <ul className="mt-0.5 space-y-px border-l border-line pl-2 ml-4">
                {a.modules.map((m) => {
                  const href = moduleHref(m);
                  const active = current === href;
                  return (
                    <li key={`${a.id}-${m.title}`}>
                      <Link
                        to={href}
                        className={cx(
                          'block truncate rounded-md px-2 py-1 text-[13px]',
                          active ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-200' : 'text-muted hover:bg-raised hover:text-ink',
                        )}
                      >
                        {m.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

const CREATABLE = [
  { table: 'incident', label: 'Incident' },
  { table: 'problem', label: 'Problem' },
  { table: 'change_request', label: 'Change' },
  { table: 'kb_knowledge', label: 'Knowledge article' },
];

export function WorkspaceShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [sidebar, setSidebar] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
  const nav = useQuery({
    queryKey: ['navigation'],
    queryFn: async () => (await api.get<{ result: NavApp[] }>('/api/app/navigation')).result,
    staleTime: 300_000,
  });
  const creatable = useMemo(() => {
    const tables = new Set((nav.data ?? []).flatMap((a) => a.modules.map((m) => m.table)));
    return CREATABLE.filter((c) => tables.has(c.table));
  }, [nav.data]);

  useEffect(() => setMobileNav(false), [location.pathname, location.search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <button type="button" className="rounded-lg p-2 text-muted hover:bg-raised lg:hidden" onClick={() => setMobileNav((s) => !s)} aria-label="Menu">
          <Menu className="size-5" />
        </button>
        <button type="button" className="hidden rounded-lg p-2 text-muted hover:bg-raised lg:block" onClick={() => setSidebar((s) => !s)} aria-label="Toggle navigation">
          <PanelLeftClose className={cx('size-4 transition-transform', !sidebar && 'rotate-180')} />
        </button>
        <NavLink to="/workspace">
          <Logo />
        </NavLink>
        <span className="hidden rounded-md bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 sm:inline dark:bg-brand-900/40 dark:text-brand-300">Workspace</span>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mx-auto flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-line bg-raised px-3 text-sm text-subtle hover:border-brand-400"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search records…</span>
          <Kbd>⌘K</Kbd>
        </button>
        {creatable.length > 0 && (
          <details className="relative">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-1 rounded-lg bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-800 [&::-webkit-details-marker]:hidden">
              <Plus className="size-4" /> <span className="hidden sm:inline">New</span>
            </summary>
            <div className="absolute right-0 z-30 mt-1 w-48 rounded-lg border border-line bg-surface py-1 shadow-lg">
              {creatable.map((c) => (
                <button
                  key={c.table}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-raised"
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
        <ThemeToggle />
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg p-1 hover:bg-raised [&::-webkit-details-marker]:hidden">
            <Avatar name={me?.name ?? '?'} />
          </summary>
          <div className="absolute right-0 z-30 mt-1 w-60 rounded-lg border border-line bg-surface py-1 shadow-lg">
            <div className="border-b border-line px-3 py-2">
              <div className="text-sm font-medium">{me?.name}</div>
              <div className="truncate text-xs text-muted">{me?.email ?? me?.user_name}</div>
            </div>
            <Link to={`/workspace/record/sys_user/${me?.sys_id}`} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-raised">
              <UserRound className="size-4" /> Profile
            </Link>
            <Link to="/portal" className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-raised">
              <Monitor className="size-4" /> Employee portal
            </Link>
            <button type="button" onClick={() => logout().then(() => navigate('/login'))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-raised">
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </details>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className={cx(
            'w-64 shrink-0 flex-col border-r border-line bg-surface',
            mobileNav ? 'fixed inset-y-14 left-0 z-40 flex shadow-xl' : 'hidden',
            sidebar ? 'lg:flex' : 'lg:hidden',
          )}
        >
          <div className="p-3">
            <Input placeholder="Filter navigator" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 scrollbar-thin">
            <NavLink
              to="/workspace"
              end
              className={({ isActive }) =>
                cx('mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-semibold', isActive ? 'bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200' : 'hover:bg-raised')
              }
            >
              <Icon name="layout-dashboard" className="size-4 text-brand-600 dark:text-brand-300" /> Home
            </NavLink>
            <Navigator apps={nav.data ?? []} filter={filter} />
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
          <Outlet />
        </main>
      </div>
      <SearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
