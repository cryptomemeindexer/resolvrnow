import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Mail, MessageSquare, Paperclip, PenLine, PlusCircle } from 'lucide-react';
import { useState } from 'react';
import { type ActivityItem, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Button, cx, Empty, Loading, localDateTime, relativeTime, Textarea, useToast } from './ui';

function Entry({ item }: { item: ActivityItem }) {
  const who = item.user_name || item.created_by || 'System';
  if (item.type === 'journal') {
    const internal = item.field === 'work_notes';
    return (
      <li className="flex gap-3">
        <Avatar name={who} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
            <span className="font-semibold text-ink">{who}</span>
            <span className={cx('inline-flex items-center gap-1', internal ? 'text-amber-700 dark:text-amber-400' : '')}>
              {internal ? <Lock className="size-3" /> : <MessageSquare className="size-3" />}
              {item.label}
            </span>
            <span title={localDateTime(item.created_on)}>{relativeTime(item.created_on)}</span>
          </div>
          <div
            className={cx(
              'mt-1 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
              internal ? 'border border-amber-200 bg-amber-50/70 dark:border-amber-500/20 dark:bg-amber-500/10' : 'border border-line bg-raised',
            )}
          >
            {item.value}
          </div>
        </div>
      </li>
    );
  }
  if (item.type === 'changes' || item.type === 'created') {
    return (
      <li className="flex gap-3">
        <span className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-full bg-raised text-subtle">
          {item.type === 'created' ? <PlusCircle className="size-4" /> : <PenLine className="size-4" />}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <div className="text-xs text-muted">
            <span className="font-semibold text-ink">{who}</span> {item.type === 'created' ? 'created the record' : 'updated'} ·{' '}
            <span title={localDateTime(item.created_on)}>{relativeTime(item.created_on)}</span>
          </div>
          <dl className="mt-1 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-0.5 text-xs">
            {item.changes?.map((c) => (
              <div key={c.field} className="contents">
                <dt className="text-muted">{c.label}</dt>
                <dd className="min-w-0 truncate">
                  {item.type === 'changes' && c.old ? <span className="text-subtle line-through">{c.old}</span> : null}
                  {item.type === 'changes' && c.old ? ' → ' : ''}
                  <span>{c.new || <em className="text-subtle">empty</em>}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </li>
    );
  }
  if (item.type === 'email') {
    return (
      <li className="flex gap-3 text-sm">
        <span className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600 dark:bg-sky-500/15">
          <Mail className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-xs text-muted">
            Email {item.recipients ? `to ${item.recipients}` : ''} · {relativeTime(item.created_on)}
          </div>
          <div className="truncate">{item.subject}</div>
        </div>
      </li>
    );
  }
  return (
    <li className="flex gap-3 text-sm">
      <span className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-full bg-raised text-subtle">
        <Paperclip className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-xs text-muted">
          {who} attached a file · {relativeTime(item.created_on)}
        </div>
        <a className="text-brand-600 hover:underline" href={`/api/now/attachment/${item.sys_id}/file`}>
          {item.file_name}
        </a>
      </div>
    </li>
  );
}

/** Activity stream with a composer for comments (customer visible) and work notes (internal). */
export function Activity({ table, sysId, canWrite }: { table: string; sysId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { hasRole } = useAuth();
  const agent = hasRole('itil');
  const [kind, setKind] = useState<'work_notes' | 'comments'>(agent ? 'work_notes' : 'comments');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'all' | 'notes' | 'changes'>('all');
  const q = useQuery({
    queryKey: ['activity', table, sysId],
    queryFn: async () => (await api.get<{ result: ActivityItem[] }>(`/api/app/activity/${table}/${sysId}`)).result,
  });
  const post = useMutation({
    mutationFn: () => api.patch(`/api/now/table/${table}/${sysId}`, { [kind]: text }),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: ['activity', table, sysId] });
      qc.invalidateQueries({ queryKey: ['record', table, sysId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const upload = useMutation({
    mutationFn: async (file: File) =>
      api.post(`/api/now/attachment/file?table_name=${table}&table_sys_id=${sysId}&file_name=${encodeURIComponent(file.name)}`, file, {
        'Content-Type': file.type || 'application/octet-stream',
      }),
    onSuccess: () => {
      toast('File attached', 'success');
      qc.invalidateQueries({ queryKey: ['activity', table, sysId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const items = (q.data ?? []).filter((i) =>
    filter === 'all' ? true : filter === 'notes' ? i.type === 'journal' : i.type === 'changes' || i.type === 'created',
  );

  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="rounded-xl border border-line bg-surface p-3 shadow-xs">
          <div className="mb-2 flex items-center gap-1 text-xs">
            {agent && (
              <button
                type="button"
                onClick={() => setKind('work_notes')}
                className={cx('rounded-md px-2 py-1 font-medium', kind === 'work_notes' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' : 'text-muted hover:bg-raised')}
              >
                Work notes (internal)
              </button>
            )}
            <button
              type="button"
              onClick={() => setKind('comments')}
              className={cx('rounded-md px-2 py-1 font-medium', kind === 'comments' ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300' : 'text-muted hover:bg-raised')}
            >
              Additional comments (customer visible)
            </button>
          </div>
          <Textarea
            rows={3}
            value={text}
            placeholder={kind === 'work_notes' ? 'Add an internal work note…' : 'Reply to the requester…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) post.mutate();
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted hover:text-ink">
              <Paperclip className="size-3.5" /> Attach file
              <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
            </label>
            <Button size="sm" variant="primary" disabled={!text.trim()} loading={post.isPending} onClick={() => post.mutate()}>
              Post
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-1 text-xs">
        {(['all', 'notes', 'changes'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cx('rounded-md px-2 py-1 capitalize', filter === f ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink')}
          >
            {f === 'notes' ? 'Comments & notes' : f === 'changes' ? 'Field changes' : 'All activity'}
          </button>
        ))}
      </div>
      {q.isLoading ? <Loading /> : items.length === 0 ? <Empty title="No activity yet" /> : <ol className="space-y-4">{items.map((i, n) => <Entry key={`${i.type}-${i.created_on}-${n}`} item={i} />)}</ol>}
    </div>
  );
}
