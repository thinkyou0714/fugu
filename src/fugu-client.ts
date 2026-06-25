/**
 * Fugu API client (OpenAI-compatible). Built-in global `fetch` — no runtime deps.
 *
 *   - POST /responses          (Responses API — recommended for generation)
 *   - POST /chat/completions   (Chat Completions API)
 *
 * P0: typed error hierarchy, secret redaction, timeout/abort/network classification,
 *     effort-scaled timeouts, typed usage + cost (incl. Fugu orchestration tokens).
 * P2: retries (backoff + jitter, honoring Retry-After) with an idempotency key,
 *     streaming (SSE), a spend BudgetGuard, and output-token / input-size caps.
 */

import { randomUUID } from "node:crypto";
import { normalizeBaseUrl, defaultTimeoutMs } from "./config.ts";
import type { FuguConfig, ReasoningEffort } from "./config.ts";
import {
  FuguError,
  FuguConfigError,
  FuguConnectionError,
  FuguTimeoutError,
  FuguAbortError,
  FuguParseError,
  FuguIncompleteError,
  FuguBadRequestError,
  FuguValidationError,
  errorFromResponse,
} from "./errors.ts";
import { computeCost, DEFAULT_PRICES } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import { parseUsage, parseResponseMeta, extractResponsesText, extractChatText } from "./types.ts";
import type { FuguResult } from "./types.ts";
import { DEFAULT_RETRY, retryDelayMs, sleep } from "./retry.ts";
import type { RetryConfig } from "./retry.ts";
import {
  parseSSE,
  extractStreamDelta,
  extractStreamFinal,
  extractStreamUsage,
  extractStreamFinishReason,
} from "./stream.ts";
import type { BudgetGuard } from "./budget.ts";
import { cacheKeyFor } from "./cache.ts";
import type { RequestCache } from "./cache.ts";
import { mapToolsForResponses, mapToolsForChat, parseToolCalls } from "./tools.ts";
import type { FuguTool, ToolChoice } from "./tools.ts";
import { parseJsonLoose } from "./json.ts";
import { errorMessage, requestIdFrom } from "./internal.ts";
import { noopLogger } from "./observe.ts";
import type { Logger, RequestEvent, ResponseEvent } from "./observe.ts";

export type { FuguResult, FuguUsage, ResponseStatus } from "./types.ts";
export * from "./errors.ts";

export interface FuguClientOptions extends FuguConfig {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetch?: typeof fetch;
  /** Override the per-request timeout (ms). When unset, an effort/model-scaled default is used. */
  timeoutMs?: number;
  /** Price table for cost estimation (defaults to the built-in table). */
  priceTable?: PriceTable;
  /** Max retries after the first attempt for transient failures (default 2). */
  maxRetries?: number;
  /** Backoff base / cap (ms) — full-jitter exponential backoff (defaults 500 / 8000). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Hard cap applied to requested max output tokens. */
  maxOutputTokens?: number;
  /** Reject inputs longer than this many characters (default 4,000,000; 0 disables). */
  maxInputChars?: number;
  /** Optional spend guard; throws FuguBudgetError once the limit would be exceeded. */
  budget?: BudgetGuard;
  /** Optional response cache; identical requests are served without a network call. */
  cache?: RequestCache;
  /** Called before each network attempt (incl. retries) — metadata only, no content. */
  onRequest?: (event: RequestEvent) => void;
  /**
   * Called after each buffered request (`respond`/`chat`/`runTools`) settles — on success
   * with status/usage/cost, and on failure with `error` set and `status` = the error code.
   * Metadata only; streaming methods don't emit this.
   */
  onResponse?: (event: ResponseEvent) => void;
  /** Structured logger (defaults to a no-op). Wire pino/console/OpenTelemetry here. */
  logger?: Logger;
}

