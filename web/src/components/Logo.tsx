import { useId } from 'react';
import { cx } from './ui';

/** The Resolve knot: a tangled loop that straightens into a check mark. */
export const KNOT_PATH = 'M14.5 46C19 38.5 24.5 30.5 27.5 26C31.3 20.2 28.6 13.8 22.6 14.9C15.2 16.3 13.6 27.6 20.6 35.6L30 46L52 20';

/** The app icon: the knot in white on a coral tile. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cx('shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8a68" />
          <stop offset=".55" stopColor="#f25d3f" />
          <stop offset="1" stopColor="#dc4329" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id})`} />
      <path d={KNOT_PATH} fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The knot on its own, drawn in the current text color. */
export function KnotGlyph({ className, strokeWidth = 6 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <path d={KNOT_PATH} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark and wordmark. */
export function Logo({ size = 30, wordmark = true, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      {wordmark && (
        <span className="font-bold tracking-[-0.02em] text-ink" style={{ fontSize: Math.round(size * 0.58) }}>
          ResolvrNow
        </span>
      )}
      {!wordmark && <span className="sr-only">ResolvrNow</span>}
    </span>
  );
}
