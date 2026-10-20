/**
 * Text classifiers over sparse TF-IDF vectors, written for small to medium ITSM
 * datasets (hundreds to a few hundred thousand records):
 *
 * - multinomial Naive Bayes (fast baseline that copes well with little data)
 * - multinomial logistic regression trained with SGD and L2 regularisation
 *
 * Both expose raw class scores; `softmax(scores, temperature)` turns them into
 * probabilities, with the temperature calibrated on held-out records.
 */
import { round6, type SparseVec } from './tfidf.js';

export type Algorithm = 'naive_bayes' | 'logistic_regression';

export interface Classifier {
  readonly kind: Algorithm;
  readonly nClasses: number;
  /** Unnormalised log-scores, one per class index. */
  scores(x: SparseVec): number[];
  toJSON(): ClassifierJson;
}

interface SparseRow {
  i: number[];
  v: number[];
}

export type ClassifierJson =
  | {
      kind: 'naive_bayes';
      nClasses: number;
      nFeatures: number;
      alpha: number;
      logPrior: number[];
      totals: number[];
      sums: SparseRow[];
    }
  | {
      kind: 'logistic_regression';
      nClasses: number;
      nFeatures: number;
      bias: number[];
      weights: SparseRow[];
    };

/** Deterministic PRNG (mulberry32) so training runs are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function softmax(scores: number[], temperature = 1): number[] {
  const t = temperature > 0 ? temperature : 1;
  let max = -Infinity;
  for (const s of scores) if (s / t > max) max = s / t;
  const exps = scores.map((s) => Math.exp(s / t - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function argmax(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

function sparseRow(dense: ArrayLike<number>, epsilon: number): SparseRow {
  const i: number[] = [];
  const v: number[] = [];
  for (let k = 0; k < dense.length; k++) {
    if (Math.abs(dense[k]) > epsilon) {
      i.push(k);
      v.push(round6(dense[k]));
    }
  }
  return { i, v };
}

// ---------------------------------------------------------------- Naive Bayes

export class NaiveBayes implements Classifier {
  readonly kind = 'naive_bayes' as const;
  private logTheta: Float64Array[];

  private constructor(
    readonly nClasses: number,
    readonly nFeatures: number,
    readonly alpha: number,
    readonly logPrior: number[],
    readonly totals: number[],
    readonly sums: SparseRow[],
  ) {
    this.logTheta = sums.map((row, c) => {
      const denom = totals[c] + alpha * nFeatures;
      const arr = new Float64Array(nFeatures).fill(Math.log(alpha / denom));
      row.i.forEach((j, k) => {
        arr[j] = Math.log((row.v[k] + alpha) / denom);
      });
      return arr;
    });
  }

  static train(X: SparseVec[], y: number[], nClasses: number, nFeatures: number, alpha = 0.1): NaiveBayes {
    const sums = Array.from({ length: nClasses }, () => new Float64Array(nFeatures));
    const counts = new Array<number>(nClasses).fill(0);
    X.forEach((x, n) => {
      const c = y[n];
      counts[c]++;
      for (let k = 0; k < x.idx.length; k++) sums[c][x.idx[k]] += x.val[k];
    });
    const total = X.length;
    const logPrior = counts.map((n) => Math.log((n + 1) / (total + nClasses)));
    const totals = sums.map((s) => s.reduce((a, b) => a + b, 0));
    return new NaiveBayes(
      nClasses,
      nFeatures,
      alpha,
      logPrior,
      totals,
      sums.map((s) => sparseRow(s, 0)),
    );
  }

  static fromJSON(j: Extract<ClassifierJson, { kind: 'naive_bayes' }>): NaiveBayes {
    return new NaiveBayes(j.nClasses, j.nFeatures, j.alpha, j.logPrior, j.totals, j.sums);
  }

  scores(x: SparseVec): number[] {
    return this.logTheta.map((theta, c) => {
      let s = this.logPrior[c];
      for (let k = 0; k < x.idx.length; k++) s += x.val[k] * theta[x.idx[k]];
      return s;
    });
  }

  toJSON(): ClassifierJson {
    return {
      kind: 'naive_bayes',
      nClasses: this.nClasses,
      nFeatures: this.nFeatures,
      alpha: this.alpha,
      logPrior: this.logPrior.map(round6),
      totals: this.totals.map(round6),
      sums: this.sums,
    };
  }
}

// -------------------------------------------------------- logistic regression

export interface LogisticOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  seed?: number;
}

export class LogisticRegression implements Classifier {
  readonly kind = 'logistic_regression' as const;

  private constructor(
    readonly nClasses: number,
    readonly nFeatures: number,
    readonly bias: number[],
    readonly weights: Float64Array[],
  ) {}

  /** Softmax regression trained by stochastic gradient descent with L2 weight decay. */
  static train(
    X: SparseVec[],
    y: number[],
    nClasses: number,
    nFeatures: number,
    opts: LogisticOptions = {},
  ): LogisticRegression {
    const epochs = opts.epochs ?? 30;
    const lr0 = opts.learningRate ?? 0.8;
    const l2 = opts.l2 ?? 1e-4;
    const rnd = seededRandom(opts.seed ?? 42);
    const W = Array.from({ length: nClasses }, () => new Float64Array(nFeatures));
    const b = new Array<number>(nClasses).fill(0);
    const order = X.map((_, i) => i);
    const z = new Array<number>(nClasses).fill(0);
    for (let epoch = 0; epoch < epochs; epoch++) {
      const lr = lr0 / (1 + 0.15 * epoch);
      shuffle(order, rnd);
      for (const n of order) {
        const x = X[n];
        for (let c = 0; c < nClasses; c++) {
          let s = b[c];
          const w = W[c];
          for (let k = 0; k < x.idx.length; k++) s += x.val[k] * w[x.idx[k]];
          z[c] = s;
        }
        const p = softmax(z);
        for (let c = 0; c < nClasses; c++) {
          const g = p[c] - (y[n] === c ? 1 : 0);
          if (g === 0) continue;
          b[c] -= lr * g;
          const w = W[c];
          for (let k = 0; k < x.idx.length; k++) w[x.idx[k]] -= lr * g * x.val[k];
        }
      }
      // L2 weight decay, applied once per epoch (equivalent to a per-sample decay of lr * l2).
      const decay = Math.exp(-lr * l2 * X.length);
      if (decay < 1) for (const w of W) for (let j = 0; j < nFeatures; j++) w[j] *= decay;
    }
    return new LogisticRegression(nClasses, nFeatures, b, W);
  }

  static fromJSON(j: Extract<ClassifierJson, { kind: 'logistic_regression' }>): LogisticRegression {
    const W = j.weights.map((row) => {
      const arr = new Float64Array(j.nFeatures);
      row.i.forEach((idx, k) => {
        arr[idx] = row.v[k];
      });
      return arr;
    });
    return new LogisticRegression(j.nClasses, j.nFeatures, j.bias, W);
  }

  scores(x: SparseVec): number[] {
    return this.weights.map((w, c) => {
      let s = this.bias[c];
      for (let k = 0; k < x.idx.length; k++) s += x.val[k] * w[x.idx[k]];
      return s;
    });
  }

  toJSON(): ClassifierJson {
    return {
      kind: 'logistic_regression',
      nClasses: this.nClasses,
      nFeatures: this.nFeatures,
      bias: this.bias.map(round6),
      weights: this.weights.map((w) => sparseRow(w, 1e-5)),
    };
  }
}

