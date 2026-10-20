/**
 * Predictive classification ("solutions"): training from a solution definition,
 * model storage as JSON, prediction on insert with confidence thresholds, and the
 * prediction results log used for audit, the UI and outcome statistics.
 */
import type { Context } from '../../../engine/context.js';
import { InvalidError, NotFoundError } from '../../../engine/errors.js';
import type { Platform } from '../../../engine/platform.js';
import { QueryBuilder } from '../../../engine/querybuilder.js';
import type { Rec } from '../../../engine/record.js';
import type { TableMeta } from '../../../engine/types.js';
import { diffMs, nowGlide } from '../../../engine/util.js';
import { PROP } from '../config.js';
import { AI_TABLE_NAMES } from '../tables.js';
import {
  type Algorithm,
  type Classifier,
  type ClassifierJson,
  classifierFromJSON,
  evaluate,
  fitTemperature,
  LogisticRegression,
  NaiveBayes,
  softmax,
} from './classifiers.js';
import { recordText } from './records.js';
import { analyze } from './text.js';
import { type SparseVec, TfidfVectorizer, type VectorizerJson } from './tfidf.js';

export interface DefinitionInfo {
  sysId: string;
  name: string;
  label: string;
  capability: string;
  table: string;
  outputField: string;
  inputFields: string[];
  filter: string;
  /** Definition-level minimum confidence (0-100). */
  threshold: number;
  targetPrecision: number;
  preference: string;
  trainingFrequency: string;
  solutionId: string | null;
  algorithm: Algorithm | 'auto';
}

export interface ClassMeta {
  value: string;
  display: string;
  /** Threshold derived from held-out precision (0 when no evidence, 100 when the target is never met). */
  minThreshold: number;
}

export interface TrainingMetrics {
  accuracy: number | null;
  precision: number | null;
  coverage: number | null;
  recall: number | null;
  holdout: number;
  candidates: { algorithm: Algorithm; accuracy: number; macroF1: number }[];
}

export interface ModelArtifact {
  format: 1;
  table: string;
  outputField: string;
  inputFields: string[];
  algorithm: Algorithm;
  temperature: number;
  bigrams: boolean;
  vectorizer: VectorizerJson;
  model: ClassifierJson;
  classes: ClassMeta[];
  metrics: TrainingMetrics;
}

export interface Candidate {
  value: string;
  display: string;
  confidence: number;
}

export interface Prediction {
  definition: string;
  definitionName: string;
  definitionLabel: string;
  solution: string;
  version: number;
  table: string;
  field: string;
  value: string;
  display: string;
  confidence: number;
  threshold: number;
  aboveThreshold: boolean;
  preference: string;
  candidates: Candidate[];
}

export interface ClassSummary {
  value: string;
  display: string;
  records: number;
  distribution: number;
  threshold: number;
  precision: number | null;
  coverage: number | null;
}

export interface TrainResult {
  definition: string;
  solution: string;
  name: string;
  version: number;
  state: 'solution_complete' | 'solution_error';
  error: string | null;
  errorCode: string | null;
  algorithm: Algorithm | null;
  trainingRecords: number;
  accuracy: number | null;
  precision: number | null;
  coverage: number | null;
  recall: number | null;
  classes: ClassSummary[];
  excludedClasses: { value: string; display: string; records: number }[];
}

interface LoadedModel {
  solutionId: string;
  version: number;
  stamp: string;
  vectorizer: TfidfVectorizer;
  classifier: Classifier;
  temperature: number;
  classes: ClassMeta[];
  inputFields: string[];
  bigrams: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number): number | null => (den > 0 ? round1((100 * num) / den) : null);

function splitList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function frequencyDays(freq: string): number | null {
  if (freq === 'every_day') return 1;
  const m = /^every_(\d+)_days$/.exec(freq);
  return m ? Number(m[1]) : null;
}

export class Predictor {
  private defs: DefinitionInfo[] | null = null;
  private models = new Map<string, LoadedModel>();

  constructor(private readonly platform: Platform) {}

