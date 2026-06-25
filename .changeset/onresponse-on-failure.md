---
"@thinkyou0714/fugu": minor
---

`onResponse` now also fires on failure for the buffered request paths (`respond`,
`chat`, `runTools`). The failure event carries `error` (the thrown `FuguError`) and
sets `status` to the error code, with `usage`/`costUsd` omitted. Success behavior is
unchanged — one event per logical call (retries do not emit extra events). Streaming
methods (`respondStream`/`chatStream`) still surface their result via the yielded
`done` event and do not emit `onResponse`.
