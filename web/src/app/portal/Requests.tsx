import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Paperclip, Send, XCircle } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ReferencePicker } from '../../components/fields/ReferencePicker';
import { Icon } from '../../components/Icon';
import { Button, Card, Chip, cx, Empty, IconTile, Input, Label, Loading, relativeTime, SectionHeader, Segmented, Select, Stepper, Textarea, useToast } from '../../components/ui';
import { api, type ApiError } from '../../lib/api';
import { evaluate } from '../../lib/encoded';
import { CATALOG, type ItemForm, type OrderResult, PORTAL, type TicketPage, type TicketRow, useApprovals, useItemForm, useTicket, useTickets, type Variable } from './data';
import { useI18n } from './i18n';
import { NotFound, RichText, StateBadge, TicketList } from './parts';

const LAYOUT = new Set(['break', 'container_start', 'container_split', 'container_end', 'attachment', 'unsupported']);

interface VarState {
  visible: boolean;
  mandatory: boolean;
  readOnly: boolean;
}

/** Applies catalog UI policies (in order) on top of each variable's own settings. */
function variableStates(form: ItemForm, values: Record<string, string>, displays: Record<string, string>): Record<string, VarState> {
  const out: Record<string, VarState> = {};
  for (const v of form.variables) out[v.name] = { visible: v.visible !== false, mandatory: !!v.mandatory, readOnly: !!v.read_only };
  const subject: Record<string, { value: string; display_value: string }> = {};
  for (const [k, v] of Object.entries(values)) subject[k] = { value: v, display_value: displays[k] ?? v };
  for (const p of [...form.ui_policies].sort((a, b) => a.order - b.order)) {
    const ok = evaluate(p.condition, subject);
    if (!ok && !p.reverse_if_false) continue;
    for (const a of p.actions) {
      const s = out[a.name];
      if (!s) continue;
      const apply = (flag: string) => (ok ? flag === 'true' : flag !== 'true');
      if (a.visible && a.visible !== 'ignore') s.visible = apply(a.visible);
      if (a.mandatory && a.mandatory !== 'ignore') s.mandatory = apply(a.mandatory);
      if (a.disabled && a.disabled !== 'ignore') s.readOnly = apply(a.disabled);
    }
  }
  return out;
}

function VariableInput({ v, value, display, readOnly, onChange }: { v: Variable; value: string; display: string; readOnly: boolean; onChange: (value: string, display?: string) => void }) {
  const id = `var-${v.name}`;
  switch (v.ui_type) {
    case 'textarea':
    case 'html':
      return <Textarea id={id} rows={4} value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value)} placeholder={v.example_text} />;
    case 'select':
      return (
        <Select id={id} value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value, e.target.selectedOptions[0]?.text)}>
          {!v.mandatory && <option value="">--</option>}
          {(v.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      );
    case 'radio':
    case 'scale':
    case 'yes_no': {
      const choices = v.choices?.length ? v.choices : v.ui_type === 'yes_no' ? [{ value: 'Yes', label: 'Yes', price: 0 }, { value: 'No', label: 'No', price: 0 }] : [];
      return (
        <div className="flex flex-wrap gap-2" role="radiogroup" id={id}>
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={value === c.value}
              disabled={readOnly}
              onClick={() => onChange(c.value, c.label)}
              className={cx(
                'rounded-control border px-3.5 py-2 text-[13px] font-semibold transition-colors',
                value === c.value ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'border-line bg-surface hover:bg-sunken',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" className="size-4 accent-brand-600" checked={value === 'true'} disabled={readOnly} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
          {v.label}
        </label>
      );
    case 'reference':
      return (
        <ReferencePicker
          id={id}
          table={v.reference ?? 'sys_user'}
          qualifier={v.reference_qualifier}
          value={{ value, display_value: display }}
          onChange={(r) => onChange(r.value, r.display_value)}
          disabled={readOnly}
          showLink={false}
        />
      );
    case 'date':
      return <Input id={id} type="date" value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return (
        <Input
          id={id}
          type="datetime-local"
          value={value.replace(' ', 'T').slice(0, 16)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value ? `${e.target.value.replace('T', ' ')}:00` : '')}
        />
      );
    case 'email':
    case 'url':
    case 'password':
      return <Input id={id} type={v.ui_type} value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value)} placeholder={v.example_text} />;
    default:
      return <Input id={id} value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value)} placeholder={v.example_text} />;
  }
}

