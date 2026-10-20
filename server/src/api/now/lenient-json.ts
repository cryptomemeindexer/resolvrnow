/**
 * Lenient JSON reader for request bodies.
 *
 * Several official REST samples send single-quoted JSON (`{'short_description':'x'}`) or
 * unquoted property names, and platform clients rely on those bodies being accepted.
 * Strict JSON is tried first; on failure this JSON5-style parser accepts single-quoted
 * strings, unquoted identifier keys, trailing commas, comments, hexadecimal numbers,
 * leading `+` and leading or trailing decimal points.
 */

export class JsonSyntaxError extends Error {}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;
const NUMBER_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)/;

class Reader {
  i = 0;

  constructor(private readonly s: string) {
    if (s.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  fail(msg: string): never {
    throw new JsonSyntaxError(`${msg} at position ${this.i}`);
  }

  ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const ch = s[this.i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ' || ch === '﻿') {
        this.i++;
      } else if (ch === '/' && s[this.i + 1] === '/') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (ch === '/' && s[this.i + 1] === '*') {
        const end = s.indexOf('*/', this.i + 2);
        if (end < 0) this.fail('Unterminated comment');
        this.i = end + 2;
      } else {
        break;
      }
    }
  }

  value(): unknown {
    this.ws();
    const ch = this.s[this.i];
    if (ch === undefined) this.fail('Unexpected end of input');
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) return this.number();
    const word = this.identifier();
    switch (word) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'Infinity':
        return Number.POSITIVE_INFINITY;
      case 'NaN':
        return Number.NaN;
      default:
        return this.fail(`Unexpected token ${word ?? ch}`);
    }
  }

  identifier(): string | null {
    const s = this.s;
    if (this.i >= s.length || !ID_START.test(s[this.i])) return null;
    const start = this.i++;
    while (this.i < s.length && ID_PART.test(s[this.i])) this.i++;
    return s.slice(start, this.i);
  }

  number(): number {
    const m = NUMBER_RE.exec(this.s.slice(this.i));
    if (!m) this.fail('Invalid number');
    this.i += m[0].length;
    const t = m[0];
    if (/^[+-]?0[xX]/.test(t)) {
      const neg = t.startsWith('-');
      const n = Number.parseInt(t.replace(/^[+-]/, ''), 16);
      return neg ? -n : n;
    }
    return Number(t);
  }

  string(): string {
    const s = this.s;
    const quote = s[this.i++];
    let out = '';
    while (this.i < s.length) {
      const ch = s[this.i++];
      if (ch === quote) return out;
      if (ch === '\n' || ch === '\r') this.fail('Unterminated string');
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const e = s[this.i++];
      switch (e) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'v':
          out += '\v';
          break;
        case '0':
          out += '\0';
          break;
        case 'x': {
          const hex = s.slice(this.i, this.i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('Invalid escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.i += 2;
          break;
        }
        case 'u': {
          const hex = s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.i += 4;
          break;
        }
        case '\r':
          if (s[this.i] === '\n') this.i++;
          break;
        case '\n':
          break;
        case undefined:
          return this.fail('Unterminated string');
        default:
          out += e;
      }
    }
    return this.fail('Unterminated string');
  }

  array(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === ']') {
          this.i++;
          return out;
        }
        continue;
      }
      if (c === ']') {
        this.i++;
        return out;
      }
      this.fail("Expected ',' or ']'");
    }
  }

  object(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const ch = this.s[this.i];
      const key = ch === '"' || ch === "'" ? this.string() : this.identifier();
      if (key === null) this.fail('Expected a property name');
      this.ws();
      if (this.s[this.i] !== ':') this.fail("Expected ':'");
      this.i++;
      const v = this.value();
      // Own property even for "__proto__", like JSON.parse.
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === '}') {
          this.i++;
          return out;
        }
        continue;
      }
      if (c === '}') {
        this.i++;
        return out;
      }
      this.fail("Expected ',' or '}'");
    }
  }
}

/** Parses strict JSON, falling back to the lenient grammar. Throws JsonSyntaxError. */
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* not strict JSON: try the lenient reader */
  }
  const r = new Reader(text);
  const v = r.value();
  r.ws();
  if (r.i < text.length) r.fail('Unexpected trailing content');
  return v;
}
