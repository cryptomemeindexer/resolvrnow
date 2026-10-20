import { ArrowRight, Lock } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Button, Input, Label } from '../components/ui';
import { useAuth } from '../lib/auth';
import { Logo } from './workspace/Shell';

const DEMO_ACCOUNTS = [
  { user: 'priya.nair', role: 'Service desk manager' },
  { user: 'alex.rivera', role: 'Service desk agent' },
  { user: 'grace.okafor', role: 'Change manager' },
  { user: 'olivia.martin', role: 'Employee (portal)' },
];

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
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-brand-800 p-12 text-white lg:flex lg:flex-col">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-brand-600/40 blur-3xl" />
        <div className="absolute -bottom-32 -left-16 size-96 rounded-full bg-ember-500/20 blur-3xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 text-lg font-semibold">
            <Logo compact /> ResolvrNow
          </span>
        </div>
        <div className="relative mt-auto max-w-md space-y-4">
          <h1 className="text-3xl font-semibold leading-tight">Open-source service management, built for teams that move fast.</h1>
          <p className="text-brand-100">
            Incidents, problems, changes, requests, knowledge and CMDB on one metadata-driven platform, with an API that existing integrations already speak.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="lg:hidden">
            <Logo />
          </div>
          <div>
            <h2 className="text-2xl font-semibold">Sign in</h2>
            <p className="text-sm text-muted">Use your ResolvrNow account.</p>
          </div>
          <div>
            <Label htmlFor="u">User name</Label>
            <Input id="u" autoComplete="username" autoFocus value={userName} onChange={(e) => setUserName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="p">Password</Label>
            <Input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<Lock className="size-4" />}>
            Sign in
          </Button>
          {import.meta.env.VITE_DEMO !== 'false' && (
            <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
              <p className="mb-2 font-medium text-ink">Demo accounts (password demo1234)</p>
              <div className="grid gap-1">
                {DEMO_ACCOUNTS.map((a) => (
                  <button
                    key={a.user}
                    type="button"
                    className="flex items-center justify-between rounded px-2 py-1 text-left hover:bg-raised"
                    onClick={() => {
                      setUserName(a.user);
                      setPassword('demo1234');
                    }}
                  >
                    <span className="font-mono text-ink">{a.user}</span>
                    <span className="flex items-center gap-1">
                      {a.role} <ArrowRight className="size-3" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
