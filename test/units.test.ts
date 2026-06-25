/**
 * Small pure-function unit tests for shared internals and helpers that the
 * higher-level suites only exercise indirectly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProp, errorMessage, toError, requestIdFrom } from "../src/internal.ts";
import { retryDelayMs, DEFAULT_RETRY } from "../src/retry.ts";
import { FuguRateLimitError, parseApiError } from "../src/errors.ts";
import { BudgetGuard } from "../src/budget.ts";
import { redact } from "../src/redact.ts";

test("getProp reads own data keys and refuses prototype-chain keys", () => {
  assert.equal(getProp({ a: 1 }, "a"), 1);
  assert.equal(getProp({ a: 1 }, "missing"), undefined);
  assert.equal(getProp(null, "a"), undefined);
  assert.equal(getProp("not-an-object", "length"), undefined);
  // Hardening: never walk the prototype chain, even for a literal __proto__ own-key.
  assert.equal(getProp({}, "__proto__"), undefined);
  assert.equal(getProp({}, "constructor"), undefined);
  assert.equal(getProp({}, "prototype"), undefined);
});

test("errorMessage and toError normalize unknown throwables", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(42), "42");

  const original = new Error("x");
  assert.equal(toError(original), original); // Errors pass through unchanged
  const made = toError("oops");
  assert.ok(made instanceof Error);
  assert.equal(made.message, "oops");
});

test("requestIdFrom reads canonical and legacy header spellings", () => {
  assert.equal(requestIdFrom(new Headers({ "x-request-id": "r1" })), "r1");
  assert.equal(requestIdFrom(new Headers({ "x-requestid": "r2" })), "r2");
  assert.equal(requestIdFrom(new Headers()), undefined);
});

test("retryDelayMs caps a server Retry-After at 60s", () => {
  const huge = new FuguRateLimitError("slow", { retryAfterMs: 24 * 60 * 60_000 });
  assert.equal(retryDelayMs(huge, 0, DEFAULT_RETRY), 60_000);
  const small = new FuguRateLimitError("slow", { retryAfterMs: 2_000 });
  assert.equal(retryDelayMs(small, 0, DEFAULT_RETRY), 2_000);
});

test("parseApiError marks truncated messages with an ellipsis (and leaves short ones alone)", () => {
  const long = "x".repeat(600);
  const truncated = parseApiError(JSON.stringify({ error: { message: long } }));
  assert.ok(truncated?.message?.endsWith("…"));
  assert.equal(truncated?.message?.length, 513); // 512 chars + ellipsis
  const short = parseApiError(JSON.stringify({ error: { message: "nope" } }));
  assert.equal(short?.message, "nope");
});

test("BudgetGuard.check(estimated) throws before spend would exceed the limit", () => {
  const budget = new BudgetGuard({ limitUsd: 1 });
  budget.record(0.6);
  assert.throws(() => budget.check(0.5), /Budget exceeded/); // 0.6 + 0.5 > 1
  assert.doesNotThrow(() => budget.check(0.3)); // 0.6 + 0.3 <= 1
});

test("redact censors deny-listed keys (incl. obsidian + sakana api keys), nested too", () => {
  const out = redact({
    obsidian_api_key: "s1",
    sakana_api_key: "s2",
    nested: { "x-api-key": "s3", keep: "ok" },
  }) as Record<string, unknown>;
  assert.equal(out.obsidian_api_key, "[REDACTED]");
  assert.equal(out.sakana_api_key, "[REDACTED]");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested["x-api-key"], "[REDACTED]");
  assert.equal(nested.keep, "ok");
});
