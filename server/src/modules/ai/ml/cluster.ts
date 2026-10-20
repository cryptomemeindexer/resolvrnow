/**
 * Spherical k-means over L2-normalised TF-IDF vectors (cosine similarity), with
 * k-means++ seeding and a silhouette-based choice of k for small corpora.
 */
import { seededRandom } from './classifiers.js';
import { dot, dotDense, type SparseVec } from './tfidf.js';

export interface KMeansResult {
  k: number;
  /** Cluster index per input vector. */
  assign: number[];
  /** Normalised dense centroids. */
  centroids: Float64Array[];
  /** Cosine similarity of each vector to its centroid. */
  sims: number[];
  silhouette: number;
}

function normalizeDense(v: Float64Array): Float64Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function denseOf(x: SparseVec, nFeatures: number): Float64Array {
  const d = new Float64Array(nFeatures);
  for (let k = 0; k < x.idx.length; k++) d[x.idx[k]] = x.val[k];
  return d;
}

export function sphericalKMeans(
  X: SparseVec[],
  k: number,
  nFeatures: number,
  seed = 7,
  maxIter = 60,
): KMeansResult {
  const n = X.length;
  const rnd = seededRandom(seed);
  k = Math.max(1, Math.min(k, n));
  // k-means++ seeding with cosine distance.
  const centroids: Float64Array[] = [];
  centroids.push(denseOf(X[Math.floor(rnd() * n)], nFeatures));
  const best = new Array<number>(n).fill(-Infinity);
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1];
    let total = 0;
    const weights = X.map((x, i) => {
      best[i] = Math.max(best[i], dotDense(x, last));
      const d = Math.max(0, 1 - best[i]);
      total += d * d;
      return d * d;
    });
    let pick = 0;
    if (total <= 0) pick = Math.floor(rnd() * n);
    else {
      let r = rnd() * total;
      for (let i = 0; i < n; i++) {
        r -= weights[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    }
    centroids.push(denseOf(X[pick], nFeatures));
  }
  const assign = new Array<number>(n).fill(-1);
  const sims = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let bs = -Infinity;
      for (let c = 0; c < k; c++) {
        const s = dotDense(X[i], centroids[c]);
        if (s > bs) {
          bs = s;
          bi = c;
        }
      }
      if (assign[i] !== bi) changed++;
      assign[i] = bi;
      sims[i] = bs;
    }
    // Recompute centroids; reseed empty clusters with the worst-fitting point.
    const sums = Array.from({ length: k }, () => new Float64Array(nFeatures));
    const sizes = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      sizes[assign[i]]++;
      const x = X[i];
      const s = sums[assign[i]];
      for (let j = 0; j < x.idx.length; j++) s[x.idx[j]] += x.val[j];
    }
    for (let c = 0; c < k; c++) {
      if (sizes[c] === 0) {
        let worst = 0;
        for (let i = 1; i < n; i++) if (sims[i] < sims[worst]) worst = i;
        centroids[c] = denseOf(X[worst], nFeatures);
        sims[worst] = 1;
        changed++;
      } else centroids[c] = normalizeDense(sums[c]);
    }
    if (changed === 0 && iter > 0) break;
  }
  for (let i = 0; i < n; i++) sims[i] = dotDense(X[i], centroids[assign[i]]);
  return { k, assign, centroids, sims, silhouette: 0 };
}

/** Pairwise cosine similarities (symmetric, row-major). */
export function similarityMatrix(X: SparseVec[], nFeatures: number): Float32Array {
  const n = X.length;
  const m = new Float32Array(n * n);
  const dense = X.map((x) => denseOf(x, nFeatures));
  for (let i = 0; i < n; i++) {
    m[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = dotDense(X[j], dense[i]);
      m[i * n + j] = s;
      m[j * n + i] = s;
    }
  }
  return m;
}

