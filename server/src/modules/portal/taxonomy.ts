import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { addMs, isSysId, nowGlide } from '../../engine/util.js';
import { type ContentType, EXT, PROPS, T } from './constants.js';
import { type Lang, t } from './i18n.js';
import {
  type CatalogAccessLike,
  catalogService,
  hasColumn,
  hasTable,
  idList,
  plainText,
  truncate,
  visibleByCriteria,
} from './util.js';

const DAY = 86_400_000;

// ------------------------------------------------------------------ topics

export interface TopicNode {
  sys_id: string;
  name: string;
  description: string;
  icon: string;
  banner_image_url: string;
  order: number;
  path: string;
  parent: string | null;
  taxonomy: string | null;
  featured: boolean;
  children: TopicNode[];
  quick_links: ReturnType<typeof quickLinkJson>[];
}

/** Active topics the user may see (active taxonomy, user criteria when the topic enables them). */
export function visibleTopics(ctx: Context): Rec[] {
  const sys = ctx.elevated();
  const inactiveTaxonomies = new Set(sys.query(T.taxonomy, { query: 'active=false' }).map((r) => r.sysId));
  let topics = sys
    .query(T.topic, { query: 'active=true^ORDERBYorder^ORDERBYname', limit: 2000 })
    .filter((tp) => !inactiveTaxonomies.has(tp.str('taxonomy')))
    .filter((tp) => !tp.bool('enable_user_criteria_check') || visibleByCriteria(ctx, tp));
  // A sub-topic disappears with a hidden or inactive parent.
  for (let changed = true; changed; ) {
    const ids = new Set(topics.map((tp) => tp.sysId));
    const kept = topics.filter((tp) => !tp.str('parent_topic') || ids.has(tp.str('parent_topic')));
    changed = kept.length !== topics.length;
    topics = kept;
  }
  return topics;
}

function topicNode(tp: Rec): TopicNode {
  return {
    sys_id: tp.sysId,
    name: tp.str('name'),
    description: tp.str('description'),
    icon: tp.str('icon'),
    banner_image_url: tp.str('banner_image_url'),
    order: tp.num('order') ?? 100,
    path: tp.str('topic_path') || tp.str('name'),
    parent: tp.str('parent_topic') || null,
    taxonomy: tp.str('taxonomy') || null,
    featured: tp.bool('resolvr_featured'),
    children: [],
    quick_links: [],
  };
}

/** Topic tree (department, topic, sub-topic...) with the quick links connected to each node. */
export function topicTree(ctx: Context, taxonomy?: string | null): TopicNode[] {
  const topics = visibleTopics(ctx).filter((tp) => !taxonomy || tp.str('taxonomy') === taxonomy);
  const nodes = new Map(topics.map((tp) => [tp.sysId, topicNode(tp)]));
  const links = connectedQuickLinks(ctx, [...nodes.keys()]);
  const roots: TopicNode[] = [];
  for (const node of nodes.values()) {
    node.quick_links = links.get(node.sys_id) ?? [];
    if (!node.parent) roots.push(node);
    else nodes.get(node.parent)?.children.push(node);
    // A child whose parent is hidden or inactive disappears with it.
  }
  return roots;
}

/** Breadcrumb from the root topic down to `topic`. */
export function breadcrumbOf(ctx: Context, topic: Rec): { sys_id: string; name: string }[] {
  const sys = ctx.elevated();
  const out: { sys_id: string; name: string }[] = [];
  const seen = new Set<string>();
  let cur: Rec | null = topic;
  while (cur && !seen.has(cur.sysId) && out.length < 20) {
    seen.add(cur.sysId);
    out.unshift({ sys_id: cur.sysId, name: cur.str('name') });
    cur = cur.str('parent_topic') ? sys.get(T.topic, cur.str('parent_topic')) : null;
  }
  return out;
}

