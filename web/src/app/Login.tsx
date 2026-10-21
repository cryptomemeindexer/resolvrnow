import { ArrowRight, Check } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { KnotGlyph, Logo } from '../components/Logo';
import { Avatar, Button, Input, Label } from '../components/ui';
import { useAuth } from '../lib/auth';

const DEMO_ACCOUNTS = [
  { user: 'priya.nair', name: 'Priya Nair', role: 'Service desk manager' },
  { user: 'alex.rivera', name: 'Alex Rivera', role: 'Service desk agent' },
  { user: 'grace.okafor', name: 'Grace Okafor', role: 'Change manager' },
  { user: 'olivia.martin', name: 'Olivia Martin', role: 'Employee (portal)' },
];

const POINTS = ['Incident, problem, change and request management', 'REST API compatible with existing ITSM integrations', 'Self-hosted and MIT licensed'];

function HeroPanel() {
  return (
    <div
      className="relative hidden overflow-hidden rounded-card p-11 text-white shadow-[0_2px_6px_rgb(74_56_30/0.06),0_14px_36px_rgb(74_56_30/0.1)] lg:flex lg:flex-col"
      style={{ background: 'linear-gradient(150deg, #ff8a68 0%, #ee5738 36%, #b3361f 70%, #4a1d1a 100%)' }}
    >
      <KnotGlyph className="pointer-events-none absolute -right-28 -bottom-32 size-[760px] text-white/[0.08]" strokeWidth={5} />
      <div className="pointer-events-none absolute inset-5 rounded-t-[150px] rounded-b-[18px] border border-white/25" aria-hidden />
      <span className="absolute top-5 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-gold-300" aria-hidden />
      <div className="relative mt-auto max-w-[470px]">
        <div className="eyebrow text-white/85">Open-source service management</div>
        <h2 className="mt-4 text-[32px] leading-[1.12] font-bold tracking-[-0.02em]">From open to resolved, faster.</h2>
        <p className="mt-4 text-sm leading-[1.7] text-white/85">
          Incidents, problems, changes, requests and knowledge on one platform, with a REST API your integrations already speak.
        </p>
        <ul className="mt-6 space-y-3 text-sm">
          {POINTS.map((p) => (
            <li key={p} className="flex items-center gap-3">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-white/45">
                <Check className="size-3.5" strokeWidth={2.5} />
              </span>
              {p}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex gap-12 border-t border-white/20 pt-6">
          {[
            ['20', 'Modules'],
            ['MIT', 'License'],
            ['REST', 'Table API'],
          ].map(([v, l]) => (
            <div key={l}>
              <div className="text-[32px] leading-none font-bold tracking-[-0.02em]">{v}</div>
              <div className="micro mt-2 text-[9px] text-white/70">{l}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from;

  if (me) return <Navigate to={from ?? (me.is_agent ? '/workspace' : '/portal')} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(userName.trim(), password);
      navigate(from ?? (u.is_agent ? '/workspace' : '/portal'), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen p-3 sm:p-5">
      <div className="mx-auto grid min-h-[calc(100vh-40px)] max-w-[1400px] gap-[26px] lg:grid-cols-2">
        <HeroPanel />
        <div className="flex items-center justify-center rounded-card border border-line bg-surface p-6 shadow-card sm:px-[46px] sm:py-10">
          <form onSubmit={submit} className="w-full max-w-[400px]">
            <Logo size={34} />
            <div className="mt-9">
              <div className="eyebrow">Sign in</div>
              <h1 className="mt-3 text-[32px] leading-[1.1] font-bold tracking-[-0.02em] text-brand-500 dark:text-brand-400">Welcome back.</h1>
              <p className="mt-3 text-sm leading-[1.7] text-muted">Agents go to the workspace, everyone else to the self-service portal.</p>
            </div>
            <div className="mt-7 space-y-4">
              <div>
                <Label htmlFor="u">User name</Label>
                <Input id="u" className="h-11" autoComplete="username" autoFocus value={userName} onChange={(e) => setUserName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="p">Password</Label>
                <Input id="p" className="h-11" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              {error && <p className="rounded-control bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
              <Button type="submit" variant="primary" className="h-11 w-full text-sm" loading={busy}>
                Sign in <ArrowRight className="size-4" />
              </Button>
            </div>
            {import.meta.env.VITE_DEMO !== 'false' && (
              <div className="mt-8">
                <div className="micro flex items-center justify-between text-subtle">
                  <span>Demo accounts</span>
                  <span className="tracking-[0.06em] normal-case">password demo1234</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {DEMO_ACCOUNTS.map((a) => (
                    <button
                      key={a.user}
                      type="button"
                      className="flex items-center gap-2.5 rounded-tile border border-line px-3 py-2.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/50 dark:hover:bg-brand-500/10"
                      onClick={() => {
                        setUserName(a.user);
                        setPassword('demo1234');
                      }}
                    >
                      <Avatar name={a.name} size={30} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-ink">{a.name}</span>
                        <span className="block truncate text-[11px] text-subtle">{a.role}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