/** Mean silhouette coefficient with cosine distance (1 - similarity). */
export function silhouette(sim: Float32Array, n: number, assign: number[], k: number): number {
  if (k < 2) return 0;
  let total = 0;
  const sums = new Float64Array(k);
  const sizes = new Array<number>(k).fill(0);
  for (const a of assign) sizes[a]++;
  for (let i = 0; i < n; i++) {
    sums.fill(0);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      sums[assign[j]] += 1 - sim[i * n + j];
    }
    const own = assign[i];
    if (sizes[own] <= 1) continue;
    const a = sums[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || sizes[c] === 0) continue;
      b = Math.min(b, sums[c] / sizes[c]);
    }
    if (!Number.isFinite(b)) continue;
    const den = Math.max(a, b);
    total += den > 0 ? (b - a) / den : 0;
  }
  return total / n;
}

export interface ClusterOptions {
  /** Fixed k (skips the automatic choice). */
  k?: number;
  maxK?: number;
  seed?: number;
}

/**
 * Clusters normalised vectors. Small corpora (up to 600 vectors) try every k in
 * [2, maxK] and keep the best silhouette; larger corpora use about one cluster per
 * 25 records, bounded to [2, 500].
 */
export function cluster(X: SparseVec[], nFeatures: number, opts: ClusterOptions = {}): KMeansResult {
  const n = X.length;
  const seed = opts.seed ?? 7;
  if (n <= 2) return { ...sphericalKMeans(X, 1, nFeatures, seed), silhouette: 0 };
  if (opts.k) return sphericalKMeans(X, opts.k, nFeatures, seed);
  if (n > 600) return sphericalKMeans(X, Math.max(2, Math.min(500, Math.round(n / 25))), nFeatures, seed);
  const sim = similarityMatrix(X, nFeatures);
  const maxK = Math.max(2, Math.min(opts.maxK ?? 20, n - 1));
  let bestRun: KMeansResult | null = null;
  for (let k = 2; k <= maxK; k++) {
    const run = sphericalKMeans(X, k, nFeatures, seed + k);
    run.silhouette = silhouette(sim, n, run.assign, k);
    if (!bestRun || run.silhouette > bestRun.silhouette + 1e-9) bestRun = run;
  }
  return bestRun!;
}

/**
 * Average-linkage agglomerative clustering on cosine similarity: repeatedly merges
 * the two most similar clusters while their average pairwise similarity is at least
 * `threshold`. Records that resemble nothing stay as singletons.
 */
export function agglomerative(X: SparseVec[], threshold: number): { k: number; assign: number[] } {
  const n = X.length;
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = dot(X[i], X[j]);
      S[i * n + j] = v;
      S[j * n + i] = v;
    }
  }
  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const members: number[][] = X.map((_, i) => [i]);
  const nn = new Int32Array(n).fill(-1);
  const nnSim = new Float64Array(n).fill(-Infinity);
  const recompute = (i: number) => {
    let best = -1;
    let bs = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || !active[j]) continue;
      const v = S[i * n + j];
      if (v > bs) {
        bs = v;
        best = j;
      }
    }
    nn[i] = best;
    nnSim[i] = bs;
  };
  for (let i = 0; i < n; i++) recompute(i);
  for (;;) {
    let i = -1;
    let bs = -Infinity;
    for (let x = 0; x < n; x++) {
      if (active[x] && nn[x] >= 0 && nnSim[x] > bs) {
        bs = nnSim[x];
        i = x;
      }
    }
    if (i < 0 || bs < threshold) break;
    const j = nn[i];
    // Lance-Williams update for average linkage.
    for (let x = 0; x < n; x++) {
      if (!active[x] || x === i || x === j) continue;
      const v = (size[i] * S[i * n + x] + size[j] * S[j * n + x]) / (size[i] + size[j]);
      S[i * n + x] = v;
      S[x * n + i] = v;
    }
    size[i] += size[j];
    active[j] = false;
    members[i].push(...members[j]);
    members[j] = [];
    recompute(i);
    for (let x = 0; x < n; x++) {
      if (!active[x] || x === i) continue;
      if (nn[x] === i || nn[x] === j) recompute(x);
      else if (S[x * n + i] > nnSim[x]) {
        nn[x] = i;
        nnSim[x] = S[x * n + i];
      }
    }
  }
  const assign = new Array<number>(n).fill(0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    for (const m of members[i]) assign[m] = k;
    k++;
  }
  return { k, assign };
}
