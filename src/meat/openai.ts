// openai.ts is meat/openai.go: OpenAIModel, a built-in Model backed by the
// OpenAI Responses API. Uses streaming responses (ChatGPT-backed exe.dev
// integrations require it) but `generate` still returns one complete
// provider-agnostic reply — the whole SSE stream is drained by the shared
// `postJSONWithRetry` (anthropic.ts) before this file parses anything; this
// is not an incremental/streaming API at the application layer.
//
// H4 (critical — the highest-consequence mechanism in the whole port):
// `Block.providerData` is the carrier for opaque provider state — for
// reasoning models this is encrypted reasoning items, cryptographically
// bound to their exact bytes. Every output item's ENTIRE raw bytes become
// `providerData` (`blocksFromOpenAIItem`), and are replayed byte-for-byte,
// unparsed, on a later turn via the opaque-replay short-circuit in
// `toOpenAIInput` — checked FIRST, before the type switch, for every block
// regardless of type. A `JSON.parse`→re-serialize round trip anywhere on
// this path corrupts the binding. Unlike `anthropic.ts`'s `tool_use.input`
// (embedded raw JSON), this file's OWN `arguments` field is a JSON-encoded
// *string* (a different RawMessage shape — a plain `JSON.parse` reproduces
// it losslessly, no scanning needed), but decoding `resp.output[]` (and,
// inside an SSE stream, each event's `item`/`response` fields) needs the
// same raw-span-extraction technique `anthropic.ts` built first —
// `rawObjectField`/`rawArrayElements`, imported from there rather than
// duplicated (this file's own need is the second occurrence, not the
// first).
// H6: `ctx` flows straight into the shared retry loop; a client-level
// 5-minute default timeout (independent of `ctx`, same two-timeout pattern
// as `gateway.ts`/`anthropic.ts`) applies when no override is given, sized
// for a full streaming reasoning-model turn. A cancellation landing during
// the full-body SSE read is not distinguished from an ordinary transient
// read failure at that call site (inherited from the shared retry loop) —
// matters more here than for `anthropic.ts` since responses are routinely
// large, slow streams.
// H12: the SSE line scan enforces the same 16 MiB per-line cap Go's
// `bufio.Scanner` does — exceeding it is an explicit error, never a silent
// truncation, unlike `tools.ts`'s `capLines`.
// H13: output items are reassembled in ascending `output_index` order via
// an explicit sort, even though a JS `Map` would already preserve insertion
// (SSE arrival) order — insertion order is not provably identical to
// ascending index order; the sort is the actual contract, kept regardless.

import { splitLines, trimSpace, encodeUTF8, decodeUTF8, at } from "./bytes.ts";
import { resolveModel } from "./provider.ts";
import { discoverExeGatewayBase } from "./gateway.ts";
import { postJSONWithRetry, rawObjectField, rawArrayElements } from "./anthropic.ts";
import { type Model, type Message, type Block, type Tool, type Response } from "./model.ts";

/** Go's `DefaultOpenAIModel` (`meat/openai.go:17`). */
export const DefaultOpenAIModel = "gpt-5.6-sol";

/**
 * Default Grok model id (xAI Responses API). Used when the resolved model is
 * a `grok-*` id, and as the CLI default when only xAI credentials are set.
 */
export const DefaultGrokModel = "grok-4.6";

/** Default xAI origin, including the `/v1` prefix the Responses URL builder recognizes. */
export const DefaultXAIBaseURL = "https://api.x.ai/v1";

/** Go's `DefaultReasoningEffort` (`meat/openai.go:21`). */
export const DefaultReasoningEffort = "medium";

/** Go's `maxOpenAIOutputTokens` (`meat/openai.go:25`). */
export const maxOpenAIOutputTokens = 32768;

/** Go's `client := m.HTTPC; if client == nil { client = &http.Client{Timeout: 5*time.Minute} }` (`meat/openai.go:174-177`). */
const defaultClientTimeoutMs = 5 * 60 * 1000;

