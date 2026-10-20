import { useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { X } from 'lucide-react';
import { useState } from 'react';
import { api, type Choice, type ColumnInfo, type FieldValue } from '../../lib/api';
import { Input, Select, Textarea } from '../ui';
import { ReferencePicker } from './ReferencePicker';

const DATE_TYPES = new Set(['glide_date_time', 'due_date']);
const NUMBER_TYPES = new Set(['integer', 'decimal', 'float', 'currency', 'price', 'percent_complete']);
const MULTILINE = new Set(['multi_two_lines', 'journal_input', 'journal', 'conditions', 'json', 'name_values']);

/** Converts stored UTC `YYYY-MM-DD HH:MM:SS` to the value of an <input type="datetime-local"> in local time. */
function toLocalInput(glide: string): string {
  if (!glide) return '';
  const d = new Date(`${glide.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function fromLocalInput(v: string): string {
  if (!v) return '';
  const d = new Date(v);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function durationParts(ms: number) {
  const s = Math.floor(ms / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60) };
}

function useChoices(table: string, col: ColumnInfo, dependentValue: string | undefined) {
  const needsFetch = !!col.dependentOn;
  const q = useQuery({
    queryKey: ['choices', table, col.name, dependentValue ?? ''],
    enabled: needsFetch,
    queryFn: async () =>
      (await api.get<{ result: Choice[] }>(`/api/app/choices/${table}/${col.name}${dependentValue ? `?dependent=${encodeURIComponent(dependentValue)}` : ''}`)).result,
    staleTime: 300_000,
  });
  if (!needsFetch) return col.choices ?? [];
  return q.data ?? col.choices ?? [];
}

export interface FieldEditorProps {
  table: string;
  col: ColumnInfo;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  readOnly?: boolean;
  invalid?: boolean;
  /** Current value of the field this one depends on (choice dependencies). */
  dependentValue?: string;
  id?: string;
}

/** Input control for a dictionary field, chosen by type. */
export function FieldEditor({ table, col, value, onChange, readOnly, invalid, dependentValue, id }: FieldEditorProps) {
  const set = (v: string, d = v) => onChange({ value: v, display_value: d });
  const choices = useChoices(table, col, dependentValue);

  if (choices.length > 0 && col.type !== 'boolean') {
    const none = col.choiceMode !== 'dropdown_without_none';
    return (
      <Select id={id} disabled={readOnly} invalid={invalid} value={value.value} onChange={(e) => set(e.target.value, e.target.selectedOptions[0]?.text ?? '')}>
        {(none || !value.value) && <option value="">-- None --</option>}
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
        {value.value && !choices.some((c) => c.value === value.value) && <option value={value.value}>{value.display_value || value.value}</option>}
      </Select>
    );
  }

  switch (col.type) {
    case 'boolean':
      return (
        <label className="inline-flex h-9 items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            className="size-4 rounded border-line accent-brand-600"
            disabled={readOnly}
            checked={value.value === 'true' || value.value === '1'}
            onChange={(e) => set(e.target.checked ? 'true' : 'false')}
          />
          <span className="text-muted">{value.value === 'true' ? 'Yes' : 'No'}</span>
        </label>
      );
    case 'reference':
      return (
        <ReferencePicker
          id={id}
          table={col.reference ?? 'sys_user'}
          qualifier={col.referenceQual}
          disabled={readOnly}
          invalid={invalid}
          value={{ value: value.value, display_value: value.display_value }}
          onChange={(v) => onChange(v)}
        />
      );
    case 'glide_list':
      return <ListEditor table={col.reference ?? 'sys_user'} value={value} onChange={onChange} readOnly={readOnly} />;
    case 'glide_date':
      return <Input id={id} type="date" disabled={readOnly} invalid={invalid} value={value.value?.slice(0, 10) ?? ''} onChange={(e) => set(e.target.value)} />;
    case 'glide_time':
      return <Input id={id} type="time" disabled={readOnly} invalid={invalid} value={value.value?.slice(11, 16) ?? ''} onChange={(e) => set(`1970-01-01 ${e.target.value}:00`)} />;
    case 'glide_duration': {
      const ms = value.value ? new Date(`${value.value.replace(' ', 'T')}Z`).getTime() : 0;
      const p = durationParts(Number.isNaN(ms) ? 0 : ms);
      const update = (d: number, h: number, m: number) => {
        const total = ((d * 24 + h) * 60 + m) * 60000;
        set(new Date(total).toISOString().replace('T', ' ').slice(0, 19), `${d}d ${h}h ${m}m`);
      };
      return (
        <div className="flex items-center gap-1.5 text-sm">
          {(['d', 'h', 'm'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                disabled={readOnly}
                className="w-16"
                value={p[k]}
                onChange={(e) => update(k === 'd' ? +e.target.value : p.d, k === 'h' ? +e.target.value : p.h, k === 'm' ? +e.target.value : p.m)}
              />
              <span className="text-muted">{k}</span>
            </label>
          ))}
        </div>
      );
    }
    case 'html':
    case 'translated_html':
      return readOnly ? (
        <div className="prose-app rounded-lg border border-line bg-raised p-3" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value.value) }} />
      ) : (
        <Textarea id={id} rows={8} invalid={invalid} value={value.value} onChange={(e) => set(e.target.value)} className="font-mono text-xs" />
      );
    case 'script':
      return (
        <Textarea
          id={id}
          rows={10}
          spellCheck={false}
          disabled={readOnly}
          value={value.value}
          onChange={(e) => set(e.target.value)}
          className="font-mono text-xs leading-relaxed"
        />
      );
    case 'password2':
      return <Input id={id} type="password" autoComplete="new-password" disabled={readOnly} placeholder="Unchanged" value={value.value} onChange={(e) => set(e.target.value)} />;
    default:
      if (DATE_TYPES.has(col.type)) {
        return <Input id={id} type="datetime-local" disabled={readOnly} invalid={invalid} value={toLocalInput(value.value)} onChange={(e) => set(fromLocalInput(e.target.value))} />;
      }
      if (NUMBER_TYPES.has(col.type)) {
        return <Input id={id} type="number" step={col.type === 'integer' ? 1 : 'any'} disabled={readOnly} invalid={invalid} value={value.value} onChange={(e) => set(e.target.value)} />;
      }
      if (MULTILINE.has(col.type) || (col.maxLength ?? 0) > 255 || col.name === 'description') {
        return <Textarea id={id} rows={4} disabled={readOnly} invalid={invalid} value={value.value} onChange={(e) => set(e.target.value)} />;
      }
      return (
        <Input
          id={id}
          type={col.type === 'email' ? 'email' : col.type === 'url' ? 'url' : 'text'}
          disabled={readOnly}
          invalid={invalid}
          maxLength={col.maxLength ?? undefined}
          value={value.value}
          onChange={(e) => set(e.target.value)}
        />
      );
  }
}

/** Multi-reference chips for glide_list fields (watch lists etc.). */
function ListEditor({ table, value, onChange, readOnly }: { table: string; value: FieldValue; onChange: (v: FieldValue) => void; readOnly?: boolean }) {
  const ids = value.value ? value.value.split(',').filter(Boolean) : [];
  const labels = value.display_value ? value.display_value.split(', ') : [];
  const [adding, setAdding] = useState(false);
  const remove = (i: number) => {
    const nid = ids.filter((_, j) => j !== i);
    const nl = labels.filter((_, j) => j !== i);
    onChange({ value: nid.join(','), display_value: nl.join(', ') });
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1">
      {ids.map((id, i) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-xs">
          {labels[i] ?? id}
          {!readOnly && (
            <button type="button" aria-label="Remove" onClick={() => remove(i)} className="text-subtle hover:text-ink">
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly &&
        (adding ? (
          <div className="min-w-48 flex-1">
            <ReferencePicker
              table={table}
              value={{ value: '', display_value: '' }}
              onChange={(v) => {
                if (v.value && !ids.includes(v.value)) onChange({ value: [...ids, v.value].join(','), display_value: [...labels, v.display_value].join(', ') });
                setAdding(false);
              }}
            />
          </div>
        ) : (
          <button type="button" className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setAdding(true)}>
            + Add
          </button>
        ))}
    </div>
  );
}
