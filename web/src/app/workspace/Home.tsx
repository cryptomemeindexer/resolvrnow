import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { DataTable } from '../../components/DataTable';
import { Icon } from '../../components/Icon';
import { ArrowButton, Card, Chip, Empty, IconTile, Loading, PageHero, SectionHeader, StatTile, TINTS, type Tint } from '../../components/ui';
import { api, fv, type NavApp, tableQuery } from '../../lib/api';
import { DYNAMIC_ME, DYNAMIC_MY_GROUPS } from '../../lib/encoded';
import { useTableMeta } from './RecordPage';

const MINE = `active=true^assigned_toDYNAMIC${DYNAMIC_ME}`;
const GROUP_UNASSIGNED = `active=true^assigned_toISEMPTY^assignment_groupDYNAMIC${DYNAMIC_MY_GROUPS}`;
const CRITICAL = 'active=true^priority<=2';
const MY_APPROVALS = `state=requested^approverDYNAMIC${DYNAMIC_ME}`;
const BREACHED = 'active=true^has_breached=true';

const listHref = (table: string, query: string, title: string) =>
  `/workspace/list/${table}?query=${encodeURIComponent(query)}&title=${encodeURIComponent(title)}`;

/** Row count for a query, or null when the table is not installed or not readable. */
function useCount(table: string, query: string, enabled = true) {
  return useQuery({
    queryKey: ['count', table, query],
    enabled,
    retry: false,
    queryFn: async () =>
      Number((await api.get<{ result: { stats: { count: string } } }>(`/api/now/stats/${table}?sysparm_count=true&sysparm_query=${encodeURIComponent(query)}`)).result.stats.count),
  });
}

function Stat({ table, query, label }: { table: string; query: string; label: string }) {
  const q = useCount(table, query);
  if (q.isError) return null;
  return <StatTile value={q.data ?? '–'} label={label} to={listHref(table, query, label)} />;
}

function Queue({ title, query }: { title: string; query: string }) {
  const navigate = useNavigate();
  const meta = useTableMeta('task');
  const cols = ['number', 'short_description', 'priority', 'state', 'sys_updated_on'];
  const q = useQuery({
    queryKey: ['home-queue', query],
    queryFn: () => tableQuery('task', { query: `${query}^ORDERBYpriority^ORDERBYDESCsys_updated_on`, fields: ['sys_id', 'sys_class_name', ...cols], limit: 8 }),
  });
  return (
    <Card
      title={title}
      actions={
        <Link className="text-xs font-semibold text-accent hover:underline" to={listHref('task', query, title)}>
          View all ({q.data?.total ?? 0})
        </Link>
      }
    >
      {q.isLoading || meta.isLoading ? (
        <Loading />
      ) : (
        <DataTable
          columns={cols}
          meta={meta.data?.columns ?? {}}
          rows={(q.data?.rows ?? []).map((r) => ({ sys_id: fv(r.sys_id).value, table: fv(r.sys_class_name).value, values: r }))}
          onOpen={(r) => navigate(`/workspace/record/${r.table}/${r.sys_id}`)}
          emptyState={
            <Empty title="Nothing here" icon={<CheckCircle2 className="size-5" />}>
              You're all caught up.
            </Empty>
          }
        />
      )}
    </Card>
  );
}

interface AppCardDef {
  app: string;
  title: string;
  icon: string;
  tint: Tint;
  text: string;
  table: string;
  query: string;
  unit: string;
  to?: string;
}