/** The topic and all its active descendants. */
export function descendantTopicIds(ctx: Context, topicId: string): string[] {
  const all = visibleTopics(ctx);
  const byParent = new Map<string, string[]>();
  for (const tp of all) {
    const p = tp.str('parent_topic');
    if (!p) continue;
    byParent.set(p, [...(byParent.get(p) ?? []), tp.sysId]);
  }
  const out: string[] = [];
  const stack = [topicId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.includes(id)) continue;
    out.push(id);
    stack.push(...(byParent.get(id) ?? []));
  }
  return out;
}

export function loadVisibleTopic(ctx: Context, id: string): Rec {
  const topic = isSysId(id) ? visibleTopics(ctx).find((tp) => tp.sysId === id) : undefined;
  if (!topic) throw new NotFoundError();
  return topic;
}

/** Computes `topic_path` ("IT > Hardware > Laptops") for a topic. */
export function topicPath(ctx: Context, topic: Rec): string {
  const sys = ctx.elevated();
  const names = [topic.str('name')];
  const seen = new Set([topic.sysId]);
  let parentId = topic.str('parent_topic');
  while (parentId && !seen.has(parentId) && names.length < 20) {
    seen.add(parentId);
    const parent = sys.get(T.topic, parentId);
    if (!parent) break;
    names.unshift(parent.str('name'));
    parentId = parent.str('parent_topic');
  }
  return names.join(' > ');
}

/** True when `candidate` is `topic` itself or one of its descendants (parent loop guard). */
export function isSelfOrDescendant(ctx: Context, topicId: string, candidate: string): boolean {
  const sys = ctx.elevated();
  const seen = new Set<string>();
  let cur: string | null = candidate;
  while (cur && !seen.has(cur)) {
    if (cur === topicId) return true;
    seen.add(cur);
    cur = sys.get(T.topic, cur)?.str('parent_topic') || null;
  }
  return false;
}

// ------------------------------------------------------------------ quick links and announcements

export function quickLinkJson(link: Rec) {
  const type = link.str('content_type') || 'url';
  return {
    sys_id: link.sysId,
    name: link.str('name'),
    short_description: link.str('short_description'),
    content_type: type,
    icon: link.str('icon'),
    url: type === 'url' ? link.str('url') : '',
    page: type === 'page' ? link.str('page') : '',
    catalog_item: type === 'catalog' ? link.str('catalog_item') || null : null,
    knowledge: type === 'knowledge' ? link.str('knowledge') || null : null,
    order: link.num('order') ?? 100,
  };
}

function visibleQuickLink(ctx: Context, link: Rec): boolean {
  return link.bool('active') && visibleByCriteria(ctx, link);
}

/** Quick links flagged for the home page, in order. */
export function homeQuickLinks(ctx: Context) {
  return ctx
    .elevated()
    .query(T.quickLink, { query: 'active=true^show_on_home=true^ORDERBYorder^ORDERBYname', limit: 50 })
    .filter((l) => visibleQuickLink(ctx, l))
    .map(quickLinkJson);
}

function connectedQuickLinks(
  ctx: Context,
  topicIds: string[],
): Map<string, ReturnType<typeof quickLinkJson>[]> {
  const out = new Map<string, ReturnType<typeof quickLinkJson>[]>();
  if (!topicIds.length) return out;
  const sys = ctx.elevated();
  const rows = sys.query(T.content, {
    query: `active=true^content_type=quick_link^topicIN${idList(topicIds)}^ORDERBYorder`,
    limit: 2000,
  });
  const links = new Map(
    sys
      .query(T.quickLink, { query: `sys_idIN${idList(rows.map((r) => r.str('quick_link')))}` })
      .filter((l) => visibleQuickLink(ctx, l))
      .map((l) => [l.sysId, quickLinkJson(l)]),
  );
  for (const row of rows) {
    const link = links.get(row.str('quick_link'));
    if (!link) continue;
    out.set(row.str('topic'), [...(out.get(row.str('topic')) ?? []), link]);
  }
  return out;
}

