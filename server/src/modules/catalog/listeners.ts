/** Submission listeners: other modules (portal, universal requests) react to catalog orders. */
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';

export interface SubmissionEvent {
  kind: 'request' | 'producer';
  ctx: Context;
  item: Rec;
  request?: Rec;
  items?: Rec[];
  record?: Rec;
}

export type SubmissionListener = (ev: SubmissionEvent) => void;

/** Listeners other modules (portal, universal requests) register for catalog submissions. */
export class CatalogListeners {
  private listeners: SubmissionListener[] = [];

  on(fn: SubmissionListener): void {
    this.listeners.push(fn);
  }

  emit(ev: SubmissionEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (e) {
        ev.ctx.platform.reportError('catalog submission listener', e);
      }
    }
  }
}

const fallbackListeners = new WeakMap<Platform, CatalogListeners>();

export function catalogListeners(platform: Platform): CatalogListeners {
  const svc = platform.services.get('catalog') as { listeners?: CatalogListeners } | undefined;
  if (svc?.listeners) return svc.listeners;
  let l = fallbackListeners.get(platform);
  if (!l) {
    l = new CatalogListeners();
    fallbackListeners.set(platform, l);
  }
  return l;
}
