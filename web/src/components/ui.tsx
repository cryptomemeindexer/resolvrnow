import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
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
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm',
        variant === 'secondary' && 'bg-surface text-ink border border-line hover:bg-raised shadow-xs',
        variant === 'outline' && 'border border-brand-600 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/30',
        variant === 'ghost' && 'text-muted hover:text-ink hover:bg-raised',
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

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        'h-9 w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-subtle outline-none transition-shadow',
        'focus:border-brand-500 focus:ring-3 focus:ring-brand-500/15 disabled:bg-raised disabled:text-muted',
        invalid ? 'border-red-500' : 'border-line',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(
          'w-full rounded-lg border bg-surface px-3 py-2 text-sm text-ink placeholder:text-subtle outline-none',
          'focus:border-brand-500 focus:ring-3 focus:ring-brand-500/15 disabled:bg-raised disabled:text-muted',
          invalid ? 'border-red-500' : 'border-line',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select(
  { className, invalid, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(
        'h-9 w-full rounded-lg border bg-surface px-2.5 text-sm text-ink outline-none',
        'focus:border-brand-500 focus:ring-3 focus:ring-brand-500/15 disabled:bg-raised disabled:text-muted',
        invalid ? 'border-red-500' : 'border-line',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Label({ children, required, htmlFor, hint }: { children: ReactNode; required?: boolean; htmlFor?: string; hint?: string | null }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 flex items-center gap-1 text-xs font-medium text-muted" title={hint ?? undefined}>
      {required && <span className="text-red-500">*</span>}
      {children}
    </label>
  );
}

const TONES = {
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  red: 'bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-500/15 dark:text-red-300',
  orange: 'bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  blue: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  brand: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
};
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-brand-600', className)} />;
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
      {icon && <div className="text-subtle">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 45% 42%)` }}
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh] backdrop-blur-[1px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx('w-full rounded-xl border border-line bg-surface shadow-2xl', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" className="rounded p-1 text-muted hover:bg-raised" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
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
    <div className="flex gap-1 border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.id ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-raised px-1.5 text-[11px] text-muted">{t.count}</span>}
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
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'pointer-events-auto rounded-lg border px-3.5 py-2.5 text-sm shadow-lg',
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
