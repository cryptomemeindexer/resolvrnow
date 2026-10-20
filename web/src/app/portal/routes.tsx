import { Link } from 'react-router';
import { Logo } from '../workspace/Shell';

/** Employee portal (self-service). Replaced by the full portal implementation. */
export function PortalRoutes() {
  return (
    <div className="mx-auto max-w-3xl p-10">
      <Logo />
      <h1 className="mt-6 text-2xl font-semibold">Employee portal</h1>
      <p className="mt-2 text-muted">The self-service portal is being built.</p>
      <Link to="/workspace" className="mt-4 inline-block text-brand-600 hover:underline">
        Go to workspace
      </Link>
    </div>
  );
}
