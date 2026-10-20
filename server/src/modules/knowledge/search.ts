import type { Context } from '../../engine/context.js';
import type { SqlParam } from '../../engine/db.js';
import type { Platform } from '../../engine/platform.js';
import { QueryCompiler } from '../../engine/query/compiler.js';
import type { Rec } from '../../engine/record.js';
import { chunk, nowGlide } from '../../engine/util.js';
import type { KnowledgeAccess } from './access.js';
import { ARTICLE, articleCol, escapeHtml, physTable, props, stripHtml, today, truncate } from './util.js';

/** FTS5 index over articles (number, title, body without markup, meta tags). */
export const FTS_TABLE = 'resolvr_kb_fts';

/** Column weights for bm25: sys_id (unindexed), number, short description, body, meta. */
const BM25_WEIGHTS = '0.0, 4.0, 4.0, 1.0, 2.0';
const HIT_OPEN = '\u0002';
const HIT_CLOSE = '\u0003';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'why',
  'with',
  'you',
  'your',
]);

export type SearchOrder = 'relevance' | 'views' | 'newest' | 'alphabetical';

export interface SearchOptions {
  query?: string;
  /** Restrict to these knowledge bases. */
  kbs?: string[];
  /** Restrict to these categories (already expanded to descendants). */
  categories?: string[];
  /** Encoded query on kb_knowledge. */
  filter?: string;
  /** Languages to include; null or empty means all. */
  languages?: string[] | null;
  /** Restrict to these article sys_ids. */
  ids?: string[];
  limit: number;
  offset: number;
  order?: SearchOrder;
  /** Write a ts_query_kb search log row. */
  log?: { source: string; sessionId?: string | null } | null;
}

export interface SearchHit {
  rec: Rec;
  score: number;
  /** HTML-escaped text with matches wrapped in <B>..</B>. */
  snippet: string;
  /** 1-based position in the whole result set. */
  rank: number;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
  searchId: string | null;
  terms: string[];
}

