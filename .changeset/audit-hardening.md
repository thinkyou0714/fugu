---
"@thinkyou0714/fugu": minor
---

Audit-driven hardening, correctness, and parity:

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
