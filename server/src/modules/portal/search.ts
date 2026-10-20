import type { Context } from '../../engine/context.js';
import { AccessError } from '../../engine/errors.js';
import { Rec } from '../../engine/record.js';
import { optionalService, SERVICES } from '../contracts.js';
import { EXT, PROPS, T } from './constants.js';
import { type Lang, t } from './i18n.js';
import {
  articleJson,
  catalogItemFilter,
  catalogItemJson,
  descendantTopicIds,
  favoriteIds,
  visibleArticle,
} from './taxonomy.js';
import { hasColumn, hasTable, idList, q, searchWords } from './util.js';

export type SearchSource = 'all' | 'knowledge' | 'catalog';

export interface SearchParams {
  q: string;
  source?: SearchSource;
  /** Topic sys_id (includes its sub-topics). */
  topic?: string | null;
  /** Knowledge base sys_id. */
  kb?: string | null;
  /** Article type (article_type value, else class name). */
  type?: string | null;
  limit?: number;
  offset?: number;
}

interface Hit {
  rec: Rec;
  snippet: string;
  score: number;
}

const CANDIDATES = 300;
const GROUP_SIZE = 5;

export function normalizeSource(v: unknown): SearchSource {
  const s = String(v ?? 'all').toLowerCase();
  if (s === 'kb' || s === 'knowledge') return 'knowledge';
  if (s === 'catalog' || s === 'catalogs' || s === 'sc') return 'catalog';
  return 'all';
}

// ------------------------------------------------------------------ knowledge

interface KnowledgeSearchLike {
  search: (ctx: Context, opts: Record<string, unknown>) => unknown;
}

/** Finds the knowledge module's search function, whichever shape the service has. */
function knowledgeSearchFn(ctx: Context): ((opts: Record<string, unknown>) => unknown) | null {
  const svc = optionalService<Record<string, unknown>>(ctx.platform, SERVICES.knowledge);
  if (!svc) return null;
  if (typeof svc.search === 'function')
    return (opts) => (svc as unknown as KnowledgeSearchLike).search(ctx, opts);
  const inner = svc.search as Record<string, unknown> | undefined;
  if (inner && typeof inner.search === 'function')
    return (opts) => (inner as unknown as KnowledgeSearchLike).search(ctx, opts);
  return null;
}

function toHits(result: unknown): Hit[] | null {
  const list = Array.isArray(result)
    ? result
    : Array.isArray((result as { hits?: unknown })?.hits)
      ? (result as { hits: unknown[] }).hits
      : null;
  if (!list) return null;
  const out: Hit[] = [];
  for (const h of list) {
    if (h instanceof Rec) out.push({ rec: h, snippet: '', score: 0 });
    else if (h && typeof h === 'object' && (h as { rec?: unknown }).rec instanceof Rec) {
      const hit = h as { rec: Rec; snippet?: unknown; score?: unknown };
      out.push({
        rec: hit.rec,
        snippet: typeof hit.snippet === 'string' ? hit.snippet : '',
        score: Number(hit.score ?? 0) || 0,
      });
    }
  }
  return out;
}

/** Published articles matching the query: through the knowledge search service when installed, else a text query. */
function knowledgeHits(ctx: Context, text: string, kb: string | null): Hit[] {
  if (!hasTable(ctx, EXT.article)) return [];
  const search = knowledgeSearchFn(ctx);
  if (search) {
    try {
      const hits = toHits(
        search({
          query: text,
          limit: CANDIDATES,
          offset: 0,
          kbs: kb ? [kb] : undefined,
          log: { source: 'portal' },
        }),
      );
      if (hits) return hits.filter((h) => visibleArticle(ctx, h.rec));
    } catch {
      // Fall back to the table query below.
    }
  }
  const parts = [`123TEXTQUERY321=${q(text)}`];
  if (hasColumn(ctx, EXT.article, 'workflow_state')) parts.push('workflow_state=published');
  if (hasColumn(ctx, EXT.article, 'active')) parts.push('active=true^ORactiveISEMPTY');
  if (kb && hasColumn(ctx, EXT.article, 'kb_knowledge_base')) parts.push(`kb_knowledge_base=${q(kb)}`);
  const order = hasColumn(ctx, EXT.article, 'sys_view_count') ? '^ORDERBYDESCsys_view_count' : '';
  return readable(() => ctx.query(EXT.article, { query: `${parts.join('^')}${order}`, limit: CANDIDATES }))
    .filter((r) => visibleArticle(ctx, r))
    .map((rec) => ({ rec, snippet: '', score: 0 }));
}

