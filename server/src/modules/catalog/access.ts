/**
 * Who may see and order what: user criteria evaluation (Available For / Not
 * Available For), catalog and category membership, channel flags. Spec section 3.3.
 */
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { PROP, T } from './constants.js';

export const splitList = (v: unknown): string[] =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export interface UserProfile {
  id: string | null;
  roles: Set<string>;
  groups: string[];
  department: string;
  company: string;
  location: string;
  manager: string;
  active: boolean;
}

/** Facts about a user that user criteria can test. */
export function profileOf(platform: Platform, userId: string | null): UserProfile {
  const empty: UserProfile = {
    id: userId,
    roles: new Set(),
    groups: [],
    department: '',
    company: '',
    location: '',
    manager: '',
    active: false,
  };
  if (!userId) return empty;
  const session = platform.users.session(userId);
  if (!session) return empty;
  const row = platform.db.get<Record<string, unknown>>(
    `SELECT "department","company","location","manager","active" FROM "sys_user" WHERE "sys_id" = ?`,
    [userId],
  );
  return {
    id: userId,
    roles: session.roles,
    groups: session.groups,
    department: String(row?.department ?? ''),
    company: String(row?.company ?? ''),
    location: String(row?.location ?? ''),
    manager: String(row?.manager ?? ''),
    active: row?.active !== 0,
  };
}

export type CatalogView = 'desktop' | 'mobile' | 'both';

export interface ViewOptions {
  /** `sysparm_view`: desktop (default), mobile or both. */
  view?: CatalogView;
  /** Portal rendering: honours `hide_sp`. */
  portal?: boolean;
  /** Search and browsing: honours `no_search`. */
  search?: boolean;
}

/**
 * Evaluates catalog visibility for one user. Instances cache criteria results, so
 * create one per request (or per business operation) and reuse it.
 */
export class CatalogAccess {
  readonly profile: UserProfile;
  private criteriaCache = new Map<string, boolean>();
  private catalogActive = new Map<string, boolean>();
  private sys: Context;

  constructor(
    readonly ctx: Context,
    userId?: string | null,
  ) {
    this.sys = ctx.platform.systemContext();
    this.profile = profileOf(ctx.platform, userId === undefined ? ctx.user.sysId : userId);
  }

  get platform(): Platform {
    return this.ctx.platform;
  }

  private useCriteria(): boolean {
    return this.platform.properties.getBool('glide.sc.use_user_criteria', true);
  }

  /** True when the user satisfies a user_criteria record. */
  matchesCriteria(criteriaId: string): boolean {
    const hit = this.criteriaCache.get(criteriaId);
    if (hit !== undefined) return hit;
    const rec = this.sys.get(T.criteria, criteriaId);
    const result = !!rec && this.evaluate(rec);
    this.criteriaCache.set(criteriaId, result);
    return result;
  }

  private evaluate(rec: Rec): boolean {
    if (!rec.bool('active') && rec.get('active') !== null) return false;
    const p = this.profile;
    if (!p.id) return false;
    if (rec.bool('advanced')) {
      const scripts = optionalService<ScriptService>(this.platform, SERVICES.scripts);
      const script = rec.str('script');
      if (!scripts || !hasCode(script)) return false;
      try {
        return !!scripts.run(this.sys, script, { vars: { user_id: p.id } });
      } catch (e) {
        this.platform.log.warn(
          `[catalog] user criteria ${rec.str('name')} script failed: ${(e as Error).message}`,
        );
        return false;
      }
    }
    const roleNames = splitList(rec.str('role')).map((id) => this.roleName(id));
    type Dim = { values: string[]; test: (v: string[]) => boolean };
    const all: Dim[] = [
      { values: splitList(rec.str('user')), test: (v) => v.includes(p.id!) },
      { values: splitList(rec.str('group')), test: (v) => v.some((g) => p.groups.includes(g)) },
      { values: roleNames, test: (v) => v.some((r) => p.roles.has(r)) },
      { values: splitList(rec.str('department')), test: (v) => !!p.department && v.includes(p.department) },
      { values: splitList(rec.str('company')), test: (v) => !!p.company && v.includes(p.company) },
      { values: splitList(rec.str('location')), test: (v) => !!p.location && v.includes(p.location) },
    ];
    const dims = all.filter((d) => d.values.length > 0);
    if (!dims.length) return false;
    return rec.bool('match_all') ? dims.every((d) => d.test(d.values)) : dims.some((d) => d.test(d.values));
  }

  private roleName(idOrName: string): string {
    if (!/^[0-9a-f]{32}$/.test(idOrName)) return idOrName;
    const row = this.platform.db.get<{ name: string }>(
      `SELECT "name" FROM "sys_user_role" WHERE "sys_id" = ?`,
      [idOrName],
    );
    return row?.name ?? idOrName;
  }