  /** Drops cached definitions (called when definitions or solutions change). */
  invalidate(): void {
    this.defs = null;
  }

  private sys(): Context {
    return this.platform.systemContext();
  }

  toInfo(r: Rec): DefinitionInfo {
    const adv = parseJson<{ algorithm?: string }>(r.str('advanced_settings')) ?? {};
    const algorithm =
      adv.algorithm === 'naive_bayes' || adv.algorithm === 'logistic_regression' ? adv.algorithm : 'auto';
    return {
      sysId: r.sysId,
      name: r.str('name') || r.str('label'),
      label: r.str('label') || r.str('name'),
      capability: r.str('capability') || 'classification',
      table: r.str('table'),
      outputField: r.str('output_field'),
      inputFields: splitList(r.str('input_fields') || 'short_description'),
      filter: r.str('filter'),
      threshold: r.num('confidence_threshold') ?? 50,
      targetPrecision: r.num('target_precision') ?? 80,
      preference: r.str('prediction_preference') || 'monitor_only',
      trainingFrequency: r.str('training_frequency') || 'run_once',
      solutionId: r.str('current_solution') || null,
      algorithm,
    };
  }

  /** Active classification definitions (cached). */
  definitions(): DefinitionInfo[] {
    if (this.defs) return this.defs;
    if (!this.platform.registry.has('ml_solution_definition')) {
      this.defs = [];
      return this.defs;
    }
    this.defs = this.sys()
      .query('ml_solution_definition', 'active=true^capability=classification')
      .map((r) => this.toInfo(r));
    return this.defs;
  }

  /** Definitions with a trained solution that apply to records of `meta`. */
  definitionsFor(meta: TableMeta): DefinitionInfo[] {
    if (AI_TABLE_NAMES.has(meta.name)) return [];
    return this.definitions().filter(
      (d) => d.solutionId && d.preference !== 'off' && meta.ancestors.includes(d.table),
    );
  }

  hasSolutionsFor(meta: TableMeta): boolean {
    if (AI_TABLE_NAMES.has(meta.name) || meta.name.startsWith('sys_')) return false;
    return this.definitionsFor(meta).length > 0;
  }

  // ------------------------------------------------------------- models

  private loadModel(solutionId: string): LoadedModel | null {
    const row = this.sys().get('ml_solution', solutionId);
    if (row?.str('state') !== 'solution_complete') return null;
    const stamp = `${row.str('sys_mod_count')}:${row.str('sys_updated_on')}`;
    const cached = this.models.get(solutionId);
    if (cached && cached.stamp === stamp) return cached;
    const art = parseJson<ModelArtifact>(row.str('artifact'));
    if (art?.format !== 1) return null;
    const model: LoadedModel = {
      solutionId,
      version: row.num('version') ?? 1,
      stamp,
      vectorizer: TfidfVectorizer.fromJSON(art.vectorizer),
      classifier: classifierFromJSON(art.model),
      temperature: art.temperature || 1,
      classes: art.classes,
      inputFields: art.inputFields,
      bigrams: art.bigrams,
    };
    if (this.models.size > 50) this.models.clear();
    this.models.set(solutionId, model);
    return model;
  }

  private predictWith(
    def: DefinitionInfo,
    model: LoadedModel,
    text: string,
    table: string,
  ): Prediction | null {
    const x = model.vectorizer.transform(analyze(text, { bigrams: model.bigrams }));
    if (!x.idx.length) return null;
    const probs = softmax(model.classifier.scores(x), model.temperature);
    const order = probs.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const top = order[0];
    const cls = model.classes[top];
    const confidence = round1(probs[top] * 100);
    const threshold = Math.max(def.threshold, cls.minThreshold);
    return {
      definition: def.sysId,
      definitionName: def.name,
      definitionLabel: def.label,
      solution: model.solutionId,
      version: model.version,
      table,
      field: def.outputField,
      value: cls.value,
      display: cls.display,
      confidence,
      threshold,
      aboveThreshold: confidence >= threshold,
      preference: def.preference,
      candidates: order.slice(0, 3).map((i) => ({
        value: model.classes[i].value,
        display: model.classes[i].display,
        confidence: round1(probs[i] * 100),
      })),
    };
  }

