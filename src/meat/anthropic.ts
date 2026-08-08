// anthropic.ts is meat/anthropic.go: AnthropicModel, a built-in Model backed
// by the Anthropic Messages API, using only Node's built-in fetch so meat.dev
// has no third-party dependency. Also delivers postJSONWithRetry, the retry
// loop openai.ts (item 4p) reuses — port once, share it (specs/providers.md
// "The retry loop").
//
// H4 (critical, new ground for this port): `tool_use.input` arrives embedded
// as raw JSON (an object/array), never a JSON-encoded string — the opposite
// shape from OpenAI's `arguments` field (H4's note in migration/HAZARDS.md).
// A single `JSON.parse` of the whole response body would silently reformat
// it (number precision, whitespace, duplicate-key collapse) before this file
// ever sees the bytes Anthropic actually sent — exactly the
// JSON.parse -> JSON.stringify round trip H4 forbids, for both directions:
// - Incoming (decodeAnthropicResponse): `scanJSONValueEnd`/`rawObjectField`/
//   `rawArrayElements` locate each tool_use block's `"input"` value by
//   tracking bracket/quote nesting only, in the ORIGINAL response text, and
//   slice it out verbatim — never handed to JSON.parse.
// - Outgoing (buildAntRequestBody): the request body is hand-assembled by
//   string splicing, not a single JSON.stringify call, so a replayed
//   `tool_use.input`/tool `input_schema` (already-Uint8Array raw JSON
//   fragments) are spliced in as pre-serialized text, verbatim.
// H5: `postJSONWithRetry`'s aggregate "after N attempts" error wraps its
// cause ({cause}); the top-level API-error-object error and the per-attempt
// HTTP-status error are opaque leaves, matching Go's non-%w errors.
// H6: three independent abort points — the backoff wait, the request itself
// (both via the caller's own signal, un-derived), and a THIRD, genuinely
// separate per-ATTEMPT client-level timeout (Go's `http.Client.Timeout` has
// no context-composition mechanism of its own; it re-arms fresh on every
// `client.Do()` call, i.e. every attempt, not once for the whole retry loop).
// H9: `antMessage.content` has no Go `omitempty` and marshals as JSON `null`
// when every block in a message was of an unrecognized type — ported as an
// explicit `blocks.length > 0 ? [...] : "null"` splice, not `[]`.
// H14: the per-attempt error's body trim uses the Go-matching `trimSpace`
// (bytes.ts), not `.trim()`.
// H19 (migration/HAZARDS.md): the per-attempt client timeout is composed via
// a ref'd `setTimeout` + explicit `cancel()`, never `AbortSignal.timeout()`
// — H19 names this exact file as a candidate for the same unref'd-timer bug
// that broke a `meat.ts` deadline test; see that entry and `meat.ts`'s own
// `timeoutSignal` for the pattern (duplicated here, not imported — a
// provider file has no business depending on the orchestrator).

import { encodeUTF8, decodeUTF8, trimSpace } from "./bytes.ts";
import { resolveModel } from "./provider.ts";
import { discoverExeGatewayBase } from "./gateway.ts";
import { type Model, type Message, type Block, type Tool, type Response } from "./model.ts";

/** Go's `DefaultAnthropicModel` (`meat/anthropic.go:17`). */
export const DefaultAnthropicModel = "claude-opus-4-8";

/** Go's `maxOutputTokens` (`meat/anthropic.go:31`). */
export const maxOutputTokens = 16384;

/** Go's `implicitGatewayKey` (`meat/anthropic.go:36`). */
const implicitGatewayKey = "implicit";

/** Go's `client := m.HTTPC; if client == nil { client = &http.Client{Timeout: 2*time.Minute} }` (`meat/anthropic.go:133-136`). */
const defaultClientTimeoutMs = 2 * 60 * 1000;

/** Go's `maxAttempts = 4` (`meat/anthropic.go:172`) — a true `const`, no test-injection seam (`specs/test-infrastructure.md`: "there is no seam for maxAttempts"). Exported for openai.ts's (item 4p) shared use of `postJSONWithRetry`. */
export const maxAttempts = 4;