  /** Available For / Not Available For: deny wins; no Available For means everyone. */
  private criteriaAllow(table: { yes: string; no: string }, field: string, id: string): boolean {
    if (!this.useCriteria()) return true;
    const no = this.sys.query(table.no, { query: `${field}=${id}` }).map((r) => r.str('user_criteria'));
    if (no.some((c) => this.matchesCriteria(c))) return false;
    const yes = this.sys.query(table.yes, { query: `${field}=${id}` }).map((r) => r.str('user_criteria'));
    return yes.length === 0 || yes.some((c) => this.matchesCriteria(c));
  }

  private hasLegacyRoles(rolesField: string): boolean {
    const roles = splitList(rolesField);
    return roles.length === 0 || roles.some((r) => this.profile.roles.has(r));
  }

  isCatalogActive(id: string): boolean {
    let v = this.catalogActive.get(id);
    if (v === undefined) {
      const cat = this.sys.get(T.catalog, id);
      v = !!cat && cat.bool('active');
      this.catalogActive.set(id, v);
    }
    return v;
  }

  /** Catalogs an item belongs to (sc_catalogs list plus sc_cat_item_catalog links). */
  itemCatalogs(item: Rec): string[] {
    const ids = new Set(splitList(item.str('sc_catalogs')));
    for (const l of this.sys.query(T.itemCatalog, { query: `sc_cat_item=${item.sysId}` }))
      ids.add(l.str('sc_catalog'));
    return [...ids];
  }

  /** Categories of an item (primary category first, then additional ones). */
  itemCategories(item: Rec): string[] {
    const ids: string[] = [];
    if (item.str('category')) ids.push(item.str('category'));
    for (const l of this.sys.query(T.itemCategory, { query: `sc_cat_item=${item.sysId}` })) {
      if (!ids.includes(l.str('sc_category'))) ids.push(l.str('sc_category'));
    }
    return ids;
  }

  canViewCatalog(catalog: Rec): boolean {
    return catalog.bool('active');
  }

  canViewCategory(category: Rec): boolean {
    if (!category.bool('active')) return false;
    if (category.str('sc_catalog') && !this.isCatalogActive(category.str('sc_catalog'))) return false;
    if (!this.hasLegacyRoles(category.str('roles'))) return false;
    return this.criteriaAllow(
      { yes: T.categoryAvailable, no: T.categoryNotAvailable },
      'sc_category',
      category.sysId,
    );
  }

  /** Spec 3.3 canView(user, item, channel). Category restrictions do not cascade to items. */
  canViewItem(item: Rec, opts: ViewOptions = {}): boolean {
    if (!item.bool('active')) return false;
    if (!this.profile.id) return false;
    if (!this.itemCatalogs(item).some((c) => this.isCatalogActive(c))) return false;
    const availability = item.str('availability') || 'on_both';
    const view = opts.view ?? 'desktop';
    if (view === 'desktop' && availability === 'on_mobile') return false;
    if (view === 'mobile' && availability === 'on_desktop') return false;
    if (opts.portal && item.bool('hide_sp')) return false;
    if (opts.search && item.bool('no_search')) return false;
    if (!this.hasLegacyRoles(item.str('roles'))) return false;
    return this.criteriaAllow({ yes: T.itemAvailable, no: T.itemNotAvailable }, 'sc_cat_item', item.sysId);
  }
}

/** True when a script field holds more than comments and whitespace. */
export function hasCode(script: string): boolean {
  const stripped = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .trim();
  return stripped.length > 0;
}

/** The default catalog: the configured one, else "Service Catalog", else the oldest active catalog. */
export function defaultCatalogId(ctx: Context): string | null {
  const sys = ctx.platform.systemContext();
  const configured = ctx.platform.properties.get(PROP.defaultCatalog);
  if (configured && sys.get(T.catalog, configured)) return configured;
  const named = sys.first(T.catalog, 'title=Service Catalog^active=true');
  if (named) return named.sysId;
  return sys.first(T.catalog, 'active=true', [{ field: 'sys_created_on', desc: false }])?.sysId ?? null;
}

/** Roles that may change the Requested For of an order (glide.sc.req_for.roles). */
export function canRequestForOthers(ctx: Context): boolean {
  if (ctx.user.isSystem) return true;
  const roles = splitList(ctx.platform.properties.get('glide.sc.req_for.roles'));
  if (roles.length) return ctx.hasAnyRole(roles);
  return (
    (ctx.platform.properties.get('glide.sc.req_for.roles.default') ?? 'allow').trim().toLowerCase() !== 'deny'
  );
}