/** Lower-cased search words without punctuation; stop words are dropped when other words remain. */
export function searchTerms(q: string | null | undefined): string[] {
  const words =
    String(q ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  return [...new Set(meaningful.length ? meaningful : words)].slice(0, 12);
}

function matchExpression(terms: string[], op: 'AND' | 'OR'): string {
  return terms.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(op === 'AND' ? ' ' : ' OR ');
}

/** Stable FTS rowid derived from the article sys_id (52 bits of the random hex id). */
export function ftsRowId(sysId: string): number {
  return Number.parseInt(sysId.slice(0, 13), 16) || 0;
}

function formatSnippet(raw: string): string {
  return escapeHtml(raw.replace(/\s+/g, ' ').trim())
    .replaceAll(HIT_OPEN, '<B>')
    .replaceAll(HIT_CLOSE, '</B>');
}

/** Small popularity boost (at most +25%) applied on top of text relevance. */
export function popularityBoost(views: number, rating: number): number {
  return Math.min(0.25, 0.05 * Math.log10(1 + Math.max(0, views)) + 0.02 * Math.max(0, rating));
}

interface Candidate {
  sysId: string;
  relevance: number;
  snippet: string;
  views: number;
  rating: number;
}

export class KnowledgeSearch {
  constructor(
    private platform: Platform,
    private access: KnowledgeAccess,
  ) {}

  // ------------------------------------------------------------------ index maintenance

  ensureIndex(): void {
    this.platform.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(sys_id UNINDEXED, number, short_description, body, meta, tokenize = 'porter unicode61 remove_diacritics 2')`,
    );
  }

  indexArticle(rec: Rec): void {
    const body = stripHtml(rec.str('text') || rec.str('wiki'));
    const rowid = ftsRowId(rec.sysId);
    this.platform.db.run(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`, [rowid]);
    this.platform.db.run(
      `INSERT INTO ${FTS_TABLE} (rowid, sys_id, number, short_description, body, meta) VALUES (?,?,?,?,?,?)`,
      [rowid, rec.sysId, rec.str('number'), rec.str('short_description'), body, rec.str('meta')],
    );
  }

  removeArticle(sysId: string): void {
    this.platform.db.run(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`, [ftsRowId(sysId)]);
  }

  /** Rebuilds the index from the article table. */
  rebuild(): number {
    const ctx = this.platform.systemContext();
    const meta = this.platform.registry.table(ARTICLE);
    let n = 0;
    this.platform.db.tx(() => {
      this.platform.db.run(`DELETE FROM ${FTS_TABLE}`);
      for (const row of this.platform.db.all<Record<string, unknown>>(
        `SELECT * FROM ${physTable(this.platform, ARTICLE)}`,
      )) {
        this.indexArticle(ctx.rowToRec(row, meta));
        n++;
      }
    });
    return n;
  }

  /** Rebuilds when the index and the article table disagree (new install, restored database). */
  rebuildIfNeeded(): void {
    const articles =
      this.platform.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${physTable(this.platform, ARTICLE)}`)
        ?.n ?? 0;
    const indexed = this.platform.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`)?.n ?? 0;
    if (articles !== indexed) this.rebuild();
  }

  // ------------------------------------------------------------------ search

  /**
   * Searches published, active, unexpired articles the user may read. Text queries are
   * ranked by bm25 (title and number weigh more than the body) with a small boost for
   * view count and rating; without text, articles are ordered by views.
   */
  search(ctx: Context, opts: SearchOptions): SearchResult {
    const terms = searchTerms(opts.query);
    const corpus = this.corpusWhere(ctx, opts);
    let candidates: Candidate[] = [];
    if (terms.length) {
      candidates = this.textCandidates(terms, 'AND', corpus);
      const operator = props(this.platform).str('glide.knowman.search.operator', 'and_then_or').toLowerCase();
      if (terms.length > 1 && (operator === 'or' || (candidates.length === 0 && operator !== 'and'))) {
        candidates = this.textCandidates(terms, 'OR', corpus);
      }
    } else {
      candidates = this.plainCandidates(corpus);
    }

    const recs = this.loadReadable(
      ctx,
      candidates.map((c) => c.sysId),
    );
    const scored = candidates
      .filter((c) => recs.has(c.sysId))
      .map((c) => {
        const rec = recs.get(c.sysId)!;
        const score = terms.length ? c.relevance * (1 + popularityBoost(c.views, c.rating)) : c.views;
        const snippet = c.snippet.includes(HIT_OPEN)
          ? formatSnippet(c.snippet)
          : escapeHtml(truncate(stripHtml(rec.str('text')).replace(/\s+/g, ' '), 200));
        return { rec, score, snippet, views: c.views };
      });

    const order: SearchOrder = opts.order ?? (terms.length ? 'relevance' : 'views');
    const byTitle = (a: { rec: Rec }, b: { rec: Rec }) =>
      a.rec.str('short_description').localeCompare(b.rec.str('short_description'));
    scored.sort((a, b) => {
      switch (order) {
        case 'views':
          return b.views - a.views || byTitle(a, b);
        case 'newest':
          return (
            (b.rec.str('published') || b.rec.str('sys_updated_on')).localeCompare(
              a.rec.str('published') || a.rec.str('sys_updated_on'),
            ) || byTitle(a, b)
          );
        case 'alphabetical':
          return byTitle(a, b);
        default:
          return b.score - a.score || b.views - a.views || byTitle(a, b);
      }
    });

    const page = scored.slice(opts.offset, opts.offset + opts.limit);
    const hits: SearchHit[] = page.map((s, i) => ({
      rec: s.rec,
      score: Math.round(s.score * 1000) / 1000,
      snippet: s.snippet,
      rank: opts.offset + i + 1,
    }));
    const searchId =
      terms.length && opts.log
        ? this.logSearch(ctx, String(opts.query ?? ''), scored.length, order, opts.log)
        : null;
    return { total: scored.length, hits, searchId, terms };
  }

  /** Published, valid articles the user may read (no text matching), ordered by views. */
  corpus(ctx: Context, opts: Omit<SearchOptions, 'limit' | 'offset' | 'query'>): Rec[] {
    const corpus = this.corpusWhere(ctx, opts);
    const candidates = this.plainCandidates(corpus);
    const recs = this.loadReadable(
      ctx,
      candidates.map((c) => c.sysId),
    );
    return candidates.filter((c) => recs.has(c.sysId)).map((c) => recs.get(c.sysId)!);
  }

  private corpusWhere(
    ctx: Context,
    opts: Omit<SearchOptions, 'limit' | 'offset'>,
  ): { sql: string; params: SqlParam[] } {
    const c = (f: string) => `k.${articleCol(this.platform, f)}`;
    const where: string[] = [
      `${c('workflow_state')} = 'published'`,
      `(${c('active')} IS NULL OR ${c('active')} = 1)`,
      `${c('valid_to')} >= ?`,
    ];
    const params: SqlParam[] = [today()];
    let kbs: string[] | null = this.access.isKnowledgeAdmin(ctx) ? null : this.access.readableKbIds(ctx);
    if (opts.kbs?.length) kbs = kbs ? kbs.filter((k) => opts.kbs!.includes(k)) : opts.kbs;
    if (kbs) {
      if (!kbs.length) return { sql: '1=0', params: [] };
      where.push(`${c('kb_knowledge_base')} IN (${kbs.map(() => '?').join(',')})`);
      params.push(...kbs);
    }
    if (opts.categories?.length) {
      where.push(`${c('kb_category')} IN (${opts.categories.map(() => '?').join(',')})`);
      params.push(...opts.categories);
    }
    if (opts.ids) {
      if (!opts.ids.length) return { sql: '1=0', params: [] };
      where.push(`k."sys_id" IN (${opts.ids.map(() => '?').join(',')})`);
      params.push(...opts.ids);
    }
    const langs = (opts.languages ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
    if (langs.length) {
      const blank = langs.includes('en') ? ` OR COALESCE(${c('language')}, '') = ''` : '';
      where.push(`(LOWER(${c('language')}) IN (${langs.map(() => '?').join(',')})${blank})`);
      params.push(...langs);
    }
    if (opts.filter?.trim()) {
      const compiled = QueryCompiler.compile(this.platform.registry, ARTICLE, opts.filter, ctx.env);
      where.push(
        `k."sys_id" IN (SELECT t0."sys_id" FROM ${compiled.from} ${compiled.joins.join(' ')} WHERE ${compiled.where})`,
      );
      params.push(...compiled.params);
    }
    return { sql: where.join(' AND '), params };
  }

  private textCandidates(
    terms: string[],
    op: 'AND' | 'OR',
    corpus: { sql: string; params: SqlParam[] },
  ): Candidate[] {
    const c = (f: string) => `k.${articleCol(this.platform, f)}`;
    const rows = this.platform.db.all<{
      sys_id: string;
      bm: number;
      snip: string;
      views: number | null;
      rating: number | null;
    }>(
      `SELECT k."sys_id" AS sys_id, bm25(${FTS_TABLE}, ${BM25_WEIGHTS}) AS bm, snippet(${FTS_TABLE}, 3, ?, ?, '...', 24) AS snip,
              ${c('sys_view_count')} AS views, ${c('rating')} AS rating
         FROM ${FTS_TABLE} JOIN ${physTable(this.platform, ARTICLE)} k ON k."sys_id" = ${FTS_TABLE}.sys_id
        WHERE ${FTS_TABLE} MATCH ? AND ${corpus.sql}`,
      [HIT_OPEN, HIT_CLOSE, matchExpression(terms, op), ...corpus.params],
    );
    return rows.map((r) => ({
      sysId: r.sys_id,
      relevance: -Number(r.bm ?? 0),
      snippet: r.snip ?? '',
      views: Number(r.views ?? 0),
      rating: Number(r.rating ?? 0),
    }));
  }

  private plainCandidates(corpus: { sql: string; params: SqlParam[] }): Candidate[] {
    const c = (f: string) => `k.${articleCol(this.platform, f)}`;
    const rows = this.platform.db.all<{ sys_id: string; views: number | null; rating: number | null }>(
      `SELECT k."sys_id" AS sys_id, ${c('sys_view_count')} AS views, ${c('rating')} AS rating
         FROM ${physTable(this.platform, ARTICLE)} k
        WHERE ${corpus.sql}
        ORDER BY COALESCE(${c('sys_view_count')}, 0) DESC, ${c('short_description')} ASC`,
      corpus.params,
    );
    return rows.map((r) => ({
      sysId: r.sys_id,
      relevance: 0,
      snippet: '',
      views: Number(r.views ?? 0),
      rating: Number(r.rating ?? 0),
    }));
  }

  /** Loads candidate rows and keeps those the user may read (record ACLs). */
  private loadReadable(ctx: Context, ids: string[]): Map<string, Rec> {
    const out = new Map<string, Rec>();
    if (!ids.length) return out;
    const meta = this.platform.registry.table(ARTICLE);
    const applyAcls = props(this.platform).bool('glide.knowman.search.apply_acls', true);
    for (const part of chunk(ids, 400)) {
      const rows = this.platform.db.all<Record<string, unknown>>(
        `SELECT * FROM ${physTable(this.platform, ARTICLE)} WHERE "sys_id" IN (${part.map(() => '?').join(',')})`,
        part,
      );
      for (const row of rows) {
        const rec = ctx.rowToRec(row, meta);
        if (applyAcls && !this.platform.acl.canTable(ctx, rec.className, 'read', rec).allowed) continue;
        out.set(rec.sysId, rec);
      }
    }
    return out;
  }

  /** Writes a ts_query_kb row; the last successful term of a session is flagged as final. */
  private logSearch(
    ctx: Context,
    term: string,
    results: number,
    order: SearchOrder,
    log: { source: string; sessionId?: string | null },
  ): string | null {
    if (!this.platform.registry.has('ts_query_kb')) return null;
    const e = ctx.elevated();
    const sessionId = log.sessionId ?? '';
    if (results > 0 && sessionId) {
      this.platform.db.run(
        `UPDATE "ts_query_kb" SET "final_search_term" = 0 WHERE "session_id" = ? AND "final_search_term" = 1`,
        [sessionId],
      );
    }
    const row = e.insert('ts_query_kb', {
      search_term: truncate(term, 1000),
      results,
      user: ctx.user.sysId ?? '',
      sort_order: order,
      session_id: sessionId,
      source: log.source,
      final_search_term: results > 0 && !!sessionId,
    });
    return row.sysId;
  }

  /** Records the best (lowest) clicked rank of a search. */
  recordClick(searchId: string, rank: number): void {
    if (!searchId || !Number.isFinite(rank) || rank < 1) return;
    this.platform.db.run(
      `UPDATE "ts_query_kb" SET "highest_click_rank" = ?, "sys_updated_on" = ? WHERE "sys_id" = ? AND ("highest_click_rank" IS NULL OR "highest_click_rank" > ?)`,
      [rank, nowGlide(), searchId, rank],
    );
  }
}
