/**
 * OpenAI-compatible proxy coverage: route shapes (/models, /chat/completions, /responses),
 * the /v1 prefix, 404s, bearer-token auth (incl. the constant-time path), and — the new
 * behavior — that body fields beyond `model` (effort, max tokens, instructions, sampling)
 * are forwarded to the backend instead of silently dropped. Runs against a real loopback
 * server with a mock backend; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createProxyServer } from "../src/proxy.ts";
import type { ProxyBackend, ProxyOptions } from "../src/proxy.ts";
import type { FuguResult } from "../src/types.ts";
import type { GenerateOptions, ChatMessage, FuguStreamEvent } from "../src/fugu-client.ts";

function mkResult(extra: Partial<FuguResult> = {}): FuguResult {
  return {
    text: "hello",
    raw: { output_text: "hello" },
    model: "fugu",
    status: "completed",
    usage: { inputTokens: 1, outputTokens: 2 },
    ...extra,
  };
}

/** A backend that records the opts it was last called with, so we can assert passthrough. */
function recordingBackend() {
  const seen: { respond?: GenerateOptions; chat?: GenerateOptions } = {};
  const backend: ProxyBackend = {
    async respond(_input: string, opts?: GenerateOptions) {
      seen.respond = opts;
      return mkResult({ text: "r", raw: { output_text: "r" } });
    },
    async chat(_messages: ChatMessage[], opts?: GenerateOptions) {
      seen.chat = opts;
      return mkResult({ text: "c", raw: {} });
    },
    async *respondStream() {
      yield { type: "delta", textDelta: "x" } as FuguStreamEvent;
      yield { type: "done", result: mkResult() } as FuguStreamEvent;
    },
    async *chatStream() {
      yield { type: "delta", textDelta: "x" } as FuguStreamEvent;
      yield { type: "done", result: mkResult() } as FuguStreamEvent;
    },
  };
  return { backend, seen };
}

async function withServer(opts: ProxyOptions, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createProxyServer(opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /v1/models and /models both list the advertised models", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend }, async (base) => {
    for (const path of ["/v1/models", "/models"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      assert.deepEqual(
        body.data.map((m) => m.id),
        ["fugu", "fugu-ultra"],
      );
    }
  });
});

test("unknown routes 404", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend }, async (base) => {
    const res = await fetch(`${base}/v1/nope`);
    assert.equal(res.status, 404);
  });
});

test("POST /v1/chat/completions returns an OpenAI chat.completion shape", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fugu", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; choices: Array<{ message: { content: string } }> };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "c");
  });
});

test("POST /v1/responses returns the raw payload", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend }, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fugu", input: "hi" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output_text: string };
    assert.equal(body.output_text, "r");
  });
});

test("bearer auth: missing/wrong token is 401, correct token passes", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend, token: "s3cret" }, async (base) => {
    const noAuth = await fetch(`${base}/v1/models`);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200);
  });
});

test("a wrong-length token is rejected (constant-time compare guards the length first)", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend, token: "s3cret" }, async (base) => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer s" } });
    assert.equal(res.status, 401);
  });
});

test("body fields beyond model (effort, max tokens, instructions, sampling) are forwarded", async () => {
  const { backend, seen } = recordingBackend();
  await withServer({ backend }, async (base) => {
    await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fugu-ultra",
        input: "hi",
        reasoning: { effort: "high" },
        max_output_tokens: 50,
        instructions: "be terse",
        temperature: 0.5,
        seed: 7,
      }),
    });
    assert.equal(seen.respond?.model, "fugu-ultra");
    assert.equal(seen.respond?.reasoningEffort, "high");
    assert.equal(seen.respond?.maxOutputTokens, 50);
    assert.equal(seen.respond?.instructions, "be terse");
    assert.deepEqual(seen.respond?.params, { temperature: 0.5, seed: 7 });
  });
});

test("streaming chat completions emit SSE chunks then [DONE]", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fugu", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /data: /);
    assert.match(text, /\[DONE\]/);
  });
});