/** Announcements inside their display window that the user has not dismissed. */
export function activeAnnouncements(ctx: Context) {
  const now = nowGlide();
  const dismissed = dismissedAnnouncements(ctx);
  return ctx
    .elevated()
    .query(T.announcement, {
      query: `active=true^display_fromISEMPTY^ORdisplay_from<=${now}^display_toISEMPTY^ORdisplay_to>=${now}^ORDERBYorder^ORDERBYDESCdisplay_from`,
      limit: 20,
    })
    .filter((a) => !dismissed.has(a.sysId))
    .map((a) => ({
      sys_id: a.sysId,
      title: a.str('title'),
      summary: a.str('summary'),
      style: a.str('display_style') || 'normal',
      link: a.str('details_url')
        ? { url: a.str('details_url'), text: a.str('details_link_text') || a.str('details_url') }
        : null,
      dismissible: a.bool('dismissible'),
      from: a.str('display_from'),
      to: a.str('display_to'),
    }));
}

const DISMISS_PREFIX = 'resolvr.portal.announcement.';

function dismissedAnnouncements(ctx: Context): Set<string> {
  const me = ctx.user.sysId;
  if (!me || !hasTable(ctx, EXT.preference)) return new Set();
  return new Set(
    ctx
      .elevated()
      .query(EXT.preference, { query: `user=${me}^nameSTARTSWITH${DISMISS_PREFIX}^value=true` })
      .map((p) =>
        p
          .str('name')
          .slice(DISMISS_PREFIX.length)
          .replace(/\.dismissed$/, ''),
      ),
  );
}

/** Stores a per-user preference (`sys_user_preference`). */
export function setPreference(ctx: Context, name: string, value: string): void {
  const me = ctx.user.sysId;
  if (!me || !hasTable(ctx, EXT.preference)) return;
  const sys = ctx.elevated();
  const existing = sys.first(EXT.preference, `user=${me}^name=${name}`);
  if (existing) sys.update(existing, { value });
  else sys.insert(EXT.preference, { user: me, name, value });
}

export function preferenceValue(ctx: Context, name: string): string | null {
  const me = ctx.user.sysId;
  if (!me || !hasTable(ctx, EXT.preference)) return null;
  return ctx.elevated().first(EXT.preference, `user=${me}^name=${name}`)?.str('value') ?? null;
}

export function dismissAnnouncement(ctx: Context, id: string): void {
  const a = isSysId(id) ? ctx.elevated().get(T.announcement, id) : null;
  if (!a?.bool('active')) throw new NotFoundError();
  if (!a.bool('dismissible')) throw new InvalidError('This announcement cannot be dismissed');
  setPreference(ctx, `${DISMISS_PREFIX}${a.sysId}.dismissed`, 'true');
}

// ------------------------------------------------------------------ content (catalog items, articles, quick links)

export interface ContentItem {
  type: ContentType;
  type_label: string;
  table: string;
  sys_id: string;
  title: string;
  short_description: string;
  icon: string;
  picture: string;
  url: string;
  page: string;
  popularity: number;
  updated: string;
  featured: boolean;
  order: number;
  favorite: boolean;
  topic: { sys_id: string; name: string } | null;
}

/**
 * Visibility of catalog items on the portal, built once per request: active, not hidden from the
 * portal, readable through ACLs and, when the catalog module is installed, allowed by its
 * visibility rules (catalogs, availability, roles, user criteria).
 */
export function catalogItemFilter(
  ctx: Context,
  opts: { search?: boolean } = {},
): (item: Rec | null | undefined) => item is Rec {
  let access: CatalogAccessLike | null = null;
  const svc = catalogService(ctx.platform);
  if (typeof svc?.access === 'function') {
    try {
      access = svc.access(ctx);
    } catch {
      access = null;
    }
  }
  return (item): item is Rec => {
    if (!item) return false;
    if (item.has('active') && item.str('active') !== '' && !item.bool('active')) return false;
    if (item.has('hide_sp') && item.bool('hide_sp')) return false;
    if (opts.search && item.has('no_search') && item.bool('no_search')) return false;
    if (!ctx.user.isSystem && !ctx.platform.acl.canTable(ctx, item.className, 'read', item).allowed)
      return false;
    if (typeof access?.canViewItem !== 'function') return true;
    try {
      return access.canViewItem(item, { portal: true, search: !!opts.search });
    } catch {
      return false;
    }
  };
}

