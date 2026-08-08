// The vocabulary every other file in the engine is written against: a
// conversation is an ordered list of Messages, each carrying an ordered list
// of Blocks; a Tool is one function the model may call; a Response is what
// one model call returns; Model is the one-method contract a live LLM
// backend satisfies. This file is a shape, not a process — `textBlock` is
// its only executable logic (specs/model.md).

/**
 * Unlike Go's `type Role string` (which places no restriction on a third
 * value at the type level — specs/model.md's Open Questions calls this
 * genuinely unresolved), every real producer in the codebase only ever uses
 * these two values, so the port encodes that reality as a literal union
 * rather than leaving the door open for a value nothing consumes.
 */
export const RoleUser = "user" as const;
export const RoleAssistant = "assistant" as const;
export type Role = typeof RoleUser | typeof RoleAssistant;

/** `json.RawMessage`-equivalent: opaque bytes, never parsed (H4). */
export type RawJSON = Uint8Array;

/**
 * `Provider`/`ProviderData` are an overlay usable on *any* Block variant,
 * not a fifth kind of their own (specs/model.md "an overlay, not a fifth
 * kind") — OpenAI attaches them to `"text"` and `"tool_use"` blocks too,
 * whenever the underlying wire item also has a normalized representation.
 * `exactOptionalPropertyTypes` makes omission a deliberate act: a caller
 * cannot write `{ providerData: undefined }`, only omit the key entirely —
 * matching Go's `len(ProviderData) > 0` presence check, where a `nil` and a
 * present-but-empty `RawMessage` are already treated identically (H9 does
 * not apply the way it applies to the `-json` CLI form).
 */
interface ProviderOverlay {
  readonly provider?: string;
  readonly providerData?: RawJSON;
}

export interface TextBlock extends ProviderOverlay {
  readonly type: "text";
  readonly text: string;
}

export interface ToolUseBlock extends ProviderOverlay {
  readonly type: "tool_use";
  readonly id: string;
  readonly toolName: string;
  readonly toolInput: RawJSON;
}

export interface ToolResultBlock extends ProviderOverlay {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly toolResult: string;
  readonly toolError: boolean;
}

/**
 * No normalized fields of its own — `provider`/`providerData` (inherited
 * from ProviderOverlay) *are* the payload here. `model.go` itself does not
 * require them to be present for this variant; the OpenAI encoder is what
 * rejects an empty one (specs/model.md Errors).
 */
export interface ProviderStateBlock extends ProviderOverlay {
  readonly type: "provider_state";
}

/**
 * A discriminated union, not Go's flat all-fields-present struct (every
 * TODO item that reads a type-specific field narrows on `.type` first — a
 * struct with all fields always present let Go code read a zero-valued
 * field by accident with no compiler complaint; a union makes that a type
 * error instead).
 */
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ProviderStateBlock;

export interface Message {
  readonly role: Role;
  readonly content: readonly Block[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: RawJSON;
}

export interface Response {
  readonly content: readonly Block[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Go's `Model.Generate` returns `(*Response, error)` with an implicit,
 * unenforced "nil error implies non-nil Response" contract (H15) — its sole
 * caller dereferences the response unconditionally once `err == nil`. A
 * `Promise<Response>` that rejects on failure makes that invalid state
 * structurally unrepresentable instead of relying on a runtime check: there
 * is no way to "succeed" with an absent response. `signal` replaces `ctx`
 * (H6); honoring it is each implementation's responsibility, exactly as
 * `model.go` only declares `ctx` and implements no cancellation itself.
 */
export interface Model {
  generate(
    signal: AbortSignal,
    system: string,
    messages: readonly Message[],
    tools: readonly Tool[],
  ): Promise<Response>;
}

/** The nudge message and the initial user prompt both build a bare text turn. */
export function textBlock(text: string): TextBlock {
  return { type: "text", text };
}