export interface GenerateOptions {
  /** Override the configured model for this call. */
  model?: string;
  /** Reasoning effort (high/xhigh/max) — also scales the default timeout. */
  reasoningEffort?: ReasoningEffort;
  /** Responses API `instructions` (system/developer guidance). */
  instructions?: string;
  /** Abort signal; combined with the internal timeout via AbortSignal.any. */
  signal?: AbortSignal;
  /** Override the timeout for this call (ms). */
  timeoutMs?: number;
  /** Override the retry count for this call. */
  maxRetries?: number;
  /** Per-call output-token cap (clamped to the client's maxOutputTokens). */
  maxOutputTokens?: number;
  /** Reuse a specific Idempotency-Key (defaults to a fresh UUID per logical request). */
  idempotencyKey?: string;
  /** Throw FuguIncompleteError when the response status is "incomplete". */
  throwOnIncomplete?: boolean;
  /** Tools the model may call (function tools + the built-in web_search). */
  tools?: FuguTool[];
  /** Tool-choice policy: "auto" | "none" | "required". */
  toolChoice?: ToolChoice;
  /** Responses API: chain from a prior response id (server-side state). */
  previousResponseId?: string;
  /** Responses API: persist this response server-side (enables chaining). */
  store?: boolean;
  /** Extra body params merged into the request (e.g. { temperature: 0.2 }). */
  params?: Record<string, unknown>;
  /** Set false to bypass the client's response cache for this call. */
  cache?: boolean;
}

export type ChatRole = "system" | "developer" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface FuguStreamEvent {
  type: "delta" | "done";
  /** Present on "delta" events: the incremental text. */
  textDelta?: string;
  /** Present on the terminal "done" event: the aggregated result. */
  result?: FuguResult;
}

interface RawResponse {
  json: unknown;
  requestId?: string;
}