/** Single-item form of `catalogItemFilter`. */
export function visibleCatalogItem(ctx: Context, item: Rec | null): item is Rec {
  return catalogItemFilter(ctx)(item);
}

/** Published, current articles the user may read. */
export function visibleArticle(ctx: Context, article: Rec | null): article is Rec {
  if (!article) return false;
  if (article.has('workflow_state') && article.str('workflow_state') !== 'published') return false;
  if (article.has('active') && article.str('active') !== '' && !article.bool('active')) return false;
  if (article.has('valid_to') && article.str('valid_to') && article.str('valid_to') < nowGlide().slice(0, 10))
    return false;
  return ctx.user.isSystem || ctx.platform.acl.canTable(ctx, article.className, 'read', article).allowed;
}

function popularityWindowStart(ctx: Context): string {
  return addMs(nowGlide(), -ctx.platform.properties.getNumber(PROPS.popularDays, 90) * DAY);
}

/** Orders in the popularity window, per catalog item. */
function orderCounts(ctx: Context, itemIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!itemIds.length || !hasTable(ctx, EXT.ritm) || !hasColumn(ctx, EXT.ritm, 'cat_item')) return out;
  const since = popularityWindowStart(ctx);
  for (const r of ctx
    .elevated()
    .query(EXT.ritm, { query: `cat_itemIN${idList(itemIds)}^sys_created_on>=${since}`, limit: 10000 })) {
    out.set(r.str('cat_item'), (out.get(r.str('cat_item')) ?? 0) + 1);
  }
  return out;
}

export function catalogItemJson(
  item: Rec,
  lang: Lang,
): Omit<ContentItem, 'popularity' | 'featured' | 'order' | 'favorite' | 'topic'> {
  return {
    type: 'catalog',
    type_label: t(lang, 'type.catalog'),
    table: item.className,
    sys_id: item.sysId,
    title: item.str('name') || item.displayValue(),
    short_description: item.str('short_description'),
    icon: item.has('icon') ? item.str('icon') : '',
    picture: item.has('picture') ? item.str('picture') : '',
    url: '',
    page: 'sc_cat_item',
    updated: item.str('sys_updated_on'),
  };
}

export function articleJson(
  article: Rec,
  lang: Lang,
): Omit<ContentItem, 'popularity' | 'featured' | 'order' | 'favorite' | 'topic'> {
  return {
    type: 'knowledge',
    type_label: t(lang, 'type.knowledge'),
    table: article.className,
    sys_id: article.sysId,
    title: article.str('short_description') || article.str('number'),
    short_description: truncate(plainText(article.has('text') ? article.str('text') : ''), 200),
    icon: '',
    picture: '',
    url: '',
    page: 'kb_article_view',
    updated: (article.has('published') && article.str('published')) || article.str('sys_updated_on'),
  };
}

export type ContentSort = 'popular' | 'name' | 'newest';

