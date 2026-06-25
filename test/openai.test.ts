/**
 * Adapter test for the optional `fugu-poc/openai` subpath. `openai` is an installed
 * dev dependency here, so we let the real dynamic import resolve (no module mocking)
 * and assert the client is constructed and wired to the Fugu endpoint + key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFuguOpenAI } from "../src/openai.ts";

test("createFuguOpenAI constructs an OpenAI client wired to Fugu", async () => {
  const client = await createFuguOpenAI<{ baseURL?: string; apiKey?: string }>({
    apiKey: "sk-test-adapter",
    baseURL: "https://api.test/v1",
  });
  assert.ok(client);
  // Options take precedence over env/config, so these reflect exactly what we passed.
  assert.equal(client.baseURL, "https://api.test/v1");
  assert.equal(client.apiKey, "sk-test-adapter");
});
