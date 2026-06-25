---
"@thinkyou0714/fugu": patch
---

Internal dedup + hardening (no public API changes):

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
