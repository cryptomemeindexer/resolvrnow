/**
 * Minimal XML support for the REST layer: request bodies (`Content-Type: application/xml`)
 * and responses (`Accept: application/xml`). Responses use a `<response>` root and
 * repeat an element per array item, so a record list is a series of `<result>` elements.
 * DOCTYPE declarations are rejected and entities other than the predefined and numeric
 * character references are not expanded.
 */

export class XmlSyntaxError extends Error {}

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][\w.:-]*)\s*>/y;

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Parses an XML document into a simple element tree (attributes are ignored). */
export function parseXml(text: string): XmlNode {
  const s = text.replace(/^﻿/, '');
  let i = 0;
  const fail = (msg: string): never => {
    throw new XmlSyntaxError(`${msg} at position ${i}`);
  };
  const skipMisc = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i);
        if (end < 0) fail('Unterminated processing instruction');
        i = end + 2;
      } else if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i);
        if (end < 0) fail('Unterminated comment');
        i = end + 3;
      } else if (s.startsWith('<!DOCTYPE', i) || s.startsWith('<!doctype', i)) {
        fail('DOCTYPE is not allowed');
      } else {
        return;
      }
    }
  };
  const element = (): XmlNode => {
    if (s[i] !== '<') fail("Expected '<'");
    START_TAG.lastIndex = i;
    const m = START_TAG.exec(s);
    if (!m) fail('Malformed start tag');
    i += m![0].length;
    const node: XmlNode = { name: m![1], children: [], text: '' };
    if (m![3] === '/') return node;
    let text = '';
    for (;;) {
      if (i >= s.length) fail(`Unclosed element <${node.name}>`);
      if (s.startsWith('</', i)) {
        END_TAG.lastIndex = i;
        const close = END_TAG.exec(s);
        if (!close || close[1] !== node.name) fail(`Mismatched closing tag for <${node.name}>`);
        i += close![0].length;
        node.text = text;
        return node;
      }
      if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i);
        if (end < 0) fail('Unterminated CDATA section');
        text += s.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i);
        if (end < 0) fail('Unterminated comment');
        i = end + 3;
        continue;
      }
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i);
        if (end < 0) fail('Unterminated processing instruction');
        i = end + 2;
        continue;
      }
      if (s[i] === '<') {
        node.children.push(element());
        continue;
      }
      const next = s.indexOf('<', i);
      const chunk = next < 0 ? s.slice(i) : s.slice(i, next);
      text += decode(chunk);
      i = next < 0 ? s.length : next;
    }
  };
  skipMisc();
  if (i >= s.length) fail('Empty document');
  const root = element();
  skipMisc();
  if (i < s.length) fail('Unexpected content after the root element');
  return root;
}

function nodeValue(n: XmlNode): unknown {
  if (!n.children.length) return n.text;
  const out: Record<string, unknown> = {};
  for (const c of n.children) {
    const v = nodeValue(c);
    const prev = out[c.name];
    if (prev === undefined) out[c.name] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[c.name] = [prev, v];
  }
  return out;
}

/**
 * Converts an XML request body to a flat field map. Wrapper elements such as
 * `<request><entry>...</entry></request>` are unwrapped.
 */
export function xmlToObject(text: string): Record<string, unknown> {
  let node = parseXml(text);
  for (let depth = 0; depth < 2; depth++) {
    const kids = node.children;
    if (
      kids.length === 1 &&
      kids[0].children.length > 0 &&
      ['request', 'entry', 'record', 'xml', 'response', 'result'].includes(node.name)
    ) {
      node = kids[0];
    } else {
      break;
    }
  }
  const v = nodeValue(node);
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tagName(name: string): string {
  let t = name.replace(/[^\w.-]/g, '_');
  if (!/^[A-Za-z_]/.test(t)) t = `_${t}`;
  return t;
}

function element(name: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((item) => element(name, item)).join('');
  const tag = tagName(name);
  if (v === null || v === undefined) return `<${tag}/>`;
  if (typeof v === 'object') {
    const inner = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => element(k, x))
      .join('');
    return `<${tag}>${inner}</${tag}>`;
  }
  return `<${tag}>${escapeText(String(v))}</${tag}>`;
}

/** Serializes a JSON response body under a `<response>` root. */
export function toXmlResponse(body: unknown): string {
  let inner: string;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    inner = Object.entries(body as Record<string, unknown>)
      .map(([k, v]) => element(k, v))
      .join('');
  } else {
    inner = element('result', body);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><response>${inner}</response>`;
}