  /** Predictions for a record (no side effects). */
  predictRecord(rec: Rec): Prediction[] {
    const out: Prediction[] = [];
    for (const def of this.definitionsFor(rec.table)) {
      if (!rec.has(def.outputField)) continue;
      const model = this.loadModel(def.solutionId!);
      if (!model) continue;
      const text = recordText(rec, model.inputFields);
      if (!text.trim()) continue;
      const p = this.predictWith(def, model, text, rec.className);
      if (p) out.push(p);
    }
    return out;
  }

  /** True when the output field was not set by a person (empty, or still the dictionary default). */
  private openForPrediction(cur: Rec, field: string): boolean {
    const v = cur.get(field);
    if (v === null || v === '') return true;
    return !cur.touched.has(field);
  }

  private usableValue(ctx: Context, cur: Rec, field: string, value: string): boolean {
    const col = cur.column(field);
    if (!col) return false;
    if (col.type === 'reference' && col.reference) return !!ctx.loadRaw(col.reference, value);
    const choices = this.platform.choices.list(cur.className, field, { includeInactive: false });
    if (choices.length) return choices.some((c) => c.value === value);
    return true;
  }

  /** Before-insert rule body: fills empty output fields when confidence passes the threshold. */
  applyOnInsert(cur: Rec, ctx: Context): void {
    for (const def of this.definitionsFor(cur.table)) {
      if (!cur.has(def.outputField) || !this.openForPrediction(cur, def.outputField)) continue;
      const model = this.loadModel(def.solutionId!);
      if (!model) continue;
      const text = recordText(cur, model.inputFields);
      if (!text.trim()) continue;
      const p = this.predictWith(def, model, text, cur.className);
      if (!p) continue;
      const applied =
        def.preference === 'autofill' &&
        p.aboveThreshold &&
        this.usableValue(ctx, cur, def.outputField, p.value);
      if (applied) {
        cur.set(def.outputField, p.value);
        if (cur.has('work_notes')) {
          const label = cur.column(def.outputField)?.label ?? def.outputField;
          cur.set(
            'work_notes',
            `AI prediction: ${label} set to "${p.display}" by ${def.label} (confidence ${p.confidence}%).`,
          );
        }
      }
      ctx.elevated().insert('ml_predictor_results', {
        solution: p.solution,
        definition: def.sysId,
        table: cur.className,
        record: cur.sysId,
        field: def.outputField,
        predicted_value: p.value,
        predicted_display: p.display,
        confidence: p.confidence,
        threshold: p.threshold,
        above_threshold: p.aboveThreshold,
        applied,
        preference: def.preference,
        user_action: p.aboveThreshold ? 'none' : 'skipped',
        outcome: 'pending',
      });
    }
  }

  /** After-update hook body: records user overrides and final outcomes when the record closes. */
  trackOutcome(rec: Rec, ctx: Context): void {
    const defs = this.definitionsFor(rec.table);
    if (!defs.length) return;
    const closing = rec.has('active') && rec.changed('active') && !rec.bool('active');
    if (!closing && !defs.some((d) => rec.changed(d.outputField))) return;
    const sys = ctx.platform.systemContext();
    for (const r of sys.query('ml_predictor_results', `record=${rec.sysId}^outcome=pending`)) {
      const field = r.str('field');
      const updates: Record<string, unknown> = {};
      const current = rec.str(field);
      if (rec.changed(field) && r.str('user_action') === 'none') {
        if (r.bool('applied')) {
          if (current !== r.str('predicted_value')) updates.user_action = 'replaced';
        } else if (current === r.str('predicted_value')) updates.user_action = 'accepted';
      }
      if (closing) {
        updates.final_value = current;
        updates.outcome = r.bool('above_threshold')
          ? current === r.str('predicted_value')
            ? 'correct'
            : 'incorrect'
          : 'no_prediction';
        updates.outcome_at = nowGlide();
      }
      if (Object.keys(updates).length) sys.update(r, updates);
    }
  }