/** Go's `bufio.Scanner`'s 16 MiB max token size (`meat/openai.go:419`, H12). Exceeding this on any single SSE line is an explicit error, never silent truncation. */
const maxSSELineBytes = 16 * 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonStr(s: string): string {
  return JSON.stringify(s);
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charAt(end - 1) === "/") end--;
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------
// OpenAIModel: plain, mutable, embedder-constructible (mirrors Go's exported
// struct), satisfying `Model` via a self-referencing `generate` closure —
// same shape as `anthropic.ts`'s `AnthropicModel`, see that file's own doc
// comment for the rationale.
// ---------------------------------------------------------------------------

export interface OpenAIModel extends Model {
  apiKey: string;
  model: string;
  baseURL: string;
  reasoningEffort: string;
  /** Stands in for Go's `*http.Client` — see `AnthropicModel.clientTimeoutMs`'s doc comment for the `undefined`-vs-`0` contract (identical here, just a 5-minute default instead of 2). */
  clientTimeoutMs?: number;
}

export interface OpenAIModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseURL?: string;
  readonly reasoningEffort?: string;
  readonly clientTimeoutMs?: number;
}

/** Direct construction, mirroring Go's `&OpenAIModel{...}` struct literal. */
export function newOpenAIModel(opts: OpenAIModelOptions = {}): OpenAIModel {
  const m: OpenAIModel = {
    apiKey: opts.apiKey ?? "",
    model: opts.model ?? "",
    baseURL: opts.baseURL ?? "",
    reasoningEffort: opts.reasoningEffort ?? "",
    ...(opts.clientTimeoutMs !== undefined ? { clientTimeoutMs: opts.clientTimeoutMs } : {}),
    generate: (signal, system, messages, tools) => openaiGenerate(m, signal, system, messages, tools),
  };
  return m;
}

/**
 * Go's `NewOpenAIFromEnv` (`meat/openai.go:49-72`, G16-G18). Notable
 * asymmetry with Anthropic's gateway fallback (G8): Anthropic sets `APIKey`
 * to the placeholder `"implicit"` so the edge gateway has something to
 * substitute; OpenAI's gateway branch sends **no placeholder at all** —
 * `apiKey` stays `""`, so `generate` never sets an `authorization` header
 * for a gateway-routed request. Do not invent a placeholder here — the
 * absence of the header is the actual contract.
 */
export async function NewOpenAIFromEnv(signal: AbortSignal, model: string): Promise<OpenAIModel> {
  const resolvedModel = resolveModel(model, DefaultOpenAIModel);
  const key = process.env["OPENAI_API_KEY"] ?? "";
  const baseURL = process.env["OPENAI_BASE_URL"] ?? "";
  if (key !== "" || baseURL !== "") {
    return newOpenAIModel({ apiKey: key, model: resolvedModel, baseURL, reasoningEffort: DefaultReasoningEffort });
  }
  const base = await discoverExeGatewayBase(signal);
  if (base !== "") {
    return newOpenAIModel({ model: resolvedModel, baseURL: `${base}/openai`, reasoningEffort: DefaultReasoningEffort });
  }
  throw new Error("no OpenAI credentials: set OPENAI_API_KEY, OPENAI_BASE_URL, or run on an exe.dev VM with an attached 'llm' integration");
}

/**
 * Strip one optional leading `xai/` so a user-facing id like `xai/grok-4.6`
 * reaches api.x.ai as `grok-4.6`. Matches `strings.TrimPrefix` (at most once).
 */
function grokAPIModel(model: string): string {
  return model.startsWith("xai/") ? model.slice("xai/".length) : model;
}

/**
 * Builds an OpenAI-compatible model pointed at xAI. Resolution:
 *  1. If `XAI_API_KEY` or `XAI_BASE_URL` is set, use it. An empty base URL
 *     becomes `DefaultXAIBaseURL` (`https://api.x.ai/v1`) so `generate` does
 *     not fall through to api.openai.com.
 *  2. Otherwise throw. No exe.dev gateway fallback — the gateway only
 *     exposes `/openai` and `/anthropic` prefixes.
 *
 * `model` falls back to `$MEAT_MODEL`, then `DefaultGrokModel`. The optional
 * `xai/` prefix is stripped before the id is stored on the model (the wire id).
 */
