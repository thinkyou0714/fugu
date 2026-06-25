---
"@thinkyou0714/fugu": minor
---

Harden + publish-prep.

- **Security:** fix a secret-leak in `redactString` — a quoted multi-word secret
  (`api_key="a b c"`) was only partially redacted because the value matcher stopped at the
  first space. It is now quote-aware (double/single-quoted values redacted in full). Adds the
  previously-missing `redact` regression suite.
- **DX:** error type-guards (`isFuguError`, `isRetryable`, `isAuthError`, `isPermissionError`,
  `isRateLimitError`, `isTimeoutError`), a README "Troubleshooting" table, and GitHub issue templates.
- **Publish:** the package is published as the scoped name `@thinkyou0714/fugu`.
