/**
 * Similar records, knowledge suggestions and clustering over TF-IDF vectors.
 *
 * Indexes are built per table with the system context (most recent records first,
 * window capped by resolvr.ml.similarity.window) and rebuilt lazily after records
 * change. Every hit is re-checked against the caller's read access before it is
 * returned, so the index never leaks records.
 */
import type { Context } from '../../../engine/context.js';
import type { Platform } from '../../../engine/platform.js';
import type { Rec } from '../../../engine/record.js';
import type { TableMeta } from '../../../engine/types.js';
import { PROP } from '../config.js';
import { AI_TABLE_NAMES } from '../tables.js';
import { agglomerative, cluster } from './cluster.js';
import {
  fieldText,
  openRecordsQuery,
  publishedKnowledgeQuery,
  recordText,
  recordTitle,
  similarityFields,
} from './records.js';
import { analyze, plainText, SurfaceForms, truncate } from './text.js';
import { dot, dotDense, type SparseVec, TfidfVectorizer } from './tfidf.js';

export interface SimilarHit {
  table: string;
  sys_id: string;
  number: string;
  title: string;
  score: number;
  state?: string;
  active?: boolean;
  snippet?: string;
  knowledge_base?: string;
  updated?: string;
}

interface IndexedDoc {
  sysId: string;
  className: string;
  vec: SparseVec;
}

interface TableIndex {
  table: string;
  vectorizer: TfidfVectorizer;
  docs: IndexedDoc[];
  version: number;
}

export interface ClusterMember {
  sys_id: string;
  table: string;
  number: string;
  title: string;
  score: number;
}

export interface ClusterInfo {
  id: string;
  size: number;
  cohesion: number;
  concept: string;
  terms: string[];
  purity: { field: string; value: string; display: string; share: number }[];
  problem_candidate: boolean;
  members: ClusterMember[];
}

export interface ClusterResult {
  table: string;
  records: number;
  method: 'agglomerative' | 'kmeans';
  k: number;
  clusters: ClusterInfo[];
}

/** Fields that, when changed, invalidate a table's index. */
const FILTER_FIELDS = ['active', 'state', 'workflow_state', 'valid_to'];

export class SimilarityService {
  private indexes = new Map<string, TableIndex>();
  private versions = new Map<string, number>();

  constructor(private readonly platform: Platform) {}

  /** Hook body: marks the indexes of a changed record's table hierarchy as stale. */
  noteChange(rec: Rec, event: 'insert' | 'update' | 'delete'): void {
    if (AI_TABLE_NAMES.has(rec.table.name) || rec.table.name.startsWith('sys_')) return;
    if (!rec.table.ancestors.some((t) => this.indexes.has(t))) return;
    if (event === 'update') {
      const fields = [...similarityFields(rec.table).map((f) => f.field), ...FILTER_FIELDS];
      if (!fields.some((f) => rec.has(f) && rec.changed(f))) return;
    }
    for (const t of rec.table.ancestors) {
      if (this.indexes.has(t)) this.versions.set(t, (this.versions.get(t) ?? 0) + 1);
    }
  }

  private baseQuery(meta: TableMeta): string {
    return meta.ancestors.includes('kb_knowledge') ? publishedKnowledgeQuery(meta) : '';
  }

  private index(table: string): TableIndex | null {
    const meta = this.platform.registry.tryTable(table);
    if (!meta) return null;
    const version = this.versions.get(table) ?? 0;
    const cached = this.indexes.get(table);
    if (cached && cached.version === version) return cached;
    const window = this.platform.properties.getNumber(PROP.simWindow, 5000);
    const fields = similarityFields(meta);
    const recs = this.platform.systemContext().query(table, {
      query: this.baseQuery(meta),
      orderBy: [{ field: 'sys_created_on', desc: true }],
      limit: window,
    });
    const tokens = recs.map((r) => analyze(recordText(r, fields)));
    const vectorizer = TfidfVectorizer.fit(tokens, { minDf: 1 });
    const docs: IndexedDoc[] = [];
    recs.forEach((r, i) => {
      const vec = vectorizer.transform(tokens[i]);
      if (vec.idx.length) docs.push({ sysId: r.sysId, className: r.className, vec });
    });
    const idx: TableIndex = { table, vectorizer, docs, version };
    this.indexes.set(table, idx);
    this.versions.set(table, version);
    return idx;
  }

