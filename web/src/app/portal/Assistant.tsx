import { useMutation } from '@tanstack/react-query';
import { Bot, Send, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { api } from '../../lib/api';

/** Virtual agent chat (POST /api/app/va/message), docked in the portal. */

interface Card {
  title: string;
  subtitle?: string;
  fields?: { label: string; value: string }[];
  table?: string;
  sys_id?: string;
}
interface BotMessage {
  type: 'text' | 'card' | 'list';
  text?: string;
  card?: Card;
  items?: Card[];
  quickReplies?: { label: string; value: string }[];
}
interface Turn {
  conversationId: string;
  number: string;
  messages: BotMessage[];
}
type Entry = { from: 'bot'; message: BotMessage } | { from: 'me'; text: string };

const KEY = 'portal.va';

function cardHref(c: Card): string | null {
  if (!c.table || !c.sys_id) return null;
  return c.table === 'kb_knowledge' ? `/portal/kb/${c.sys_id}` : `/portal/ticket/${c.table}/${c.sys_id}`;
}

function CardView({ card }: { card: Card }) {
  const href = cardHref(card);
  const body = (
    <>
      <p className="text-[13px] font-semibold">{card.title}</p>
      {card.subtitle && <p className="text-xs text-muted">{card.subtitle}</p>}
      {!!card.fields?.length && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {card.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-subtle">{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
  return href ? (
    <Link to={href} className="block rounded-tile border border-line bg-surface px-3 py-2.5 hover:border-brand-300">
      {body}
    </Link>
  ) : (
    <div className="rounded-tile border border-line bg-surface px-3 py-2.5">{body}</div>
  );
}

function saved(): { id: string; number: string; log: Entry[] } | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => saved() ?? { id: '', number: '', log: [] as Entry[] });
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable */
    }
    end.current?.scrollIntoView({ block: 'end' });
  }, [state]);

  const send = useMutation({
    mutationFn: async (input: { text?: string; value?: string }) =>
      (await api.post<{ result: Turn }>('/api/app/va/message', { conversationId: state.id || undefined, ...input })).result,
    onSuccess: (turn) =>
      setState((s) => ({ id: turn.conversationId, number: turn.number, log: [...s.log, ...turn.messages.map((m) => ({ from: 'bot' as const, message: m }))] })),
  });

  // Start the conversation (the agent's greeting) the first time the panel opens.
  const greeted = useRef(false);
  const start = send.mutate;
  useEffect(() => {
    if (!open || state.id || greeted.current) return;
    greeted.current = true;
    start({ text: '' });
  }, [open, state.id, start]);

  const say = (input: { text?: string; value?: string }, shown: string) => {
    setState((s) => ({ ...s, log: [...s.log, { from: 'me', text: shown }] }));
    send.mutate(input);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    say({ text: text.trim() }, text.trim());
    setText('');
  };
  const last = [...state.log].reverse().find((e) => e.from === 'bot');
  const replies = last?.from === 'bot' ? (last.message.quickReplies ?? []) : [];

  return (
    <>
      {open && (
        <section
          className="fixed end-4 bottom-24 z-40 flex h-[min(560px,calc(100vh-140px))] w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-pop"
          aria-label="Virtual agent"
        >
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <span className="inline-flex size-9 items-center justify-center rounded-control bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <Bot className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">Virtual agent</p>
              <p className="micro text-subtle">{state.number || 'Online'}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-subtle hover:bg-sunken" aria-label="Close chat">
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-raised px-4 py-4 scrollbar-thin" aria-live="polite">
            {state.log.map((e, i) =>
              e.from === 'me' ? (
                <p key={i} className="ms-auto w-fit max-w-[85%] rounded-tile bg-brand-600 px-3.5 py-2 text-sm text-white">
                  {e.text}
                </p>
              ) : (
                <div key={i} className="max-w-[92%] space-y-2">
                  {e.message.text && <p className="w-fit rounded-tile border border-line bg-surface px-3.5 py-2 text-sm whitespace-pre-wrap">{e.message.text}</p>}
                  {e.message.card && <CardView card={e.message.card} />}
                  {e.message.items?.map((c) => (
                    <CardView key={`${c.table}-${c.sys_id}-${c.title}`} card={c} />
                  ))}
                </div>
              ),
            )}
            {send.isPending && <p className="w-fit rounded-tile border border-line bg-surface px-3.5 py-2 text-sm text-subtle">…</p>}
            <div ref={end} />
          </div>
          {replies.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-2.5">
              {replies.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  disabled={send.isPending}
                  onClick={() => say({ value: r.value }, r.label)}
                  className="rounded-full border border-brand-500 px-3 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={submit} className="flex items-center gap-2 border-t border-line px-3 py-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a message"
              aria-label="Message"
              className="h-10 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-sm outline-none focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10"
            />
            <button type="submit" disabled={!text.trim() || send.isPending} className="inline-flex size-10 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50" aria-label="Send">
              <Send className="size-4" />
            </button>
          </form>
        </section>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx('fixed end-4 bottom-4 z-40 inline-flex h-14 items-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-semibold text-white shadow-pop hover:bg-brand-700', open && 'px-4')}
        aria-expanded={open}
      >
        {open ? <X className="size-5" /> : <Bot className="size-5" />}
        {!open && 'Ask the virtual agent'}
      </button>
    </>
  );
}
