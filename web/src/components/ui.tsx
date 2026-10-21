import clsx from 'clsx';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';

export const cx = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-control font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-4 text-[13px]',
        variant === 'primary' && 'bg-brand-600 text-white shadow-card hover:bg-brand-700',
        variant === 'secondary' && 'border border-line bg-surface text-ink shadow-card hover:border-line-strong hover:bg-raised',
        variant === 'outline' && 'border border-brand-500 bg-surface text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10',
        variant === 'ghost' && 'text-muted hover:bg-sunken hover:text-ink',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

const CONTROL =
  'w-full rounded-control border bg-surface text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10 disabled:bg-sunken disabled:text-muted';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(CONTROL, 'h-9 px-3', invalid ? 'border-red-500' : 'border-line', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cx(CONTROL, 'px-3 py-2', invalid ? 'border-red-500' : 'border-line', className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select(
  { className, invalid, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(CONTROL, 'h-9 px-2.5', invalid ? 'border-red-500' : 'border-line', className)} {...rest}>
      {children}
    </select>
  );
});

export function Label({ children, required, htmlFor, hint }: { children: ReactNode; required?: boolean; htmlFor?: string; hint?: string | null }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-muted" title={hint ?? undefined}>
      {required && <span className="text-brand-600">*</span>}
      {children}
    </label>
  );
}

const TONES = {
  gray: 'bg-sunken text-muted ring-line',
  red: 'bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/20',
  orange: 'bg-orange-50 text-orange-700 ring-orange-600/15 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/20',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/20',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/15 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/15 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/20',
};
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ring-1 ring-inset', TONES[tone], className)}>
      {children}
    </span>
  );
}

