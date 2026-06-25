/**
 * Proxy coverage for behavior NOT already exercised by p4.test.ts: that request-body
 * fields beyond `model` (reasoning effort, output-token cap, instructions, sampling) are
 * forwarded to the backend, and that the constant-time bearer check rejects a wrong-LENGTH
 * token with 401 (rather than throwing inside timingSafeEqual). Runs against a real
 * loopback server with a mock backend; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createProxyServer } from "../src/proxy.ts";
import type { ProxyBackend, ProxyOptions } from "../src/proxy.ts";
import type { FuguResult } from "../src/types.ts";
import type { GenerateOptions, FuguStreamEvent } from "../src/fugu-client.ts";

function mkResult(extra: Partial<FuguResult> = {}): FuguResult {
  return {
    text: "r",
    raw: { output_text: "r" },
    model: "fugu",
    status: "completed",
    usage: { inputTokens: 1, outputTokens: 2 },
    ...extra,
  };
}

/** A backend that records the opts it was last called with, so we can assert passthrough. */
function recordingBackend() {
  const seen: { respond?: GenerateOptions } = {};
  const backend: ProxyBackend = {
    async respond(_input: string, opts?: GenerateOptions) {
      seen.respond = opts;
      return mkResult();
    },
    async chat() {
      return mkResult();
    },
    async *respondStream() {
      yield { type: "done", result: mkResult() } as FuguStreamEvent;
    },
    async *chatStream() {
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

test("a wrong-LENGTH bearer token is rejected with 401 (constant-time length guard)", async () => {
  const { backend } = recordingBackend();
  await withServer({ backend, token: "s3cret" }, async (base) => {
    // Shorter than "Bearer s3cret" — timingSafeEqual would throw on unequal lengths without
    // the guard; the proxy must turn this into a clean 401, not a 500.
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer s" } });
    assert.equal(res.status, 401);
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200);
  });
});