/** Runs a query as the user; a table the user cannot read yields no results. */
function readable(run: () => Rec[]): Rec[] {
  try {
    return run();
  } catch (e) {
    if (e instanceof AccessError) return [];
    throw e;
  }
}

// ------------------------------------------------------------------ catalog

function catalogHits(ctx: Context, text: string): Rec[] {
  if (!hasTable(ctx, EXT.catalogItem)) return [];
  const words = searchWords(text);
  if (!words.length) return [];
  const textFields = ['name', 'short_description', 'meta'].filter((f) => hasColumn(ctx, EXT.catalogItem, f));
  if (!textFields.length) return [];
  const parts: string[] = [];
  if (hasColumn(ctx, EXT.catalogItem, 'active')) parts.push('active=true');
  for (const f of ['hide_sp', 'no_search'])
    if (hasColumn(ctx, EXT.catalogItem, f)) parts.push(`${f}=false^OR${f}ISEMPTY`);
  for (const w of words) parts.push(textFields.map((f, i) => `${i ? '^OR' : ''}${f}LIKE${q(w)}`).join(''));
  const order = hasColumn(ctx, EXT.catalogItem, 'order') ? '^ORDERBYorder^ORDERBYname' : '';
  let items = readable(() =>
    ctx.query(EXT.catalogItem, { query: `${parts.join('^')}${order}`, limit: CANDIDATES }),
  ).filter(catalogItemFilter(ctx, { search: true }));
  if (ctx.platform.properties.getBool(PROPS.catalogRequiresTopic, false)) {
    const connected = connectedIds(ctx, 'catalog', null);
    items = items.filter(
      (i) => connected.has(i.sysId) || (i.has('taxonomy_topic') && !!i.str('taxonomy_topic')),
    );
  }
  return items;
}

/** Content sys_ids connected to topics (optionally restricted to a set of topics). */
function connectedIds(ctx: Context, type: 'catalog' | 'knowledge', topicIds: string[] | null): Set<string> {
  const field = type === 'catalog' ? 'catalog_item' : 'knowledge';
  const where = topicIds ? `^topicIN${idList(topicIds)}` : '';
  return new Set(
    ctx
      .elevated()
      .query(T.content, { query: `active=true^content_type=${type}${where}`, limit: 10000 })
      .map((r) => r.str(field)),
  );
}

/** Topics an article or item belongs to (connected content plus its primary topic). */
function topicsByContent(ctx: Context, type: 'catalog' | 'knowledge', recs: Rec[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!recs.length) return out;
  const field = type === 'catalog' ? 'catalog_item' : 'knowledge';
  const add = (id: string, topic: string) => {
    if (!topic) return;
    const set = out.get(id) ?? new Set<string>();
    set.add(topic);
    out.set(id, set);
  };
  for (const row of ctx.elevated().query(T.content, {
    query: `active=true^content_type=${type}^${field}IN${idList(recs.map((r) => r.sysId))}`,
    limit: 10000,
  })) {
    add(row.str(field), row.str('topic'));
  }
  for (const r of recs) if (r.has('taxonomy_topic')) add(r.sysId, r.str('taxonomy_topic'));
  return out;
}

function articleType(rec: Rec): { value: string; label: string } {
  if (rec.className !== EXT.article) return { value: rec.className, label: rec.table.label };
  const v = rec.has('article_type') ? rec.str('article_type') : '';
  return v
    ? { value: v, label: rec.display('article_type') || v }
    : { value: rec.className, label: rec.table.label };
}

interface FacetValue {
  value: string;
  label: string;
  count: number;
}