/** Connected content of a set of topics, visible to the user, de-duplicated, filtered and sorted. */
export function topicContent(
  ctx: Context,
  topicIds: string[],
  lang: Lang,
  opts: { type?: string; sort?: ContentSort } = {},
): ContentItem[] {
  const sys = ctx.elevated();
  const topicNames = new Map(
    sys.query(T.topic, { query: `sys_idIN${idList(topicIds)}` }).map((tp) => [tp.sysId, tp.str('name')]),
  );
  const rows = sys.query(T.content, {
    query: `active=true^topicIN${idList(topicIds)}^ORDERBYorder`,
    limit: 5000,
  });
  const wanted = (type: ContentType) => !opts.type || opts.type === 'all' || opts.type === type;
  const favorites = favoriteIds(ctx);
  const items = new Map<string, ContentItem>();
  const add = (
    base: Omit<ContentItem, 'popularity' | 'featured' | 'order' | 'favorite' | 'topic'>,
    row: { featured: boolean; order: number; topic: string },
  ) => {
    const existing = items.get(base.sys_id);
    if (existing) {
      existing.featured ||= row.featured;
      existing.order = Math.min(existing.order, row.order);
      return;
    }
    items.set(base.sys_id, {
      ...base,
      popularity: 0,
      featured: row.featured,
      order: row.order,
      favorite: favorites.has(base.sys_id),
      topic: topicNames.has(row.topic) ? { sys_id: row.topic, name: topicNames.get(row.topic)! } : null,
    });
  };
  const rowMeta = (r: Rec) => ({
    featured: r.bool('featured'),
    order: r.num('order') ?? 100,
    topic: r.str('topic'),
  });

  // Catalog items: connected rows plus items whose primary topic is in the set.
  if (wanted('catalog') && hasTable(ctx, EXT.catalogItem)) {
    const visible = catalogItemFilter(ctx);
    const linked = rows.filter((r) => r.str('content_type') === 'catalog' && r.str('catalog_item'));
    const ids = new Set(linked.map((r) => r.str('catalog_item')));
    const primary = hasColumn(ctx, EXT.catalogItem, 'taxonomy_topic')
      ? sys.query(EXT.catalogItem, { query: `taxonomy_topicIN${idList(topicIds)}`, limit: 2000 })
      : [];
    for (const p of primary) ids.add(p.sysId);
    const recs = new Map(
      sys.query(EXT.catalogItem, { query: `sys_idIN${idList(ids)}`, limit: 5000 }).map((r) => [r.sysId, r]),
    );
    for (const r of linked) {
      const item = recs.get(r.str('catalog_item'));
      if (visible(item)) add(catalogItemJson(item, lang), rowMeta(r));
    }
    for (const p of primary) {
      const item = recs.get(p.sysId);
      if (visible(item))
        add(catalogItemJson(item, lang), { featured: false, order: 100, topic: p.str('taxonomy_topic') });
    }
    const counts = orderCounts(
      ctx,
      [...items.values()].filter((i) => i.type === 'catalog').map((i) => i.sys_id),
    );
    for (const i of items.values()) if (i.type === 'catalog') i.popularity = counts.get(i.sys_id) ?? 0;
  }

  // Knowledge articles: connected rows plus articles whose primary topic is in the set.
  if (wanted('knowledge') && hasTable(ctx, EXT.article)) {
    const linked = rows.filter((r) => r.str('content_type') === 'knowledge' && r.str('knowledge'));
    const ids = new Set(linked.map((r) => r.str('knowledge')));
    const primary = hasColumn(ctx, EXT.article, 'taxonomy_topic')
      ? sys.query(EXT.article, { query: `taxonomy_topicIN${idList(topicIds)}`, limit: 2000 })
      : [];
    for (const p of primary) ids.add(p.sysId);
    const recs = new Map(
      sys.query(EXT.article, { query: `sys_idIN${idList(ids)}`, limit: 5000 }).map((r) => [r.sysId, r]),
    );
    const seenNumbers = new Set<string>();
    const addArticle = (
      article: Rec | undefined,
      meta: { featured: boolean; order: number; topic: string },
    ) => {
      if (!visibleArticle(ctx, article ?? null)) return;
      const number = article!.str('number');
      if (number && seenNumbers.has(number) && !items.has(article!.sysId)) return;
      if (number) seenNumbers.add(number);
      add(articleJson(article!, lang), meta);
      const item = items.get(article!.sysId);
      if (item) item.popularity = article!.has('sys_view_count') ? (article!.num('sys_view_count') ?? 0) : 0;
    };
    for (const r of linked) addArticle(recs.get(r.str('knowledge')), rowMeta(r));
    for (const p of primary)
      addArticle(recs.get(p.sysId), { featured: false, order: 100, topic: p.str('taxonomy_topic') });
  }

  // Quick links connected to the topics.
  if (wanted('quick_link')) {
    const linked = rows.filter((r) => r.str('content_type') === 'quick_link' && r.str('quick_link'));
    const recs = new Map(
      sys
        .query(T.quickLink, { query: `sys_idIN${idList(linked.map((r) => r.str('quick_link')))}` })
        .map((r) => [r.sysId, r]),
    );
    for (const r of linked) {
      const link = recs.get(r.str('quick_link'));
      if (!link || !visibleQuickLink(ctx, link)) continue;
      const j = quickLinkJson(link);
      add(
        {
          type: 'quick_link',
          type_label: t(lang, 'type.quick_link'),
          table: T.quickLink,
          sys_id: link.sysId,
          title: j.name,
          short_description: j.short_description,
          icon: j.icon,
          picture: '',
          url: j.url,
          page: j.page,
          updated: link.str('sys_updated_on'),
        },
        rowMeta(r),
      );
    }
  }

  const list = [...items.values()];
  const byName = (a: ContentItem, b: ContentItem) => a.title.localeCompare(b.title, lang);
  switch (opts.sort ?? 'popular') {
    case 'name':
      return list.sort(byName);
    case 'newest':
      return list.sort((a, b) => b.updated.localeCompare(a.updated) || byName(a, b));
    default:
      return list.sort(
        (a, b) =>
          Number(b.featured) - Number(a.featured) ||
          b.popularity - a.popularity ||
          a.order - b.order ||
          byName(a, b),
      );
  }
}