export function ItemPage() {
  const { t, lang } = useI18n();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const form = useItemForm(id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [displays, setDisplays] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (!form.data) return;
    setValues(form.data.values);
    const d: Record<string, string> = {};
    for (const v of form.data.variables) if (v.displayvalue) d[v.name] = v.displayvalue;
    setDisplays(d);
  }, [form.data]);

  const states = useMemo(() => (form.data ? variableStates(form.data, values, displays) : {}), [form.data, values, displays]);

  const order = useMutation({
    mutationFn: async () => (await api.post<{ result: OrderResult }>(`${CATALOG}/items/${id}/order`, { variables: values, quantity })).result,
    onSuccess: (r) => {
      const target = r.record ?? r.request_items[0];
      toast(t('item.done', { number: target?.number ?? r.request?.number ?? '' }), 'success');
      if (target) navigate(`/portal/ticket/${target.table}/${target.sys_id}`);
      else navigate('/portal/tickets');
    },
    onError: (e: ApiError) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });

  if (form.isLoading) return <Loading label={t('common.loading')} />;
  if (!form.data) return <NotFound />;
  const { item, variables } = form.data;
  const extra = variables.reduce((sum, v) => sum + (v.choices?.find((c) => c.value === values[v.name])?.price ?? 0), 0);
  const total = (Number(item.price_value || 0) + extra) * quantity;
  const money = new Intl.NumberFormat(lang === 'ar' ? 'ar' : 'en', { style: 'currency', currency: item.currency || 'USD' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const missing = variables.filter((v) => !LAYOUT.has(v.ui_type) && states[v.name]?.visible && states[v.name]?.mandatory && !values[v.name]);
    if (missing.length) {
      toast(t('item.required', { fields: missing.map((m) => m.label).join(', ') }), 'error');
      return;
    }
    order.mutate();
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <section>
        <Link to="/portal/catalog" className="micro text-subtle hover:text-ink">
          {t('nav.catalog')}
        </Link>
        <div className="mt-5 flex items-center gap-4">
          <IconTile tint="blue" className="size-14 rounded-tile" icon={<Icon name={item.icon || 'package'} className="size-6" strokeWidth={1.7} />} />
          <h1 className="text-[30px] leading-tight font-bold tracking-[-0.02em]">{item.name}</h1>
        </div>
        <p className="mt-4 text-base leading-[1.7] text-muted">{item.short_description}</p>
        {item.description && <RichText html={item.description} className="mt-4 text-sm text-muted" />}
        {(item.show_price || item.delivery_time) && (
          <div className="mt-6 flex flex-wrap gap-2.5">
            {item.show_price && (
              <div className="rounded-tile border border-line bg-surface px-5 pt-3.5 pb-4">
                <div className="text-2xl leading-none font-bold text-brand-500 tabular-nums">{money.format(total)}</div>
                <div className="micro mt-2 text-subtle">{t('item.price')}</div>
              </div>
            )}
            {item.delivery_time && (
              <div className="rounded-tile border border-line bg-surface px-5 pt-3.5 pb-4">
                <div className="text-2xl leading-none font-bold">{item.delivery_time}</div>
                <div className="micro mt-2 text-subtle">{t('item.delivery')}</div>
              </div>
            )}
          </div>
        )}
      </section>

      <form onSubmit={submit} className="rounded-[24px] border border-line bg-surface p-6 shadow-card sm:p-8">
        {item.type === 'order_guide' || item.type === 'content_item' ? (
          <Empty title={item.name}>{item.short_description}</Empty>
        ) : (
          <div className="space-y-5">
            {variables.map((v) => {
              if (LAYOUT.has(v.ui_type) || !states[v.name]?.visible) return null;
              if (v.ui_type === 'label' || v.ui_type === 'rich_text_label') {
                return (
                  <p key={v.name} className="pt-2 text-sm font-bold">
                    {v.label}
                  </p>
                );
              }
              const st = states[v.name];
              return (
                <div key={v.name}>
                  {v.ui_type !== 'checkbox' && (
                    <Label htmlFor={`var-${v.name}`} required={st.mandatory}>
                      {v.label}
                    </Label>
                  )}
                  <VariableInput
                    v={v}
                    value={values[v.name] ?? ''}
                    display={displays[v.name] ?? ''}
                    readOnly={st.readOnly}
                    onChange={(value, display) => {
                      setValues((s) => ({ ...s, [v.name]: value }));
                      if (display !== undefined) setDisplays((s) => ({ ...s, [v.name]: display }));
                    }}
                  />
                  {v.help_text && <p className="mt-1.5 text-xs text-subtle">{v.help_text}</p>}
                </div>
              );
            })}
            {item.show_quantity && (
              <div className="w-32">
                <Label htmlFor="qty">{t('item.quantity')}</Label>
                <Select id="qty" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
                  {(item.quantity_choices?.length ? item.quantity_choices : [1, 2, 3, 4, 5]).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-line pt-5">
              {item.show_price ? <span className="text-lg font-bold tabular-nums">{money.format(total)}</span> : <span />}
              <Button type="submit" variant="primary" className="h-11 px-6 text-sm" loading={order.isPending}>
                {item.submit_label || t('request.submit')}
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

export function ReportPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [summary, setSummary] = useState('');
  const [topic, setTopic] = useState('');
  const topics = useQuery({
    queryKey: ['portal', 'topics'],
    queryFn: async () =>
      (await api.get<{ result: { sys_id: string; name: string; path: string; children?: unknown }[] }>(`${PORTAL}/topics`)).result,
  });
  const flat = useMemo(() => {
    const out: { sys_id: string; label: string }[] = [];
    const walk = (nodes: unknown) => {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes as { sys_id: string; name: string; path?: string; children?: unknown }[]) {
        out.push({ sys_id: n.sys_id, label: n.path || n.name });
        walk(n.children);
      }
    };
    walk(topics.data);
    return out;
  }, [topics.data]);
  const create = useMutation({
    mutationFn: async () =>
      (await api.post<{ result: TicketRow & { message?: string } }>(`${PORTAL}/requests`, { description, short_description: summary || undefined, topic: topic || undefined })).result,
    onSuccess: (r) => {
      toast(r.message || t('request.created', { number: r.number }), 'success');
      navigate(`/portal/ticket/${r.table}/${r.sys_id}`);
    },
    onError: (e: ApiError) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });
  return (
    <div className="mx-auto max-w-3xl">
      <div className="eyebrow">{t('home.eyebrow')}</div>
      <h1 className="display mt-4">{t('nav.report')}</h1>
      <p className="mt-3.5 text-base leading-[1.7] text-muted">{t('report.subtitle')}</p>
      <form
        className="mt-8 space-y-5 rounded-[24px] border border-line bg-surface p-6 shadow-card sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (description.trim()) create.mutate();
        }}
      >
        <div>
          <Label htmlFor="desc" required>
            {t('request.describe')}
          </Label>
          <Textarea id="desc" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="summary">{t('report.title_label')}</Label>
          <Input id="summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </div>
        {flat.length > 0 && (
          <div>
            <Label htmlFor="topic">{t('report.topic')}</Label>
            <Select id="topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">--</option>
              {flat.map((tp) => (
                <option key={tp.sys_id} value={tp.sys_id}>
                  {tp.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex justify-end border-t border-line pt-5">
          <Button type="submit" variant="primary" className="h-11 px-6 text-sm" loading={create.isPending} disabled={!description.trim()}>
            {t('request.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function TicketsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'open';
  const [q, setQ] = useState('');
  const tickets = useTickets(view, q);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title">{t('nav.my_tickets')}</h1>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <Segmented
          value={view}
          onChange={(v) => setParams({ view: v })}
          options={(['open', 'closed', 'all'] as const).map((k) => ({ id: k, label: t(`tickets.view.${k}`) }))}
        />
        <div className="md:ms-auto md:w-80">
          <Input className="h-10" placeholder={t('tickets.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {tickets.isLoading ? <Loading label={t('common.loading')} /> : <TicketList tickets={tickets.data?.tickets ?? []} empty={t('tickets.empty')} />}
    </div>
  );
}

export function TicketView() {
  const { t } = useI18n();
  const { table = '', id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const ticket = useTicket(table, id);
  const [comment, setComment] = useState('');
  const refresh = (data?: TicketPage) => {
    if (data) qc.setQueryData(['portal', 'ticket', table, id], data);
    qc.invalidateQueries({ queryKey: ['portal', 'tickets'] });
    qc.invalidateQueries({ queryKey: ['portal', 'home'] });
  };
  const send = useMutation({
    mutationFn: async () => (await api.post<{ result: TicketPage }>(`${PORTAL}/tickets/${table}/${id}/comment`, { comment })).result,
    onSuccess: (data) => {
      setComment('');
      refresh(data);
    },
    onError: (e: ApiError) => toast(e.message, 'error'),
  });
  const act = useMutation({
    mutationFn: async ({ name, text }: { name: string; text?: string }) =>
      (await api.post<{ result: { message: string; ticket: TicketPage } }>(`${PORTAL}/tickets/${table}/${id}/action/${name}`, { comment: text })).result,
    onSuccess: (r) => {
      toast(r.message, 'success');
      refresh(r.ticket);
    },
    onError: (e: ApiError) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });

  if (ticket.isLoading) return <Loading label={t('common.loading')} />;
  if (!ticket.data) return <NotFound />;
  const tk = ticket.data;
  const steps = tk.timeline.filter((s) => s.status !== 'skipped');
  const current = Math.max(
    steps.findIndex((s) => s.status === 'current'),
    tk.active ? 0 : steps.length - 1,
  );

  return (
    <div className="space-y-6">
      <div>
        <Link to="/portal/tickets" className="micro block w-fit text-subtle hover:text-ink">
          {t('nav.my_tickets')}
        </Link>
        <div className="eyebrow mt-5">
          {tk.module.label} <span className="text-subtle">{tk.number}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <h1 className="max-w-3xl text-[28px] leading-tight font-bold tracking-[-0.02em] sm:text-[32px]">{tk.title}</h1>
          <StateBadge state={tk.header.state} />
        </div>
        <p className="mt-2 text-xs text-subtle">
          {t('ticket.created')} {relativeTime(tk.header.created)} · {t('ticket.updated')} {relativeTime(tk.header.updated)}
        </p>
      </div>
      {steps.length > 1 && (
        <div className="overflow-x-auto rounded-tile border border-line bg-surface px-5 py-4 shadow-card scrollbar-none">
          <Stepper steps={steps.map((s) => ({ id: s.key, label: s.label }))} current={current} />
        </div>
      )}
      {tk.actions.filter((a) => a.name !== 'comment').length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tk.actions
            .filter((a) => a.name !== 'comment')
            .map((a) => (
              <Button
                key={a.name}
                variant={a.style === 'primary' ? 'primary' : 'secondary'}
                loading={act.isPending && act.variables?.name === a.name}
                onClick={() => {
                  const text = a.comment === 'required' ? comment.trim() : undefined;
                  if (a.comment === 'required' && !text) {
                    toast(t('ticket.placeholder'), 'error');
                    return;
                  }
                  act.mutate({ name: a.name, text });
                }}
              >
                {a.label}
              </Button>
            ))}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-6">
          <Card title={t('ticket.tab.details')}>
            <dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2">
              {tk.summary
                .filter((s) => s.display_value)
                .map((s) => (
                  <div key={s.name}>
                    <dt className="micro text-subtle">{s.label}</dt>
                    <dd className="mt-1 text-sm font-semibold">{s.display_value}</dd>
                  </div>
                ))}
              {tk.variables.map((v) => (
                <div key={v.name}>
                  <dt className="micro text-subtle">{v.label}</dt>
                  <dd className="mt-1 text-sm">{v.display_value || v.value}</dd>
                </div>
              ))}
            </dl>
            {tk.description && <p className="border-t border-line px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap text-muted">{tk.description}</p>}
          </Card>
          {tk.attachments.length > 0 && (
            <Card title={t('ticket.tab.attachments')}>
              <ul className="space-y-2 p-5">
                {tk.attachments.map((a) => (
                  <li key={a.sys_id}>
                    <a href={a.download_url} className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">
                      <Paperclip className="size-4" /> {a.file_name}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card title={t('ticket.tab.activity')}>
          <div className="space-y-4 p-5">
            {tk.can_comment && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (comment.trim()) send.mutate();
                }}
                className="space-y-2"
              >
                <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('ticket.placeholder')} />
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" size="sm" icon={<Send className="size-3.5 rtl:-scale-x-100" />} loading={send.isPending} disabled={!comment.trim()}>
                    {t('action.send')}
                  </Button>
                </div>
              </form>
            )}
            {tk.activity.length === 0 && <p className="text-sm text-muted">{t('ticket.no_activity')}</p>}
            <ol className="space-y-3">
              {tk.activity.map((c) => (
                <li key={c.sys_id} className={cx('flex', c.is_me ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cx(
                      'max-w-[85%] rounded-tile px-3.5 py-2.5 text-sm leading-relaxed',
                      c.is_me ? 'bg-brand-50 text-ink dark:bg-brand-500/15' : 'border border-line bg-raised',
                    )}
                  >
                    <div className="mb-1 text-[11px] text-subtle">
                      <span className="font-semibold text-muted">{c.user_name}</span> · {relativeTime(c.created_on)}
                    </div>
                    <p className="whitespace-pre-wrap">{c.value}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function TodosPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const approvals = useApprovals();
  const [reason, setReason] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'approve' | 'reject' }) => api.post(`${PORTAL}/approvals/${id}/${verb}`, { comment: reason[id] || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portal'] });
    },
    onError: (e: ApiError) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });
  if (approvals.isLoading) return <Loading label={t('common.loading')} />;
  const list = approvals.data?.approvals ?? [];
  return (
    <div className="space-y-6">
      <h1 className="section-title">{t('nav.todos')}</h1>
      <SectionHeader title={t('todos.approvals')} aside={`${list.length}`} />
      {list.length === 0 ? (
        <Empty title={t('todos.empty')} icon={<CheckCircle2 className="size-5" />} />
      ) : (
        <div className="space-y-4">
          {list.map((a) => (
            <div key={a.sys_id} className="rounded-card border border-line bg-surface p-5 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="micro text-accent">{a.target.number}</span>
                    <span className="text-xs text-subtle">{a.target.table_label}</span>
                  </div>
                  <p className="mt-1 text-[15px] font-semibold">{a.target.title}</p>
                  <p className="mt-1 text-xs text-subtle">
                    {a.target.requested_for?.display_value} · {relativeTime(a.created)}
                  </p>
                </div>
                {a.target.price && <Chip>{a.target.price}</Chip>}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Input
                  className="h-9 min-w-48 flex-1"
                  placeholder={t('approvals.reject_reason')}
                  value={reason[a.sys_id] ?? ''}
                  onChange={(e) => setReason((s) => ({ ...s, [a.sys_id]: e.target.value }))}
                />
                <Button
                  variant="secondary"
                  icon={<XCircle className="size-4" />}
                  loading={decide.isPending && decide.variables?.id === a.sys_id && decide.variables.verb === 'reject'}
                  onClick={() => {
                    if (!reason[a.sys_id]?.trim()) {
                      toast(t('approvals.reject_reason'), 'error');
                      return;
                    }
                    decide.mutate({ id: a.sys_id, verb: 'reject' });
                  }}
                >
                  {t('approvals.reject')}
                </Button>
                <Button
                  variant="primary"
                  icon={<CheckCircle2 className="size-4" />}
                  loading={decide.isPending && decide.variables?.id === a.sys_id && decide.variables.verb === 'approve'}
                  onClick={() => decide.mutate({ id: a.sys_id, verb: 'approve' })}
                >
                  {t('approvals.approve')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