const APP_CARDS: AppCardDef[] = [
  { app: 'incident', title: 'Incidents', icon: 'flame', tint: 'coral', table: 'incident', query: 'active=true', unit: 'open', text: 'Restore service fast. Triage by impact and urgency, assign, resolve and keep callers informed.' },
  { app: 'problem', title: 'Problems', icon: 'bug', tint: 'indigo', table: 'problem', query: 'active=true', unit: 'open', text: 'Find the root cause behind recurring incidents, share workarounds and publish known errors.' },
  { app: 'change', title: 'Changes', icon: 'git-pull-request', tint: 'green', table: 'change_request', query: 'active=true', unit: 'in flight', text: 'Normal, standard and emergency changes with risk, conflict checks and CAB approval.' },
  { app: 'requests', title: 'Requests', icon: 'package', tint: 'blue', table: 'sc_req_item', query: 'active=true', unit: 'open items', text: 'Fulfil catalog requests in order: approvals, requested items and fulfilment tasks.' },
  { app: 'knowledge', title: 'Knowledge', icon: 'book-open', tint: 'rose', table: 'kb_knowledge', query: 'workflow_state=published', unit: 'published', text: 'Write, review and publish articles so people can solve common issues on their own.' },
  { app: 'cmdb', title: 'Configuration', icon: 'network', tint: 'teal', table: 'cmdb_ci', query: 'install_status!=7', unit: 'items', text: 'Business services, servers and applications, with dependencies, health and impact.' },
  { app: 'approvals', title: 'Approvals', icon: 'check-circle', tint: 'amber', table: 'sysapproval_approver', query: MY_APPROVALS, unit: 'waiting on you', text: 'Approve or reject the requests and changes waiting on you or the people you cover for.' },
  { app: 'analytics', title: 'Analytics', icon: 'bar-chart-3', tint: 'violet', table: 'sys_report', query: '', unit: 'reports', to: '/workspace/dashboards', text: 'Dashboards, reports and service desk KPIs with a daily history of every indicator.' },
];

function AppCard({ def }: { def: AppCardDef }) {
  const count = useCount(def.table, def.query);
  const to = def.to ?? listHref(def.table, def.query, def.title);
  return (
    <div className="group relative flex flex-col rounded-card border border-line bg-surface p-[22px] shadow-card transition-shadow hover:shadow-pop">
      <div className="flex items-center gap-3">
        <IconTile tint={def.tint} icon={<Icon name={def.icon} className="size-[18px]" strokeWidth={1.8} />} />
        <h3 className={`text-lg font-bold tracking-[-0.01em] ${TINTS[def.tint].text}`}>
          <Link to={to} className="after:absolute after:inset-0">
            {def.title}
          </Link>
        </h3>
      </div>
      <p className="mt-4 flex-1 text-[13px] leading-[1.62] text-muted">{def.text}</p>
      <div className="mt-5 flex items-center justify-between gap-2 border-t border-line pt-4">
        <div className="flex flex-wrap gap-1.5">{count.data !== undefined && <Chip>{`${count.data.toLocaleString()} ${def.unit}`}</Chip>}</div>
        <span className="relative">
          <ArrowButton to={to} label={`Open ${def.title}`} />
        </span>
      </div>
    </div>
  );
}

export function WorkspaceHome() {
  const nav = useQuery({
    queryKey: ['navigation'],
    queryFn: async () => (await api.get<{ result: NavApp[] }>('/api/app/navigation')).result,
    staleTime: 300_000,
  });
  const installed = new Set((nav.data ?? []).map((a) => a.id));
  const cards = APP_CARDS.filter((c) => installed.has(c.app));
  const mine = useCount('task', MINE);
  return (
    <div className="space-y-12">
      <div>
        <PageHero title="ResolvrNow" eyebrow="Agent workspace">
          Incidents, problems, changes and requests in one place. Work your queue, keep SLAs on track and resolve what matters first.
        </PageHero>
        <div className="mt-8 flex flex-wrap gap-2.5">
          <Stat table="task" query={MINE} label="Assigned to me" />
          <Stat table="task" query={GROUP_UNASSIGNED} label="Unassigned in my groups" />
          <Stat table="task" query={CRITICAL} label="Critical and high" />
          {installed.has('approvals') && <Stat table="sysapproval_approver" query={MY_APPROVALS} label="Awaiting my approval" />}
          {installed.has('sla') && <Stat table="task_sla" query={BREACHED} label="Breached SLAs" />}
        </div>
      </div>

      <section>
        <SectionHeader title="Your work" aside={mine.data !== undefined ? `${mine.data} assigned to you` : undefined} />
        <div className="mt-5 grid gap-6 xl:grid-cols-2">
          <Queue title="Assigned to me" query={MINE} />
          <Queue title="Unassigned in my groups" query={GROUP_UNASSIGNED} />
        </div>
      </section>

      {cards.length > 0 && (
        <section>
          <SectionHeader title="Service desk" aside={`${String(cards.length).padStart(2, '0')} available`} />
          <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {cards.map((c) => (
              <AppCard key={c.app} def={c} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
