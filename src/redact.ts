/**
 * Zero-dependency secret redaction.
 *
 * Anything that could carry the API key — the `Authorization` header, a stray
 * `Bearer …` / `sk-…` token in an error body or log line — is scrubbed before it
 * can reach stdout/stderr, a logger, or an error message.
 */

/**
 * Header/field names whose values must never be surfaced. Exact (lower-cased) match, so
 * benign look-alikes like `total_tokens` / a logprobs `token` field are NOT redacted —
 * only fields whose name *is* a credential. Covers the common bearer/secret aliases, not
 * just this API's own keys, since `redact()` runs over arbitrary upstream payloads.
 */
const DENY_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "apikey",
  "api_key",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "sakana_api_key",
  "sakana-api-key",
  "obsidian_api_key",
  "obsidian-api-key",
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "private_key",
  "cookie",
  "set-cookie",
]);

/** Scrub key-shaped tokens from a free-text string. */
export function redactString(input: string): string {
  return (
    input
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      // OpenAI-style keys with a hyphen or underscore prefix (e.g. "sk" + "-"/"_" + token).
      .replace(/\bsk[-_][A-Za-z0-9._-]{6,}/gi, "[REDACTED]")
      // Labelled secrets in free text: api_key=…, secret: …, "password":"…", `tok`, etc.
      // The separator tolerates a quote around the label so JSON / single-quoted blobs
      // (`"api_key": "…"`, `'api_key': '…'`) are scrubbed too. The value matcher is
      // quote-aware AND escape-aware: a double/single/backtick-quoted value is redacted IN
      // FULL — even with spaces or an escaped quote (`"a\" b"`) — while an unquoted value
      // stops at the first delimiter. (A bare `[^\s…]+` value leaked the tail past the
      // first space; a non-escape-aware `"[^"]*"` leaked the tail past an escaped quote.)
      // (The Authorization header is covered by the Bearer rule above + the object deny-list.)
      .replace(
        /\b(api[-_]?key|api[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd)\b(["']?\s*[=:]\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|([^\s"',}\]]+))/gi,
        (_m, key, sep, dq, sq, bt) => {
          const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : bt !== undefined ? "`" : "";
          return `${key}${sep}${quote}[REDACTED]${quote}`;
        },
      )
  );
}

/** Deep-redact an arbitrary value: deny-listed keys are censored, strings scrubbed. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = DENY_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, seen);
    }
    return out;
  }
  return value;
}
