# Roadmap

Scored backlog for `@thinkyou0714/fugu`. Tags: **Impact** (High/Med/Low) × **Effort** (S/M/L).
Source: a deep-dive gap analysis (≈75 ideas) + an adversarial review. Pick from the top of
"Next up" first; everything below is intentionally deferred, not forgotten.

## Shipped (hardening pass, v0.2.0)

- Fixed a secret-leak bug in `redact.ts` (quoted multi-word values) + added the missing
  `test/redact.test.ts` regression suite.
- Error type-guards (`isFuguError`, `isRetryable`, `isAuthError`, `isPermissionError`,
  `isRateLimitError`, `isTimeoutError`) + tests.
- README "Troubleshooting" table; GitHub PR + issue templates.
- Scoped package name `@thinkyou0714/fugu`; generated `CHANGELOG.md`.
- GitHub Actions SHA-pinning + dependency updates via Renovate (PRs open); Dependabot alerts on.

## Next up (High impact / Small–Medium effort)

| Idea | I×E | Notes |
|---|---|---|
| TypeDoc API reference site (publish to Pages) | High×M | heavy JSDoc already exists; just generate + publish |
| "Getting started" tutorial (CLI → code → MCP) | High×S | reduce first-run friction |
| Gated live E2E integration test (CI, skipped without key) | High×M | distinct from the manual smoke; never logs the key |
| Vercel AI SDK adapter (`./ai`, mirror `openai.ts`) | High×M | growing ecosystem; the user is on Vercel |
| Architecture diagram (client → router → proxy / MCP / integrations) | Med×M | text-heavy README needs a visual |
| Node version matrix incl. 24/25 + Windows runner in CI | High×S | currently ubuntu-only |

## Resilience & cost (Med)

- Circuit-breaker across requests (N consecutive timeouts → fail fast). Med×M
- Graceful budget degrade (cascade down a tier instead of throwing). Med×M
- Streaming cost tracking (emit running estimate during long streams). Low×M
- Document estimated-vs-billed cost accuracy. Med×S

## Type-safety & DX (Med/Low)

- `as const` tool definitions for better narrowing. Med×S
- Conditional types (e.g. `fugu-ultra` ⇒ effort required). Low×M
- Zod-validated `loadConfig` (schema-checked env). Med×M
- devcontainer.json; husky + lint-staged pre-commit. Med×S

## Observability (Med/Low)

- OpenTelemetry context propagation guide + helper. High×M
- pino wiring example for the `logger` hook. Med×S
- Cache hit/miss + rate-limit bucket metrics surfaced to OTel. Low×S

## Security & supply-chain (defense-in-depth)

- **SSRF hardening**: default-deny private/link-local base URLs with an explicit opt-in,
  validated **after** DNS resolution (anti-rebinding). Med×M — *low real risk today (fixed
  upstream), so deferred; adopt the `codex_egress_check` DNS-pinning pattern when added.*
- `npm audit` / Snyk gate in CI. Med×S
- Richer SECURITY.md (PGP, disclosure timeline). Med×S
- Audit that no log path bypasses `redact()`. Med×S

## Ecosystem (High/Med)

- Publish the n8n community node (`n8n-nodes-fugu`). High×M
- LangChain integration. Med×M
- Ship the Obsidian integration as a real community plugin (GUI). Med×M
- Deno / Bun support + CI. Low×S–L

## Testing (Med/Low)

- Raise coverage thresholds toward 90%. Med×M
- Property/fuzz tests (fast-check) for cost calc, cache keys, error parsing. Med×M
- Add the untested-but-bug-prone paths flagged in review: proxy body-size limit,
  `compareSystems` partial-failure, mid-stream error synthesis. Med×M

## Deliberately not doing (unless new info)

- Pull a fuller second LLM into the core (keeps zero-dep + small surface).
- Heavyweight plugin/transport abstractions before there's a real second consumer.
- Bare npm name `fugu` (collision risk with a possible official Sakana package).
