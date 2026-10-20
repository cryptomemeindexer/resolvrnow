import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Inbox, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { DataTable } from '../../components/DataTable';
import { Card, Empty, Loading } from '../../components/ui';
import { api, fv, tableQuery } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DYNAMIC_ME, DYNAMIC_MY_GROUPS } from '../../lib/encoded';
import { useTableMeta } from './RecordPage';

const MINE = `active=true^assigned_toDYNAMIC${DYNAMIC_ME}`;
const GROUP_UNASSIGNED = `active=true^assigned_toISEMPTY^assignment_groupDYNAMIC${DYNAMIC_MY_GROUPS}`;
const CRITICAL = 'active=true^priority<=2';

function Stat({ icon, label, query, table, tone }: { icon: ReactNode; label: string; query: string; table: string; tone: string }) {
  const q = useQuery({
    queryKey: ['stat', table, query],
    queryFn: async () => (await api.get<{ result: { stats: { count: string } } }>(`/api/now/stats/${table}?sysparm_count=true&sysparm_query=${encodeURIComponent(query)}`)).result.stats.count,
  });
  return (
    <Link
      to={`/workspace/list/${table}?query=${encodeURIComponent(query)}&title=${encodeURIComponent(label)}`}
      className="group rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:border-brand-300"
    >
      <div className="flex items-center justify-between">
        <span className={`rounded-lg p-2 ${tone}`}>{icon}</span>
        <span className="text-2xl font-semibold tabular-nums">{q.data ?? '–'}</span>
      </div>
      <div className="mt-3 text-sm font-medium text-muted group-hover:text-ink">{label}</div>
    </Link>
  );
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
        <Link className="text-xs font-medium text-brand-600 hover:underline" to={`/workspace/list/task?query=${encodeURIComponent(query)}&title=${encodeURIComponent(title)}`}>
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
          emptyState={<Empty title="Nothing here" icon={<CheckCircle2 className="size-6" />}>You're all caught up.</Empty>}
        />
      )}
    </Card>
  );
}

export function WorkspaceHome() {
  const { me } = useAuth();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {greeting}, {me?.name.split(' ')[0]}
        </h1>
        <p className="text-sm text-muted">Here's what needs your attention.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat table="task" label="Assigned to me" query={MINE} icon={<Inbox className="size-4" />} tone="bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300" />
        <Stat table="task" label="Unassigned in my groups" query={GROUP_UNASSIGNED} icon={<Users className="size-4" />} tone="bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" />
        <Stat table="task" label="Critical & high priority" query={CRITICAL} icon={<AlertTriangle className="size-4" />} tone="bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300" />
        <Stat table="task" label="Updated today" query="active=true^sys_updated_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()" icon={<Clock className="size-4" />} tone="bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Queue title="My work" query={MINE} />
        <Queue title="Unassigned in my groups" query={GROUP_UNASSIGNED} />
      </div>
    </div>
  );
}