/**
 * Go's `var retryBaseDelay = time.Second` (`meat/anthropic.go:176`): a
 * package-level var so tests can shrink it. H17's mutable-object seam
 * (matching `gatewayConfig`/`meatConfig`) — an `export let` binding cannot
 * be reassigned from an importing test module, but this object's property
 * can. Shared with openai.ts once that file exists, since `postJSONWithRetry`
 * is the one retry loop both providers call.
 */
export const retryConfig = {
  baseDelayMs: 1000,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// AnthropicModel: a plain, mutable, embedder-constructible struct (mirrors
// Go's exported `AnthropicModel` struct, `meat/anthropic.go:21-26`) that
// directly satisfies `Model` via a self-referencing `generate` closure — the
// same shape this codebase's test harnesses already use for a `Model`
// implementation (see `test/meat/meat.test.ts`'s `newScriptedModel`), rather
// than a class, matching the project's function-over-class convention.
// Every field defaults lazily inside `generate`, not just in the
// constructor (Invariants: a directly-constructed model must default
// identically to one built by `NewAnthropicFromEnv`).
// ---------------------------------------------------------------------------

export interface AnthropicModel extends Model {
  apiKey: string;
  model: string;
  baseURL: string;
  /**
   * Stands in for Go's `*http.Client` parameter — the one thing it actually
   * varies here is the client-level timeout (same pattern as
   * `gateway.ts`'s `GatewayHttpClientOpts`). `undefined` (the constructor
   * default) mirrors `HTTPC == nil`: the production 2-minute default
   * applies. An explicit `0` mirrors an explicitly-supplied client with a
   * zero-value `Timeout` field (Go's "no timeout"; the HTTP-stub test
   * harness's `srv.Client()` is exactly this) — a real number is any other
   * caller-chosen cap.
   */
  clientTimeoutMs?: number;
}

export interface AnthropicModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseURL?: string;
  readonly clientTimeoutMs?: number;
}

/** Direct construction, mirroring Go's `&AnthropicModel{...}` struct literal. */
export function newAnthropicModel(opts: AnthropicModelOptions = {}): AnthropicModel {
  const m: AnthropicModel = {
    apiKey: opts.apiKey ?? "",
    model: opts.model ?? "",
    baseURL: opts.baseURL ?? "",
    ...(opts.clientTimeoutMs !== undefined ? { clientTimeoutMs: opts.clientTimeoutMs } : {}),
    generate: (signal, system, messages, tools) => anthropicGenerate(m, signal, system, messages, tools),
  };
  return m;
}

/**
 * Go's `NewAnthropicFromEnv` (`meat/anthropic.go:48-67`, G7-G9). Resolution
 * order: an explicit `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` wins outright
 * over gateway discovery (G7) — even on an exe.dev VM with a matching `llm`
 * integration; otherwise fall back to the exe.dev managed gateway (G8);
 * otherwise throw (G9). `model` resolution
 * (`resolveModel(model, DefaultAnthropicModel)`) happens here AND, again,
 * independently inside `generate` — both are kept, since a directly
 * -constructed `AnthropicModel` (bypassing this constructor entirely) only
 * ever sees the second one.
 */
export async function NewAnthropicFromEnv(signal: AbortSignal, model: string): Promise<AnthropicModel> {
  const resolvedModel = resolveModel(model, DefaultAnthropicModel);
  const key = process.env["ANTHROPIC_API_KEY"] ?? "";
  const baseURL = process.env["ANTHROPIC_BASE_URL"] ?? "";
  if (key !== "" || baseURL !== "") {
    return newAnthropicModel({ apiKey: key, model: resolvedModel, baseURL });
  }
  const base = await discoverExeGatewayBase(signal);
  if (base !== "") {
    return newAnthropicModel({ apiKey: implicitGatewayKey, model: resolvedModel, baseURL: `${base}/anthropic` });
  }
  throw new Error("no LLM credentials: set ANTHROPIC_API_KEY, or run on an exe.dev VM with an attached 'llm' integration");
}

// ---------------------------------------------------------------------------
// Minimal raw-JSON-value scanner (H4, incoming direction). Tracks
// bracket/quote nesting only — never interprets a value — so a captured
// span is always a verbatim substring of the original response text.
// ---------------------------------------------------------------------------

function isJSONWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isJSONWhitespaceOrComma(ch: string): boolean {
  return ch === "," || isJSONWhitespace(ch);
}

function isJSONValueDelimiter(ch: string): boolean {
  return ch === "," || ch === "}" || ch === "]" || isJSONWhitespace(ch);
}

