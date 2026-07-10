# fugu — Improvement Backlog

Scored best-practice backlog from a read-only deep-research sweep (value × effort × risk).
Tiers: **T1** = high-value / low-risk / behavior-preserving · **T2** = behavior-preserving code-quality
· **T3** = higher-leverage or behavior-changing (needs design). Status reflects `main` at time of writing.

## Done / not needed (verified against the codebase)
- **"CRLF breaks CI"** — **not a bug**: committed blobs are LF and CI is green; the local CRLF is a Windows `core.autocrlf=true` checkout artifact. The genuine gap was a missing `.gitattributes` (added in this PR). Do **not** mass-renormalize files.
- **SHA-pinned Actions** — workflows already pin to full SHAs (`actions/checkout@…# v4`); Renovate (`helpers:pinGitHubActionDigests`) maintains them. **No Dependabot** (Renovate present).
- **Already present**: `.editorconfig`, `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`, issue/PR templates, CodeQL workflow, npm provenance (`provenance: true` + OIDC trusted publishing).

## T1 — hardening (this PR)
- **`.gitattributes`** (`* text=auto eol=lf` + binary/linguist markers) — explicit LF normalization.
- **`.claude/settings.json`** — read-only permission allowlist + destructive-command deny (complements the existing `.claude/agents` + `.claude/skills`).
- **`secret-scan.yml`** — gitleaks secret scanning on push/PR (SHA-pinned).
- **`dependency-review.yml`** — license/vuln review on PRs (SHA-pinned).

## T2 — behavior-preserving code-quality / tests
- **Unify text extractors** — `extractResponsesText` + `extractChatText` (`src/types.ts`) share tolerant-shape logic; extract a single `extractNestedText(root, apiKind)` and keep the two public functions as thin wrappers. (M/S/low)
- **CLI coverage** — add tests for `--stream` and `--instructions` paths (`src/cli.ts` ~51%); reuse the existing `mockFetch` pattern. (M/S/low)
- **Observability hook tests** — `onRequest`/`onResponse` fire counts across retries, errors, and cache hits. (M/S/low)
- **Integration-package CI** — run `mcp/`, `obsidian/`, `n8n/` package tests in the CI matrix so a core change can't silently break an adapter. (M/M/low)
- **Defensive `AbortSignal.any` guard** — assert availability in the constructor (future-proofs an accidental Node floor bump). (low/S/low)
- **Document streaming-incomplete contract** — truncated streams return `status:"incomplete"` with usable text; add a comment + test + README note. (low/S/low)

## T3 — higher-leverage / behavior-changing (separate PRs, design first)
- **`StreamAggregator` extraction** — pull SSE→delta/usage/finish-reason aggregation + final-result synthesis out of the 726-line `fugu-client.ts` `stream()` into a private, unit-testable class/functions. Transport stays thin. Behavior-preserving but structural. (M/M/low)
- **Streaming redaction option** — `redactStream?: boolean` (default true for CLI) to sanitize secrets echoed in stream deltas. **Behavior-changing** for the CLI surface. (M/M/medium)
- **Custom judge factory** — `customJudge(scoreFn)` in `cascade.ts` so users inject domain-specific scoring without forking. (low/M/low)
- **TypeDoc API site** — generate + publish API reference (`docs:generate` + Pages). (M/M/low)
- **Gated live E2E** — `e2e.yml` on PR, `if: secrets.SAKANA_API_KEY != ''`, wrapping `npm run smoke` (safe in forks). (high/M/low)

> Part of an ecosystem-wide best-practice sweep; companion backlogs live in the sibling repos
> (ccmux, engineer-tenshoku-navi, denken-os). Cross-cutting standardization is tracked for the org
> `.github` repo.
