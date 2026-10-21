import { useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, cx } from '../../components/ui';
import { api, type ApiError } from '../../lib/api';

const SAMPLE = `// Server-side JavaScript in the sandbox, with GlideRecord and gs.
var gr = new GlideRecord('incident');
gr.addActiveQuery();
gr.addQuery('priority', '<=', 2);
gr.query();
gs.print('Open critical and high incidents: ' + gr.getRowCount());`;

interface RunResult {
  result: unknown;
  output: string[];
  durationMs: number;
  error?: string;
}

/** Background scripts for administrators (POST /api/app/scripts/background). */
export function ScriptsPage() {
  const [script, setScript] = useState(SAMPLE);
  const run = useMutation({
    mutationFn: async () => api.post<RunResult>('/api/app/scripts/background', { script }),
  });
  const res = run.data;
  const err = (run.error as ApiError | null) ?? null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-title">Background scripts</h1>
        <Button variant="primary" icon={<Play className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
          Run script
        </Button>
      </div>
      <p className="max-w-3xl text-sm text-muted">
        Scripts run on the server in a sandbox with memory and time limits, as your user and with your access. Changes they make are real and audited.
      </p>
      <Card className="overflow-hidden">
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run.mutate();
          }}
          spellCheck={false}
          aria-label="Script"
          className="block min-h-72 w-full resize-y bg-surface p-5 font-mono text-[13px] leading-relaxed text-ink outline-none"
        />
      </Card>
      {(res || err) && (
        <Card title={err || res?.error ? 'Error' : `Output · ${res?.durationMs ?? 0} ms`}>
          <pre className={cx('overflow-x-auto p-5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap', (err || res?.error) && 'text-red-600')}>
            {err ? `${err.message}${err.detail ? `: ${err.detail}` : ''}` : res?.error ? res.error : [...(res?.output ?? []), res?.result != null ? `=> ${JSON.stringify(res.result)}` : ''].filter(Boolean).join('\n') || '(no output)'}
          </pre>
        </Card>
      )}
    </div>
  );
}