/** Returns the index just past the JSON value starting at `text[start]` (no leading whitespace). */
function scanJSONValueEnd(text: string, start: number): number {
  let i = start;
  const c = text.charAt(i);
  if (c === '"') {
    i++;
    while (i < text.length && text.charAt(i) !== '"') {
      if (text.charAt(i) === "\\") i++;
      i++;
    }
    return i + 1;
  }
  if (c === "{" || c === "[") {
    const open = c;
    const close = c === "{" ? "}" : "]";
    let depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      const ch = text.charAt(i);
      if (ch === '"') {
        i++;
        while (i < text.length && text.charAt(i) !== '"') {
          if (text.charAt(i) === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) depth--;
      i++;
    }
    return i;
  }
  // true / false / null / a number: run to the next structural delimiter.
  while (i < text.length && !isJSONValueDelimiter(text.charAt(i))) i++;
  return i;
}

/**
 * Scans a JSON object's raw text (starting at `{`) for `key` at the
 * object's top level, and returns the raw substring of its value —
 * skipping every other key's value via `scanJSONValueEnd` without parsing
 * it. Returns `undefined` if `key` is absent or `text` is malformed.
 *
 * Exported for `openai.ts` (item 4p) — its own incoming `RawMessage` field
 * (each `resp.output[]`/SSE-event `item`/`response` element) is the same
 * "extract one field's raw span from a larger JSON document" problem this
 * file solved first, on a second concrete need rather than duplicated,
 * matching this codebase's established precedent for extracting a shared
 * helper (`bytes.ts`'s `arrayAt`).
 */
export function rawObjectField(text: string, key: string): string | undefined {
  let i = 1; // past the leading '{'
  while (i < text.length) {
    while (i < text.length && isJSONWhitespaceOrComma(text.charAt(i))) i++;
    if (i >= text.length || text.charAt(i) === "}") break;
    if (text.charAt(i) !== '"') break; // malformed; give up rather than misread.
    const keyStart = i;
    const keyEnd = scanJSONValueEnd(text, i);
    const parsedKey = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = keyEnd;
    while (i < text.length && isJSONWhitespace(text.charAt(i))) i++;
    if (text.charAt(i) !== ":") break;
    i++;
    while (i < text.length && isJSONWhitespace(text.charAt(i))) i++;
    const valueStart = i;
    const valueEnd = scanJSONValueEnd(text, valueStart);
    if (parsedKey === key) return text.slice(valueStart, valueEnd);
    i = valueEnd;
  }
  return undefined;
}

/** Splits a JSON array's raw text (starting at `[`) into its top-level elements' raw substrings, in order. Exported for `openai.ts`, see `rawObjectField`'s doc comment. */
export function rawArrayElements(text: string): string[] {
  const out: string[] = [];
  let i = 1; // past the leading '['
  while (i < text.length) {
    while (i < text.length && isJSONWhitespaceOrComma(text.charAt(i))) i++;
    if (i >= text.length || text.charAt(i) === "]") break;
    const start = i;
    const end = scanJSONValueEnd(text, start);
    out.push(text.slice(start, end));
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outgoing wire translation (`toAntMessages`, `toAntTools`,
// `meat/anthropic.go:247-272`) — hand-assembled by string splicing, not one
// `JSON.stringify` call, so a replayed `tool_use.input`/tool `input_schema`
// (raw JSON fragments already carried as bytes throughout the engine, H4)
// are spliced in as pre-serialized text, verbatim.
// ---------------------------------------------------------------------------

function jsonStr(s: string): string {
  return JSON.stringify(s);
}

/** Go's `toAntTools` (`meat/anthropic.go:247-253`). */
function serializeAntTool(t: Tool): string {
  return `{"name":${jsonStr(t.name)},"description":${jsonStr(t.description)},"input_schema":${decodeUTF8(t.inputSchema)}}`;
}

/** Go's `toAntMessages`'s per-block translation (`meat/anthropic.go:260-267`) — any other `Type`, including `"provider_state"`, matches no case and is silently dropped (H4). */
function serializeAntBlock(b: Block): string | undefined {
  switch (b.type) {
    case "text":
      return `{"type":"text","text":${jsonStr(b.text)}}`;
    case "tool_use":
      return `{"type":"tool_use","id":${jsonStr(b.id)},"name":${jsonStr(b.toolName)},"input":${decodeUTF8(b.toolInput)}}`;
    case "tool_result":
      return `{"type":"tool_result","tool_use_id":${jsonStr(b.toolUseId)},"content":${jsonStr(b.toolResult)}${b.toolError ? ',"is_error":true' : ""}}`;
    default:
      return undefined;
  }
}

/**
 * Go's `toAntMessages` (`meat/anthropic.go:255-272`). H9: `am.Content` has
 * no `omitempty` and is Go's zero-value `nil` slice whenever every block in
 * the message was unrecognized — marshals as `"content": null`, not `[]`.
 */
function serializeAntMessage(m: Message): string {
  const blocks: string[] = [];
  for (const b of m.content) {
    const serialized = serializeAntBlock(b);
    if (serialized !== undefined) blocks.push(serialized);
  }
  const contentField = blocks.length > 0 ? `[${blocks.join(",")}]` : "null";
  return `{"role":${jsonStr(m.role)},"content":${contentField}}`;
}

function buildAntRequestBody(model: string, system: string, messages: readonly Message[], tools: readonly Tool[]): Uint8Array {
  const messagesField = `[${messages.map(serializeAntMessage).join(",")}]`;
  const toolsField = tools.length > 0 ? `,"tools":[${tools.map(serializeAntTool).join(",")}]` : "";
  const json = `{"model":${jsonStr(model)},"max_tokens":${maxOutputTokens},"system":${jsonStr(system)},"messages":${messagesField}${toolsField}}`;
  return encodeUTF8(json);
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charAt(end - 1) === "/") end--;
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------
// The retry loop (`postWithRetry` -> `postJSONWithRetry`,
// `meat/anthropic.go:178-245`). Shared with openai.ts (item 4p).
// ---------------------------------------------------------------------------

/** Go's `retryableStatus` (`meat/anthropic.go:243-245`). */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * H19: a ref'd `setTimeout` + explicit `cancel()`, never
 * `AbortSignal.timeout()` — see this file's header comment and
 * `migration/HAZARDS.md` H19.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`meat: request exceeded client timeout of ${ms}ms`)), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** Races a plain ref'd timer against `signal` aborting first, mirroring Go's `select { case <-ctx.Done(): ...; case <-time.After(delay): } ` (`meat/anthropic.go:199-203`). Rejects with `signal.reason` if the signal wins. */
function backoffDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as unknown);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as unknown);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Go's `postJSONWithRetry` (`meat/anthropic.go:193-238`): POSTs `body` to
 * `url`, retrying transient failures (429, 5xx including Anthropic's
 * non-standard 529, and transport/read errors) with exponential backoff.
 * `maxAttempts` (4) = 1 initial + 3 retries. Returns the raw response bytes
 * on the first HTTP 200 — decoding (JSON parse, provider-specific error
 * checks) is each caller's own job, not this function's, since openai.ts
 * needs the SAME raw bytes for a totally different (SSE) decode path.
 */
