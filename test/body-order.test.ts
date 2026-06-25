import { test } from "node:test";
import assert from "node:assert/strict";

import { FuguClient, functionTool } from "../src/index.ts";

// The request-body key order is part of the cache-key contract: `cacheKeyFor` hashes the
// body, so reordering fields in `buildBody` silently busts cache compatibility. These tests
// lock the canonical order for both endpoints — they fail loudly if a future edit reorders it.

interface RecordedCall {
  init: RequestInit & { body: string };
}

function mockFetch(responder: () => Response) {
  const calls: RecordedCall[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init: (init ?? {}) as RecordedCall["init"] });
    return responder();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const newClient = (fn: typeof fetch, model: string) =>
  new FuguClient({ apiKey: "k", baseUrl: "https://api.sakana.ai/v1", model, fetch: fn });

const tool = functionTool("f", { parameters: { type: "object", properties: {} } });

test("respond() body key order is stable (cache-key contract)", async () => {
  const { fn, calls } = mockFetch(() => jsonResponse({ status: "completed", output_text: "x" }));
  await newClient(fn, "fugu-ultra").respond("hi", {
    params: { temperature: 0.2 },
    instructions: "sys",
    reasoningEffort: "high",
    tools: [tool],
    toolChoice: "auto",
    previousResponseId: "resp_0",
    store: true,
    maxOutputTokens: 100,
  });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), [
    "temperature",
    "model",
    "input",
    "instructions",
    "reasoning",
    "tools",
    "tool_choice",
    "previous_response_id",
    "store",
    "max_output_tokens",
  ]);
});

test("chat() body key order is stable (cache-key contract)", async () => {
  const { fn, calls } = mockFetch(() =>
    jsonResponse({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }),
  );
  await newClient(fn, "fugu").chat([{ role: "user", content: "hi" }], {
    params: { temperature: 0.2 },
    reasoningEffort: "high",
    tools: [tool],
    toolChoice: "auto",
    maxOutputTokens: 50,
  });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), [
    "temperature",
    "model",
    "messages",
    "reasoning",
    "tools",
    "tool_choice",
    "max_completion_tokens",
  ]);
});
