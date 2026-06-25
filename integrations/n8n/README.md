# n8n-nodes-fugu

An [n8n](https://n8n.io) **community node** for **Sakana Fugu** — call Fugu's
frontier-model pool from any workflow. A custom `execute()` shapes the output for downstream
nodes (a clean `text` field, not raw API JSON), with a `Fugu API` credential that injects your
key as a Bearer token. The node is also `usableAsTool`, so an n8n **AI Agent** can call Fugu
as a "second opinion" tool.

## Node

**Fugu** (group: *transform*) — two operations:

| Operation | Request                       | Key fields                          |
|-----------|-------------------------------|-------------------------------------|
| Respond   | `POST /responses`             | Input, Model, Reasoning Effort      |
| Chat      | `POST /chat/completions`      | Messages (JSON array), Model        |

Each input item is processed independently. The node returns one row per item:

| Field    | Meaning                                                              |
|----------|---------------------------------------------------------------------|
| `text`   | The assistant's answer (`output_text`, or `choices[0].message.content`). |
| `model`  | The model id the API reports (falls back to the requested one).      |
| `status` | Response status when present (e.g. `completed` / `incomplete`).      |
| `usage`  | Token usage, including Fugu's hidden orchestration tokens.           |
| `raw`    | The untouched API payload (nothing is lost — pluck anything else here). |

Enable **Continue On Fail** to get a per-item `{ error }` row instead of aborting the run.

## Credential — Fugu API

- **API Key** (stored encrypted) → sent as `Authorization: Bearer <key>`.
- **Base URL** — default `https://api.sakana.ai/v1` (copy the exact value from your console).
- **Test** hits `GET /models`, so the credential's *Test* button validates the key.

## Install (local dev)

n8n loads **compiled** nodes, so unlike the rest of this repo (which runs `.ts` directly)
this package is built with `tsc` to `dist/`.

```bash
cd integrations/n8n
npm install          # pulls n8n-workflow (peer) for types
npm run build        # tsc -> dist/ (+ copies the icon)

# load it into a local n8n via the custom-extensions dir:
mkdir -p ~/.n8n/custom && ln -s "$PWD" ~/.n8n/custom/n8n-nodes-fugu
n8n start            # the "Fugu" node + "Fugu API" credential now appear
```

> On Windows, replace `ln -s` with
> `mklink /D %USERPROFILE%\.n8n\custom\n8n-nodes-fugu "%CD%"` (Developer Mode or an
> elevated shell), or just copy the folder into `~/.n8n/custom/`.

To publish to the community registry, drop `"private": true`, fill in `author`/`repository`,
run `npm run build`, and `npm publish` (the `n8n` field in `package.json` registers the node
and credential).

## Layout

```
integrations/n8n/
├── credentials/FuguApi.credentials.ts   # ICredentialType: Bearer auth + /models test
├── nodes/Fugu/Fugu.node.ts              # INodeType with execute() (one HTTP call per item)
├── nodes/Fugu/fugu.svg                  # node icon
├── package.json                         # n8n: { credentials, nodes }
└── tsconfig.json                        # CJS build -> dist/
```

> Template status: structured to the n8n community-node spec and typechecked against
> `n8n-workflow`. Run `npm run build` then load it into a local n8n to exercise it live.
