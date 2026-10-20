/**
 * Text pipeline shared by the classifiers, the similarity engine, clustering and the
 * virtual agent: normalisation, tokenisation, English stop words and the classic
 * Porter suffix-stripping stemmer (Porter, 1980).
 */

/** Common English function words plus service desk pleasantries that carry no signal. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are aren as at be because been before being below between both but by ' +
    'can cannot could couldn did didn do does doesn doing don down during each few for from further get gets got had hadn has hasn have ' +
    'haven having he her here hers herself him himself his how i if in into is isn it its itself just let me more most mustn my myself ' +
    'no nor not now of off on once only or other ought our ours ourselves out over own same shan she should shouldn so some such ' +
    'than that the their theirs them themselves then there these they this those through to too under until up upon very was ' +
    'wasn we were weren what when where which while who whom why will with won would wouldn you your yours yourself yourselves ' +
    'also already still even etc ie eg via per within without would could might may must shall ' +
    'please pls thanks thank thx hi hello hey dear regards kind best team cheers'
  ).split(/\s+/),
);

/** Lowercase, strip HTML tags and entities, fold accents. */
export function normalizeText(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Plain-text rendering of a possibly-HTML value (keeps sentence punctuation). */
export function plainText(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const TICKET_NUMBER = /^[a-z]{2,6}\d{5,}$/;
const LONG_NUMBER = /^\d{5,}$/;

/** Word tokens (normalised, unstemmed), without noise such as ticket numbers. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of normalizeText(text).split(/[^a-z0-9]+/)) {
    if (t.length < 2 || t.length > 40) continue;
    if (TICKET_NUMBER.test(t) || LONG_NUMBER.test(t)) continue;
    out.push(t);
  }
  return out;
}

export interface AnalyzeOptions {
  /** Add adjacent-word bigrams (`a_b`) after the unigrams. */
  bigrams?: boolean;
  /** Keep stop words (used for short virtual agent utterances). */
  keepStopWords?: boolean;
}

/** Stemmed terms for indexing and matching. */
export function analyze(text: string, opts: AnalyzeOptions = {}): string[] {
  const terms: string[] = [];
  for (const t of tokenize(text)) {
    if (!opts.keepStopWords && STOP_WORDS.has(t)) continue;
    terms.push(stem(t));
  }
  if (opts.bigrams) {
    const n = terms.length;
    for (let i = 0; i + 1 < n; i++) terms.push(`${terms[i]}_${terms[i + 1]}`);
  }
  return terms;
}

/** Records the most frequent surface form of each stem, for readable cluster labels. */
export class SurfaceForms {
  private counts = new Map<string, Map<string, number>>();

  add(text: string): void {
    for (const t of tokenize(text)) {
      if (STOP_WORDS.has(t)) continue;
      const s = stem(t);
      let m = this.counts.get(s);
      if (!m) {
        m = new Map();
        this.counts.set(s, m);
      }
      m.set(t, (m.get(t) ?? 0) + 1);
    }
  }

  word(term: string): string {
    if (term.includes('_'))
      return term
        .split('_')
        .map((p) => this.word(p))
        .join(' ');
    const m = this.counts.get(term);
    if (!m) return term;
    let best = term;
    let n = -1;
    for (const [w, c] of m) {
      if (c > n || (c === n && w < best)) {
        best = w;
        n = c;
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ stemming

function isConsonant(w: string, i: number): boolean {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isConsonant(w, i - 1);
  return true;
}

/** Porter's measure m: the number of vowel-consonant sequences in the stem. */
function measure(stemPart: string): number {
  let m = 0;
  let prevVowel = false;
  for (let i = 0; i < stemPart.length; i++) {
    const cons = isConsonant(stemPart, i);
    if (cons && prevVowel) m++;
    prevVowel = !cons;
  }
  return m;
}

function hasVowel(stemPart: string): boolean {
  for (let i = 0; i < stemPart.length; i++) if (!isConsonant(stemPart, i)) return true;
  return false;
}

function endsDoubleConsonant(w: string): boolean {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && isConsonant(w, n - 1);
}

/** Ends consonant-vowel-consonant where the final consonant is not w, x or y. */
function endsCvc(w: string): boolean {
  const n = w.length;
  if (n < 3) return false;
  return (
    isConsonant(w, n - 3) && !isConsonant(w, n - 2) && isConsonant(w, n - 1) && !'wxy'.includes(w[n - 1])
  );
}

const byLengthDesc = (list: [string, string][]) => [...list].sort((a, b) => b[0].length - a[0].length);

const STEP2 = byLengthDesc([
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['bli', 'ble'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
  ['logi', 'log'],
]);

const STEP3 = byLengthDesc([
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
]);

const STEP4 = [
  'al',
  'ance',
  'ence',
  'er',
  'ic',
  'able',
  'ible',
  'ant',
  'ement',
  'ment',
  'ent',
  'ion',
  'ou',
  'ism',
  'ate',
  'iti',
  'ous',
  'ive',
  'ize',
].sort((a, b) => b.length - a.length);

function replaceSuffix(w: string, list: [string, string][], minMeasure: number): string {
  for (const [suffix, repl] of list) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, w.length - suffix.length);
    return measure(base) > minMeasure ? base + repl : w;
  }
  return w;
}

const stemCache = new Map<string, string>();

/** English stem of a lowercase word (non-alphabetic tokens are returned unchanged). */
export function stem(word: string): string {
  if (word.length <= 2 || !/^[a-z]+$/.test(word)) return word;
  const hit = stemCache.get(word);
  if (hit !== undefined) return hit;
  let w = word;

  // Step 1a: plurals
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) {
    /* unchanged */
  } else if (w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b: -eed, -ed, -ing
  let step1bExtra = false;
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    step1bExtra = true;
  } else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    step1bExtra = true;
  }
  if (step1bExtra) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
    else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && endsCvc(w)) w += 'e';
  }

  // Step 1c: y -> i when the stem has a vowel
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;

  // Steps 2 and 3: map double suffixes to single ones
  w = replaceSuffix(w, STEP2, 0);
  w = replaceSuffix(w, STEP3, 0);

  // Step 4: remove a final suffix when m > 1
  for (const suffix of STEP4) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, w.length - suffix.length);
    if (measure(base) > 1 && (suffix !== 'ion' || /[st]$/.test(base))) w = base;
    break;
  }

  // Step 5a: remove a final -e
  if (w.endsWith('e')) {
    const base = w.slice(0, -1);
    const m = measure(base);
    if (m > 1 || (m === 1 && !endsCvc(base))) w = base;
  }
  // Step 5b: -ll -> -l when m > 1
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith('l')) w = w.slice(0, -1);

  if (stemCache.size > 50_000) stemCache.clear();
  stemCache.set(word, w);
  return w;
}

// ------------------------------------------------------------------ sentences

/** First sentence of a text (plain), capped to `max` characters. */
export function firstSentence(text: string, max = 240): string {
  const t = plainText(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = (m ? m[1] : t).trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Splits plain text into sentences (keeps list items as separate sentences). */
export function sentences(text: string): string[] {
  return plainText(text)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/^[-*•]\s*/, '').trim())
    .filter((s) => s.length > 0);
}

/** Number of meaningful words (stop words excluded). */
export function countRelevantWords(text: string): number {
  let n = 0;
  for (const t of tokenize(text)) if (!STOP_WORDS.has(t)) n++;
  return n;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/** Levenshtein distance (two-row dynamic programming); null when the texts are too long to compare. */
export function editDistance(a: string, b: string, maxLength = 5000): number | null {
  if (a.length > maxLength || b.length > maxLength) return null;
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
