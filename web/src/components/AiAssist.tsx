import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ApiError, type FieldValue } from '../lib/api';
import { Button, Card, cx, Modal, useToast } from './ui';

/** Predictions, similar records, suggested articles and generative skills for a record (the ai module). */

interface Prediction {
  field: string;
  field_label: string;
  current_value: string;
  value: string;
  display_value: string;
  confidence: number;
  above_threshold?: boolean;
}
interface Ref {
  table?: string;
  sys_id: string;
  number?: string;
  title?: string;
  short_description?: string;
}
interface Recommendations {
  predictions: Prediction[];
  similar_records: Ref[];
  knowledge: Ref[];
}
interface Skill {
  id: string;
  label: string;
  allowed: boolean;
  table: string;
  needs_record: boolean;
}
interface SkillResult {
  label: string;
  text: string;
  provider: string;
  status: string;
}

const SKILLS = ['incident_summarization', 'resolution_notes_generation', 'email_response_generation'];

export function AiAssist({ table, sysId, values, onApply }: { table: string; sysId: string; values: Record<string, FieldValue>; onApply: (field: string, v: FieldValue) => void }) {
  const toast = useToast();
  const [result, setResult] = useState<SkillResult | null>(null);
  const recs = useQuery({
    queryKey: ['ai-recs', table, sysId],
    retry: false,
    queryFn: async () => (await api.get<{ result: Recommendations }>(`/api/app/ai/recommendations/${table}/${sysId}`)).result,
  });
  const skills = useQuery({
    queryKey: ['ai-skills'],
    retry: false,
    staleTime: 300_000,
    queryFn: async () => (await api.get<{ result: Skill[] }>('/api/app/ai/skills')).result,
  });
  const run = useMutation({
    mutationFn: async (skill: string) => (await api.post<{ result: SkillResult }>(`/api/app/ai/skills/${skill}`, { table, sys_id: sysId })).result,
    onSuccess: setResult,
    onError: (e: ApiError) => toast(e.detail ? `${e.message}: ${e.detail}` : e.message, 'error'),
  });
  if (recs.isError || !recs.data) return null;
  const r = recs.data;
  // Only suggestions the model is confident about (above its solution's threshold) are offered.
  const predictions = r.predictions.filter((p) => p.above_threshold !== false && p.value && p.value !== (values[p.field]?.value ?? p.current_value));
  const available = (skills.data ?? []).filter((s) => s.allowed && s.needs_record && SKILLS.includes(s.id) && (s.table === table || s.table === 'task'));
  const insights = predictions.length > 0 || r.similar_records.length > 0 || r.knowledge.length > 0;
  if (!insights && !available.length) return null;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-brand-500" /> AI assist
        </span>
      }
    >
      <div className="space-y-4 p-5 text-[13px]">
        {predictions.length > 0 && (
          <div className="space-y-2">
            <p className="micro text-subtle">Suggested values</p>
            {predictions.map((p) => (
              <div key={p.field} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    <span className="text-muted">{p.field_label}:</span> <b>{p.display_value}</b>
                  </p>
                  <p className="text-[11px] text-subtle">{Math.round(p.confidence)}% confidence</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => onApply(p.field, { value: p.value, display_value: p.display_value })}>
                  Apply
                </Button>
              </div>
            ))}
          </div>
        )}
        {r.similar_records.length > 0 && (
          <div>
            <p className="micro mb-1.5 text-subtle">Similar tickets</p>
            {r.similar_records.slice(0, 4).map((s) => (
              <Link key={s.sys_id} to={`/workspace/record/${s.table ?? table}/${s.sys_id}`} className="block truncate rounded-md py-1 hover:text-accent">
                <span className="micro me-2 text-accent">{s.number}</span>
                {s.title ?? s.short_description}
              </Link>
            ))}
          </div>
        )}
        {r.knowledge.length > 0 && (
          <div>
            <p className="micro mb-1.5 text-subtle">Suggested articles</p>
            {r.knowledge.slice(0, 3).map((k) => (
              <Link key={k.sys_id} to={`/workspace/record/kb_knowledge/${k.sys_id}`} className="block truncate rounded-md py-1 hover:text-accent">
                {k.title ?? k.short_description}
              </Link>
            ))}
          </div>
        )}
        {available.length > 0 && (
          <div className={cx('flex flex-wrap gap-2', insights && 'border-t border-line pt-4')}>
            {available.map((s) => (
              <Button key={s.id} size="sm" loading={run.isPending && run.variables === s.id} onClick={() => run.mutate(s.id)}>
                {s.id === 'incident_summarization' ? 'Summarize' : s.id === 'resolution_notes_generation' ? 'Draft resolution notes' : 'Draft email'}
              </Button>
            ))}
          </div>
        )}
      </div>
      <Modal
        open={!!result}
        onClose={() => setResult(null)}
        title={result?.label ?? ''}
        wide
        footer={
          <Button
            icon={<Copy className="size-4" />}
            onClick={() => {
              navigator.clipboard.writeText(result?.text ?? '');
              toast('Copied', 'success');
            }}
          >
            Copy
          </Button>
        }
      >
        <p className="mb-3 text-xs text-subtle">{result?.provider === 'offline' ? 'Generated offline from the record and related tickets (no AI provider configured)' : `Generated by ${result?.provider}`}</p>
        <div className="max-h-[55vh] overflow-y-auto rounded-tile border border-line bg-raised p-4 text-sm leading-relaxed whitespace-pre-wrap">{result?.text}</div>
      </Modal>
    </Card>
  );
}