export async function postJSONWithRetry(
  signal: AbortSignal,
  url: string,
  body: Uint8Array,
  provider: string,
  clientTimeoutMs: number | undefined,
  setHeaders: (headers: Headers) => void,
): Promise<Uint8Array> {
  let lastErr: unknown = new Error("unreachable: retry loop ran zero attempts");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // 1s, 2s, 4s by default — modest; the Abridge wall-clock budget is the
      // real cap. Rejects (propagating out of this whole function, bypassing
      // retry) if `signal` aborts first — Go's ctx.Err() short-circuit.
      const delayMs = retryConfig.baseDelayMs << (attempt - 1);
      await backoffDelay(delayMs, signal);
    }

    const headers = new Headers({ "content-type": "application/json" });
    setHeaders(headers);

    const effectiveClientTimeoutMs = clientTimeoutMs ?? defaultClientTimeoutMs;
    const perAttempt = effectiveClientTimeoutMs > 0 ? timeoutSignal(effectiveClientTimeoutMs) : null;
    const requestSignal = perAttempt !== null ? AbortSignal.any([signal, perAttempt.signal]) : signal;

    let httpResp: globalThis.Response;
    try {
      httpResp = await fetch(url, { method: "POST", body, headers, signal: requestSignal });
    } catch (err) {
      perAttempt?.cancel();
      // Go checks ctx.Err() FIRST — the caller's own (un-derived) signal, not
      // whichever of the composed signals actually fired — so a per-attempt
      // client-timeout firing here is treated as an ordinary transport
      // failure and retried, exactly like Go's client.Timeout (which has no
      // visibility into ctx at all).
      if (signal.aborted) {
        throw (signal.reason as unknown) ?? err;
      }
      lastErr = err;
      continue;
    }
    perAttempt?.cancel();

    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await httpResp.arrayBuffer());
    } catch (err) {
      lastErr = err;
      continue;
    }

    if (httpResp.status === 200) {
      return raw;
    }
    const bodyText = decodeUTF8(trimSpace(raw));
    const statusErr = new Error(`${provider} API ${httpResp.status}: ${bodyText}`);
    if (!retryableStatus(httpResp.status)) {
      throw statusErr;
    }
    lastErr = statusErr;
  }
  throw new Error(`after ${maxAttempts} attempts: ${errorMessage(lastErr)}`, { cause: lastErr });
}

