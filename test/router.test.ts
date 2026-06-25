/**
 * FuguRouter failover coverage (the module previously had no tests): success tagging,
 * fail-over on retryable/auth errors, NO fail-over on non-retryable ones, the all-fail
 * path, per-provider model override, a custom shouldFailover, and stream-from-first.
 * Mocked fetch, fully offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FuguClient } from "../src/fugu-client.ts";
import { FuguRouter } from "../src/router.ts";
import { FuguError, FuguBadRequestError, FuguRateLimitError } from "../src/errors.ts";
import { DEFAULT_BASE_URL } from "../src/config.ts";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A provider whose fetch returns a fixed response, with a call counter and an optional model. */
function provider(name: string, factory: () => Response, model?: string) {
  const state = { calls: 0 };
  const fn = (async () => {
    state.calls += 1;
    return factory();
  }) as unknown as typeof fetch;
  // maxRetries:0 so a transient error fails fast — we want to exercise failover, not retry.
  const client = new FuguClient({
    apiKey: "k",
    baseUrl: DEFAULT_BASE_URL,
    model: "fugu",
    fetch: fn,
    maxRetries: 0,
  });
  return { name, client, model, state };
}

test("router returns the first provider's result, tagged with its name", async () => {
  const a = provider("a", () => jsonResponse({ output_text: "from-a" }));
  const b = provider("b", () => jsonResponse({ output_text: "from-b" }));
  const r = await new FuguRouter({ providers: [a, b] }).respond("hi");
  assert.equal(r.text, "from-a");
  assert.equal(r.provider, "a");
  assert.equal(b.state.calls, 0); // never reached
});

test("router fails over to the next provider on a retryable (429) error", async () => {
  const a = provider("a", () => jsonResponse({ error: { message: "slow" } }, 429));
  const b = provider("b", () => jsonResponse({ output_text: "from-b" }));
  const r = await new FuguRouter({ providers: [a, b] }).respond("hi");
  assert.equal(r.text, "from-b");
  assert.equal(r.provider, "b");
  assert.equal(a.state.calls, 1);
});

test("router fails over on an auth (401) error by default", async () => {
  const a = provider("a", () => jsonResponse({ error: { message: "bad key" } }, 401));
  const b = provider("b", () => jsonResponse({ output_text: "recovered" }));
  const r = await new FuguRouter({ providers: [a, b] }).respond("hi");
  assert.equal(r.provider, "b");
});

test("router does NOT fail over on a non-retryable 400 — it throws and skips the rest", async () => {
  const a = provider("a", () => jsonResponse({ error: { message: "bad" } }, 400));
  const b = provider("b", () => jsonResponse({ output_text: "unused" }));
  await assert.rejects(
    () => new FuguRouter({ providers: [a, b] }).respond("hi"),
    (e: unknown) => e instanceof FuguBadRequestError,
  );
  assert.equal(b.state.calls, 0);
});

test("router throws the last error when every provider fails", async () => {
  const a = provider("a", () => jsonResponse({ error: { message: "slow" } }, 429));
  const b = provider("b", () => jsonResponse({ error: { message: "slow" } }, 429));
  await assert.rejects(
    () => new FuguRouter({ providers: [a, b] }).respond("hi"),
    (e: unknown) => e instanceof FuguRateLimitError,
  );
  assert.equal(a.state.calls, 1);
  assert.equal(b.state.calls, 1);
});

test("router applies a per-provider model override", async () => {
  const a = provider("a", () => jsonResponse({ output_text: "ok" }), "fugu-ultra");
  const r = await new FuguRouter({ providers: [a] }).respond("hi");
  assert.equal(r.model, "fugu-ultra");
});

test("a custom shouldFailover can refuse to fail over", async () => {
  const a = provider("a", () => jsonResponse({ error: { message: "slow" } }, 429));
  const b = provider("b", () => jsonResponse({ output_text: "unused" }));
  await assert.rejects(() => new FuguRouter({ providers: [a, b], shouldFailover: () => false }).respond("hi"));
  assert.equal(b.state.calls, 0);
});

test("respondStream streams from the first provider only (no mid-stream failover)", async () => {
  const a = provider("a", () =>
    sseResponse(['data: {"type":"response.output_text.delta","delta":"hi"}\n\n', "data: [DONE]\n\n"]),
  );
  const b = provider("b", () => jsonResponse({ output_text: "unused" }));
  let text = "";
  for await (const ev of new FuguRouter({ providers: [a, b] }).respondStream("x")) {
    if (ev.type === "delta") text += ev.textDelta ?? "";
  }
  assert.equal(text, "hi");
  assert.equal(b.state.calls, 0);
});

test("constructing a router with no providers throws a config error", () => {
  assert.throws(
    () => new FuguRouter({ providers: [] }),
    (e: unknown) => e instanceof FuguError && e.code === "config",
  );
});
