# @thinkyou0714/fugu

## 0.2.1

### Patch Changes

- 4d0eb88: docs: add npm version / CI / license badges to the README.

## 0.2.0

### Minor Changes

- 3040214: Audit-driven hardening, correctness, and parity:

  - **Security:** `redactString` now scrubs JSON-shaped labelled secrets (`"api_key": "…"`),
    which the previous `[=:]`-only rule missed; the object deny-list gained common credential
    aliases (`password`, `access_token`, `refresh_token`, `client_secret`,
    `proxy-authorization`, …) while still leaving benign look-alikes like `total_tokens`
    untouched; and `parseApiError` redacts the error `type`/`code` slugs, not just `message`.
  - **Proxy:** the bearer-token check is now constant-time (`timingSafeEqual`), and request
    bodies forward `reasoning.effort`, the output-token cap, `instructions`, and sampling
    params (`temperature`/`top_p`/`seed`/…) instead of dropping everything but `model`.
  - **Strategy:** `runEval` bypasses the client response cache by default (a cache hit would
    report ~0 ms / $0 and mask model changes; override with `generate.cache = true`), and
    `Cascade` now reports `totalCostUsd` across every stage that ran, not just the final one.
  - **CLI:** new `--stream`, `--version`, and `--instructions` flags (feature parity with the client).
  - **MCP:** `fugu_chat` accepts `effort`, matching `fugu_respond`.
  - **Tests:** added `FuguRouter` failover coverage (previously untested), proxy server
    coverage (routes / auth / passthrough), and the audit-fix cases.

- da236a1: Harden + publish-prep.

  - **Security:** fix a secret-leak in `redactString` — a quoted multi-word secret
    (`api_key="a b c"`) was only partially redacted because the value matcher stopped at the
    first space. It is now quote-aware (double/single-quoted values redacted in full). Adds the
    previously-missing `redact` regression suite.
  - **DX:** error type-guards (`isFuguError`, `isRetryable`, `isAuthError`, `isPermissionError`,
    `isRateLimitError`, `isTimeoutError`), a README "Troubleshooting" table, and GitHub issue templates.
  - **Publish:** the package is published as the scoped name `@thinkyou0714/fugu`.

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
- dfcad3b: `onResponse` now also fires on failure for the buffered request paths (`respond`,
  `chat`, `runTools`). The failure event carries `error` (the thrown `FuguError`) and
  sets `status` to the error code, with `usage`/`costUsd` omitted. Success behavior is
  unchanged — one event per logical call (retries do not emit extra events). Streaming
  methods (`respondStream`/`chatStream`) still surface their result via the yielded
  `done` event and do not emit `onResponse`.
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

### Patch Changes

- dfcad3b: Internal dedup + hardening (no public API changes):

  - Collapse duplicated request logic in `FuguClient` (`buildBody` / `send` /
    `openRequest`) and extract shared internal helpers (`getProp`, `errorMessage`,
    `toError`, `requestIdFrom`, `scoreAnswer`).
  - Harden `getProp` against prototype-chain keys (`__proto__`/`constructor`/`prototype`).
  - Make `createFuguOpenAI<T = unknown>()` generic so callers can recover typing
    without the core depending on `openai`.
  - Mark truncated API error messages with an ellipsis; correct the "no fetch"
    message to require Node >= 22.9; add `@param/@returns/@throws` JSDoc to the
    public `FuguClient` methods.
  - Add tests for the internals, the runTools iteration cap, streaming usage,
    output-token clamping, the input-size boundary, MemoryCache TTL/LRU, the
    Retry-After cap, and the `openai` adapter.

- dfcad3b: `redact()` now also censors `obsidian_api_key` / `obsidian-api-key` keys in deep-object
  redaction, matching the existing `sakana_api_key` entry (defense-in-depth parity for the
  Obsidian integration).