export function classifierFromJSON(j: ClassifierJson): Classifier {
  return j.kind === 'naive_bayes' ? NaiveBayes.fromJSON(j) : LogisticRegression.fromJSON(j);
}

// ---------------------------------------------------------------- calibration

/**
 * Temperature that minimises the negative log-likelihood of the true classes
 * (golden-section search on log T). Returns 1 when there is too little data.
 */
export function fitTemperature(scoreRows: number[][], y: number[]): number {
  if (scoreRows.length < 5) return 1;
  const nll = (logT: number) => {
    const t = Math.exp(logT);
    let s = 0;
    scoreRows.forEach((row, i) => {
      const p = softmax(row, t)[y[i]];
      s -= Math.log(Math.max(p, 1e-12));
    });
    return s;
  };
  let lo = Math.log(0.05);
  let hi = Math.log(100);
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = nll(c);
  let fd = nll(d);
  for (let i = 0; i < 60; i++) {
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = nll(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = nll(d);
    }
  }
  return round6(Math.exp((lo + hi) / 2));
}

// ---------------------------------------------------------------- evaluation

export interface EvalSummary {
  accuracy: number;
  macroF1: number;
}

export function evaluate(model: Classifier, X: SparseVec[], y: number[]): EvalSummary {
  const n = model.nClasses;
  const tp = new Array<number>(n).fill(0);
  const fp = new Array<number>(n).fill(0);
  const fn = new Array<number>(n).fill(0);
  let correct = 0;
  X.forEach((x, i) => {
    const p = argmax(model.scores(x));
    if (p === y[i]) {
      correct++;
      tp[p]++;
    } else {
      fp[p]++;
      fn[y[i]]++;
    }
  });
  const present = new Set(y);
  let f1Sum = 0;
  for (const c of present) {
    const prec = tp[c] + fp[c] ? tp[c] / (tp[c] + fp[c]) : 0;
    const rec = tp[c] + fn[c] ? tp[c] / (tp[c] + fn[c]) : 0;
    f1Sum += prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  }
  return { accuracy: X.length ? correct / X.length : 0, macroF1: present.size ? f1Sum / present.size : 0 };
}
