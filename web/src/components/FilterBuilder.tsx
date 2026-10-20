import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ColumnInfo, TableMeta } from '../lib/api';
import { type Cond, DATE_PRESETS, DYNAMIC_ME, DYNAMIC_MY_GROUPS, operatorsFor, type ParsedQuery, parseQuery, stringifyQuery } from '../lib/encoded';
import { ReferencePicker } from './fields/ReferencePicker';
import { Button, Input, Select } from './ui';

function blankCond(meta: TableMeta): Cond {
  const first = meta.list.columns.find((c) => meta.columns[c]) ?? Object.keys(meta.columns)[0];
  return { field: first, op: '=', value: '' };
}

function ValueInput({ meta, col, cond, onChange }: { meta: TableMeta; col?: ColumnInfo; cond: Cond; onChange: (v: string) => void }) {
  const ops = col ? operatorsFor(col.type, !!col.choices?.length) : [];
  const def = ops.find((o) => o.op === cond.op);
  if (!col || !def || def.input === 'none') return null;
  if (def.input === 'date') {
    return (
      <Select value={cond.value} onChange={(e) => onChange(e.target.value)} className="w-48">
        <option value="">Choose…</option>
        {DATE_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </Select>
    );
  }
  if (def.input === 'two') {
    const [a = '', b = ''] = cond.value.split('@');
    return (
      <div className="flex items-center gap-1">
        <Input className="w-32" value={a} onChange={(e) => onChange(`${e.target.value}@${b}`)} />
        <span className="text-muted">and</span>
        <Input className="w-32" value={b} onChange={(e) => onChange(`${a}@${e.target.value}`)} />
      </div>
    );
  }
  if (col.type === 'boolean') {
    return (
      <Select value={cond.value} onChange={(e) => onChange(e.target.value)} className="w-28">
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  }
  if (col.choices?.length && def.input === 'single') {
    return (
      <Select value={cond.value} onChange={(e) => onChange(e.target.value)} className="w-48">
        <option value="">-- None --</option>
        {col.choices
          .filter((c, i, all) => all.findIndex((x) => x.value === c.value) === i)
          .map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
      </Select>
    );
  }
  if (col.type === 'reference' && cond.op === 'DYNAMIC') {
    return (
      <Select value={cond.value} onChange={(e) => onChange(e.target.value)} className="w-48">
        <option value={DYNAMIC_ME}>Me</option>
        <option value={DYNAMIC_MY_GROUPS}>One of My Groups</option>
      </Select>
    );
  }
  if (col.type === 'reference' && (cond.op === '=' || cond.op === '!=') && col.reference) {
    return (
      <div className="w-56">
        <ReferencePicker table={col.reference} value={{ value: cond.value, display_value: cond.value }} onChange={(v) => onChange(v.value)} />
      </div>
    );
  }
  return <Input className="w-56" value={cond.value} onChange={(e) => onChange(e.target.value)} placeholder={def.input === 'list' ? 'a,b,c' : ''} />;
}

/** Visual editor for encoded queries: OR-groups of AND conditions. */
export function FilterBuilder({ meta, query, onApply }: { meta: TableMeta; query: string; onApply: (q: string) => void }) {
  const [model, setModel] = useState<ParsedQuery>(() => parseQuery(query));
  useEffect(() => setModel(parseQuery(query)), [query]);
  const fields = Object.values(meta.columns)
    .filter((c) => c.canRead && c.type !== 'journal_input' && c.type !== 'journal' && c.type !== 'password2')
    .sort((a, b) => a.label.localeCompare(b.label));

  const update = (bi: number, ci: number, oi: number, patch: Partial<Cond>) =>
    setModel((m) => {
      const blocks = m.blocks.map((b) => b.map((cl) => cl.map((c) => ({ ...c }))));
      Object.assign(blocks[bi][ci][oi], patch);
      return { ...m, blocks };
    });
  const removeCond = (bi: number, ci: number, oi: number) =>
    setModel((m) => {
      const blocks = m.blocks.map((b) => b.map((cl) => [...cl]));
      blocks[bi][ci].splice(oi, 1);
      if (blocks[bi][ci].length === 0) blocks[bi].splice(ci, 1);
      return { ...m, blocks: blocks.filter((b) => b.length) };
    });
  const addAnd = (bi: number) =>
    setModel((m) => {
      const blocks = m.blocks.map((b) => [...b]);
      if (!blocks[bi]) blocks[bi] = [];
      blocks[bi].push([blankCond(meta)]);
      return { ...m, blocks };
    });
  const addOr = (bi: number, ci: number) =>
    setModel((m) => {
      const blocks = m.blocks.map((b) => b.map((cl) => [...cl]));
      blocks[bi][ci].push(blankCond(meta));
      return { ...m, blocks };
    });

  return (
    <div className="space-y-3">
      {model.blocks.length === 0 && <p className="text-sm text-muted">No conditions. All records are shown.</p>}
      {model.blocks.map((block, bi) => (
        <div key={bi} className="space-y-2 rounded-lg border border-line p-3">
          {bi > 0 && <div className="text-xs font-semibold uppercase text-gold-600">or</div>}
          {block.map((cluster, ci) =>
            cluster.map((cond, oi) => {
              const col = meta.columns[cond.field.split('.')[0]];
              const ops = col ? operatorsFor(col.type, !!col.choices?.length) : [];
              return (
                <div key={`${ci}-${oi}`} className="flex flex-wrap items-center gap-2">
                  <span className="w-10 text-right text-xs font-medium text-muted">{ci === 0 && oi === 0 ? 'Where' : oi > 0 ? 'or' : 'and'}</span>
                  <Select className="w-52" value={cond.field} onChange={(e) => update(bi, ci, oi, { field: e.target.value, op: '=', value: '' })}>
                    {!col && <option value={cond.field}>{cond.field}</option>}
                    {fields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <Select className="w-44" value={cond.op} onChange={(e) => update(bi, ci, oi, { op: e.target.value, value: '' })}>
                    {!ops.some((o) => o.op === cond.op) && <option value={cond.op}>{cond.op}</option>}
                    {ops.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <ValueInput meta={meta} col={col} cond={cond} onChange={(value) => update(bi, ci, oi, { value })} />
                  <Button size="sm" variant="ghost" onClick={() => addOr(bi, ci)}>
                    OR
                  </Button>
                  <button type="button" aria-label="Remove condition" className="rounded p-1 text-subtle hover:text-red-600" onClick={() => removeCond(bi, ci, oi)}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
              );
            }),
          )}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => addAnd(bi)}>
            AND condition
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => addAnd(model.blocks.length)}>
          {model.blocks.length ? 'New OR group' : 'Add condition'}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setModel({ blocks: [], orderBy: model.orderBy })}>
          Clear
        </Button>
        <Button size="sm" variant="primary" onClick={() => onApply(stringifyQuery(model))}>
          Run filter
        </Button>
      </div>
      <code className="block break-all rounded bg-raised px-2 py-1 font-mono text-[11px] text-muted">{stringifyQuery(model) || '(empty query)'}</code>
    </div>
  );
}