/** Topic page payload: breadcrumb, header, child topics and support resources. */
export function topicPage(
  ctx: Context,
  id: string,
  lang: Lang,
  opts: { type?: string; sort?: ContentSort } = {},
) {
  const topic = loadVisibleTopic(ctx, id);
  const ids = descendantTopicIds(ctx, topic.sysId);
  const all = topicContent(ctx, ids, lang, { sort: opts.sort });
  const type = opts.type && opts.type !== 'all' ? opts.type : 'all';
  const content = type === 'all' ? all : all.filter((i) => i.type === type);
  const children = visibleTopics(ctx)
    .filter((tp) => tp.str('parent_topic') === topic.sysId)
    .map((tp) => {
      const node = topicNode(tp);
      return {
        sys_id: node.sys_id,
        name: node.name,
        description: node.description,
        icon: node.icon,
        order: node.order,
      };
    });
  return {
    topic: { ...topicNode(topic), children: undefined, quick_links: undefined },
    breadcrumb: breadcrumbOf(ctx, topic),
    children,
    filter: type,
    sort: opts.sort ?? 'popular',
    counts: {
      all: all.length,
      catalog: all.filter((i) => i.type === 'catalog').length,
      knowledge: all.filter((i) => i.type === 'knowledge').length,
      quick_link: all.filter((i) => i.type === 'quick_link').length,
    },
    content,
    can_request: true,
  };
}

/** Topics shown on the home page: featured topics, else the first level below the departments. */
export function featuredTopics(ctx: Context) {
  const topics = visibleTopics(ctx);
  let picked = topics.filter((tp) => tp.bool('resolvr_featured'));
  if (!picked.length) {
    const roots = new Set(topics.filter((tp) => !tp.str('parent_topic')).map((tp) => tp.sysId));
    picked = topics.filter((tp) => roots.has(tp.str('parent_topic')));
    if (!picked.length) picked = topics.filter((tp) => roots.has(tp.sysId));
  }
  const childCount = new Map<string, number>();
  for (const tp of topics)
    if (tp.str('parent_topic'))
      childCount.set(tp.str('parent_topic'), (childCount.get(tp.str('parent_topic')) ?? 0) + 1);
  return picked.slice(0, 12).map((tp) => ({
    sys_id: tp.sysId,
    name: tp.str('name'),
    description: tp.str('description'),
    icon: tp.str('icon'),
    path: tp.str('topic_path') || tp.str('name'),
    children: childCount.get(tp.sysId) ?? 0,
  }));
}

// ------------------------------------------------------------------ favorites

const FAVORITE_TABLES: Record<string, ContentType | 'topic'> = {
  [EXT.catalogItem]: 'catalog',
  [EXT.article]: 'knowledge',
  [T.quickLink]: 'quick_link',
  [T.topic]: 'topic',
};

function favoriteKind(ctx: Context, table: string): ContentType | 'topic' | null {
  const meta = ctx.registry.tryTable(table);
  if (!meta) return null;
  for (const a of meta.ancestors) if (FAVORITE_TABLES[a]) return FAVORITE_TABLES[a];
  return null;
}

