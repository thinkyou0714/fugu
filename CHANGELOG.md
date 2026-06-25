# @thinkyou0714/fugu

## 0.2.0

### Minor Changes

- 3412465: P0 + P1 hardening: typed `FuguError` hierarchy with secret redaction (the raw
  response body is never stored or logged), typed `usage` + cost estimation
  including Fugu's hidden orchestration tokens, effort-scaled request timeouts,
  `status`/`incomplete`/`finishReason` surfacing, a curated public API barrel, an
  optional `./openai` adapter, and a real ESM build (tsdown) with `exports`/`bin`
  validated by publint + are-the-types-wrong.
- 9863c40: Live smoke test (`npm run smoke`): a key-gated, one-shot real round-trip against
  `api.sakana.ai` that prints a PASS/FAIL banner with latency + usage and, on failure, maps
  each typed `FuguError` to a concrete fix (401 → re-copy SAKANA_API_KEY, 403 → plan/model
  access, 429 → wait, connection/parse → verify SAKANA_BASE_URL, timeout → raise/retry).
  Distinct exit codes (0 pass / 1 failed / 2 not configured) let CI treat a missing key as a
  skip. The `diagnose` / `runSmoke` / `formatSmoke` helpers are pure and unit-tested offline.
- 3412465: P2 resilience & cost control: automatic retries (exponential backoff + full jitter,
  honoring `Retry-After`) with a stable `Idempotency-Key`, SSE streaming
  (`respondStream` / `chatStream`), a `BudgetGuard` spend circuit-breaker, output-token
  and input-size caps, and a `chooseModel()` routing policy (`fugu` ↔ `fugu-ultra`).
- 3412465: P3 advanced API & observability: tool / function calling (`tools`, `toolChoice`,
  parsed `result.toolCalls`, built-in `web_search`) plus a `runTools` agentic loop;
  structured output via `respondJson` with a validate-and-repair loop
  (`FuguValidationError`); stateful Responses chaining (`previousResponseId` / `store`
  and a `Conversation` helper); and dependency-free observability hooks
  (`onRequest` / `onResponse` / `logger`) for wiring pino / OpenTelemetry.
- 3412465: P4 ecosystem (router + proxy): a multi-provider `FuguRouter` that fails over across
  OpenAI-compatible providers (Fugu primary → backups) on transient/auth errors, and a
  zero-dependency OpenAI-compatible HTTP `createProxyServer` (+ `fugu-proxy` bin)
  exposing `/v1/models`, `/v1/chat/completions`, and `/v1/responses` (with SSE
  streaming) so Cursor / n8n / any OpenAI-SDK tool can target Fugu at a localhost
  endpoint, optionally behind a local token.
