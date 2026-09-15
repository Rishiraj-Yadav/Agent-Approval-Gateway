/**
 * @raag/security — redaction primitives.
 *
 * PURPOSE: text leaving the process (Telegram content, log lines, audit
 * detail, validation messages) must not carry recognized secrets.
 *
 * HONEST LIMITATIONS (see security.md, ADR-021):
 *  - Detection is best-effort (value PATTERN + field NAME). Novel formats or
 *    key names can survive. The PRIMARY defense is structural: raw agent
 *    payloads are hashed and discarded, secrets live in env/config that
 *    never enter these functions. Redaction is the second layer.
 *  - Deterministic and idempotent: REDACTED itself matches no rule, so a
 *    second pass is a no-op (property-tested).
 */
export const packageName = '@raag/security' as const;

/** Canonical replacement token — short; "[redacted]" matches no rule. */
export const REDACTED = '[redacted]';
const MAX_STRING_INPUT = 65_536;

/** Sensitive key-name alternation shared by the kv rule. */
const W =
  '(?:password|passwd|credential|credentials|api[_-]?key|apikey|access[_-]?key|accesskey|secret[_-]?access[_-]?key|client[_-]?secret|hmac[_-]?key|signing[_-]?key|private[_-]?key|connection[_-]?string|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|secret|token)';

interface Rule {
  readonly re: RegExp;
  /** Receives (whole match, positional capture strings). */
  readonly repl: (match: string, captures: readonly string[]) => string;
}

const keepHead =
  (n: number): Rule['repl'] =>
  (_m, captures) =>
    `${captures.slice(0, n).join('')}${REDACTED}`;

/** Evaluated in order: specific shapes first, generic base64 LAST. */
export const REDACTION_RULES: readonly Rule[] = [
  // PEM private key blocks (span lines)
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    repl: () => REDACTED,
  },
  // JWT-ish triplets (eyJ… header)
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, repl: () => REDACTED },
  // Telegram bot token: <digits>:<32+ base64url chars>
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, repl: () => REDACTED },
  // AWS-style access key ids
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, repl: () => REDACTED },
  // Authorization header line — keep only the label + separator
  { re: /((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi, repl: keepHead(1) },
  // Loose "Bearer <opaque>" — keep the scheme word
  { re: /(Bearer\s)[A-Za-z0-9._~+/=-]{8,}/gi, repl: keepHead(1) },
  // key <sep> value with a sensitive name; tolerates JSON quoting either side.
  // Quoted values are dropped entirely (display context doesn't need them).
  {
    re: new RegExp(
      `(${W})(["'\x60]?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|\x60[^\x60]*\x60|[^\\s,;"\x60{}\\[\\]()]+)`,
      'gi',
    ),
    repl: keepHead(2),
  },
  // Generic long base64 material — LAST
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, repl: () => REDACTED },
];

/** Deterministic string redaction. Oversized input is clipped, never dumped. */
export function redactString(input: string): string {
  let out =
    input.length > MAX_STRING_INPUT ? `${input.slice(0, MAX_STRING_INPUT)}…[truncated]` : input;
  for (const rule of REDACTION_RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      // callback args: captures…, offset, whole-string — trim the numeric tail
      const captures = rest
        .slice(0, Math.max(0, rest.length - 2))
        .filter((r): r is string => typeof r === 'string');
      return rule.repl(match, captures);
    });
  }
  return out;
}

/** Sensitive field NAMES (wherever they appear) force whole-value replacement. */
export function isSensitiveFieldName(raw: string): boolean {
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n.length === 0) return false;
  return (
    n === 'authorization' ||
    n === 'proxyauthorization' ||
    n === 'cookie' ||
    n.includes('token') ||
    n.includes('secret') ||
    n.includes('password') ||
    n.includes('credential') ||
    n.includes('privatekey') ||
    n.includes('apikey') ||
    n.includes('accesskey')
  );
}

const MAX_DEPTH = 12;
const MAX_ARRAY_ITEMS = 64;
const MAX_OBJECT_KEYS = 256;

/**
 * Deep structural redaction for ARBITRARY UNTRUSTED values:
 * sensitive NAMES ⇒ whole value replaced; strings ⇒ redactString; output is
 * rebuilt onto null prototypes (hostile "__proto__" keys stay plain data);
 * depth/breadth/cycle bounded; opaque markers for exotic kinds.
 */
export function redactUnknown(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]';
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return null;
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
    default:
      if (value === null) return null;
      if (value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
      if (typeof value !== 'object') return '[unserializable]';
      if (seen.has(value)) return '[cycle]';
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const head = value.slice(0, MAX_ARRAY_ITEMS).map((el) => walk(el, depth + 1, seen));
          if (value.length > MAX_ARRAY_ITEMS)
            head.push(`…(${value.length - MAX_ARRAY_ITEMS} more)`);
          return head;
        }
        const entries = Object.entries(value as Record<string, unknown>);
        const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) {
          out[redactString(key.slice(0, 128))] = isSensitiveFieldName(key)
            ? REDACTED
            : walk(val, depth + 1, seen);
        }
        if (entries.length > MAX_OBJECT_KEYS) out['…'] = '[truncated]';
        return out;
      } finally {
        seen.delete(value);
      }
  }
}
