/**
 * Sparse TF-IDF vectors: sublinear term frequency, smoothed inverse document
 * frequency and L2 normalisation, so the dot product of two vectors is their cosine.
 */

/** Sparse vector with strictly increasing indexes. */
export interface SparseVec {
  idx: number[];
  val: number[];
}

export const EMPTY_VEC: SparseVec = Object.freeze({ idx: [], val: [] }) as SparseVec;

export interface VectorizerOptions {
  /** Ignore terms present in fewer documents (default 1). */
  minDf?: number;
  /** Keep at most this many terms, the most frequent first (default 50,000). */
  maxFeatures?: number;
  /** Use 1 + ln(tf) instead of raw counts (default true). */
  sublinearTf?: boolean;
}

export interface VectorizerJson {
  terms: string[];
  idf: number[];
  docs: number;
  sublinearTf: boolean;
}

export class TfidfVectorizer {
  readonly vocab = new Map<string, number>();

  private constructor(
    readonly terms: string[],
    readonly idf: number[],
    readonly docs: number,
    readonly sublinearTf: boolean,
  ) {
    terms.forEach((t, i) => {
      this.vocab.set(t, i);
    });
  }

  get size(): number {
    return this.terms.length;
  }

  /** Learns the vocabulary and IDF weights from tokenised documents. */
  static fit(docs: string[][], opts: VectorizerOptions = {}): TfidfVectorizer {
    const minDf = Math.max(1, opts.minDf ?? 1);
    const maxFeatures = opts.maxFeatures ?? 50_000;
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const kept = [...df.entries()]
      .filter(([, n]) => n >= minDf)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, maxFeatures)
      .map(([t]) => t)
      .sort();
    const n = docs.length;
    const idf = kept.map((t) => Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1);
    return new TfidfVectorizer(kept, idf, n, opts.sublinearTf ?? true);
  }

  static fromJSON(j: VectorizerJson): TfidfVectorizer {
    return new TfidfVectorizer(j.terms, j.idf, j.docs, j.sublinearTf);
  }

  toJSON(): VectorizerJson {
    return { terms: this.terms, idf: this.idf.map(round6), docs: this.docs, sublinearTf: this.sublinearTf };
  }

  /** L2-normalised TF-IDF vector of a tokenised document (unknown terms are ignored). */
  transform(tokens: string[]): SparseVec {
    const counts = new Map<number, number>();
    for (const t of tokens) {
      const i = this.vocab.get(t);
      if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    if (counts.size === 0) return { idx: [], val: [] };
    const idx = [...counts.keys()].sort((a, b) => a - b);
    const val = idx.map((i) => {
      const c = counts.get(i)!;
      return (this.sublinearTf ? 1 + Math.log(c) : c) * this.idf[i];
    });
    return normalize({ idx, val });
  }

  /**
   * Query vector for similarity search. Words the corpus has never seen still count
   * in the norm (weighted like an average word), so a long query sharing a single
   * word with a short document does not look like a near-duplicate.
   */
  queryVector(tokens: string[]): SparseVec {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const unseenIdf = this.idf.length ? this.idf.reduce((a, b) => a + b, 0) / this.idf.length : 1;
    const known = new Map<number, number>();
    let norm2 = 0;
    for (const [t, c] of counts) {
      const i = this.vocab.get(t);
      const w = (this.sublinearTf ? 1 + Math.log(c) : c) * (i !== undefined ? this.idf[i] : unseenIdf);
      norm2 += w * w;
      if (i !== undefined) known.set(i, w);
    }
    if (!known.size) return { idx: [], val: [] };
    const n = Math.sqrt(norm2);
    const idx = [...known.keys()].sort((a, b) => a - b);
    return { idx, val: idx.map((i) => known.get(i)! / n) };
  }
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function norm(v: SparseVec): number {
  let s = 0;
  for (const x of v.val) s += x * x;
  return Math.sqrt(s);
}

export function normalize(v: SparseVec): SparseVec {
  const n = norm(v);
  if (n === 0) return v;
  return { idx: v.idx, val: v.val.map((x) => x / n) };
}

/** Dot product of two sparse vectors (cosine when both are normalised). */
export function dot(a: SparseVec, b: SparseVec): number {
  let i = 0;
  let j = 0;
  let s = 0;
  const ai = a.idx;
  const bi = b.idx;
  while (i < ai.length && j < bi.length) {
    if (ai[i] === bi[j]) {
      s += a.val[i] * b.val[j];
      i++;
      j++;
    } else if (ai[i] < bi[j]) i++;
    else j++;
  }
  return s;
}

/** Dot product of a sparse vector with a dense one. */
export function dotDense(a: SparseVec, dense: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < a.idx.length; k++) s += a.val[k] * dense[a.idx[k]];
  return s;
}

/** dense += scale * a */
export function addScaled(dense: Float64Array, a: SparseVec, scale = 1): void {
  for (let k = 0; k < a.idx.length; k++) dense[a.idx[k]] += scale * a.val[k];
}

/** Converts a dense vector to sparse form, dropping near-zero entries. */
export function toSparse(dense: ArrayLike<number>, epsilon = 1e-9): SparseVec {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < dense.length; i++) {
    const x = dense[i];
    if (Math.abs(x) > epsilon) {
      idx.push(i);
      val.push(x);
    }
  }
  return { idx, val };
}
