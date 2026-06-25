---
"fugu-poc": patch
---

`redact()` now also censors `obsidian_api_key` / `obsidian-api-key` keys in deep-object
redaction, matching the existing `sakana_api_key` entry (defense-in-depth parity for the
Obsidian integration).