/** Sys_ids of the records the user marked as favorite. */
export function favoriteIds(ctx: Context): Set<string> {
  const me = ctx.user.sysId;
  if (!me) return new Set();
  return new Set(
    ctx
      .elevated()
      .query(T.favorite, { query: `user=${me}` })
      .map((f) => f.str('document')),
  );
}

function favoriteTarget(ctx: Context, table: string, id: string): Rec | null {
  const kind = favoriteKind(ctx, table);
  if (!kind || !isSysId(id)) return null;
  const rec = ctx.elevated().get(table, id);
  if (!rec) return null;
  if (kind === 'catalog') return visibleCatalogItem(ctx, rec) ? rec : null;
  if (kind === 'knowledge') return visibleArticle(ctx, rec) ? rec : null;
  if (kind === 'quick_link') return visibleQuickLink(ctx, rec) ? rec : null;
  return rec.bool('active') && (!rec.bool('enable_user_criteria_check') || visibleByCriteria(ctx, rec))
    ? rec
    : null;
}

function favoriteJson(ctx: Context, fav: Rec, target: Rec, lang: Lang) {
  const kind = favoriteKind(ctx, target.className)!;
  let base: { title: string; short_description: string; icon: string; url: string; page: string };
  if (kind === 'catalog') base = catalogItemJson(target, lang);
  else if (kind === 'knowledge') base = articleJson(target, lang);
  else if (kind === 'quick_link') {
    const j = quickLinkJson(target);
    base = { title: j.name, short_description: j.short_description, icon: j.icon, url: j.url, page: j.page };
  } else
    base = {
      title: target.str('name'),
      short_description: target.str('description'),
      icon: target.str('icon'),
      url: '',
      page: 'emp_taxonomy_topic',
    };
  return {
    sys_id: fav.sysId,
    table: target.className,
    document: target.sysId,
    type: kind,
    type_label: t(lang, `type.${kind}`),
    title: base.title,
    short_description: base.short_description,
    icon: base.icon,
    url: base.url,
    page: base.page,
    added: fav.str('sys_created_on'),
  };
}

/** The user's favorites; targets that were removed or are no longer visible are hidden (not deleted). */
export function listFavorites(ctx: Context, lang: Lang) {
  const me = ctx.user.sysId;
  if (!me) return [];
  const out: ReturnType<typeof favoriteJson>[] = [];
  for (const fav of ctx
    .elevated()
    .query(T.favorite, { query: `user=${me}^ORDERBYorder^ORDERBYDESCsys_created_on`, limit: 500 })) {
    const target = favoriteTarget(ctx, fav.str('table'), fav.str('document'));
    if (target) out.push(favoriteJson(ctx, fav, target, lang));
  }
  return out;
}

/** Adds a favorite (idempotent). Returns the favorite and whether it was created. */
export function addFavorite(
  ctx: Context,
  table: string,
  id: string,
  lang: Lang,
): { favorite: ReturnType<typeof favoriteJson>; created: boolean } {
  const me = ctx.user.sysId;
  if (!me) throw new InvalidError('Only signed-in users have favorites');
  if (!table || !favoriteKind(ctx, table))
    throw new InvalidError('This record cannot be a favorite', `Unsupported table ${table}`);
  const target = favoriteTarget(ctx, table, id);
  if (!target) throw new NotFoundError();
  const sys = ctx.elevated();
  const existing = sys.first(T.favorite, `user=${me}^document=${target.sysId}`);
  if (existing) return { favorite: favoriteJson(ctx, existing, target, lang), created: false };
  const fav = sys.insert(T.favorite, { user: me, table: target.className, document: target.sysId });
  return { favorite: favoriteJson(ctx, fav, target, lang), created: true };
}

/** Removes a favorite by its sys_id or by the favorite record's document (idempotent). */
export function removeFavorite(ctx: Context, id: string): boolean {
  const me = ctx.user.sysId;
  if (!me || !isSysId(id)) return false;
  const sys = ctx.elevated();
  const rows = sys.query(T.favorite, { query: `user=${me}^sys_id=${id}^ORdocument=${id}` });
  for (const r of rows) sys.delete(r);
  return rows.length > 0;
}
