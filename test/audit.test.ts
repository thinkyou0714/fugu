/**
 * Coverage for the audit-driven fixes:
 *  - redactString now scrubs JSON-shaped labelled secrets (`"api_key": "…"`)
 *  - redact() censors the expanded deny-list (password / access_token / secret / …)
 *  - parseApiError redacts the error `type`/`code` slugs, not just `message`
 *  - runEval bypasses the client cache by default (and honors an explicit override)
 *  - Cascade reports totalCostUsd across every stage that ran
 *  - the MCP fugu_chat handler forwards `effort`
 * Fully offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { redact, redactString } from "../src/redact.ts";
import { parseApiError } from "../src/errors.ts";
import { Cascade } from "../src/cascade.ts";
import type { Responder } from "../src/cascade.ts";
import { runEval, exactGrader } from "../src/evals.ts";
import type { FuguResult } from "../src/types.ts";
import type { GenerateOptions, FuguClient } from "../src/fugu-client.ts";
import { fuguChat } from "../integrations/mcp/src/handlers.ts";

function result(text: string, extra: Partial<FuguResult> = {}): FuguResult {
  return { text, raw: {}, model: "fugu", status: "completed", usage: {}, ...extra };
}

// Assemble secret-shaped strings at runtime so no literal token lives in source.
const SK = ["sk", "DEADBEEFcafe1234"].join("-");

// ---------------------------------------------------------------- redaction

test("redactString scrubs a labelled secret inside a JSON-shaped blob", () => {
  const secret = "supersecretvalue42";
  const out = redactString(`{"api_key": "${secret}"}`);
  assert.ok(!out.includes(secret), "raw secret must not survive");
  assert.match(out, /\[REDACTED\]/);
});

test("redactString handles password=/secret: forms and an unquoted JSON value", () => {
  assert.equal(redactString("password=hunter2pass go"), "password=[REDACTED] go");
  assert.equal(redactString("secret: topsecretvalue"), "secret: [REDACTED]");
  const out = redactString('{"client_secret":abcdef123456}');
  assert.ok(!out.includes("abcdef123456"));
});

test("redact() censors the expanded deny-list and leaves benign fields", () => {
  const out = redact({
    password: "p",
    access_token: "t",
    refresh_token: "rt",
    secret: "s",
    "proxy-authorization": "Bearer x",
    total_tokens: 1234, // benign look-alike — must NOT be redacted
    keep: "ok",
  }) as Record<string, unknown>;
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.access_token, "[REDACTED]");
  assert.equal(out.refresh_token, "[REDACTED]");
  assert.equal(out.secret, "[REDACTED]");
  assert.equal(out["proxy-authorization"], "[REDACTED]");
  assert.equal(out.total_tokens, 1234);
  assert.equal(out.keep, "ok");
});

test("parseApiError redacts a secret echoed in the error type/code slugs", () => {
  const parsed = parseApiError(
    JSON.stringify({ error: { message: "bad", type: `api_key=${SK}`, code: `Bearer ${SK}` } }),
  );
  assert.ok(!parsed?.type?.includes(SK), "type must not leak the key");
  assert.ok(!parsed?.code?.includes(SK), "code must not leak the key");
  assert.match(parsed?.type ?? "", /\[REDACTED\]/);
  assert.match(parsed?.code ?? "", /\[REDACTED\]/);
});

// ---------------------------------------------------------------- evals cache bypass

test("runEval bypasses the client cache by default, and honors an explicit override", async () => {
  const seen: GenerateOptions[] = [];
  const client: Responder = {
    async respond(_input, opts) {
      seen.push(opts ?? {});
      return result("x", { costUsd: 0.01 });
    },
  };
  await runEval(client, [{ id: "a", input: "q" }], { grader: exactGrader() });
  assert.equal(seen[0].cache, false);

  seen.length = 0;
  await runEval(client, [{ id: "a", input: "q" }], { grader: exactGrader(), generate: { cache: true } });
  assert.equal(seen[0].cache, true);
});

// ---------------------------------------------------------------- cascade total cost

test("Cascade.totalCostUsd sums the cost of every stage that ran", async () => {
  const byModel: Record<string, FuguResult> = {
    fugu: result("", { status: "incomplete", costUsd: 0.001 }),
    "fugu-ultra": result("done", { costUsd: 0.02 }),
  };
  const client: Responder = {
    async respond(_input, opts) {
      return byModel[opts?.model ?? "fugu"];
    },
  };
  const outcome = await new Cascade(client, {
    stages: [{ model: "fugu" }, { model: "fugu-ultra" }],
  }).run("q");
  assert.equal(outcome.escalations, 1);
  assert.ok(Math.abs(outcome.totalCostUsd - 0.021) < 1e-9, `expected ~0.021, got ${outcome.totalCostUsd}`);
});

// ---------------------------------------------------------------- mcp chat effort

test("fugu_chat handler forwards the reasoning effort to the client", async () => {
  let seenOpts: GenerateOptions | undefined;
  const fake = {
    async chat(_messages: unknown, opts?: GenerateOptions) {
      seenOpts = opts;
      return result("ok");
    },
  } as unknown as FuguClient;
  await fuguChat(fake, { messages: [{ role: "user", content: "hi" }], effort: "high" });
  assert.equal(seenOpts?.reasoningEffort, "high");
});