function facet(counts: Map<string, FacetValue>): FacetValue[] {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function bump(map: Map<string, FacetValue>, value: string, label: string): void {
  if (!value) return;
  const f = map.get(value) ?? { value, label, count: 0 };
  f.count++;
  map.set(value, f);
}

// ------------------------------------------------------------------ unified search

/**
 * Portal search over catalog items and knowledge articles, grouped by source with
 * facets (source, and for knowledge: topic, knowledge base, type of article).
 */
export function portalSearch(ctx: Context, params: SearchParams, lang: Lang) {
  const text = String(params.q ?? '').trim();
  const source = params.source ?? 'all';
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const topicFilter = params.topic ? new Set(descendantTopicIds(ctx, params.topic)) : null;
  const showKnowledge = source !== 'catalog';
  const showCatalog = source !== 'knowledge';

  let articles: Hit[] = [];
  let items: Rec[] = [];
  if (text) {
    articles = knowledgeHits(ctx, text, params.kb ?? null);
    items = catalogHits(ctx, text);
  }

  // Facets are counted on the text matches, before the facet filters are applied.
  const articleTopics = topicsByContent(
    ctx,
    'knowledge',
    articles.map((h) => h.rec),
  );
  const itemTopics = topicsByContent(ctx, 'catalog', items);
  const topicNames = new Map(
    ctx
      .elevated()
      .query(T.topic, {
        query: `sys_idIN${idList([...articleTopics.values(), ...itemTopics.values()].flatMap((s) => [...s]))}`,
      })
      .map((tp) => [tp.sysId, tp.str('name')]),
  );
  const topicFacet = new Map<string, FacetValue>();
  const kbFacet = new Map<string, FacetValue>();
  const typeFacet = new Map<string, FacetValue>();
  for (const h of articles) {
    for (const tp of articleTopics.get(h.rec.sysId) ?? []) bump(topicFacet, tp, topicNames.get(tp) ?? tp);
    if (h.rec.has('kb_knowledge_base'))
      bump(kbFacet, h.rec.str('kb_knowledge_base'), h.rec.display('kb_knowledge_base'));
    const at = articleType(h.rec);
    bump(typeFacet, at.value, at.label);
  }

  const inTopic = (topics: Set<string> | undefined) =>
    !topicFilter || [...(topics ?? [])].some((tp) => topicFilter.has(tp));
  const filteredArticles = articles.filter(
    (h) =>
      inTopic(articleTopics.get(h.rec.sysId)) &&
      (!params.kb || (h.rec.has('kb_knowledge_base') && h.rec.str('kb_knowledge_base') === params.kb)) &&
      (!params.type || articleType(h.rec).value === params.type),
  );
  const filteredItems = items.filter((i) => inTopic(itemTopics.get(i.sysId)));
  const favorites = favoriteIds(ctx);

  const pageOf = <X>(list: X[]) =>
    source === 'all' ? list.slice(0, GROUP_SIZE) : list.slice(offset, offset + limit);
  const groups: Record<string, unknown>[] = [];
  if (showKnowledge && hasTable(ctx, EXT.article)) {
    groups.push({
      source: 'knowledge',
      label: t(lang, 'search.knowledge'),
      total: filteredArticles.length,
      results: pageOf(filteredArticles).map((h) => ({
        ...articleJson(h.rec, lang),
        number: h.rec.str('number'),
        snippet: h.snippet || articleJson(h.rec, lang).short_description,
        knowledge_base:
          h.rec.has('kb_knowledge_base') && h.rec.str('kb_knowledge_base')
            ? { sys_id: h.rec.str('kb_knowledge_base'), name: h.rec.display('kb_knowledge_base') }
            : null,
        article_type: articleType(h.rec),
        views: h.rec.has('sys_view_count') ? (h.rec.num('sys_view_count') ?? 0) : 0,
        score: h.score,
        favorite: favorites.has(h.rec.sysId),
      })),
    });
  }
  if (showCatalog && hasTable(ctx, EXT.catalogItem)) {
    groups.push({
      source: 'catalog',
      label: t(lang, 'search.catalog'),
      total: filteredItems.length,
      results: pageOf(filteredItems).map((i) => ({
        ...catalogItemJson(i, lang),
        price: i.has('price') ? i.str('price') : '',
        action_label: t(lang, 'search.request'),
        favorite: favorites.has(i.sysId),
      })),
    });
  }

  const knowledgeCount = hasTable(ctx, EXT.article) ? filteredArticles.length : 0;
  const catalogCount = hasTable(ctx, EXT.catalogItem) ? filteredItems.length : 0;
  const facets: Record<string, FacetValue[]> = {
    source: [
      { value: 'all', label: t(lang, 'search.all'), count: knowledgeCount + catalogCount },
      { value: 'knowledge', label: t(lang, 'search.knowledge'), count: knowledgeCount },
      { value: 'catalog', label: t(lang, 'search.catalog'), count: catalogCount },
    ],
  };
  if (showKnowledge) {
    facets.topic = facet(topicFacet);
    facets.knowledge_base = facet(kbFacet);
    facets.article_type = facet(typeFacet);
  }
  return {
    query: text,
    source,
    filters: { topic: params.topic ?? null, kb: params.kb ?? null, type: params.type ?? null },
    limit: source === 'all' ? GROUP_SIZE : limit,
    offset: source === 'all' ? 0 : offset,
    total: (showKnowledge ? knowledgeCount : 0) + (showCatalog ? catalogCount : 0),
    groups,
    facets,
    message:
      text && !groups.some((g) => (g.total as number) > 0) ? t(lang, 'search.no_results', { q: text }) : null,
  };
}
