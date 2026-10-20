/**
 * Guardrails applied to everything sent to an LLM: secret redaction and escaping
 * of delimiter characters so record text cannot break out of its data section.
 */

const REDACTED = '[REDACTED]';

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

type Replacer = string | ((match: string, ...groups: string[]) => string);

/** Secret patterns, most specific first. */
const SECRET_PATTERNS: [RegExp, Replacer][] = [
  // PEM private keys
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED PRIVATE KEY]',
  ],
  // Credentials embedded in URLs: scheme://user:secret@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // Bearer / Basic authorization values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/g, `$1 ${REDACTED}`],
  // JSON web tokens
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  // Well-known API key shapes
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bresolvr_[A-Za-z0-9_-]{20,}/g, REDACTED],
  // key: value / key=value secrets
  [
    /\b(pass(?:word|wd|phrase|code)?|pwd|pin|secret|client[_ -]?secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|credentials?)(\s*(?::=|=>|[:=])\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${REDACTED}`,
  ],
  // "my password is Summer2026!" / "password was hunter2" (not "password is expired")
  [
    /\b(pass(?:word|wd|phrase|code)?|pwd)(\s+(?:is|was|to)\s+)("[^"]*"|'[^']*'|(?=\S*[0-9!@#$%^&*])\S+)/gi,
    `$1$2${REDACTED}`,
  ],
  // "temporary password Welcome1!" (a password-looking word right after the keyword)
  [/\b(pass(?:word|wd|code)|pwd)(\s+)(?=\S*[0-9!@#$%^&*])(\S{6,})/gi, `$1$2${REDACTED}`],
  // Payment card numbers (Luhn-valid 13-19 digit sequences)
  [
    /\b\d(?:[ -]?\d){12,18}\b/g,
    (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[REDACTED CARD]' : m;
    },
  ],
];

/** Replaces passwords, tokens, keys and card numbers with placeholders. */
export function stripSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = typeof repl === 'string' ? out.replace(re, repl) : out.replace(re, repl as (m: string) => string);
  }
  return out;
}

/** True when stripSecrets would change the text. */
export function containsSecret(text: string): boolean {
  return stripSecrets(text) !== text;
}

/** Neutralises angle brackets so data cannot open or close prompt sections. */
export function escapeData(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches control characters on purpose, to remove them
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Sanitises a value for prompts and offline output: secrets removed, control characters dropped. */
export function sanitize(text: string, max = 4000): string {
  const clean = stripSecrets(text).replace(CONTROL_CHARS, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
