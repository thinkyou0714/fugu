# Setup — use Fugu across your stack

Three ways to reach Fugu, cheapest-first. All read `SAKANA_API_KEY` from the environment
(or a local `.env` — never commit it).

```bash
cp .env.example .env   # then fill in SAKANA_API_KEY from https://console.sakana.ai/get-started
npm run smoke          # confirm a real round-trip works (PASS / FAIL + fix hints)
```

## Cost first (read this)

Fugu bills **hidden orchestration tokens** — a single `fugu-ultra` call can cost ~10× its
visible tokens (measured: a one-sentence answer ≈ $0.13). So:

- **Default to `fugu`** (fast, ~1/3–1/6 the price). Reach for `fugu-ultra` + `--effort high`
  only on genuinely hard / high-stakes work.
- Keep prompts tight — send only the relevant context, not whole files.
- Watch spend with `--usage`; wire `BudgetGuard` for a hard cap in code.

## 1. CLI (ad-hoc)

```bash
npm start -- "Explain Sakana Fugu in one sentence." --usage
npm start -- --model fugu-ultra --effort high < prompt.txt   # pipe a file/prompt via stdin
```

## 2. Claude Code — second opinion via MCP

Expose Fugu as MCP tools (`fugu_respond`, `fugu_chat`, `fugu_list_models`) plus the `/fugu`
skill + `fugu` subagent for adversarial review / hard-reasoning escalation.

```bash
cd integrations/mcp && npm install && cd ../..
# Register globally; the key is loaded from .env at launch — not stored in any config file:
claude mcp add fugu --scope user -- \
  node --env-file-if-exists=/ABS/PATH/fugu/.env /ABS/PATH/fugu/integrations/mcp/src/bin.ts
claude mcp list            # expect: fugu - ✔ Connected
```

Then (after a Claude Code restart) the `mcp__fugu__*` tools are callable, and `/fugu`
delegates a second opinion. To remove: `claude mcp remove fugu -s user`.

> The `/fugu` skill (`.claude/skills/fugu/`) and `fugu` subagent (`.claude/agents/fugu.md`)
> can be copied to `~/.claude/` to use them in every project.

## 3. OpenAI-compatible proxy — Cursor / n8n / any OpenAI SDK

```bash
npm run proxy                                   # http://localhost:4141/v1
FUGU_PROXY_PORT=8080 FUGU_PROXY_TOKEN=secret npm run proxy
```

Point any OpenAI-SDK tool at `http://localhost:4141/v1` and use model `fugu` / `fugu-ultra`.
Exposes `/v1/models`, `/v1/chat/completions`, `/v1/responses` (with SSE streaming).
Set `FUGU_PROXY_TOKEN` to require an `Authorization: Bearer` header.
