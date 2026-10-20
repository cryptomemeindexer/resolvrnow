/** Class mechanics for CIs: class path and reclassification (cmdb.md section 1). */
import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import type { SchemaRegistry } from '../../engine/registry.js';

/** Characters used for class path levels; excludes `/` (separator) and `^` (encoded query separator). */
const ALPHABET = '!#$%&()*+,-.0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz{|}~';

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function levelCode(className: string): string {
  const n = ALPHABET.length;
  const h = hash(className) % (n * n);
  return ALPHABET[Math.floor(h / n)] + ALPHABET[h % n];
}

/**
 * Opaque, prefix-sortable ancestry string: one two-character code per level, root first.
 * Codes are derived from class names so paths stay stable when classes are added.
 */
export function classPath(registry: SchemaRegistry, className: string): string {
  const meta = registry.tryTable(className);
  if (!meta) return '';
  return [...meta.ancestors]
    .reverse()
    .map((c, i) => (i === 0 ? '/!!' : `/${levelCode(c)}`))
    .join('');
}

/**
 * Before-update handling of a sys_class_name change: the class must belong to the same
 * hierarchy, and values of columns the new class does not have are cleared.
 */
export function applyClassChange(cur: Rec, registry: SchemaRegistry): void {
  const target = registry.tryTable(cur.str('sys_class_name'));
  if (!target || target.root !== cur.table.root) {
    cur.abort(`Invalid class ${cur.str('sys_class_name')}`);
    return;
  }
  for (const [name, col] of cur.table.columns) {
    if (!col.storage || col.system) continue;
    const kept = target.columns.get(name);
    if (kept && kept.physical === col.physical) continue;
    const v = cur.get(name);
    if (v !== null && v !== '') cur.setRaw(name, null);
  }
  cur.setRaw('sys_class_path', classPath(registry, target.name));
}

/**
 * Moves a CI to another class of the hierarchy keeping its sys_id (upgrade, downgrade or
 * switch). Returns the record reloaded as the new class.
 */
export function reclassify(ctx: Context, ci: Rec, newClass: string): Rec {
  if (ci.className === newClass) return ci;
  const target = ctx.registry.tryTable(newClass);
  if (!target || target.root !== ci.table.root) throw new InvalidError(`Invalid class ${newClass}`);
  ctx.update(ci, { sys_class_name: newClass });
  const fresh = ctx.get(newClass, ci.sysId) ?? ctx.elevated().get(newClass, ci.sysId);
  if (!fresh) throw new InvalidError(`Reclassification of ${ci.sysId} to ${newClass} failed`);
  return fresh;
}

export type ReclassKind = 'upgrade' | 'downgrade' | 'switch';

export function reclassKind(registry: SchemaRegistry, from: string, to: string): ReclassKind {
  if (registry.isA(to, from)) return 'upgrade';
  if (registry.isA(from, to)) return 'downgrade';
  return 'switch';
}