export async function NewGrokFromEnv(signal: AbortSignal, model: string): Promise<OpenAIModel> {
  void signal;
  const resolvedModel = grokAPIModel(resolveModel(model, DefaultGrokModel));
  const key = process.env["XAI_API_KEY"] ?? "";
  const baseURL = process.env["XAI_BASE_URL"] ?? "";
  if (key !== "" || baseURL !== "") {
    return newOpenAIModel({
      apiKey: key,
      model: resolvedModel,
      baseURL: baseURL !== "" ? baseURL : DefaultXAIBaseURL,
      reasoningEffort: DefaultReasoningEffort,
    });
  }
  throw new Error("no xAI credentials: set XAI_API_KEY, XAI_BASE_URL");
}

// ---------------------------------------------------------------------------
// URL construction (`openAIResponsesURL`, `meat/openai.go:219-225`).
// ---------------------------------------------------------------------------

/** Go's `openAIResponsesURL` (`meat/openai.go:219-225`). Exported: `TestOpenAIResponsesURL` (`meat/openai_test.go:219-228`) calls it directly, same-package in Go. */
export function openAIResponsesURL(base: string): string {
  const trimmed = trimTrailingSlashes(base);
  if (trimmed.endsWith("/v1")) return `${trimmed}/responses`;
  return `${trimmed}/v1/responses`;
}

// ---------------------------------------------------------------------------
// Outgoing wire translation (`toOpenAITools`, `toOpenAIInput`,
// `meat/openai.go:227-317`).
// ---------------------------------------------------------------------------

function serializeOpenAITool(t: Tool): string {
  return `{"type":"function","name":${jsonStr(t.name)},"description":${jsonStr(t.description)},"parameters":${decodeUTF8(t.inputSchema)}}`;
}