export class FuguClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutOverrideMs?: number;
  private readonly priceTable: PriceTable;
  private readonly retry: RetryConfig;
  private readonly maxOutputTokens?: number;
  private readonly maxInputChars: number;
  private readonly budget?: BudgetGuard;
  private readonly cache?: RequestCache;
  private readonly onRequest?: (event: RequestEvent) => void;
  private readonly onResponse?: (event: ResponseEvent) => void;
  private readonly logger: Logger;

  constructor(options: FuguClientOptions) {
    this.apiKey = (options.apiKey ?? "").trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = options.model;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutOverrideMs = options.timeoutMs;
    this.priceTable = options.priceTable ?? DEFAULT_PRICES;
    this.retry = {
      maxRetries: options.maxRetries ?? DEFAULT_RETRY.maxRetries,
      baseMs: options.retryBaseMs ?? DEFAULT_RETRY.baseMs,
      maxMs: options.retryMaxMs ?? DEFAULT_RETRY.maxMs,
    };
    this.maxOutputTokens = options.maxOutputTokens;
    this.maxInputChars = options.maxInputChars ?? 4_000_000;
    this.budget = options.budget;
    this.cache = options.cache;
    this.onRequest = options.onRequest;
    this.onResponse = options.onResponse;
    this.logger = options.logger ?? noopLogger;
    if (typeof this.fetchImpl !== "function") {
      throw new FuguConfigError("No fetch implementation available. Use Node >= 22.9 or pass options.fetch.");
    }
  }

  /**
   * Generate via the Responses API (recommended for generation).
   *
   * @param input The user prompt.
   * @param opts Per-call options — model, reasoningEffort, tools, instructions, caching, etc.
   * @returns Typed result: text, usage, estimated cost, status, requestId, and any toolCalls.
   * @throws {FuguError} Subclasses for config/auth/rate-limit/timeout/connection/parse failures.
   */
  async respond(input: string, opts: GenerateOptions = {}): Promise<FuguResult> {
    this.guardInput(input.length);
    const model = opts.model ?? this.model;
    const body = this.buildBody({ model, input }, opts, "responses");
    return this.send("/responses", body, model, opts, extractResponsesText);
  }

  /**
   * Generate via the Chat Completions API.
   *
   * @param messages The chat transcript (system / developer / user / assistant turns).
   * @param opts Per-call options — model, reasoningEffort, tools, caching, etc.
   * @returns Typed result (see {@link respond}).
   * @throws {FuguError} Subclasses on request failure.
   */
  async chat(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<FuguResult> {
    this.guardInput(messages.reduce((n, m) => n + m.content.length, 0));
    const model = opts.model ?? this.model;
    const body = this.buildBody({ model, messages }, opts, "chat");
    return this.send("/chat/completions", body, model, opts, extractChatText);
  }

  /**
   * Build a non-streaming request body for the Responses ("responses") or Chat
   * Completions ("chat") endpoint from the shared GenerateOptions. Endpoint-specific
   * params (instructions / previous_response_id / store, tool mapping, output-token
   * field) are gated on `kind` so the two public methods stay one-liners.
   */
  private buildBody(
    payload: Record<string, unknown>,
    opts: GenerateOptions,
    kind: "responses" | "chat",
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { ...(opts.params ?? {}), ...payload };
    if (kind === "responses" && opts.instructions) body.instructions = opts.instructions;
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    if (opts.tools) {
      body.tools = kind === "responses" ? mapToolsForResponses(opts.tools) : mapToolsForChat(opts.tools);
    }
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    if (kind === "responses") {
      if (opts.previousResponseId) body.previous_response_id = opts.previousResponseId;
      if (opts.store !== undefined) body.store = opts.store;
    }
    this.applyOutputCap(body, kind === "responses" ? "max_output_tokens" : "max_completion_tokens", opts);
    return body;
  }

  /**
   * Shared non-streaming request flow: serve from cache when possible, otherwise send
   * the request, build the typed result, populate the cache, and emit the response event.
   * `extractText` pulls the assistant text out of the endpoint's raw JSON shape.
   */
  private async send(
    endpoint: string,
    body: Record<string, unknown>,
    model: string,
    opts: GenerateOptions,
    extractText: (json: unknown) => string,
  ): Promise<FuguResult> {
    const start = Date.now();
    const cacheKey = this.cacheKey(endpoint, body, opts);
    if (cacheKey) {
      const hit = await this.cache?.get(cacheKey);
      if (hit) {
        const cached = { ...hit, cached: true };
        this.emitResponse(endpoint, model, cached, Date.now() - start);
        return cached;
      }
    }
    let result: FuguResult;
    try {
      const { json, requestId } = await this.request(endpoint, body, model, opts);
      result = this.buildResult(json, model, extractText(json), requestId, opts);
    } catch (err) {
      if (err instanceof FuguError) this.emitError(endpoint, model, err, Date.now() - start);
      throw err;
    }
    if (cacheKey) await this.cache?.set(cacheKey, result);
    this.emitResponse(endpoint, model, result, Date.now() - start);
    return result;
  }

  /** A stable cache key for this request, or undefined when the call isn't cacheable. */
  private cacheKey(endpoint: string, body: Record<string, unknown>, opts: GenerateOptions): string | undefined {
    if (!this.cache || opts.cache === false) return undefined;
    // Never cache tool calls (side effects) or server-side stateful chaining.
    if (opts.tools || opts.previousResponseId || opts.store) return undefined;
    return cacheKeyFor(endpoint, body);
  }

  /**
   * Agentic tool loop on Chat Completions: calls the model, runs any requested tools
   * via `handlers`, feeds the results back, and repeats up to `maxIterations` (default 5).
   *
   * @param messages Initial transcript; assistant + tool turns are appended as the loop runs.
   * @param opts Generation options plus `handlers` (tool name → fn) and optional `maxIterations`.
   * @returns The final result; if the iteration cap is reached it may still carry `toolCalls`.
   * @throws {FuguError} Subclasses on request failure (handler errors are fed back to the model).
   */
  async runTools(
    messages: Array<ChatMessage | Record<string, unknown>>,
    opts: GenerateOptions & {
      handlers: Record<string, (args: unknown) => unknown | Promise<unknown>>;
      maxIterations?: number;
    },
  ): Promise<FuguResult> {
    const model = opts.model ?? this.model;
    const tools = opts.tools ? mapToolsForChat(opts.tools) : undefined;
    const maxIterations = Math.max(1, opts.maxIterations ?? 5);
    const conversation: unknown[] = [...messages];
    let result: FuguResult | undefined;

    for (let i = 0; i < maxIterations; i += 1) {
      const start = Date.now();
      const body: Record<string, unknown> = { ...(opts.params ?? {}), model, messages: conversation };
      if (tools) body.tools = tools;
      // Force the tool on the first turn only; relax "required" to "auto" afterwards so the
      // model can produce a final answer instead of being forced to call a tool every turn.
      if (opts.toolChoice) {
        const forcedFirstTurn = i === 0 || opts.toolChoice !== "required";
        body.tool_choice = forcedFirstTurn ? opts.toolChoice : "auto";
      }
      if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
      this.applyOutputCap(body, "max_completion_tokens", opts);
      let json: unknown;
      try {
        const res = await this.request("/chat/completions", body, model, opts);
        json = res.json;
        result = this.buildResult(json, model, extractChatText(json), res.requestId, opts);
      } catch (err) {
        if (err instanceof FuguError) this.emitError("/chat/completions", model, err, Date.now() - start);
        throw err;
      }
      this.emitResponse("/chat/completions", model, result, Date.now() - start);

      const calls = result.toolCalls ?? [];
      if (calls.length === 0) return result;

      conversation.push(rawAssistantMessage(json) ?? { role: "assistant", content: result.text });
      for (const call of calls) {
        const handler = opts.handlers[call.name];
        let output: unknown;
        if (!handler) {
          output = { error: `No handler registered for tool "${call.name}".` };
        } else {
          try {
            output = await handler(safeParse(call.arguments));
          } catch (err) {
            output = { error: errorMessage(err) };
          }
        }
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }
    }
    // Reached the iteration cap; return the last result (may still carry tool calls).
    return result as FuguResult;
  }

  /**
   * Structured output with a validate-and-repair loop. Requests a JSON schema (if given),
   * parses loosely, runs `validate`, and on failure feeds the error back up to
   * `repairAttempts` times (default 1) before throwing FuguValidationError.
   *
   * Without `validate`, the parsed value is returned as `T` WITHOUT a runtime check —
   * rely on the strict json_schema (when `schema` is set) or pass a `validate` guard.
   */
  async respondJson<T = unknown>(
    input: string,
    opts: GenerateOptions & {
      schema?: Record<string, unknown>;
      schemaName?: string;
      validate?: (value: unknown) => T;
      repairAttempts?: number;
    } = {},
  ): Promise<{ data: T; result: FuguResult }> {
    const repairAttempts = opts.repairAttempts ?? 1;
    const params: Record<string, unknown> = { ...(opts.params ?? {}) };
    if (opts.schema) {
      // Merge into any caller-provided `text` block (e.g. text.verbosity) rather than clobber it.
      const existingText =
        params.text && typeof params.text === "object" ? (params.text as Record<string, unknown>) : {};
      params.text = {
        ...existingText,
        format: { type: "json_schema", name: opts.schemaName ?? "output", strict: true, schema: opts.schema },
      };
    }
    let currentInput = input;
    let lastError = "unknown error";
    for (let attempt = 0; attempt <= repairAttempts; attempt += 1) {
      const result = await this.respond(currentInput, { ...opts, params });
      let parsed: unknown;
      try {
        parsed = parseJsonLoose(result.text);
      } catch (err) {
        lastError = `output was not valid JSON (${errorMessage(err)})`;
        currentInput = `${input}\n\nYour previous reply was invalid: ${lastError}. Return ONLY corrected JSON.`;
        continue;
      }
      try {
        const data = opts.validate ? opts.validate(parsed) : (parsed as T);
        return { data, result };
      } catch (err) {
        lastError = `validation failed (${errorMessage(err)})`;
        currentInput = `${input}\n\nYour previous reply failed validation: ${lastError}. Return ONLY corrected JSON.`;
      }
    }
    throw new FuguValidationError(
      `Structured output failed after ${repairAttempts + 1} attempt(s): ${lastError}`,
    );
  }

  /**
   * Stream via the Responses API: yields incremental `delta` events, then one terminal
   * `done` event carrying the aggregated {@link FuguResult}.
   *
   * @param input The user prompt.
   * @param opts Per-call options (model, reasoningEffort, …).
   * @throws {FuguError} Subclasses if the stream cannot be opened or fails mid-flight.
   */
  async *respondStream(input: string, opts: GenerateOptions = {}): AsyncGenerator<FuguStreamEvent> {
    this.guardInput(input.length);
    const model = opts.model ?? this.model;
    const body: Record<string, unknown> = { ...(opts.params ?? {}), model, input, stream: true };
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    this.applyOutputCap(body, "max_output_tokens", opts);
    yield* this.stream("/responses", body, model, "responses", opts);
  }

  /**
   * Stream via the Chat Completions API: yields `delta` events then a terminal `done` event.
   *
   * @param messages The chat transcript.
   * @param opts Per-call options (model, reasoningEffort, …).
   * @throws {FuguError} Subclasses if the stream cannot be opened or fails mid-flight.
   */
  async *chatStream(messages: ChatMessage[], opts: GenerateOptions = {}): AsyncGenerator<FuguStreamEvent> {
    this.guardInput(messages.reduce((n, m) => n + m.content.length, 0));
    const model = opts.model ?? this.model;
    const body: Record<string, unknown> = { ...(opts.params ?? {}), model, messages, stream: true };
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    // Ask the API to emit a final usage chunk so cost / BudgetGuard work for chat streams.
    body.stream_options ??= { include_usage: true };
    this.applyOutputCap(body, "max_completion_tokens", opts);
    yield* this.stream("/chat/completions", body, model, "chat", opts);
  }

  private requireApiKey(): void {
    if (!this.apiKey) {
      throw new FuguConfigError(
        "Missing SAKANA_API_KEY. Get a key from https://console.sakana.ai/get-started and set it in your environment.",
      );
    }
  }

  private guardInput(chars: number): void {
    if (this.maxInputChars > 0 && chars > this.maxInputChars) {
      throw new FuguBadRequestError(`Input too large: ${chars} chars > maxInputChars ${this.maxInputChars}.`);
    }
  }

  private applyOutputCap(body: Record<string, unknown>, field: string, opts: GenerateOptions): void {
    const current = typeof body[field] === "number" ? (body[field] as number) : undefined;
    const requested = opts.maxOutputTokens ?? current;
    const cap = this.maxOutputTokens;
    if (requested !== undefined) body[field] = cap !== undefined ? Math.min(requested, cap) : requested;
    else if (cap !== undefined) body[field] = cap;
  }

  private buildResult(
    raw: unknown,
    model: string,
    text: string,
    requestId: string | undefined,
    opts: GenerateOptions,
  ): FuguResult {
    const meta = parseResponseMeta(raw);
    const usage = parseUsage(raw);
    const result: FuguResult = {
      text,
      raw,
      model,
      id: meta.id,
      status: meta.status,
      incompleteReason: meta.incompleteReason,
      finishReason: meta.finishReason,
      usage,
      costUsd: computeCost(model, usage, this.priceTable),
      requestId,
      toolCalls: parseToolCalls(raw),
    };
    this.budget?.record(result.costUsd);
    if (opts.throwOnIncomplete && meta.status === "incomplete") {
      throw new FuguIncompleteError(
        `Fugu response incomplete${meta.incompleteReason ? `: ${meta.incompleteReason}` : ""}`,
        { requestId },
      );
    }
    return result;
  }

  private emitResponse(path: string, model: string, result: FuguResult, durationMs: number): void {
    if (!this.onResponse) return;
    this.onResponse({
      path,
      model,
      status: result.status,
      durationMs,
      usage: result.usage,
      costUsd: result.costUsd,
      requestId: result.requestId,
    });
  }

  /** Emit the response hook for a FAILED buffered request — `error` set, `status` = its code. */
  private emitError(path: string, model: string, error: FuguError, durationMs: number): void {
    if (!this.onResponse) return;
    this.onResponse({ path, model, status: error.code, durationMs, requestId: error.requestId, error });
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return headers;
  }

  /** Map a thrown fetch/stream error to a typed FuguError (timeout/abort/network). */
  private classifyError(
    err: unknown,
    callerSignal: AbortSignal | undefined,
    path: string,
    timeoutMs: number,
  ): FuguError {
    if (err instanceof FuguError) return err;
    if (callerSignal?.aborted) return new FuguAbortError("Request aborted by caller.", { cause: err });
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return new FuguTimeoutError(`Request to ${path} timed out after ${timeoutMs}ms.`, { cause: err });
    }
    const reason = errorMessage(err);
    return new FuguConnectionError(`Request to ${path} failed: ${reason}`, { cause: err });
  }

  /** A single fetch with timeout/abort/network classification (no body consumed). */
  private async doFetch(
    url: string,
    init: RequestInit,
    path: string,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (err) {
      throw this.classifyError(err, callerSignal, path, timeoutMs);
    }
  }

  /**
   * Resolve the effective timeout, fire the request, and read the x-request-id header.
   * Shared by the buffered (`sendOnce`) and streaming (`stream`) paths; the response body
   * is left unconsumed for the caller to read or stream.
   */
  private async openRequest(
    path: string,
    body: unknown,
    model: string,
    opts: GenerateOptions,
    idempotencyKey?: string,
  ): Promise<{ res: Response; requestId?: string; timeoutMs: number }> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutOverrideMs ?? defaultTimeoutMs(model, opts.reasoningEffort);
    const res = await this.doFetch(
      url,
      { method: "POST", headers: this.headers(idempotencyKey), body: JSON.stringify(body) },
      path,
      timeoutMs,
      opts.signal,
    );
    const requestId = requestIdFrom(res.headers);
    return { res, requestId, timeoutMs };
  }

  private async sendOnce(
    path: string,
    body: unknown,
    model: string,
    opts: GenerateOptions,
    idempotencyKey: string,
    attempt: number,
  ): Promise<RawResponse> {
    this.onRequest?.({ path, model, attempt });
    const { res, requestId, timeoutMs } = await this.openRequest(path, body, model, opts, idempotencyKey);
    let rawText: string;
    try {
      rawText = await res.text();
    } catch (err) {
      throw this.classifyError(err, opts.signal, path, timeoutMs);
    }
    if (!res.ok) throw errorFromResponse(res.status, rawText, res.headers);
    if (!rawText) return { json: {}, requestId };
    try {
      return { json: JSON.parse(rawText), requestId };
    } catch {
      throw new FuguParseError(`Failed to parse Fugu response as JSON (${path}).`, {
        status: res.status,
        requestId,
      });
    }
  }

  private async request(
    path: string,
    body: unknown,
    model: string,
    opts: GenerateOptions,
  ): Promise<RawResponse> {
    this.requireApiKey();
    this.budget?.check();
    const idempotencyKey = opts.idempotencyKey ?? randomUUID();
    const maxRetries = opts.maxRetries ?? this.retry.maxRetries;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendOnce(path, body, model, opts, idempotencyKey, attempt);
      } catch (err) {
        if (!(err instanceof FuguError) || !err.isRetryable || attempt >= maxRetries) throw err;
        const delayMs = retryDelayMs(err, attempt, this.retry);
        this.logger.debug("fugu: retrying after error", { path, attempt, delayMs, code: err.code });
        await sleep(delayMs, opts.signal);
      }
    }
  }

  private async *stream(
    path: string,
    body: unknown,
    model: string,
    kind: "responses" | "chat",
    opts: GenerateOptions,
  ): AsyncGenerator<FuguStreamEvent> {
    this.requireApiKey();
    this.budget?.check();
    const { res, requestId, timeoutMs } = await this.openRequest(path, body, model, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw errorFromResponse(res.status, text, res.headers);
    }
    if (!res.body) throw new FuguParseError(`No response body to stream (${path}).`, { requestId });

    let text = "";
    let finalResponse: unknown;
    let usage: unknown;
    let finishReason: string | undefined;
    try {
      for await (const msg of parseSSE(res.body)) {
        if (msg.data === "[DONE]") break;
        let json: unknown;
        try {
          json = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const delta = extractStreamDelta(json);
        if (delta) {
          text += delta;
          yield { type: "delta", textDelta: delta };
        }
        const f = extractStreamFinal(json);
        if (f !== undefined) finalResponse = f;
        const u = extractStreamUsage(json);
        if (u !== undefined) usage = u;
        const fr = extractStreamFinishReason(json);
        if (fr !== undefined) finishReason = fr;
      }
    } catch (err) {
      throw this.classifyError(err, opts.signal, path, timeoutMs);
    }

    // Prefer the API's terminal payload; otherwise synthesize from accumulated text +
    // any captured usage WITHOUT claiming "completed" (a truncated stream must not look done).
    let raw: unknown;
    if (finalResponse !== undefined) {
      raw = finalResponse;
    } else if (kind === "responses") {
      raw = usage !== undefined ? { output_text: text, usage } : { output_text: text };
    } else {
      const choice: Record<string, unknown> = { message: { content: text } };
      if (finishReason !== undefined) choice.finish_reason = finishReason;
      raw = usage !== undefined ? { choices: [choice], usage } : { choices: [choice] };
    }
    const baseText = kind === "responses" ? extractResponsesText(raw) : extractChatText(raw);
    const result = this.buildResult(raw, model, baseText || text, requestId, {
      ...opts,
      throwOnIncomplete: false,
    });
    yield { type: "done", result };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rawAssistantMessage(json: unknown): Record<string, unknown> | undefined {
  const choices = (json as { choices?: unknown })?.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as { message?: unknown }).message;
    if (message && typeof message === "object") return message as Record<string, unknown>;
  }
  return undefined;
}

/** Build a client straight from a loaded config. */
export function createClient(
  config: FuguConfig,
  extra: Omit<FuguClientOptions, keyof FuguConfig> = {},
): FuguClient {
  return new FuguClient({ ...config, ...extra });
}

// Re-export the pure parsers/helpers as part of the public surface.
export { extractResponsesText, extractChatText, parseUsage, parseResponseMeta } from "./types.ts";
