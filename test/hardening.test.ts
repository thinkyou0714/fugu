/**
 * Behavior coverage for paths the phase suites leave under-tested: the runTools
 * iteration cap, streaming usage aggregation, output-token clamping, the input-size
 * boundary, and MemoryCache TTL/LRU semantics. Mocked fetch, fully offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FuguClient } from "../src/fugu-client.ts";
import { MemoryCache } from "../src/cache.ts";
import type { FuguResult } from "../src/types.ts";

const SK = "sk-test-key-abcdef";

function newClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): FuguClient {
  return new FuguClient({
    apiKey: SK,
    baseUrl: "https://api.test/v1",
    model: "fugu",
    fetch: fetchImpl,
    ...extra,
  });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

interface Captured {
  body: Record<string, unknown>;
}
function queueFetch(responders: Array<() => Response>): { fn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fn = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : {} });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder();
  }) as unknown as typeof fetch;
  return { fn, calls };
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

const toolCallResponse = () =>
  jsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });

test("runTools stops at maxIterations and returns the last result still carrying toolCalls", async () => {
  const { fn, calls } = queueFetch([toolCallResponse]); // model keeps asking for the tool
  const client = newClient(fn);
  const result = await client.runTools([{ role: "user", content: "go" }], {
    handlers: { ping: () => ({ ok: true }) },
    maxIterations: 2,
  });
  assert.equal(calls.length, 2); // hard cap honored
  assert.ok((result.toolCalls?.length ?? 0) > 0);
});

test("runTools floors maxIterations at 1", async () => {
  const { fn, calls } = queueFetch([toolCallResponse]);
  const client = newClient(fn);
  await client.runTools([{ role: "user", content: "go" }], {
    handlers: { ping: () => ({ ok: true }) },
    maxIterations: 0,
  });
  assert.equal(calls.length, 1);
});

test("respondStream surfaces usage + status from the terminal response.completed event", async () => {
  const chunks = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { output_text: "Hello", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const fn = (async () => sseResponse(chunks)) as unknown as typeof fetch;
  const client = newClient(fn);
  let text = "";
  let done: FuguResult | undefined;
  for await (const ev of client.respondStream("hi")) {
    if (ev.type === "delta") text += ev.textDelta ?? "";
    else done = ev.result;
  }
  assert.equal(text, "Hello");
  assert.equal(done?.usage.inputTokens, 3);
  assert.equal(done?.usage.outputTokens, 2);
  assert.equal(done?.status, "completed");
});

test("maxOutputTokens clamps the requested value on both endpoints", async () => {
  const { fn, calls } = queueFetch([
    () => jsonResponse({ output_text: "ok" }),
    () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
  ]);
  const client = newClient(fn, { maxOutputTokens: 100 });
  await client.respond("x", { maxOutputTokens: 5000 });
  await client.chat([{ role: "user", content: "x" }], { maxOutputTokens: 5000 });
  assert.equal(calls[0].body.max_output_tokens, 100);
  assert.equal(calls[1].body.max_completion_tokens, 100);
});

test("guardInput rejects only inputs strictly over maxInputChars", async () => {
  const { fn } = queueFetch([() => jsonResponse({ output_text: "ok" })]);
  const client = newClient(fn, { maxInputChars: 5 });
  await client.respond("12345"); // exactly 5 → allowed
  await assert.rejects(() => client.respond("123456"), /Input too large/);
});

const mkResult = (text: string): FuguResult => ({
  text,
  raw: {},
  model: "fugu",
  status: "completed",
  usage: {},
});

test("MemoryCache evicts the least-recently-used entry beyond maxEntries", async () => {
  const cache = new MemoryCache({ maxEntries: 2 });
  await cache.set("a", mkResult("a"));
  await cache.set("b", mkResult("b"));
  await cache.get("a"); // touch a → b becomes least-recently-used
  await cache.set("c", mkResult("c")); // evicts b
  assert.equal(await cache.get("b"), undefined);
  assert.ok(await cache.get("a"));
  assert.ok(await cache.get("c"));
});

test("MemoryCache expires entries at the TTL boundary (<=)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const cache = new MemoryCache({ ttlMs: 1000 }); // set at t=0 → expiresAt=1000
  await cache.set("k", mkResult("v"));
  t.mock.timers.tick(999);
  assert.ok(await cache.get("k")); // 999 < 1000 → still a hit
  t.mock.timers.tick(1); // now == 1000 == expiresAt → expired (<=)
  assert.equal(await cache.get("k"), undefined);
});