function isValidJSON(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decodeUTF8(bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * Go's `toOpenAIInput` (`meat/openai.go:240-317`). Exported: the
 * `openai-request/replay` conformance vector calls this pure function
 * directly. Returns each wire input item as either a freshly-built `string`
 * (this file's own `JSON.stringify` of a plain object it controls — safe,
 * not a re-serialization of anything parsed) or the untouched `Uint8Array`
 * of an opaquely-replayed item (H4) — the conformance harness's own
 * `toTextVal` normalizes either shape for comparison.
 */
export function toOpenAIInput(messages: readonly Message[]): Array<string | Uint8Array> {
  const out: Array<string | Uint8Array> = [];
  for (const message of messages) {
    let text: string[] = [];
    const flushText = (): void => {
      if (text.length === 0) return;
      out.push(JSON.stringify({ role: message.role, content: text.join("\n") }));
      text = [];
    };

    for (const block of message.content) {
      if (block.provider === "openai" && block.providerData !== undefined && block.providerData.length > 0) {
        flushText();
        if (!isValidJSON(block.providerData)) {
          throw new Error("openai provider state is not valid JSON");
        }
        out.push(block.providerData);
        continue;
      }

      switch (block.type) {
        case "text":
          text.push(block.text);
          break;
        case "tool_use": {
          flushText();
          const trimmed = decodeUTF8(trimSpace(block.toolInput));
          const args = trimmed === "" ? "{}" : trimmed;
          out.push(JSON.stringify({ type: "function_call", call_id: block.id, name: block.toolName, arguments: args }));
          break;
        }
        case "tool_result": {
          // block.toolError is never read here (contrast Anthropic's
          // is_error flag) — a tool error and a tool success look
          // identical on this file's wire shape.
          flushText();
          out.push(JSON.stringify({ type: "function_call_output", call_id: block.toolUseId, output: block.toolResult }));
          break;
        }
        case "provider_state":
          // Reached only when the opaque-replay precondition above failed
          // (Provider isn't exactly "openai", or ProviderData is empty).
          throw new Error("openai provider state is missing opaque response data");
        default: {
          const exhaustive: never = block;
          throw new Error(`openai: unsupported message block type ${JSON.stringify((exhaustive as { type?: unknown }).type)}`);
        }
      }
    }
    flushText();
  }
  return out;
}

function rawItemText(item: string | Uint8Array): string {
  return typeof item === "string" ? item : decodeUTF8(item);
}

function buildOpenAIRequestBody(
  model: string,
  system: string,
  input: readonly (string | Uint8Array)[],
  tools: readonly Tool[],
  reasoningEffort: string,
): Uint8Array {
  const instructionsField = system !== "" ? `,"instructions":${jsonStr(system)}` : "";
  const inputField = `[${input.map(rawItemText).join(",")}]`;
  const toolsField = tools.length > 0 ? `,"tools":[${tools.map(serializeOpenAITool).join(",")}]` : "";
  const json =
    `{"model":${jsonStr(model)}${instructionsField},"input":${inputField}${toolsField},` +
    `"reasoning":{"effort":${jsonStr(reasoningEffort)}},"include":["reasoning.encrypted_content"],` +
    `"store":false,"stream":true,"max_output_tokens":${maxOpenAIOutputTokens}}`;
  return encodeUTF8(json);
}

// ---------------------------------------------------------------------------
// Response decoding (`decodeOpenAIResponse`, `meat/openai.go:371-456`).
// ---------------------------------------------------------------------------

interface DecodedOpenAIResponse {
  readonly status?: string;
  readonly error?: { readonly type: string; readonly code: string; readonly message: string } | null;
  readonly incompleteReason?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Raw per-item bytes (H4) — never JSON.parsed until `blocksFromOpenAIItem`. */
  readonly output: readonly Uint8Array[];
}

/**
 * Parses one `openAIResp`-shaped raw JSON object — reused for both the
 * plain-JSON top-level body and an SSE terminal event's nested `response`
 * field, exactly as Go reuses `openAIResp` for both
 * (`meat/openai.go:99-108`, `openAIStreamEvent.Response *openAIResp`).
 * `output`'s array elements are extracted via the raw scanner (H4); every
 * other field is safe to decode with a normal `JSON.parse`.
 */
function parseResponseSnapshot(rawText: string): DecodedOpenAIResponse {
  let parsed: {
    status?: string;
    error?: { type: string; code: string; message: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    parsed = JSON.parse(rawText) as typeof parsed;
  } catch (err) {
    throw new Error(`decode openai response: ${errorMessage(err)}`, { cause: err });
  }
  const rawOutputField = rawObjectField(rawText, "output");
  const rawElements = rawOutputField !== undefined ? rawArrayElements(rawOutputField) : [];
  return {
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    error: parsed.error ?? null,
    ...(parsed.incomplete_details?.reason !== undefined ? { incompleteReason: parsed.incomplete_details.reason } : {}),
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    output: rawElements.map((el) => encodeUTF8(el)),
  };
}

interface ParsedSSEEvent {
  readonly type?: string;
  readonly outputIndex: number;
  /** Raw text of the `"item"` field — present whenever the key was captured at all (H4; matches Go's byte-length presence check, including a literal `null`). */
  readonly item?: string;
  /** Raw text of the `"response"` field — `undefined` for both an absent key and an explicit JSON `null` (matches Go's pointer-nil semantics, unlike `item` above). */
  readonly responseText?: string;
  readonly code?: string;
  readonly message?: string;
}

function parseSSEEvent(eventText: string): ParsedSSEEvent {
  const parsed = JSON.parse(eventText) as { type?: string; output_index?: number; code?: string; message?: string };
  const item = rawObjectField(eventText, "item");
  const rawResponse = rawObjectField(eventText, "response");
  return {
    ...(parsed.type !== undefined ? { type: parsed.type } : {}),
    outputIndex: parsed.output_index ?? 0,
    ...(item !== undefined ? { item } : {}),
    ...(rawResponse !== undefined && rawResponse !== "null" ? { responseText: rawResponse } : {}),
    ...(parsed.code !== undefined ? { code: parsed.code } : {}),
    ...(parsed.message !== undefined ? { message: parsed.message } : {}),
  };
}

/**
 * Go's SSE consumption (`meat/openai.go:371-456`, Mechanism "SSE
 * consumption"). `splitLines` (bytes.ts) already strips CRLF/LF uniformly
 * per-line (specs/diff.md Algorithm 1), matching `bufio.Scanner`'s default
 * split function plus Go's own defensive `TrimSuffix(..., "\r")`.
 */
function decodeOpenAISSEStream(raw: Uint8Array): DecodedOpenAIResponse {
  const lines = splitLines(raw);
  for (const line of lines) {
    if (line.text.length > maxSSELineBytes) {
      throw new Error("read openai stream: bufio.Scanner: token too long");
    }
  }

  const items = new Map<number, Uint8Array>();
  let final: DecodedOpenAIResponse | null = null;
  let streamErr: Error | null = null;
  let dataLines: string[] = [];

  const consume = (): void => {
    if (dataLines.length === 0) return;
    const joined = dataLines.join("\n");
    dataLines = [];
    if (joined === "[DONE]") return;
    let event: ParsedSSEEvent;
    try {
      event = parseSSEEvent(joined);
    } catch (err) {
      throw new Error(`decode openai stream event: ${errorMessage(err)}`, { cause: err });
    }
    if (event.type === "response.output_item.done") {
      if (event.item !== undefined) {
        items.set(event.outputIndex, encodeUTF8(event.item));
      }
    } else if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
      if (event.responseText !== undefined) {
        final = parseResponseSnapshot(event.responseText);
      }
    } else if (event.type === "error") {
      streamErr = new Error(`openai stream error ${event.code ?? ""}: ${event.message ?? ""}`);
    }
    // Any other type (response.created, response.output_text.delta, ...): silently ignored.
  };

  for (const line of lines) {
    const text = decodeUTF8(line.text);
    if (text === "") {
      consume();
      continue;
    }
    if (text.startsWith("data:")) {
      dataLines.push(text.slice("data:".length).trim());
    }
    // Any other non-blank line (event:, id:, retry:, a comment): silently ignored.
  }
  consume();

  if (streamErr !== null) throw streamErr;
  if (final === null) throw new Error("openai stream ended without a final response event");
  // `final` is reassigned inside the `consume` closure above, so TS cannot
  // narrow it past the null check at every later read — bind it once to a
  // fresh, never-reassigned const instead.
  const finalResponse: DecodedOpenAIResponse = final;

  if (items.size > 0) {
    const indices = [...items.keys()].sort((a, b) => a - b);
    const output: Uint8Array[] = [];
    for (const index of indices) {
      const bytes = items.get(index);
      if (bytes !== undefined) output.push(bytes);
    }
    return { ...finalResponse, output };
  }
  return finalResponse;
}

const OPEN_BRACE = 0x7b;

/** Go's `decodeOpenAIResponse` (`meat/openai.go:371-382`): dispatch on the first non-whitespace byte. */
function decodeOpenAIResponse(raw: Uint8Array): DecodedOpenAIResponse {
  const trimmed = trimSpace(raw);
  if (trimmed.length === 0) {
    throw new Error("decode openai response: empty body");
  }
  if (at(trimmed, 0) === OPEN_BRACE) {
    return parseResponseSnapshot(decodeUTF8(trimmed));
  }
  return decodeOpenAISSEStream(raw);
}

// ---------------------------------------------------------------------------
// Output-item -> Block decoding (`blocksFromOpenAIItem`, `meat/openai.go:319-365`).
// ---------------------------------------------------------------------------

interface OpenAIOutputItemPeek {
  readonly type?: string;
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string; readonly refusal?: string }[];
}

function blocksFromOpenAIItem(raw: Uint8Array): Block[] {
  let item: OpenAIOutputItemPeek;
  try {
    item = JSON.parse(decodeUTF8(raw)) as OpenAIOutputItemPeek;
  } catch (err) {
    throw new Error(`decode openai output item: ${errorMessage(err)}`, { cause: err });
  }
  // Every branch's ProviderData is the item's own untouched bytes — `raw`
  // is already a fresh, independently-allocated buffer at every call site
  // in this file (built via `encodeUTF8` of an extracted raw span), so no
  // defensive clone is needed the way Go's `bytes.Clone(raw)` is (Go's
  // `raw` can alias a shared scan buffer; this port's never does).
  const state = raw;

  switch (item.type) {
    case "reasoning":
      return [{ type: "provider_state", provider: "openai", providerData: state }];
    case "function_call": {
      const trimmedArgs = decodeUTF8(trimSpace(encodeUTF8(item.arguments ?? "")));
      const input = trimmedArgs === "" ? encodeUTF8("{}") : encodeUTF8(trimmedArgs);
      return [{ type: "tool_use", id: item.call_id ?? "", toolName: item.name ?? "", toolInput: input, provider: "openai", providerData: state }];
    }
    case "message": {
      const parts: string[] = [];
      for (const c of item.content ?? []) {
        if (c.type === "output_text") parts.push(c.text ?? "");
        else if (c.type === "refusal") parts.push(c.refusal ?? "");
      }
      if (parts.length === 0) {
        return [{ type: "provider_state", provider: "openai", providerData: state }];
      }
      return [{ type: "text", text: parts.join("\n"), provider: "openai", providerData: state }];
    }
    default:
      // Preserve unfamiliar output items rather than silently dropping
      // state a newer Responses API model may require on the next turn.
      return [{ type: "provider_state", provider: "openai", providerData: state }];
  }
}

// ---------------------------------------------------------------------------
// Generate (`meat/openai.go:148-217`).
// ---------------------------------------------------------------------------

async function openaiGenerate(
  m: OpenAIModel,
  signal: AbortSignal,
  system: string,
  messages: readonly Message[],
  tools: readonly Tool[],
): Promise<Response> {
  if (m.apiKey === "" && m.baseURL === "") {
    throw new Error("meat: OpenAIModel needs APIKey or BaseURL");
  }

  const input = toOpenAIInput(messages);
  const model = m.model !== "" ? m.model : DefaultOpenAIModel;
  const effort = m.reasoningEffort !== "" ? m.reasoningEffort : DefaultReasoningEffort;
  const body = buildOpenAIRequestBody(model, system, input, tools, effort);
  const url = openAIResponsesURL(m.baseURL !== "" ? m.baseURL : "https://api.openai.com");

  const raw = await postJSONWithRetry(signal, url, body, "openai", m.clientTimeoutMs ?? defaultClientTimeoutMs, (headers) => {
    if (m.apiKey !== "") headers.set("authorization", `Bearer ${m.apiKey}`);
  });

  const resp = decodeOpenAIResponse(raw);
  if (resp.error != null) {
    const code = resp.error.code !== "" ? resp.error.code : resp.error.type;
    throw new Error(`openai error: ${code}: ${resp.error.message}`);
  }
  if (resp.status === "incomplete") {
    const reason = resp.incompleteReason !== undefined && resp.incompleteReason !== "" ? resp.incompleteReason : "unknown";
    throw new Error(`openai response incomplete (${reason}); max_output_tokens=${maxOpenAIOutputTokens}`);
  }
  if (resp.status !== undefined && resp.status !== "" && resp.status !== "completed") {
    throw new Error(`openai response ended with status ${JSON.stringify(resp.status)}`);
  }

  const content: Block[] = [];
  for (const rawItem of resp.output) {
    content.push(...blocksFromOpenAIItem(rawItem));
  }
  return { content, inputTokens: resp.inputTokens, outputTokens: resp.outputTokens };
}
