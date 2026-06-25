#!/usr/bin/env node
/**
 * Tiny CLI for the Fugu PoC.
 *
 *   npm start -- "your prompt" --model fugu-ultra --effort high --usage
 *   node --env-file-if-exists=.env --experimental-strip-types src/cli.ts "your prompt"
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import type { ReasoningEffort } from "./config.ts";
import { FuguClient, FuguError } from "./fugu-client.ts";
import type { ChatMessage, FuguResult } from "./fugu-client.ts";
import { redact, redactString } from "./redact.ts";

const EFFORTS = new Set<ReasoningEffort>(["high", "xhigh", "max"]);

export interface CliArgs {
  prompt: string;
  model?: string;
  baseUrl?: string;
  effort?: ReasoningEffort;
  instructions?: string;
  chat: boolean;
  json: boolean;
  usage: boolean;
  stream: boolean;
  version: boolean;
  help: boolean;
  /** Set when an option value was invalid. */
  error?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: "",
    chat: false,
    json: false,
    usage: false,
    stream: false,
    version: false,
    help: false,
  };
  const positionals: string[] = [];
  const setEffort = (value: string | undefined) => {
    if (value && EFFORTS.has(value as ReasoningEffort)) args.effort = value as ReasoningEffort;
    else args.error = `--effort must be one of: high, xhigh, max (got ${JSON.stringify(value)})`;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--version" || a === "-V") args.version = true;
    else if (a === "--chat") args.chat = true;
    else if (a === "--json") args.json = true;
    else if (a === "--usage") args.usage = true;
    else if (a === "--stream") args.stream = true;
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--effort") setEffort(argv[++i]);
    else if (a === "--instructions") args.instructions = argv[++i];
    else if (a.startsWith("--model=")) args.model = a.slice("--model=".length);
    else if (a.startsWith("--base-url=")) args.baseUrl = a.slice("--base-url=".length);
    else if (a.startsWith("--effort=")) setEffort(a.slice("--effort=".length));
    else if (a.startsWith("--instructions=")) args.instructions = a.slice("--instructions=".length);
    else positionals.push(a);
  }
  args.prompt = positionals.join(" ").trim();
  // Streaming emits incremental text; a single redacted JSON blob is a buffered-only view.
  if (args.stream && args.json)
    args.error = "--stream cannot be combined with --json (streaming is text-only).";
  return args;
}

const HELP = `fugu-poc — minimal Sakana Fugu client

Usage:
  npm start -- "<prompt>" [--model fugu|fugu-ultra] [--effort high|xhigh|max] [--chat] [--json] [--usage]
  node --env-file-if-exists=.env --experimental-strip-types src/cli.ts "<prompt>"

Options:
  --model <id>      fugu (fast) or fugu-ultra (max quality). Default: fugu-ultra
  --effort <level>  reasoning effort: high | xhigh | max (also scales the timeout)
  --instructions <s>  System/developer guidance (Responses API; ignored with --chat)
  --chat            Use the Chat Completions API instead of the Responses API
  --stream          Stream the answer incrementally (text only; not with --json)
  --base-url <url>  Override the API base URL (default https://api.sakana.ai/v1)
  --json            Print the raw JSON response
  --usage           Print token usage + estimated cost to stderr
  -V, --version     Print the CLI version
  -h, --help        Show this help

Environment (see .env.example):
  SAKANA_API_KEY    required — get one at https://console.sakana.ai/get-started
  SAKANA_BASE_URL   optional — defaults to https://api.sakana.ai/v1
  FUGU_MODEL        optional — defaults to fugu-ultra
`;

/** Render the output to print. Raw JSON is deep-redacted so an echoed secret never leaks. */
export function renderResult(result: FuguResult, json: boolean): string {
  return json ? JSON.stringify(redact(result.raw), null, 2) : result.text;
}

/** Emit the incomplete warning + (optional) usage/cost line to stderr — shared by all paths. */
function emitMeta(result: FuguResult, usage: boolean): void {
  if (result.status === "incomplete") {
    process.stderr.write(`warning: response incomplete (${result.incompleteReason ?? "unknown"})\n`);
  }
  if (usage) {
    const u = result.usage;
    const cost = result.costUsd !== undefined ? `$${result.costUsd.toFixed(6)}` : "n/a";
    process.stderr.write(
      `usage: in=${u.inputTokens ?? "?"} out=${u.outputTokens ?? "?"} ` +
        `orch_in=${u.orchestrationInputTokens ?? 0} orch_out=${u.orchestrationOutputTokens ?? 0} ` +
        `cost≈${cost} (model=${result.model})\n`,
    );
  }
}

/** Read the package version from package.json (works from both src/ and dist/). */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`Error: ${args.error}\n`);
    return 1;
  }

  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY) {
    prompt = (await readStdin()).trim();
  }
  if (!prompt) {
    process.stderr.write(`Error: no prompt provided.\n\n${HELP}`);
    return 1;
  }

  const config = loadConfig();
  if (args.baseUrl) config.baseUrl = args.baseUrl;
  if (args.model) config.model = args.model;
  if (!config.apiKey) {
    process.stderr.write(
      "Error: SAKANA_API_KEY is not set.\n" +
        "Get a key at https://console.sakana.ai/get-started, then:\n" +
        "  export SAKANA_API_KEY=sk-...   (or copy .env.example to .env)\n",
    );
    return 1;
  }

  const client = new FuguClient(config);
  try {
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];

    if (args.stream) {
      const events = args.chat
        ? client.chatStream(messages, { reasoningEffort: args.effort })
        : client.respondStream(prompt, { reasoningEffort: args.effort, instructions: args.instructions });
      let streamed: FuguResult | undefined;
      for await (const ev of events) {
        if (ev.type === "delta") process.stdout.write(ev.textDelta ?? "");
        else streamed = ev.result;
      }
      process.stdout.write("\n");
      if (streamed) emitMeta(streamed, args.usage);
      return 0;
    }

    const result = args.chat
      ? await client.chat(messages, { reasoningEffort: args.effort })
      : await client.respond(prompt, { reasoningEffort: args.effort, instructions: args.instructions });

    process.stdout.write(`${renderResult(result, args.json)}\n`);
    emitMeta(result, args.usage);
    return 0;
  } catch (err) {
    if (err instanceof FuguError) {
      process.stderr.write(
        `Fugu request failed [${err.code}${err.status ? ` ${err.status}` : ""}]: ${err.message}\n`,
      );
      if (err.requestId) process.stderr.write(`request-id: ${err.requestId}\n`);
      if (err.apiError?.code && err.apiError.code !== err.code) {
        process.stderr.write(`api code: ${err.apiError.code}\n`);
      }
    } else {
      process.stderr.write(`${redactString(String(err))}\n`);
    }
    return 1;
  }
}

// Run only when executed directly (not when imported by the tests).
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  // Set exitCode and let the event loop drain so buffered stdout (e.g. large
  // --json output to a pipe) is never truncated by an eager process.exit().
  main().then((code) => {
    process.exitCode = code;
  });
}