  private minScore(override?: number): number {
    if (override !== undefined && Number.isFinite(override)) return override;
    return this.platform.properties.getNumber(PROP.simMinScore, 20);
  }

  private toHit(rec: Rec, score: number): SimilarHit {
    const hit: SimilarHit = {
      table: rec.className,
      sys_id: rec.sysId,
      number: rec.has('number') ? rec.str('number') : rec.displayValue(),
      title: recordTitle(rec),
      score,
      updated: rec.str('sys_updated_on'),
    };
    if (rec.has('state')) hit.state = rec.display('state');
    if (rec.has('active')) hit.active = rec.bool('active');
    if (rec.table.ancestors.includes('kb_knowledge')) {
      hit.snippet = truncate(plainText(rec.str('text')).replace(/\s+/g, ' '), 240);
      if (rec.has('kb_knowledge_base')) hit.knowledge_base = rec.display('kb_knowledge_base');
    }
    return hit;
  }

  /** Records of `target` most similar to free text, filtered by the caller's read access. */
  similarToText(
    ctx: Context,
    text: string,
    target: string,
    opts: { limit?: number; minScore?: number; exclude?: string[]; filter?: (rec: Rec) => boolean } = {},
  ): SimilarHit[] {
    const idx = this.index(target);
    if (!idx || !text.trim()) return [];
    const q = idx.vectorizer.queryVector(analyze(text));
    if (!q.idx.length) return [];
    const limit = opts.limit ?? 5;
    const min = this.minScore(opts.minScore);
    const exclude = new Set(opts.exclude ?? []);
    const scored = idx.docs
      .map((d) => ({ d, s: Math.round(dot(q, d.vec) * 100) }))
      .filter((x) => x.s >= min && !exclude.has(x.d.sysId))
      .sort((a, b) => b.s - a.s);
    const out: SimilarHit[] = [];
    for (const { d, s } of scored) {
      const rec = ctx.get(d.className, d.sysId);
      if (!rec || (opts.filter && !opts.filter(rec))) continue;
      out.push(this.toHit(rec, s));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Text that describes a record for similarity purposes. */
  textOf(rec: Rec): string {
    return recordText(rec, similarityFields(rec.table));
  }

  /** Similar records in each target table (the source record itself is excluded). */
  similarToRecord(
    ctx: Context,
    rec: Rec,
    targets: string[],
    opts: { limit?: number; minScore?: number } = {},
  ): Record<string, SimilarHit[]> {
    const text = this.textOf(rec);
    const out: Record<string, SimilarHit[]> = {};
    for (const t of targets) {
      if (!this.platform.registry.has(t)) continue;
      out[t] = this.similarToText(ctx, text, t, { ...opts, exclude: [rec.sysId] });
    }
    return out;
  }

  /** Published knowledge articles matching a text. */
  suggestKnowledge(
    ctx: Context,
    text: string,
    opts: { limit?: number; minScore?: number } = {},
  ): SimilarHit[] {
    if (!this.platform.registry.has('kb_knowledge')) return [];
    return this.similarToText(ctx, text, 'kb_knowledge', opts);
  }

  /**
   * Clusters the open records of a table the caller can read (problem candidates).
   * A cluster is a candidate when it has at least `minSize` members and a cohesion
   * (mean similarity to the centroid) of at least `minCohesion`.
   */
  clusters(
    ctx: Context,
    table: string,
    opts: {
      minSize?: number;
      minCohesion?: number;
      minSimilarity?: number;
      limit?: number;
      query?: string;
      k?: number;
    } = {},
  ): ClusterResult {
    const meta = this.platform.registry.table(table);
    const window = Math.min(this.platform.properties.getNumber(PROP.simWindow, 5000), opts.limit ?? 2000);
    const query = [opts.query ?? openRecordsQuery(this.platform, meta)].filter(Boolean).join('^');
    const recs = ctx.query(table, {
      query,
      orderBy: [{ field: 'sys_created_on', desc: true }],
      limit: window,
    });
    const fields = similarityFields(meta);
    const surface = new SurfaceForms();
    const texts = recs.map((r) => {
      const t = recordText(r, fields);
      surface.add(t);
      return analyze(t);
    });
    const vectorizer = TfidfVectorizer.fit(texts, { minDf: 1 });
    const items = recs
      .map((r, i) => ({ rec: r, vec: vectorizer.transform(texts[i]) }))
      .filter((x) => x.vec.idx.length > 0);
    const minSize = Math.max(2, opts.minSize ?? 3);
    const minCohesion = opts.minCohesion ?? 0.3;
    if (items.length < 2)
      return { table, records: items.length, method: 'agglomerative', k: 0, clusters: [] };
    // Average-linkage clustering for typical windows; spherical k-means for large ones or a fixed k.
    const X = items.map((x) => x.vec);
    const method = opts.k || items.length > 1500 ? 'kmeans' : 'agglomerative';
    const { k, assign } =
      method === 'kmeans'
        ? cluster(X, vectorizer.size, { k: opts.k })
        : agglomerative(X, opts.minSimilarity ?? 0.2);
    const centroids = Array.from({ length: k }, () => new Float64Array(vectorizer.size));
    X.forEach((x, i) => {
      const cen = centroids[assign[i]];
      for (let j = 0; j < x.idx.length; j++) cen[x.idx[j]] += x.val[j];
    });
    for (const cen of centroids) {
      let s2 = 0;
      for (let j = 0; j < cen.length; j++) s2 += cen[j] * cen[j];
      const nrm = Math.sqrt(s2) || 1;
      for (let j = 0; j < cen.length; j++) cen[j] /= nrm;
    }
    const sims = X.map((x, i) => dotDense(x, centroids[assign[i]]));
    const purityFields = ['category', 'assignment_group', 'cmdb_ci', 'business_service'].filter((f) =>
      meta.columns.has(f),
    );
    const clusters: ClusterInfo[] = [];
    for (let c = 0; c < k; c++) {
      const members = items
        .map((x, i) => ({ ...x, sim: sims[i], c: assign[i] }))
        .filter((m) => m.c === c)
        .sort((a, b) => b.sim - a.sim);
      if (!members.length) continue;
      const centroid = centroids[c];
      const cohesion = members.reduce((s, m) => s + m.sim, 0) / members.length;
      const terms = topTerms(centroid, vectorizer, 5).map((t) => surface.word(t));
      const purity = purityFields
        .map((field) => {
          const counts = new Map<string, { n: number; display: string }>();
          for (const m of members) {
            const v = m.rec.str(field);
            if (!v) continue;
            const e = counts.get(v) ?? { n: 0, display: fieldText(m.rec, field) || v };
            e.n++;
            counts.set(v, e);
          }
          const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
          return best
            ? {
                field,
                value: best[0],
                display: best[1].display,
                share: Math.round((100 * best[1].n) / members.length) / 100,
              }
            : null;
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      clusters.push({
        id: `${table}-${c + 1}`,
        size: members.length,
        cohesion: Math.round(cohesion * 100) / 100,
        concept: terms.join(', '),
        terms,
        purity,
        problem_candidate: members.length >= minSize && cohesion >= minCohesion,
        members: members.slice(0, 25).map((m) => ({
          sys_id: m.rec.sysId,
          table: m.rec.className,
          number: m.rec.has('number') ? m.rec.str('number') : m.rec.displayValue(),
          title: recordTitle(m.rec),
          score: Math.round(m.sim * 100),
        })),
      });
    }
    clusters.sort(
      (a, b) =>
        Number(b.problem_candidate) - Number(a.problem_candidate) ||
        b.size - a.size ||
        b.cohesion - a.cohesion,
    );
    clusters.forEach((cl, i) => {
      cl.id = `${table}-${i + 1}`;
    });
    return { table, records: items.length, method, k, clusters };
  }
}

function topTerms(centroid: Float64Array, vectorizer: TfidfVectorizer, n: number): string[] {
  const idx: number[] = [];
  for (let i = 0; i < centroid.length; i++) if (centroid[i] > 0) idx.push(i);
  return idx
    .sort((a, b) => centroid[b] - centroid[a])
    .slice(0, n)
    .map((i) => vectorizer.terms[i]);
}

/** Similarity between two free texts (0-100) using a vocabulary fitted on both. */
export function textSimilarity(a: string, b: string): number {
  const ta = analyze(a);
  const tb = analyze(b);
  const v = TfidfVectorizer.fit([ta, tb]);
  return Math.round(dot(v.transform(ta), v.transform(tb)) * 100);
}
