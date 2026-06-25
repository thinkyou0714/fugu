/**
 * Thin OpenAI-compatible HTTP proxy: expose one local endpoint that any
 * OpenAI-SDK tool (Cursor, n8n, scripts) can target, forwarding to a FuguClient or
 * FuguRouter. Injects the upstream key server-side so clients hold only a local token.
 * Zero dependencies (built-in node:http).
 *
 * Routes (with or without a `/v1` prefix):
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream:true -> SSE chunks + [DONE])
 *   POST /v1/responses          (stream:true -> response.* SSE + [DONE])
 */

import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { errorMessage, toError } from "./internal.ts";
import type { ReasoningEffort } from "./config.ts";
import type { GenerateOptions, ChatMessage, FuguStreamEvent } from "./fugu-client.ts";
import type { FuguResult, FuguUsage } from "./types.ts";

export interface ProxyBackend {
  respond(input: string, opts?: GenerateOptions): Promise<FuguResult>;
  chat(messages: ChatMessage[], opts?: GenerateOptions): Promise<FuguResult>;
  respondStream(input: string, opts?: GenerateOptions): AsyncGenerator<FuguStreamEvent>;
  chatStream(messages: ChatMessage[], opts?: GenerateOptions): AsyncGenerator<FuguStreamEvent>;
}

export interface ProxyOptions {
  backend: ProxyBackend;
  /** Require this bearer token from clients (optional; if unset, no auth is enforced). */
  token?: string;
  /** Model ids advertised on GET /models. */
  models?: string[];
}

export function createProxyServer(options: ProxyOptions): http.Server {
  const models = options.models ?? ["fugu", "fugu-ultra"];
  const server = http.createServer((req, res) => {
    handle(req, res, options, models).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: errorMessage(err), type: "proxy_error" } });
      } else {
        res.end();
      }
    });
  });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return server;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ProxyOptions,
  models: string[],
): Promise<void> {
  const rawPath = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");
  // Exact routes (with or without a /v1 prefix) — NOT endsWith, so /foo/chat/completions 404s.
  const route = rawPath.replace(/^\/v1(?=\/|$)/, "") || "/";

  if (options.token && !tokenMatches(req.headers.authorization, `Bearer ${options.token}`)) {
    return sendJson(res, 401, { error: { message: "Unauthorized", type: "auth" } });
  }

  if (req.method === "GET" && route === "/models") {
    return sendJson(res, 200, {
      object: "list",
      data: models.map((id) => ({ id, object: "model", owned_by: "sakana" })),
    });
  }
  if (req.method === "POST" && route === "/chat/completions") {
    return handleChat(res, options.backend, await readJson(req));
  }
  if (req.method === "POST" && route === "/responses") {
    return handleResponses(res, options.backend, await readJson(req));
  }
  return sendJson(res, 404, { error: { message: `Not found: ${req.method} ${rawPath}`, type: "not_found" } });
}

async function handleChat(
  res: http.ServerResponse,
  backend: ProxyBackend,
  body: Record<string, unknown>,
): Promise<void> {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
  const opts = optsFromBody(body);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    startSSE(res);
    try {
      for await (const ev of backend.chatStream(messages, opts)) {
        if (ev.type === "delta") {
          writeSSE(res, chunk(id, created, ev.result?.model ?? opts.model, { content: ev.textDelta }, null));
        } else {
          writeSSE(
            res,
            chunk(id, created, ev.result?.model ?? opts.model, {}, ev.result?.finishReason ?? "stop"),
          );
        }
      }
      res.write("data: [DONE]\n\n"); // success terminator only
    } catch (err) {
      // Surface a real error frame and do NOT send [DONE] (which would look like a clean end).
      writeSSE(res, { error: { message: errorMessage(err), type: "proxy_error" } });
    } finally {
      res.end();
    }
    return;
  }

  const result = await backend.chat(messages, opts);
  sendJson(res, 200, {
    id: result.requestId ?? id,
    object: "chat.completion",
    created,
    model: result.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: result.finishReason ?? "stop",
      },
    ],
    usage: toOpenAIUsage(result.usage),
  });
}

async function handleResponses(
  res: http.ServerResponse,
  backend: ProxyBackend,
  body: Record<string, unknown>,
): Promise<void> {
  const input = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "");
  const opts = optsFromBody(body);

  if (body.stream) {
    startSSE(res);
    try {
      for await (const ev of backend.respondStream(input, opts)) {
        if (ev.type === "delta") writeSSE(res, { type: "response.output_text.delta", delta: ev.textDelta });
        else
          writeSSE(res, {
            type: "response.completed",
            response: ev.result?.raw ?? { output_text: ev.result?.text },
          });
      }
      res.write("data: [DONE]\n\n");
    } catch (err) {
      writeSSE(res, { error: { message: errorMessage(err), type: "proxy_error" } });
    } finally {
      res.end();
    }
    return;
  }

  const result = await backend.respond(input, opts);
  sendJson(res, 200, result.raw ?? { output_text: result.text });
}

/** Constant-time bearer-token comparison (avoids leaking the token via compare timing). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  const a = Buffer.from(provided ?? "");
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; a length mismatch is already a non-match.
  return a.length === b.length && timingSafeEqual(a, b);
}

const EFFORTS = new Set<ReasoningEffort>(["high", "xhigh", "max"]);
const SAMPLING_KEYS = ["temperature", "top_p", "seed", "frequency_penalty", "presence_penalty", "stop"];

/**
 * Map an OpenAI-style request body to GenerateOptions. Beyond `model`, this forwards
 * `reasoning.effort`, the output-token cap (either field name), `instructions`, and the
 * common sampling params — otherwise a proxy client could not control effort or sampling.
 */
function optsFromBody(body: Record<string, unknown>): GenerateOptions {
  const opts: GenerateOptions = {};
  if (typeof body.model === "string") opts.model = body.model;

  const reasoning = body.reasoning;
  const effort =
    reasoning && typeof reasoning === "object" ? (reasoning as Record<string, unknown>).effort : body.effort;
  if (typeof effort === "string" && EFFORTS.has(effort as ReasoningEffort)) {
    opts.reasoningEffort = effort as ReasoningEffort;
  }

  const maxOut = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxOut === "number") opts.maxOutputTokens = maxOut;

  if (typeof body.instructions === "string") opts.instructions = body.instructions;

  const params: Record<string, unknown> = {};
  for (const key of SAMPLING_KEYS) if (body[key] !== undefined) params[key] = body[key];
  if (Object.keys(params).length > 0) opts.params = params;

  return opts;
}

function chunk(
  id: string,
  created: number,
  model: string | undefined,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toOpenAIUsage(usage: FuguUsage): Record<string, unknown> {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
      req.destroy();
    };
    req.on("data", (piece) => {
      size += piece.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error("Request body too large."));
        return;
      }
      data += piece;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(toError(err));
      }
    });
    req.on("error", (err) => fail(toError(err)));
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function startSSE(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function writeSSE(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