  // ------------------------------------------------------------- training

  private nextVersion(defId: string): number {
    const last = this.sys().first('ml_solution', `definition=${defId}`, [{ field: 'version', desc: true }]);
    return (last?.num('version') ?? 0) + 1;
  }

  /** Trains a new solution version for a classification definition. */
  train(ctx: Context, defId: string): TrainResult {
    const sys = this.sys();
    const defRec = sys.get('ml_solution_definition', defId);
    if (!defRec) throw new NotFoundError();
    const def = this.toInfo(defRec);
    if (def.capability !== 'classification') {
      throw new InvalidError(
        'Only classification solutions are trained; similarity and clustering run on demand',
      );
    }
    const meta = this.platform.registry.tryTable(def.table);
    if (!meta) throw new InvalidError(`Table ${def.table} is not installed`);
    if (!def.outputField || !meta.columns.has(def.outputField)) {
      throw new InvalidError(`Output field ${def.outputField || '(empty)'} does not exist on ${def.table}`);
    }
    const inputs = def.inputFields.filter((f) => meta.columns.has(f) && f !== def.outputField);
    if (!inputs.length) throw new InvalidError(`None of the input fields exist on ${def.table}`);

    const props = this.platform.properties;
    const minRecords = props.getNumber(PROP.mlMinRecords, 20);
    const minClass = props.getNumber(PROP.mlMinClassRecords, 3);
    const maxRecords = props.getNumber(PROP.mlMaxRecords, 100_000);
    const maxFeatures = props.getNumber(PROP.mlMaxFeatures, 20_000);

    const qb = new QueryBuilder(def.table);
    qb.addEncodedQuery(def.filter);
    qb.addEncodedQuery(`${def.outputField}ISNOTEMPTY`);
    qb.orderByDesc('sys_created_on');
    qb.limit = maxRecords;
    const recs = sys.query(def.table, qb).reverse();

    // Group by label, keeping chronological order.
    const byClass = new Map<string, { display: string; docs: string[][] }>();
    for (const r of recs) {
      const label = r.str(def.outputField);
      const tokens = analyze(recordText(r, inputs), { bigrams: true });
      if (!tokens.length) continue;
      let entry = byClass.get(label);
      if (!entry) {
        entry = { display: r.display(def.outputField) || label, docs: [] };
        byClass.set(label, entry);
      }
      entry.docs.push(tokens);
    }
    const excluded = [...byClass.entries()]
      .filter(([, e]) => e.docs.length < minClass)
      .map(([value, e]) => ({ value, display: e.display, records: e.docs.length }));
    const kept = [...byClass.entries()]
      .filter(([, e]) => e.docs.length >= minClass)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const total = kept.reduce((n, [, e]) => n + e.docs.length, 0);

    const version = this.nextVersion(def.sysId);
    const name = `${def.name} v${version}`;
    const writer = ctx.elevated();
    const fail = (code: string, message: string): TrainResult => {
      const sol = writer.insert('ml_solution', {
        name,
        definition: def.sysId,
        version,
        state: 'solution_error',
        percent_complete: 100,
        training_records: total,
        excluded_classes: excluded.map((e) => `${e.display} (${e.records})`).join(', '),
        error: `${code}: ${message}`,
        trained_at: nowGlide(),
      });
      return {
        definition: def.sysId,
        solution: sol.sysId,
        name,
        version,
        state: 'solution_error',
        error: message,
        errorCode: code,
        algorithm: null,
        trainingRecords: total,
        accuracy: null,
        precision: null,
        coverage: null,
        recall: null,
        classes: [],
        excludedClasses: excluded,
      };
    };
    if (total < minRecords)
      return fail(
        'insufficient_records',
        `Training needs at least ${minRecords} labelled records; the filter returned ${total}.`,
      );
    if (kept.length < 2)
      return fail('insufficient_classes', 'Training needs at least two classes with enough records.');

    // Stratified, time-ordered split: the newest 20 % of each class is held out.
    const classes = kept.map(([value, e]) => ({ value, display: e.display }));
    const trainDocs: string[][] = [];
    const trainY: number[] = [];
    const holdDocs: string[][] = [];
    const holdY: number[] = [];
    kept.forEach(([, e], ci) => {
      const n = e.docs.length;
      const hold = n >= 5 ? Math.max(1, Math.round(n * 0.2)) : 0;
      e.docs.forEach((d, i) => {
        if (i >= n - hold) {
          holdDocs.push(d);
          holdY.push(ci);
        } else {
          trainDocs.push(d);
          trainY.push(ci);
        }
      });
    });
    const k = classes.length;
    const fitVectorizer = (docs: string[][]) =>
      TfidfVectorizer.fit(docs, { minDf: docs.length >= 200 ? 2 : 1, maxFeatures });
    // Fewer passes on large data sets keep training time roughly linear in the record count.
    const epochs = total > 20_000 ? 8 : total > 5_000 ? 15 : 30;
    const trainModel = (algo: Algorithm, X: SparseVec[], y: number[], nFeatures: number): Classifier =>
      algo === 'naive_bayes'
        ? NaiveBayes.train(X, y, k, nFeatures)
        : LogisticRegression.train(X, y, k, nFeatures, { seed: 17, epochs });

    // Model selection and calibration on the held-out split.
    const vec1 = fitVectorizer(trainDocs);
    const Xtrain = trainDocs.map((d) => vec1.transform(d));
    const Xhold = holdDocs.map((d) => vec1.transform(d));
    const algos: Algorithm[] =
      def.algorithm === 'auto' ? ['logistic_regression', 'naive_bayes'] : [def.algorithm];
    const candidates = algos.map((algorithm) => {
      const model = trainModel(algorithm, Xtrain, trainY, vec1.size);
      const ev = Xhold.length ? evaluate(model, Xhold, holdY) : { accuracy: 0, macroF1: 0 };
      return { algorithm, model, accuracy: ev.accuracy, macroF1: ev.macroF1 };
    });
    candidates.sort((a, b) => b.accuracy - a.accuracy || b.macroF1 - a.macroF1);
    const chosen = candidates[0];
    const holdScores = Xhold.map((x) => chosen.model.scores(x));
    const temperature = fitTemperature(holdScores, holdY);

    // Per-class thresholds from held-out precision.
    const preds = holdScores.map((s, i) => {
      const p = softmax(s, temperature);
      let best = 0;
      for (let c = 1; c < k; c++) if (p[c] > p[best]) best = c;
      return { pred: best, conf: round1(p[best] * 100), truth: holdY[i] };
    });
    const target = def.targetPrecision;
    const classMeta: ClassMeta[] = classes.map((cl, ci) => {
      const mine = preds.filter((p) => p.pred === ci);
      let minThreshold = 0;
      if (target > 0 && mine.length) {
        minThreshold = 100;
        const cuts = [...new Set(mine.map((p) => p.conf))].sort((a, b) => a - b);
        for (const t of cuts) {
          const sel = mine.filter((p) => p.conf >= t);
          const prec = (100 * sel.filter((p) => p.truth === ci).length) / sel.length;
          if (prec >= target) {
            minThreshold = t;
            break;
          }
        }
      }
      return { value: cl.value, display: cl.display, minThreshold };
    });
    const effThreshold = (ci: number) => Math.max(def.threshold, classMeta[ci].minThreshold);
    const applied = preds.filter((p) => p.conf >= effThreshold(p.pred));
    const appliedCorrect = applied.filter((p) => p.pred === p.truth).length;
    const metrics: TrainingMetrics = {
      accuracy: Xhold.length ? round1(chosen.accuracy * 100) : null,
      precision: pct(appliedCorrect, applied.length),
      coverage: pct(applied.length, preds.length),
      recall: pct(appliedCorrect, preds.length),
      holdout: preds.length,
      candidates: candidates.map((c) => ({
        algorithm: c.algorithm,
        accuracy: round1(c.accuracy * 100),
        macroF1: round1(c.macroF1 * 100),
      })),
    };

    // Final model on every record.
    const allDocs = [...trainDocs, ...holdDocs];
    const allY = [...trainY, ...holdY];
    const vec = fitVectorizer(allDocs);
    const finalModel = trainModel(
      chosen.algorithm,
      allDocs.map((d) => vec.transform(d)),
      allY,
      vec.size,
    );
    const artifact: ModelArtifact = {
      format: 1,
      table: def.table,
      outputField: def.outputField,
      inputFields: inputs,
      algorithm: chosen.algorithm,
      temperature,
      bigrams: true,
      vectorizer: vec.toJSON(),
      model: finalModel.toJSON(),
      classes: classMeta,
      metrics,
    };
    const sol = writer.insert('ml_solution', {
      name,
      definition: def.sysId,
      version,
      state: 'solution_complete',
      percent_complete: 100,
      algorithm: chosen.algorithm,
      training_records: total,
      accuracy: metrics.accuracy,
      precision: metrics.precision,
      coverage: metrics.coverage,
      recall: metrics.recall,
      excluded_classes: excluded.map((e) => `${e.display} (${e.records})`).join(', '),
      artifact: JSON.stringify(artifact),
      trained_at: nowGlide(),
    });
    const summaries: ClassSummary[] = classes.map((cl, ci) => {
      const records = kept[ci][1].docs.length;
      const predictedHere = applied.filter((p) => p.pred === ci);
      const truthHere = preds.filter((p) => p.truth === ci);
      const summary: ClassSummary = {
        value: cl.value,
        display: cl.display,
        records,
        distribution: round1((100 * records) / total),
        threshold: effThreshold(ci),
        precision: pct(predictedHere.filter((p) => p.truth === ci).length, predictedHere.length),
        coverage: pct(applied.filter((p) => p.truth === ci).length, truthHere.length),
      };
      writer.insert('ml_class', {
        solution: sol.sysId,
        value: cl.value,
        display_value: cl.display,
        training_records: records,
        distribution: summary.distribution,
        estimated_precision: summary.precision,
        estimated_coverage: summary.coverage,
        threshold: summary.threshold,
      });
      return summary;
    });
    writer.update(defRec, { current_solution: sol.sysId });
    this.invalidate();
    return {
      definition: def.sysId,
      solution: sol.sysId,
      name,
      version,
      state: 'solution_complete',
      error: null,
      errorCode: null,
      algorithm: chosen.algorithm,
      trainingRecords: total,
      accuracy: metrics.accuracy,
      precision: metrics.precision,
      coverage: metrics.coverage,
      recall: metrics.recall,
      classes: summaries,
      excludedClasses: excluded,
    };
  }

  /** Scheduled job: trains definitions that were never trained or whose retraining is due. */
  trainDue(ctx: Context): TrainResult[] {
    const out: TrainResult[] = [];
    const sys = this.sys();
    for (const r of sys.query('ml_solution_definition', 'active=true^capability=classification')) {
      const def = this.toInfo(r);
      if (!this.platform.registry.has(def.table)) continue;
      let due = !def.solutionId;
      if (due) {
        // A failed attempt (not enough data yet) is retried after a day.
        const last = sys.first('ml_solution', `definition=${def.sysId}`, [
          { field: 'sys_created_on', desc: true },
        ]);
        if (last && diffMs(nowGlide(), last.str('sys_created_on')) < 86_400_000) due = false;
      } else {
        const days = frequencyDays(def.trainingFrequency);
        const sol = sys.get('ml_solution', def.solutionId!);
        const trained = sol?.str('trained_at');
        due = days !== null && (!trained || diffMs(nowGlide(), trained) >= days * 86_400_000);
      }
      if (!due) continue;
      try {
        out.push(this.train(ctx, def.sysId));
      } catch (e) {
        this.platform.log.warn(
          `[resolvrnow] training ${def.name} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  }
}

export function parseJson<T>(s: string): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
