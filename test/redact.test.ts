import { test } from "node:test";
import assert from "node:assert/strict";

import { redact, redactString } from "../src/redact.ts";

// --- redactString: token-shaped secrets in free text ---

test("redacts a Bearer token", () => {
  assert.equal(redactString("Authorization: Bearer sk-abc123.def_456"), "Authorization: Bearer [REDACTED]");
});

test("redacts an sk- prefixed key", () => {
  assert.equal(redactString("key is sk-live_abcdef123456 ok"), "key is [REDACTED] ok");
});

// --- the regression: quoted secrets with spaces must be redacted IN FULL ---

test("redacts a double-quoted value containing spaces (the bug)", () => {
  assert.equal(redactString('api_key="hunter two three"'), 'api_key="[REDACTED]"');
});

test("redacts a single-quoted value containing spaces", () => {
  assert.equal(redactString("password='hunter two'"), "password='[REDACTED]'");
});

test("leaves trailing text after a quoted secret intact", () => {
  assert.equal(redactString('secret="a b c" and then more text'), 'secret="[REDACTED]" and then more text');
});

test("redacts an unquoted single-token value", () => {
  assert.equal(redactString("api_token=abc123def"), "api_token=[REDACTED]");
});

test("redacts with a colon separator and spacing", () => {
  assert.equal(redactString('access_token:  "x y z"'), 'access_token:  "[REDACTED]"');
});

test("redacts a JSON-shaped blob (quoted key + quoted multi-word value)", () => {
  assert.equal(redactString('{"api_key": "live multi word"}'), '{"api_key": "[REDACTED]"}');
});

// --- must NOT over-redact ordinary prose ---

test("does not touch the word 'secret' without a separator", () => {
  const s = "Keep this secret between us, it is a secret.";
  assert.equal(redactString(s), s);
});

test("does not touch unrelated key=value pairs", () => {
  assert.equal(redactString("model=fugu-ultra effort=high"), "model=fugu-ultra effort=high");
});

// --- deep redact(): deny-listed object keys are censored regardless of value shape ---

test("redact() censors deny-listed keys (incl. multi-word values)", () => {
  const out = redact({
    Authorization: "Bearer abc def",
    api_key: "a b c",
    cookie: "session=xyz",
    model: "fugu",
    nested: { sakana_api_key: "deep secret value" },
  }) as Record<string, unknown>;
  assert.equal(out.Authorization, "[REDACTED]");
  assert.equal(out.api_key, "[REDACTED]");
  assert.equal(out.cookie, "[REDACTED]");
  assert.equal(out.model, "fugu");
  assert.equal((out.nested as Record<string, unknown>).sakana_api_key, "[REDACTED]");
});

test("redact() scrubs token-shaped strings inside arrays", () => {
  const out = redact(["plain", "Bearer sk-secret_token_123"]) as string[];
  assert.equal(out[0], "plain");
  assert.equal(out[1], "Bearer [REDACTED]");
});

test("redact() handles circular references without throwing", () => {
  const obj: Record<string, unknown> = { a: 1 };
  obj.self = obj;
  const out = redact(obj) as Record<string, unknown>;
  assert.equal(out.a, 1);
  assert.equal(out.self, "[Circular]");
});

test("redact() passes through non-string primitives unchanged", () => {
  assert.equal(redact(42), 42);
  assert.equal(redact(true), true);
  assert.equal(redact(null), null);
});
