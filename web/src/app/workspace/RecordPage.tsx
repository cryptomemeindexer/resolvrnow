import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, MoreHorizontal, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Activity } from '../../components/Activity';
import { DataTable } from '../../components/DataTable';
import { FieldEditor } from '../../components/fields/FieldEditor';
import { Badge, Button, Card, cx, Empty, Label, Loading, Modal, Tabs, useToast, ValueBadge } from '../../components/ui';
import { api, type ColumnInfo, type FieldValue, fv, type RecordPayload, type RelatedList, type TableMeta, type UiAction } from '../../lib/api';
import { evaluate } from '../../lib/encoded';

const JOURNAL = new Set(['journal', 'journal_input', 'journal_list']);

export function useTableMeta(table: string) {
  return useQuery({
    queryKey: ['meta', table],
    queryFn: async () => (await api.get<{ result: TableMeta }>(`/api/app/meta/${table}`)).result,
    staleTime: 300_000,
  });
}

interface FieldState {
  mandatory: boolean;
  visible: boolean;
  readOnly: boolean;
}

/** Applies UI policies (in order) to the dictionary defaults for each field. */
function fieldStates(meta: TableMeta, values: Record<string, FieldValue>, canWrite: boolean): Record<string, FieldState> {
  const out: Record<string, FieldState> = {};
  for (const [name, c] of Object.entries(meta.columns)) {
    out[name] = { mandatory: c.mandatory, visible: c.canRead, readOnly: !canWrite || c.readOnly || !c.canWrite };
  }
  const policies = [...meta.uiPolicies].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const p of policies) {
    const ok = evaluate(p.condition, values);
    if (!ok && !p.reverseIfFalse) continue;
    for (const a of p.actions) {
      const s = out[a.field];
      if (!s) continue;
      if (a.mandatory !== undefined) s.mandatory = ok ? a.mandatory : !a.mandatory && s.mandatory;
      if (a.visible !== undefined) s.visible = ok ? a.visible : !a.visible;
      if (a.readOnly !== undefined && canWrite) s.readOnly = ok ? a.readOnly : !a.readOnly && s.readOnly;
    }
  }
  return out;
}

function Field({
  meta,
  name,
  values,
  states,
  onChange,
  errors,
}: {
  meta: TableMeta;
  name: string;
  values: Record<string, FieldValue>;
  states: Record<string, FieldState>;
  onChange: (name: string, v: FieldValue) => void;
  errors: Set<string>;
}) {
  const col: ColumnInfo | undefined = meta.columns[name];
  const st = states[name];
  if (!col || !st?.visible || JOURNAL.has(col.type)) return null;
  const id = `f-${name}`;
  return (
    <div>
      <Label htmlFor={id} required={st.mandatory && !st.readOnly} hint={col.hint}>
        {col.label}
      </Label>
      <FieldEditor
        id={id}
        table={meta.name}
        col={col}
        value={fv(values[name])}
        onChange={(v) => onChange(name, v)}
        readOnly={st.readOnly}
        invalid={errors.has(name)}
        dependentValue={col.dependentOn ? fv(values[col.dependentOn]).value : undefined}
      />
    </div>
  );
}

function RelatedListPanel({ table, sysId, rl }: { table: string; sysId: string; rl: RelatedList }) {
  const navigate = useNavigate();
  const childMeta = useTableMeta(rl.table);
  const q = useQuery({
    queryKey: ['related', table, sysId, rl.table, rl.field, rl.query],
    queryFn: async () => {
      const params = new URLSearchParams({ child: rl.table });
      if (rl.field) params.set('field', rl.field);
      if (rl.query) params.set('query', rl.query);
      if (rl.columns) params.set('columns', rl.columns.join(','));
      if (rl.via) {
        params.set('via_table', rl.via.table);
        params.set('via_parent', rl.via.parentField);
        params.set('via_child', rl.via.childField);
      }
      return (
        await api.get<{ result: { total: number; columns: string[]; rows: { sys_id: string; table: string; values: Record<string, FieldValue> }[] } }>(
          `/api/app/related/${table}/${sysId}?${params}`,
        )
      ).result;
    },
  });
  if (q.isLoading || childMeta.isLoading) return <Loading />;
  if (!q.data || !childMeta.data) return <Empty title="Unable to load" />;
  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs text-muted">{q.data.total} record(s)</span>
        {rl.field && childMeta.data.canCreate && (
          <Button size="sm" onClick={() => navigate(`/workspace/record/${rl.table}/-1?sysparm_query=${rl.field}=${sysId}`)}>
            New
          </Button>
        )}
      </div>
      <Card>
        <DataTable
          columns={q.data.columns}
          meta={childMeta.data.columns}
          rows={q.data.rows}
          onOpen={(r) => navigate(`/workspace/record/${r.table ?? rl.table}/${r.sys_id}`)}
          emptyState={<Empty title="No records" />}
        />
      </Card>
    </div>
  );
}