/** Accent colors for applications, as icon tiles and titles. */
export const TINTS = {
  coral: { tile: 'bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300', text: 'text-brand-600 dark:text-brand-300' },
  indigo: { tile: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300', text: 'text-indigo-700 dark:text-indigo-300' },
  green: { tile: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', text: 'text-emerald-700 dark:text-emerald-300' },
  blue: { tile: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300', text: 'text-sky-700 dark:text-sky-300' },
  rose: { tile: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300', text: 'text-rose-700 dark:text-rose-300' },
  teal: { tile: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300', text: 'text-teal-700 dark:text-teal-300' },
  amber: { tile: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', text: 'text-amber-700 dark:text-amber-300' },
  violet: { tile: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', text: 'text-violet-700 dark:text-violet-300' },
  sand: { tile: 'bg-sunken text-muted', text: 'text-ink' },
};
export type Tint = keyof typeof TINTS;

export function IconTile({ icon, tint = 'coral', className }: { icon: ReactNode; tint?: Tint; className?: string }) {
  return <span className={cx('inline-flex size-10 shrink-0 items-center justify-center rounded-control', TINTS[tint].tile, className)}>{icon}</span>;
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-card border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex min-h-12 items-center justify-between gap-2 border-b border-line px-5 py-2.5">
          <h3 className="micro text-ink">{title}</h3>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

/** Page title block: large title, eyebrow and a short description. */
export function PageHero({ title, eyebrow, children, aside }: { title: ReactNode; eyebrow?: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="min-w-0 max-w-3xl">
        <h1 className="display">{title}</h1>
        {eyebrow && <div className="eyebrow mt-4">{eyebrow}</div>}
        {children && <div className="mt-3.5 text-base leading-[1.7] text-muted">{children}</div>}
      </div>
      {aside}
    </div>
  );
}

export function SectionHeader({ title, aside, className }: { title: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center justify-between gap-4', className)}>
      <h2 className="section-title">{title}</h2>
      {aside && <div className="text-[11px] tracking-[0.06em] text-subtle">{aside}</div>}
    </div>
  );
}

export function StatTile({ value, label, to, className }: { value: ReactNode; label: ReactNode; to?: string; className?: string }) {
  const body = (
    <>
      <div className="text-2xl leading-none font-bold tracking-[-0.02em] text-brand-500 tabular-nums dark:text-brand-400">{value}</div>
      <div className="micro mt-2 text-[9px] text-subtle">{label}</div>
    </>
  );
  const cls = cx('block min-w-[136px] rounded-tile border border-line bg-surface px-5 pt-3.5 pb-4 transition-colors', className);
  return to ? (
    <Link to={to} className={cx(cls, 'hover:border-brand-300')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center rounded-lg border border-well-line bg-well px-2 py-1.5 text-[9px] leading-tight tracking-[0.04em] text-ink/85 uppercase', className)}>
      {children}
    </span>
  );
}

/** Square outlined button with an arrow, used to open a card's target. */
export function ArrowButton({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-brand-500 text-brand-600 transition-colors hover:bg-brand-500 hover:text-white dark:text-brand-300"
    >
      <ArrowRight className="size-4" />
    </Link>
  );
}

export interface SegmentOption<T extends string> {
  id: T;
  label: ReactNode;
  to?: string;
}

/** Row of filter tabs in a white container; the active one is outlined in coral. */
export function Segmented<T extends string>({ options, value, onChange, className }: { options: SegmentOption<T>[]; value: T | null; onChange?: (v: T) => void; className?: string }) {
  return (
    <div className={cx('flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-well-line bg-surface p-[5px] scrollbar-none', className)} role="tablist">
      {options.map((o) => {
        const active = o.id === value;
        const cls = cx(
          'shrink-0 rounded-lg border px-4 py-2 text-[11px] font-bold tracking-[0.05em] whitespace-nowrap uppercase transition-colors',
          active ? 'border-brand-500 text-brand-600 dark:text-brand-300' : 'border-transparent text-ink/80 hover:bg-sunken hover:text-ink',
        );
        return o.to ? (
          <Link key={o.id} to={o.to} role="tab" aria-selected={active} className={cls}>
            {o.label}
          </Link>
        ) : (
          <button key={o.id} type="button" role="tab" aria-selected={active} className={cls} onClick={() => onChange?.(o.id)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Numbered steps; the current step is a filled coral square. */
export function Stepper({ steps, current }: { steps: { id: string; label: string }[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'next';
        return (
          <li key={s.id} className="flex items-center gap-2.5">
            {i > 0 && <span className="h-px w-[18px] bg-well-line" aria-hidden />}
            <span
              className={cx(
                'inline-flex size-7 items-center justify-center rounded-lg text-[10px] font-bold',
                state === 'current' && 'bg-brand-500 text-white',
                state === 'done' && 'bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300',
                state === 'next' && 'border border-well-line bg-raised text-subtle',
              )}
            >
              {state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cx('text-[10px] font-bold tracking-[0.07em] uppercase', state === 'current' ? 'text-ink' : 'text-subtle')} aria-current={state === 'current' ? 'step' : undefined}>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-brand-500', className)} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 inline-flex size-12 items-center justify-center rounded-tile bg-sunken text-subtle">{icon}</div>}
      <p className="text-sm font-semibold">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line bg-sunken px-1.5 py-0.5 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function Avatar({ name, size = 28, tone = 'auto' }: { name: string; size?: number; tone?: 'auto' | 'brand' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const background = tone === 'brand' ? 'var(--color-brand-500)' : `hsl(${hash % 360} 42% 46%)`;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36, background }}
      aria-hidden
    >
      {initials || '?'}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-sand-950/35 p-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx('w-full rounded-card border border-line bg-surface shadow-pop', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <h2 className="text-lg font-bold tracking-[-0.01em]">{title}</h2>
          <button type="button" className="rounded-lg p-1.5 text-muted hover:bg-sunken" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line scrollbar-none" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'micro -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 transition-colors',
            value === t.id ? 'border-brand-500 text-ink' : 'border-transparent text-subtle hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-sunken px-1.5 text-[10px] text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  tone: 'info' | 'error' | 'success';
  text: string;
}
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'pointer-events-auto rounded-tile border px-4 py-3 text-sm shadow-pop',
                t.tone === 'error' && 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-950 dark:text-red-200',
                t.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950 dark:text-emerald-200',
                t.tone === 'info' && 'border-line bg-surface text-ink',
              )}
            >
              {t.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------- formatting helpers

export function relativeTime(glide: string): string {
  if (!glide) return '';
  const d = new Date(`${glide.replace(' ', 'T')}Z`);
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = Math.abs(diff);
  const fmt = (n: number, u: string) => `${Math.round(n)}${u}`;
  let s: string;
  if (abs < 60) s = 'just now';
  else if (abs < 3600) s = fmt(abs / 60, 'm');
  else if (abs < 86400) s = fmt(abs / 3600, 'h');
  else if (abs < 86400 * 30) s = fmt(abs / 86400, 'd');
  else return d.toLocaleDateString();
  if (s === 'just now') return s;
  return diff >= 0 ? `${s} ago` : `in ${s}`;
}

export function localDateTime(glide: string): string {
  if (!glide) return '';
  const d = new Date(`${glide.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? glide : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const PRIORITY_TONE: Record<string, Tone> = { '1': 'red', '2': 'orange', '3': 'amber', '4': 'blue', '5': 'gray' };

/** Colored badge for well-known fields (priority, state, approval...). */
export function ValueBadge({ field, value, display }: { field: string; value: string; display: string }) {
  if (!display) return null;
  if (field === 'priority' || field === 'severity' || field === 'risk') return <Badge tone={PRIORITY_TONE[value] ?? 'gray'}>{display}</Badge>;
  if (field === 'approval') {
    const tone: Tone = value === 'approved' ? 'green' : value === 'rejected' ? 'red' : value === 'requested' ? 'amber' : 'gray';
    return <Badge tone={tone}>{display}</Badge>;
  }
  if (field === 'state' || field === 'incident_state' || field === 'stage' || field === 'workflow_state') {
    const d = display.toLowerCase();
    const tone: Tone = /closed|resolved|complete|published|approved|fixed|delivered/.test(d)
      ? 'green'
      : /cancel|reject|retired|incomplete|skipped/.test(d)
        ? 'gray'
        : /hold|pending|await|review|scheduled|authorize|assess/.test(d)
          ? 'amber'
          : /new|draft|open/.test(d)
            ? 'blue'
            : 'brand';
    return <Badge tone={tone}>{display}</Badge>;
  }
  return null;
}
