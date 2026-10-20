import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Logo } from '../../components/Logo';
import { PageHero } from '../../components/ui';

/** Employee portal (self-service). Replaced by the full portal implementation. */
export function PortalRoutes() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 sm:px-8">
      <header className="flex h-[76px] items-center">
        <Logo size={30} />
      </header>
      <div className="mt-10">
        <PageHero title="How can we help?" eyebrow="Employee portal">
          Report an issue, request something or find an answer. The self-service portal is being built.
        </PageHero>
        <Link to="/workspace" className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">
          Go to the agent workspace <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}