export function RecordPage() {
  const { table = '', sysId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = sysId === '-1';
  const metaQ = useTableMeta(table);
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const recQ = useQuery({
    queryKey: ['record', table, sysId, search],
    queryFn: async () => (await api.get<{ result: RecordPayload }>(`/api/app/record/${table}/${sysId}${search}`)).result,
  });
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<string>('activity');
  const [pending, setPending] = useState<UiAction | null>(null);
  const [promptValues, setPromptValues] = useState<Record<string, FieldValue>>({});

  useEffect(() => {
    if (!recQ.data) return;
    const v: Record<string, FieldValue> = {};
    for (const [k, val] of Object.entries(recQ.data.values)) v[k] = fv(val);
    setValues(v);
    setDirty(new Set());
    setErrors(new Set());
  }, [recQ.data]);

  const meta = metaQ.data;
  const rec = recQ.data;
  const canWrite = !!rec?.can_write;
  const states = useMemo(() => (meta ? fieldStates(meta, values, canWrite) : {}), [meta, values, canWrite]);

  const changes = () => {
    const out: Record<string, string> = {};
    for (const f of dirty) out[f] = values[f]?.value ?? '';
    return out;
  };

  const validate = (): boolean => {
    if (!meta) return false;
    const missing = new Set<string>();
    for (const [name, st] of Object.entries(states)) {
      const col = meta.columns[name];
      if (!col || JOURNAL.has(col.type) || !st.visible || st.readOnly || !st.mandatory) continue;
      if (!values[name]?.value) missing.add(name);
    }
    setErrors(missing);
    if (missing.size) toast(`Fill in mandatory fields: ${[...missing].map((m) => meta.columns[m].label).join(', ')}`, 'error');
    return missing.size === 0;
  };

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const body: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) if (v.value && meta?.columns[k] && !meta.columns[k].readOnly) body[k] = v.value;
        for (const f of dirty) body[f] = values[f]?.value ?? '';
        return api.post<{ result: Record<string, string> }>(`/api/now/table/${table}`, body);
      }
      return api.patch<{ result: Record<string, string> }>(`/api/now/table/${table}/${sysId}`, changes());
    },
    onSuccess: (r) => {
      toast(isNew ? `${meta?.label ?? 'Record'} created` : 'Saved', 'success');
      qc.invalidateQueries({ queryKey: ['record', table] });
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['activity', table, sysId] });
      if (isNew && r?.result?.sys_id) navigate(`/workspace/record/${table}/${r.result.sys_id}`, { replace: true });
    },
    onError: (e: Error & { detail?: string }) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/api/now/table/${table}/${sysId}`),
    onSuccess: () => {
      toast('Record deleted', 'success');
      qc.invalidateQueries({ queryKey: ['list'] });
      navigate(-1);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const runAction = useMutation({
    mutationFn: async ({ action, input }: { action: UiAction; input: Record<string, string> }) =>
      (
        await api.post<{ result: { message?: string; error?: string; redirect?: string; messages?: { type: string; text: string }[] } }>(
          `/api/app/action/${table}/${sysId}/${action.id}`,
          { values: action.saveFirst ? changes() : {}, input },
        )
      ).result,
    onSuccess: (r) => {
      setPending(null);
      if (r.error) toast(r.error, 'error');
      else if (r.message) toast(r.message, 'success');
      for (const m of r.messages ?? []) toast(m.text, m.type === 'error' ? 'error' : 'info');
      qc.invalidateQueries({ queryKey: ['record', table] });
      qc.invalidateQueries({ queryKey: ['activity', table, sysId] });
      qc.invalidateQueries({ queryKey: ['related', table, sysId] });
      qc.invalidateQueries({ queryKey: ['list'] });
      if (r.redirect) navigate(r.redirect);
    },
    onError: (e: Error & { detail?: string }) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });

  if (metaQ.isLoading || recQ.isLoading) return <Loading />;
  if (metaQ.error || recQ.error || !meta || !rec) {
    return <Empty title="Record not found">{(recQ.error as Error)?.message ?? 'It may have been deleted or you may not have access.'}</Empty>;
  }

  const onChange = (name: string, v: FieldValue) => {
    setValues((s) => ({ ...s, [name]: v }));
    setDirty((d) => new Set(d).add(name));
    setErrors((e) => {
      const n = new Set(e);
      n.delete(name);
      return n;
    });
  };

  const startAction = (a: UiAction) => {
    if (a.saveFirst && !validate()) return;
    if (a.prompt?.length || a.confirm) {
      const pv: Record<string, FieldValue> = {};
      for (const p of a.prompt ?? []) pv[p.field] = fv(values[p.field]);
      setPromptValues(pv);
      setPending(a);
      return;
    }
    runAction.mutate({ action: a, input: {} });
  };

  const highlights = meta.form.highlights ?? ['state', 'priority', 'assigned_to'].filter((f) => meta.columns[f]);
  const related = rec.related ?? [];
  const tabs = [{ id: 'activity', label: 'Activity' }, ...related.map((r, i) => ({ id: `rl${i}`, label: r.label ?? r.table }))];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4 lg:px-6">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <button type="button" onClick={() => navigate(-1)} className="mt-1 rounded-lg p-1.5 text-muted hover:bg-raised" aria-label="Back">
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">{meta.label}</div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            <span>{rec.display_value}</span>
            {!isNew && values.short_description?.value && <span className="truncate font-normal text-muted">{values.short_description.value}</span>}
          </h1>
          {!isNew && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {highlights.map((h) => {
                const v = fv(values[h]);
                if (!v.display_value) return null;
                const badge = <ValueBadge field={h} value={v.value} display={v.display_value} />;
                return (
                  <span key={h} className="inline-flex items-center gap-1 text-xs text-muted">
                    {badge ?? (
                      <Badge>
                        {meta.columns[h]?.label}: {v.display_value}
                      </Badge>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rec.actions
            .filter((a) => a.style === 'primary')
            .map((a) => (
              <Button key={a.id} variant="primary" onClick={() => startAction(a)} loading={runAction.isPending && runAction.variables?.action.id === a.id}>
                {a.label}
              </Button>
            ))}
          {rec.actions
            .filter((a) => a.style !== 'primary')
            .map((a) => (
              <Button key={a.id} variant={a.style === 'destructive' ? 'danger' : 'secondary'} onClick={() => startAction(a)}>
                {a.label}
              </Button>
            ))}
          {canWrite && (
            <Button
              variant={rec.actions.some((a) => a.style === 'primary') ? 'secondary' : 'primary'}
              icon={<Save className="size-4" />}
              loading={save.isPending}
              disabled={!isNew && dirty.size === 0}
              onClick={() => validate() && save.mutate()}
            >
              {isNew ? 'Submit' : 'Save'}
            </Button>
          )}
          {!isNew && (
            <details className="relative">
              <summary className="list-none rounded-lg border border-line p-2 text-muted hover:bg-raised [&::-webkit-details-marker]:hidden" aria-label="More">
                <MoreHorizontal className="size-4" />
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-line bg-surface py-1 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-raised"
                  onClick={() => navigator.clipboard.writeText(window.location.href)}
                >
                  <Copy className="size-3.5" /> Copy link
                </button>
                <Link className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-raised" to={`/workspace/list/sys_audit?query=documentkey=${sysId}^ORDERBYDESCsys_created_on`}>
                  History
                </Link>
                {rec.can_delete && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-raised"
                    onClick={() => window.confirm('Delete this record permanently?') && del.mutate()}
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </button>
                )}
              </div>
            </details>
          )}
        </div>
      </div>

      <div className={cx('grid gap-5', !isNew && 'xl:grid-cols-[minmax(0,1fr)_420px]')}>
        <div className="space-y-4">
          {meta.form.sections.map((s, i) => {
            const fields = s.fields ?? [];
            const left = s.left ?? [];
            const right = s.right ?? [];
            const visible = [...fields, ...left, ...right].some((f) => states[f]?.visible && meta.columns[f] && !JOURNAL.has(meta.columns[f].type));
            if (!visible) return null;
            return (
              <Card key={i} title={s.caption}>
                <div className="space-y-4 p-4">
                  {(left.length > 0 || right.length > 0) && (
                    <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
                      <div className="space-y-4">
                        {left.map((f) => (
                          <Field key={f} meta={meta} name={f} values={values} states={states} onChange={onChange} errors={errors} />
                        ))}
                      </div>
                      <div className="space-y-4">
                        {right.map((f) => (
                          <Field key={f} meta={meta} name={f} values={values} states={states} onChange={onChange} errors={errors} />
                        ))}
                      </div>
                    </div>
                  )}
                  {fields.map((f) => (
                    <Field key={f} meta={meta} name={f} values={values} states={states} onChange={onChange} errors={errors} />
                  ))}
                </div>
              </Card>
            );
          })}
          {!isNew && related.length > 0 && (
            <div className="xl:hidden">
              <Tabs tabs={tabs} value={tab} onChange={setTab} />
            </div>
          )}
          {!isNew &&
            related.map((rl, i) => (
              <div key={`${rl.table}-${i}`} className={cx(tab === `rl${i}` ? 'block' : 'hidden xl:block')}>
                <h3 className="mb-2 mt-2 text-sm font-semibold">{rl.label ?? rl.table}</h3>
                <RelatedListPanel table={table} sysId={sysId} rl={rl} />
              </div>
            ))}
        </div>
        {!isNew && (
          <aside className={cx(tab === 'activity' ? 'block' : 'hidden xl:block')}>
            <div className="xl:sticky xl:top-4">
              <h3 className="mb-2 text-sm font-semibold">Activity</h3>
              <Activity table={table} sysId={sysId} canWrite={canWrite} />
            </div>
          </aside>
        )}
      </div>

      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending?.label ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant={pending?.style === 'destructive' ? 'danger' : 'primary'}
              loading={runAction.isPending}
              onClick={() => {
                if (!pending) return;
                const missing = (pending.prompt ?? []).filter((p) => p.mandatory && !promptValues[p.field]?.value);
                if (missing.length) {
                  toast(`Required: ${missing.map((m) => m.label ?? meta.columns[m.field]?.label ?? m.field).join(', ')}`, 'error');
                  return;
                }
                const input: Record<string, string> = {};
                for (const [k, v] of Object.entries(promptValues)) input[k] = v.value;
                runAction.mutate({ action: pending, input });
              }}
            >
              {pending?.label}
            </Button>
          </>
        }
      >
        {pending?.confirm && <p className="mb-3 text-sm text-muted">{pending.confirm}</p>}
        <div className="space-y-4">
          {(pending?.prompt ?? []).map((p) => {
            const col = meta.columns[p.field] ?? ({ name: p.field, label: p.label ?? p.field, type: 'multi_two_lines', mandatory: false, readOnly: false, canRead: true, canWrite: true, reference: null, referenceQual: null, dependentOn: null, choiceMode: null, hint: null, maxLength: null, definedOn: table } as ColumnInfo);
            return (
              <div key={p.field}>
                <Label required={p.mandatory}>{p.label ?? col.label}</Label>
                <FieldEditor
                  table={table}
                  col={JOURNAL.has(col.type) ? { ...col, type: 'multi_two_lines' } : col}
                  value={fv(promptValues[p.field])}
                  onChange={(v) => setPromptValues((s) => ({ ...s, [p.field]: v }))}
                  dependentValue={col.dependentOn ? (promptValues[col.dependentOn]?.value ?? fv(values[col.dependentOn]).value) : undefined}
                />
              </div>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}