// ---------------------------------------------------------------------------
// Generate (`meat/anthropic.go:115-168`).
// ---------------------------------------------------------------------------

interface AntRespBlock {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  // "input" deliberately absent: read via the raw scanner above, H4.
}

interface AntResp {
  readonly content?: readonly AntRespBlock[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly error?: { readonly type: string; readonly message: string } | null;
}

/** Go's response decode + decision boundaries (`Generate`, `meat/anthropic.go:142-168`). */
function decodeAnthropicResponse(raw: Uint8Array): Response {
  const text = decodeUTF8(raw);
  let resp: AntResp;
  try {
    resp = JSON.parse(text) as AntResp;
  } catch (err) {
    throw new Error(`decode response: ${errorMessage(err)}`, { cause: err });
  }
  if (resp.error != null) {
    throw new Error(`anthropic error: ${resp.error.type}: ${resp.error.message}`);
  }
  // stop_reason is interpreted for exactly this one literal value; every
  // other value (including a successful "end_turn"/"tool_use") is decoded
  // and then discarded — Response carries no stop-reason field at all.
  if (resp.stop_reason === "max_tokens") {
    throw new Error(`anthropic response truncated at max_tokens (${maxOutputTokens}); the diff may be too large to abridge in one pass`);
  }

  const rawContentField = rawObjectField(text, "content");
  const rawElements = rawContentField !== undefined ? rawArrayElements(rawContentField) : [];
  const parsedContent = resp.content ?? [];

  const content: Block[] = [];
  for (let i = 0; i < parsedContent.length; i++) {
    const b = parsedContent[i];
    if (b === undefined) continue;
    if (b.type === "text") {
      content.push({ type: "text", text: b.text ?? "" });
    } else if (b.type === "tool_use") {
      const rawElement = rawElements[i];
      const rawInput = rawElement !== undefined ? rawObjectField(rawElement, "input") : undefined;
      content.push({
        type: "tool_use",
        id: b.id ?? "",
        toolName: b.name ?? "",
        toolInput: rawInput !== undefined ? encodeUTF8(rawInput) : new Uint8Array(0),
      });
    }
    // Any other block type: silently dropped — Go's switch has no default.
  }

  return {
    content,
    inputTokens: resp.usage?.input_tokens ?? 0,
    outputTokens: resp.usage?.output_tokens ?? 0,
  };
}

/** Go's `AnthropicModel.Generate` (`meat/anthropic.go:115-168`). */
async function anthropicGenerate(
  m: AnthropicModel,
  signal: AbortSignal,
  system: string,
  messages: readonly Message[],
  tools: readonly Tool[],
): Promise<Response> {
  if (m.apiKey === "") {
    throw new Error("meat: AnthropicModel.APIKey is empty");
  }

  const model = m.model !== "" ? m.model : DefaultAnthropicModel;
  const body = buildAntRequestBody(model, system, messages, tools);
  const url = `${trimTrailingSlashes(m.baseURL !== "" ? m.baseURL : "https://api.anthropic.com")}/v1/messages`;

  const raw = await postJSONWithRetry(signal, url, body, "anthropic", m.clientTimeoutMs, (headers) => {
    headers.set("x-api-key", m.apiKey);
    headers.set("anthropic-version", "2023-06-01");
  });

  return decodeAnthropicResponse(raw);
}
