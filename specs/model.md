# model

> Status: stage 1 ⬜ (no direct test file) | stage 2 ✅
> Go sources: `meat/model.go`
> Go tests: none directly (no `model_test.go`); the shapes are exercised
> indirectly by `meat/meat_test.go`, `meat/anthropic_test.go`,
> `meat/openai_test.go`, `meat/chunk_test.go`

## Purpose

`model.go` defines the vocabulary every other file in the engine is written
against: a conversation is an ordered list of turns (`Message`s), each
belonging to the user or the model and carrying an ordered list of content
pieces (`Block`s); a `Tool` is one function the model may call; a `Response`
is what one model call returns; and `Model` is the single-method contract a
live LLM backend must satisfy. Nothing else in this file executes at runtime
beyond one two-line helper — it is a shape, not a process — but every other
subject in the engine (`agent-loop.md`'s turn loop, `tools.md`'s toolbox,
`providers.md`'s two wire translators) is written entirely in terms of these
five names, never against a provider's own wire format directly
(`meat/model.go:1-79`).

The built-in Anthropic and OpenAI backends translate to and from this
vocabulary at the edge of the process; the agent loop and toolbox never see a
provider's native JSON. An embedder that doesn't use either built-in backend
implements `Model` directly and drops into the same loop unmodified
(`meat/model.go:70-72`).

## Vocabulary

- **Role** — the author of a `Message`: `"user"` or `"assistant"`; no third
  value is named (`meat/model.go:8-14`).
- **Message** — one turn: a `Role` plus an ordered list of `Block`s
  (`meat/model.go:49-53`).
- **Block** — one piece of message content. A `Type` string names the kind
  (`"text"`, `"tool_use"`, `"tool_result"`, `"provider_state"`); which other
  fields carry meaning depends on the kind (`meat/model.go:16-47`, table
  under Mechanism).
- **Tool** — one function the model may call: a name, a description, and a
  JSON Schema for its arguments (`meat/model.go:57-61`).
- **Response** — one model reply: an ordered list of `Block`s plus that
  call's own input/output token counts (`meat/model.go:63-68`).
- **Model** — the one-method interface (`Generate`) a live backend implements
  (`meat/model.go:77-79`).
- **Opaque provider state (`ProviderData`)** — already defined in
  `glossary.md` under "Providers"; this is the file that declares the field
  (`meat/model.go:41-47`).

## Guarantees

None recorded here. `model.go` has no dedicated test file, and stage 1 left
this file's Guarantees empty. The shapes it defines are exercised indirectly
every time another test builds a `Block`/`Message`/`Response` or drives a
`Model` — the guarantees that actually pin their behavior live in
`agent-loop.md` (e.g. G4, G6-G8, on which `Block.Type` values the turn loop
acts on) and `providers.md` (e.g. G10-G27, both wire translators). See Open
questions.

## Mechanism

### Role and Message

`Role` is a plain string with two named values, `RoleUser` (`"user"`) and
`RoleAssistant` (`"assistant"`) (`meat/model.go:8-14`). Nothing in this file
restricts a `Message` to only these two values — every producer in the
codebase simply uses the two constants (`meat/meat.go:152,179,209,219,224`),
and both providers cast the field straight to the wire's role string with no
validation (`meat/anthropic.go:258`, `meat/openai.go:251`), so any other
value would reach the provider unfiltered rather than being rejected locally.

A `Message` is a `Role` plus an ordered list of `Block`s
(`meat/model.go:49-53`, field `Content`). Order matters and is never
re-derived: every consumer (the agent loop `meat/meat.go:182`, Anthropic's
translator `meat/anthropic.go:259-268`, OpenAI's `meat/openai.go:260-311`)
walks `Content` with a plain in-order loop and never sorts or reorders it —
this file leaves no ordering unspecified.

### Block: one discriminated content piece

A `Block` carries every field for every kind at once; a single string field,
`Type`, says which kind it currently is, and only the fields documented for
that `Type` are meaningful — the rest sit at their zero value (empty string /
`false` / `nil`) and must be ignored (`meat/model.go:16-24`). Four `Type`
values are defined:

| `Type` | Meaningful fields | Citation |
|---|---|---|
| `"text"` | `Text` | `meat/model.go:18,28-29` |
| `"tool_use"` | `ID`, `ToolName`, `ToolInput` | `meat/model.go:19,31-34` |
| `"tool_result"` | `ToolUseID`, `ToolResult`, `ToolError` | `meat/model.go:20,36-39` |
| `"provider_state"` | `Provider`, `ProviderData` | `meat/model.go:21,45-46` |

`ID` (on a `tool_use` block) and `ToolUseID` (on the matching `tool_result`)
are the correlation key a provider uses to pair a call with its answer;
`model.go` declares both fields but enforces no relationship between them —
the agent loop copies one into the other, once, at the point it builds the
result (`meat/meat.go:188-193`: `ToolUseID: b.ID`).

Not every `Type` a block can carry is understood by every provider. Decoding
a model reply, Anthropic recognizes only `"text"` and `"tool_use"`
(`meat/anthropic.go:161-166`, no `default` case — any other content type
Anthropic's API might send is silently dropped); encoding a message back out,
it recognizes `"text"`, `"tool_use"`, and `"tool_result"`
(`meat/anthropic.go:255-272`, again no `default` — a `"provider_state"` block
reaching this path vanishes with no error). OpenAI's encoder, by contrast,
treats an unrecognized `Type` as a hard error and treats a `"provider_state"`
block carrying no data as a hard error too (see Errors). `model.go` itself
does not say which behavior — silent drop or explicit error — is the
intended contract for a block type a given provider doesn't understand (see
Open questions).

### `Provider` / `ProviderData`: an overlay, not a fifth kind

`Provider` and `ProviderData` are not exclusive to `Type: "provider_state"`.
The doc comment frames them as "opaque provider response state that must be
replayed exactly on a later turn" (`meat/model.go:41-46`), and in practice
OpenAI attaches them to `"text"` and `"tool_use"` blocks too, whenever the
underlying Responses API item has a normalized representation
(`meat/openai.go:328-340` — a `"function_call"` item becomes a `"tool_use"`
block carrying both the normalized `ToolName`/`ToolInput` *and*
`Provider`/`ProviderData`; `meat/openai.go:341-359` — a `"message"` item
becomes a `"text"` block the same way). Only item types with no normalized
shape at all — a reasoning item, or an output item type the client doesn't
recognize — become a bare `"provider_state"` block
(`meat/openai.go:326-327,351-352,360-363`).

The presence check used everywhere this matters is a length check, not a
nilness check (`meat/openai.go:261`: `block.Provider == "openai" &&
len(block.ProviderData) > 0`), so a `nil` `ProviderData` and a
present-but-empty one are treated identically as "no opaque state."

When `ProviderData` is non-empty, replay takes priority over everything
else: on the next request its raw bytes are re-emitted unchanged, and the
`Type` switch that would otherwise re-derive a wire item from
`ToolName`/`ToolInput`/`Text` is skipped entirely (`meat/openai.go:260-270`)
— true even for a `tool_use` block that also carries normalized fields (see
`providers.md` G22). Generic, provider-agnostic code (the agent loop in
`meat.go`) never reads or writes `Provider`/`ProviderData` at all — its turn
loop only ever branches on `Type` (`meat/meat.go:165-225`, specifically
`b.Type != "tool_use"` at `:183`) — matching the doc comment's contract:
"generic agent code may inspect the normalized fields above, but must leave
`ProviderData` untouched" (`meat/model.go:43-44`).

### `Tool`

A `Tool` is a name, a description, and a JSON Schema object for its
arguments, carried as opaque bytes rather than a parsed structure
(`InputSchema json.RawMessage`, `meat/model.go:57-61`). Both providers pass
`InputSchema` through unchanged into their own tool-declaration wire shape
(`meat/anthropic.go:247-253`, `meat/openai.go:227-238`) — `model.go` defines
the shape but performs no schema validation itself.

### `Response`

A `Response` is the ordered `Block` list one model call produced, plus that
same call's own input/output token counts (`meat/model.go:63-68`). The
counts are per-call, not cumulative — accumulation across a multi-turn run
happens one layer up (`agent-loop.md`, `meat/meat.go:176-177`), not here.

### `Model`

`Model` has exactly one method: `Generate(ctx, system, messages, tools)
(*Response, error)` (`meat/model.go:77-79`). It is the seam the CLI's two
built-in backends and any external embedder all implement identically. `ctx`
is the uniform cancellation/deadline channel used everywhere in the engine
(H6) — `model.go` declares the parameter but implements no cancellation
logic itself; honoring `ctx` is each implementation's responsibility.

The interface's implicit contract, enforced nowhere in this file but relied
on immediately by its one caller: a `nil` error implies a non-`nil`
`*Response`. `meat.go`'s turn loop checks `err` and, once it's `nil`,
dereferences the response's fields unconditionally in the same turn
(`meat/meat.go:167-177`) — an implementation that returned `(nil, nil)` would
crash its caller rather than being caught.

### `textBlock`

The file's only executable logic: a two-line, unexported constructor for a
text-only `Block` (`meat/model.go:81-82`), used both in production (the
nudge message and the initial user prompt, `meat/meat.go:153,220`) and
throughout the test suite.

## Invariants

- A `Block`'s `Type` is the only field that says which other fields are
  meaningful; every other field is present and zero-valued regardless of
  `Type`. Reading a type-specific field without checking `Type` first
  returns a zero value silently, not an error (`meat/model.go:16-24`).
- `ProviderData`, once attached to a block, must reach the next request
  byte-for-byte unmodified; the one path that reads it
  (`meat/openai.go:260-270`) re-emits it verbatim and never re-serializes it.
  Breaking this — e.g. round-tripping through a decode/re-encode step —
  corrupts encrypted reasoning items the provider then rejects (H4).
- A `tool_use` block's `ID` and its answering `tool_result`'s `ToolUseID`
  must match for the provider to pair them; `model.go` defines both fields
  but the equality is established once, by convention, at
  `meat/meat.go:188-193`, not by any type-level constraint.
- `Message.Content` and `Response.Content` order is significant and always
  caller-preserved; no consumer in the codebase sorts or reorders a
  `Content` slice.
- `Model.Generate` returning a `nil` error commits the implementation to
  returning a non-`nil` `*Response`, since the sole caller dereferences it
  unconditionally (`meat/meat.go:167-177`).

## Hazards

- **H4** (`json.RawMessage` is byte-preserving) applies directly to three
  fields this file defines: `Block.ToolInput` (`meat/model.go:34`),
  `Block.ProviderData` (`meat/model.go:46`), and `Tool.InputSchema`
  (`meat/model.go:60`). The doc comment states the `ProviderData`
  requirement explicitly (`meat/model.go:41-46`); enforcement — validate
  with `json.Valid`, copy with `bytes.Clone`, never decode — lives in the
  provider files, e.g. `meat/openai.go:265-268`.
- **H15** (zero values / nil semantics) applies in three distinct ways here
  — `model.go` has no pointer fields at all except the interface method's
  `*Response` return:
  - A zero-valued `Block` (`Type: ""`) or a `Role` outside the two named
    constants is representable and not rejected by this file; only
    downstream code (a provider's type switch, or nothing at all) decides
    what happens to it.
  - `nil` `Content` (on a `Message` or `Response`) and `nil` `tools` are
    valid, empty-equivalent inputs everywhere they're ranged over
    (`meat/meat.go:182`, `meat/anthropic.go:247-253,255-272`,
    `meat/openai.go:227-238,240-260`) — a `nil` slice is never distinguished
    from an empty one by any reader.
  - `Model.Generate`'s `*Response` return has an implicit
    non-`nil`-on-success contract (see Invariants) that Go's type system
    does not enforce; a TypeScript port using `null` for "no response"
    needs an explicit check in place of what Go's caller implicitly
    assumes.
- **H6** (`context.Context` → `AbortSignal`) — `Model.Generate`'s first
  parameter is `ctx context.Context` (`meat/model.go:78`); this file only
  declares the parameter, it implements no cancellation.
- **H9** (nil vs. empty slice in JSON) does not apply the way it applies to
  the `-json` CLI output: the one place `ProviderData` presence is tested,
  the check is `len(...) > 0`, not nilness (`meat/openai.go:261`), so nil
  and empty are already handled identically. None of this file's types
  (`Block`, `Message`, `Tool`, `Response`) are themselves marshaled to JSON
  anywhere in the engine — only `Result` (`meat/meat.go:94-105`, no slice
  fields) is, via `cmd/meat/cache.go:55,70`.
- **H1/H2/H3** (byte/rune/regex semantics) do not apply — this file contains
  no string indexing, iteration, or pattern matching. Its string-typed
  fields (`Text`, `ToolResult`, etc.) are opaque payloads; byte-safety of
  their *content* is the responsibility of the files that produce or
  consume it (`editplan.go`, `tools.go`, `meat.go`'s prompt building), not
  this one.

## Errors

`model.go` itself defines no error-returning function — `textBlock` cannot
fail, and every type here is a plain data shape. The errors below enforce
this file's contracts but are raised by the provider that owns the wire
translation, not by `model.go`:

- A `"provider_state"` block reaching OpenAI's encoder with no attached
  data: `"openai provider state is missing opaque response data"`
  (`meat/openai.go:307`).
- Corrupt `ProviderData` on replay: `"openai provider state is not valid
  JSON"` (`meat/openai.go:266`).
- Any other `Type` OpenAI's encoder doesn't recognize: `"openai: unsupported
  message block type %q"` (`meat/openai.go:309`).
- Anthropic's encoder and decoder have no equivalent error path for an
  unrecognized `Type` — see Mechanism and Open questions.

## Open questions

- This file has no direct test coverage (no `model_test.go`); every claim
  under Mechanism is read from source and cross-checked against how the
  type is *used* elsewhere, not pinned by a test exercising `model.go` in
  isolation. If stage 3 needs a guarantee-grade pin for one of these
  shapes, it has to come from `providers.md`, `agent-loop.md`, or
  `test-infrastructure.md` instead.
- Anthropic silently drops any `Block`/content `Type` it doesn't recognize
  (both directions — decode `meat/anthropic.go:161-166`, encode
  `meat/anthropic.go:255-272`, neither has a `default` case), while
  OpenAI's encoder raises an explicit error for the same situation
  (`meat/openai.go:308-309`). Nothing in `model.go` or the specs states
  which behavior is the intended contract for a block type a provider
  doesn't understand — e.g. what should happen if an OpenAI-derived
  `"provider_state"` block is replayed into a conversation later sent to
  Anthropic. This asymmetry is real in the current source; whether the port
  should preserve or unify it is unresolved.
- `Role` is unvalidated at the type level. Whether a third role value is
  meant to be structurally impossible (as the two-constant `const` block
  suggests) or merely conventionally avoided is not stated anywhere; no
  code path rejects an arbitrary `Role` value before it reaches a provider.
- Anthropic's decode/encode switches (`meat/anthropic.go:161-166,255-272`)
  have no `default` case, so any `Block.Type` value outside
  `"text"`/`"tool_use"`/`"tool_result"` is a silently-unreachable branch on
  that side — not dead code exactly (every named `Type` is live via
  OpenAI's `"provider_state"` blocks), but worth the same scrutiny as dead
  code when porting `providers.md`'s Anthropic mechanism.
