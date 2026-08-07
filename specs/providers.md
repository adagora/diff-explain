# providers

> Status: stage 1 ✅ | stage 2 🟡 (`provider.go`, `gateway.go` done;
> `anthropic.go`, `openai.go` pending)
> Go sources: `meat/provider.go`, `meat/gateway.go`, `meat/anthropic.go`, `meat/openai.go`
> Go tests: `meat/resolvemodel_test.go` (model-string fallback chain),
> `meat/gateway_test.go` (exe.dev gateway discovery, credential-resolution
> fallback order, backend dispatch), `meat/anthropic_test.go` (Anthropic
> Messages wire translation, retry, truncation), `meat/openai_test.go` (OpenAI
> Responses wire translation, streaming, opaque-state replay)

## Purpose

Turns a model id and the process environment into a live `Model` (the
provider-agnostic interface `meat/model.go:77-79` used everywhere else in the
system) capable of one thing: `Generate(ctx, system, messages, tools)`. This
subject covers everything that happens *before* and *around* that one method
for the two built-in backends — which credentials win, how a diff's plan
protocol translates to and from each provider's own wire format, and how each
provider's transient failures are retried or given up on. It does not cover
what the model is asked to do (that's `rubric.md`, `tools.md`) or how its
answer is turned into a compiled plan (`editplan.md`).

## Vocabulary

Most terms here are provider-wire-format-specific and defined in place below;
the cross-cutting ones are in `glossary.md` under "Providers". In short:

- **Backend dispatch** — the model-id-string rule (`claude-` prefix →
  Anthropic, everything else → OpenAI) that picks which of the two built-in
  `Model` implementations to construct.
- **exe.dev managed gateway** — an operator-hosted reverse proxy that lets a
  process on an exe.dev VM call a real provider with no API key of its own;
  discovered at runtime, used only when no explicit credential is set.
- **Opaque provider state** — output from one provider call (reasoning
  traces, tool-call envelopes) that the generic agent loop must replay
  unchanged on the next call without interpreting; see `glossary.md`.

## Guarantees

### Model resolution & backend dispatch (`provider.go`)

G1. `ResolveModel` applies a three-step fallback with no network or
    credential work: an explicit model argument wins outright; otherwise
    `$MEAT_MODEL` is used if set; otherwise the built-in default
    (`DefaultModel = DefaultOpenAIModel`) applies.
    — `meat/resolvemodel_test.go:9-14` (explicit wins even with `MEAT_MODEL`
    set), `:15-20` (env used when no explicit arg), `:21-26` (default when
    neither is set). Mechanism: `ResolveModel` `meat/provider.go:15-17` →
    `resolveModel(model, fallback)` `meat/provider.go:19-27`.

G2. Backend selection is a pure string-prefix rule applied to the *resolved*
    model id: after stripping an optional leading `anthropic/`, an id
    starting with `claude-` dispatches to the Anthropic backend with that
    exact id threaded through; any other id (including the default) dispatches
    to the OpenAI backend.
    — Anthropic side: `meat/gateway_test.go:183-198`
    (`TestNewModelFromEnv_ClaudeUsesAnthropic`) — explicit model
    `"claude-sonnet-4-6"` with `ANTHROPIC_API_KEY` set yields a concrete
    `*AnthropicModel` whose `Model` field is exactly `"claude-sonnet-4-6"`; no
    exe.dev marker or reflection stub is installed for this test, so dispatch
    itself does not depend on gateway state. OpenAI side (default id, no
    explicit model, no credentials, gateway available): `meat/gateway_test.go:155-181`
    (`TestNewModelFromEnv_DefaultsToOpenAI...`) — yields a concrete
    `*OpenAIModel` with `Model="gpt-5.6-sol"`; credential/gateway mechanics of
    that fixture are the subject of G13 below. Mechanism: `NewModelFromEnv`
    `meat/provider.go:31-37` → `isAnthropicModel` `meat/provider.go:39-42`
    (`strings.TrimPrefix(model, "anthropic/")`, then `strings.HasPrefix(model,
    "claude-")`) → `NewAnthropicFromEnv` (`meat/anthropic.go:48-67`) or
    `NewOpenAIFromEnv` (`meat/openai.go:49-72`).

### exe.dev managed gateway discovery (`gateway.go`)

G3. Given the exe.dev marker file is present and the reflection endpoint
    reports an `"llm"`-type integration with a `name` and no `team` flag,
    discovery returns the bare origin `https://<name>.int.exe.xyz`.
    — `meat/gateway_test.go:39-47`. Fixture: reflection body lists a
    `discord`-type entry first (skipped by the `i.Type != "llm"` guard) then
    an `llm`-type entry named `"llm"` (matched). Mechanism:
    `discoverExeGatewayBase` `meat/gateway.go:28-73`; integration-selection
    loop and host construction `meat/gateway.go:62-70`.

G4. When the exe.dev marker file is absent, discovery returns the empty
    string without attempting any network call at all.
    — `meat/gateway_test.go:49-56`: `exeDevMarkerPath` points at a path in a
    real, empty temp dir that is never written to, and no reflection stub is
    even installed for the test — confirming no request is attempted.
    Mechanism: the `os.Stat` presence check `meat/gateway.go:29-31`
    short-circuits before any HTTP client is constructed.

G5. When the marker is present but no integration in the reflection response
    has type `"llm"`, discovery returns the empty string.
    — `meat/gateway_test.go:58-64` (reflection body has only a `discord`-type
    entry). Mechanism: the selection loop falls through to `return ""`
    `meat/gateway.go:62-72`.

G6. When the matching `"llm"`-type integration has `"team": true`, the
    returned host uses the `.team.exe.xyz` suffix instead of `.int.exe.xyz`
    (still name-prefixed, still `https://`).
    — `meat/gateway_test.go:66-72`: name `"acme"` with `team:true` yields
    `https://acme.team.exe.xyz`. Mechanism: `meat/gateway.go:67-69`.

### Anthropic credential resolution (`anthropic.go`, via `gateway_test.go`)

G7. When `ANTHROPIC_API_KEY` is set, the Anthropic model is built from that
    key directly — empty `BaseURL` (implying the production default
    `api.anthropic.com`), default model — even when the exe.dev marker and a
    matching `"llm"` reflection integration are also present. An explicit key
    always wins over gateway discovery.
    — `meat/gateway_test.go:74-94` (comment at `:77`: "Even on an exe.dev VM
    with an llm integration, an explicit key wins"). Fixture:
    `ANTHROPIC_API_KEY=sk-explicit`, marker present, reflection reports a
    matching `llm` integration; result has `APIKey="sk-explicit"`,
    `BaseURL=""`, `Model=DefaultAnthropicModel` (`"claude-opus-4-8"`,
    `meat/anthropic.go:17`). Mechanism: the `if key != "" || baseURL != ""`
    short-circuit `meat/anthropic.go:51-55` returns before
    `discoverExeGatewayBase` is ever called.

G8. When no explicit Anthropic credential is set but the exe.dev gateway is
    discoverable, the model falls back to it: `APIKey` becomes the fixed
    placeholder `"implicit"`, and `BaseURL` becomes the discovered gateway
    origin with `/anthropic` appended.
    — `meat/gateway_test.go:96-116`. Fixture: all Anthropic env vars blank;
    marker present, reflection reports a matching `llm` integration at
    `https://llm.int.exe.xyz`; result has `APIKey="implicit"`,
    `BaseURL="https://llm.int.exe.xyz/anthropic"`,
    `Model=DefaultAnthropicModel`. Mechanism: the gateway-fallback branch
    `meat/anthropic.go:58-64`; `implicitGatewayKey` constant
    `meat/anthropic.go:36` (value `"implicit"`).

G9. When there is no explicit Anthropic credential and gateway discovery also
    fails (no marker), constructing the Anthropic model returns a non-nil
    error.
    — `meat/gateway_test.go:118-128` (checks only `err != nil`, not the
    message text — see Open questions). Mechanism: the final
    `return nil, fmt.Errorf(...)` `meat/anthropic.go:66`; exact text is
    `"no LLM credentials: set ANTHROPIC_API_KEY, or run on an exe.dev VM with
    an attached 'llm' integration"` (`meat/anthropic.go:66`, confirmed by
    reading the source; not itself asserted by any test).

### Anthropic Messages wire protocol (`anthropic_test.go`)

G10. A full plan-correction exchange round-trips through the real Messages
    wire shape faithfully enough for `Abridge` to reach a valid second-turn
    plan, in exactly two HTTP calls. Concretely, on the outgoing side: the
    `system` field carries the production rubric text (contains `"edit
    plan"`); with no repo root set, exactly two tools are advertised,
    `preview_plan` then `submit`, whose `submit` schema textually contains
    `"fold"` and never `"smart_diff"`; the first user message's first content
    block is text containing the numbered-diff gutter (`"1|diff --git"`). On
    the round-trip side: the scripted server's first reply submits an invalid
    plan (a `replace` targeting a line outside the diff); the resulting
    validation error surfaces as a `tool_result` block with `is_error: true`
    on the *next* request; the corrected second plan is then accepted and
    compiled for real (not scripted), yielding a `SmartDiff` that omits the
    removed text and contains the fold placeholder.
    — `meat/anthropic_test.go:44-116` (`TestAbridge_AnthropicEditPlanEndToEnd`);
    field assertions at `:55-63`; rejected-plan tool_result at `:65-78`;
    final compiled-output checks at `:113-115`; call-count check at
    `:110-112`. Mechanism: system field wiring `meat/anthropic.go:74,123`;
    tool translation `toAntTools` `meat/anthropic.go:247-253,96-99` from
    production tool list `meat/tools.go:84-87,65-81,40-63`; user prompt
    construction is upstream (`meat/meat.go:250-270`, numbered-diff gutter
    `meat/diff.go:126-137`) and just carried through
    `toAntMessages`'s text case `meat/anthropic.go:261-262`; `tool_use`
    decode `meat/anthropic.go:164-166`; `tool_result`/`IsError` encoding
    `meat/anthropic.go:265-266,92-93`; plan rejection text
    `"replace[%d]: line %d is outside the diff (1-%d)"` `meat/editplan.go:288`.

G11. A `429` response followed by a `529` response are both retried with
    exponential backoff, and the call succeeds on the third attempt,
    returning the parsed content and usage from the eventual 200.
    — `meat/anthropic_test.go:120-149` (`TestGenerate_RetriesTransient`).
    Fixture sequence: attempt 1 → HTTP 429 (`rate_limit_error`); attempt 2 →
    HTTP 529 (`overloaded_error`); attempt 3 → HTTP 200, one text block
    `"hi"`, `stop_reason:"end_turn"`, `usage:{input_tokens:10,output_tokens:5}`.
    Assertions: exactly 3 calls; final content is one text block `"hi"`.
    Mechanism: `postJSONWithRetry`'s attempt loop `meat/anthropic.go:193-238`;
    `retryableStatus` treats `429` and any `>= 500` (covering Anthropic's
    non-standard `529`) as retryable `meat/anthropic.go:243-245`; backoff
    doubles `retryBaseDelay` per attempt (`delay := retryBaseDelay <<
    (attempt-1)`, `meat/anthropic.go:198`) — test-shrunk to `time.Millisecond`
    so real sleeps are ~1ms/2ms rather than the production 1s/2s/4s sequence.

G12. A `400` response is never retried: exactly one HTTP call is made and
    `Generate` returns an error immediately.
    — `meat/anthropic_test.go:153-165` (`TestGenerate_NoRetryOnBadRequest`).
    Fixture: single HTTP 400 response (`invalid_request_error`). Assertions:
    error is non-nil; exactly 1 call. Mechanism: `retryableStatus` excludes
    anything under 500 except 408/429 `meat/anthropic.go:243-245`;
    `postJSONWithRetry` returns immediately on a non-retryable status
    `meat/anthropic.go:233-235`. General wire-error format is `"%s API %d:
    %s"` (`meat/anthropic.go:232`), not itself pinned by this test.

G13. Persistent 500s exhaust the fixed retry budget (`maxAttempts = 4`) and
    `Generate` returns an error wrapping the last failure, rather than
    retrying indefinitely.
    — `meat/anthropic_test.go:169-183` (`TestGenerate_GivesUpAfterMaxAttempts`).
    Fixture: every attempt returns HTTP 500 with a plain-text (non-JSON) body
    `boom`. Assertion: exactly `maxAttempts` (4) total calls — 1 initial + 3
    retries. Mechanism: `maxAttempts = 4` `meat/anthropic.go:172` bounds the
    loop `meat/anthropic.go:195`; aggregate error `"after %d attempts: %w"`
    wrapping the last per-attempt error `meat/anthropic.go:237`.

G14. A 200 response whose `stop_reason` is `"max_tokens"` is a hard error,
    not a usable truncated result — a reply cut off mid-tool-call JSON must
    not be silently returned (and potentially cached).
    — `meat/anthropic_test.go:187-195` (`TestGenerate_MaxTokensStopIsAnError`),
    rationale in the comment at `:185-186`. Mechanism: explicit check
    `meat/anthropic.go:152-154`; error text `"anthropic response truncated at
    max_tokens (%d); the diff may be too large to abridge in one pass"` where
    `%d` is `maxOutputTokens` (`16384`, `meat/anthropic.go:31`). This check
    only ever runs on an HTTP 200 — a 200 is never retried regardless of its
    `stop_reason`.

G15. Every request asks for exactly `maxOutputTokens` (16384) as `max_tokens`,
    independent of conversation content.
    — `meat/anthropic_test.go:198-214` (`TestGenerate_SendsMaxOutputTokens`):
    the decoded request's `max_tokens` field equals `16384`. Mechanism:
    `MaxTokens: maxOutputTokens` set unconditionally in `Generate`'s request
    construction `meat/anthropic.go:122`; constant `meat/anthropic.go:31`.

### OpenAI credential resolution (`openai.go`, via `gateway_test.go`)

G16. When `OPENAI_API_KEY` is set, the OpenAI model is built from that key
    directly — empty `BaseURL`, default model, default reasoning effort —
    regardless of gateway availability.
    — `meat/gateway_test.go:130-153`. Fixture: `OPENAI_API_KEY` set; marker
    and a matching `llm` reflection integration are also installed but
    unused. Result: `APIKey="sk-openai-explicit"`, `BaseURL=""`,
    `Model=DefaultOpenAIModel` (`"gpt-5.6-sol"`, `meat/openai.go:17`),
    `ReasoningEffort=DefaultReasoningEffort` (`"medium"`, `meat/openai.go:21`).
    Mechanism: `NewOpenAIFromEnv`'s explicit-credential branch
    `meat/openai.go:52-61`.

G17. With no OpenAI or Anthropic credentials set at all, resolving the
    default model through `NewModelFromEnv` routes the OpenAI backend
    through the exe.dev gateway's `/openai` prefix, using the default model
    id and default reasoning effort.
    — `meat/gateway_test.go:155-181`. Fixture: every credential/model env var
    blank; marker present, reflection reports a matching `llm` integration.
    Result: concrete `*OpenAIModel`, `Model="gpt-5.6-sol"`,
    `BaseURL="https://llm.int.exe.xyz/openai"`,
    `ReasoningEffort="medium"`. Mechanism: `NewOpenAIFromEnv`'s
    gateway-fallback branch `meat/openai.go:63-69`, reached via
    `NewModelFromEnv` → `ResolveModel` → `isAnthropicModel` (false, no
    `claude-` prefix) as in G1-G2.

G18. With no OpenAI credentials and gateway discovery also failing (no
    marker), `NewOpenAIFromEnv` returns a non-nil error.
    — `meat/gateway_test.go:200-210` (checks only `err != nil` — see Open
    questions). Mechanism: `meat/openai.go:71`; exact text is `"no OpenAI
    credentials: set OPENAI_API_KEY, OPENAI_BASE_URL, or run on an exe.dev VM
    with an attached 'llm' integration"` (`meat/openai.go:71`, confirmed by
    reading the source; not itself asserted by any test).

### OpenAI Responses wire protocol (`openai_test.go`)

G19. Every call builds a fixed-shape Responses API request: default model,
    default reasoning effort (when unset), streaming always on, server-side
    storage always off, a fixed output-token cap, and encrypted-reasoning
    inclusion — POSTed to `<base>/v1/responses` with a bearer token whenever a
    key is configured.
    — `meat/openai_test.go:49-84` (every field of the decoded request body is
    asserted inside the httptest handler, on both calls of the end-to-end
    test). Mechanism: `Generate` `meat/openai.go:148-217`; model/effort
    fallback via `cmpOr` to `DefaultOpenAIModel`/`DefaultReasoningEffort`
    (`meat/openai.go:158,162`); `Include`/`Store`/`Stream`/`MaxOutputTokens`
    are hard-coded, not caller-configurable (`meat/openai.go:163-166`), cap
    `maxOpenAIOutputTokens = 32768` (`meat/openai.go:25`); URL built by
    `openAIResponsesURL` (`meat/openai.go:219-225`); auth header set only
    when `APIKey != ""` (`meat/openai.go:178-182`).

G20. Every call declares exactly two function tools, `preview_plan` then
    `submit`, mapped mechanically from meat's tool list (name, description,
    JSON-schema parameters passed through unchanged).
    — `meat/openai_test.go:79-84`. Mechanism: `toOpenAITools`
    `meat/openai.go:227-238`.

G21. A plain text block becomes one `{role, content}` input item; multiple
    consecutive text blocks in one message join with `\n` before flushing.
    — `meat/openai_test.go:86-89` (turn 1's single input item is the numbered
    user prompt). Mechanism: `toOpenAIInput`'s `"text"` case
    (`meat/openai.go:272-274`) plus `flushText` (`meat/openai.go:244-258`).

G22. Reasoning and function-call output items are replayed byte-for-byte
    verbatim on the next request — including fields meat's own encoder never
    emits (e.g. the item's own `"id"`) — and this opaque-replay path takes
    priority over normalized re-encoding for *any* block that carries OpenAI
    provider data, even a `tool_use` block. Only a freshly-constructed block
    with no attached provider data is encoded from its normalized fields.
    — `meat/openai_test.go:90-116`: turn 2's 4 input items are decoded and
    checked one by one — the reasoning item's `type`/`encrypted_content`/`id`
    intact; the function-call item's `type`/`call_id`/`id` intact; the
    function-call-output item freshly built, keyed to `call_1`, carrying the
    tool's real answer text. Mechanism, capture side: `blocksFromOpenAIItem`
    `meat/openai.go:319-365` clones the entire raw output item into
    `ProviderData` (tagged `Provider:"openai"`) for every item type —
    `"reasoning"` (`:326-327`), `"function_call"` (`:328-340`, alongside
    normalized `ID`/`ToolName`/`ToolInput`), and `"message"` (`:341-359`,
    even for an ordinary text result). Replay side: `toOpenAIInput`
    (`meat/openai.go:261-270`) — if a block carries `Provider=="openai"` and
    non-empty `ProviderData`, the original bytes are re-emitted unchanged and
    the type switch (`:272-310`) is skipped entirely, so its own `"tool_use"`
    case (`:275-292`) never fires for an OpenAI-originated tool-call block.
    Only the tool's own result — a fresh `tool_result` block carrying no
    provider data — reaches the switch's `"tool_result"` case (`:293-305`),
    encoding `function_call_output` keyed by `ToolUseID`/`CallID`.

G23. The aggregated response's content is reconstructed exclusively from
    `response.output_item.done` events, ordered by `output_index` — this
    overrides whatever (possibly empty) `output` array shipped on the
    terminal `response.completed`/`response.incomplete`/`response.failed`
    event.
    — `meat/openai_test.go:167-195` (`TestOpenAIGenerate_StreamingText`), and
    reinforced throughout `:45-165`: every fixture's terminal event sets
    `"output": []`, so the only way content reaches any assertion is via
    `output_item.done`. Mechanism: `decodeOpenAIResponse`
    `meat/openai.go:371-456`; SSE-vs-JSON dispatch (`:376-382`); per-event
    handling in `consume()` (`:389-416`): `output_item.done` items collected
    into an `output_index → bytes` map (`:403-406`), terminal events captured
    separately (`:407-411`); after the stream ends, collected indices are
    sorted (`:444-449`) and unconditionally overwrite `final.Output`
    (`:450-453`), discarding the terminal snapshot's own `output` field.

G24. A `"message"` output item becomes one text block whose text is the
    newline-joined `output_text`/`refusal` parts, still tagged with the
    provider and the item's raw bytes.
    — `meat/openai_test.go:170-179` (fixture: one `output_text` part, text
    `"hello"`), `:189-194` (asserts `Type=="text"`, `Text=="hello"`,
    `Provider=="openai"`, `ProviderData` contains `"id":"msg_1"`). Mechanism:
    `blocksFromOpenAIItem`'s `"message"` case `meat/openai.go:341-359`.

G25. A response whose status is `"incomplete"` is surfaced as an error naming
    the truncation reason and the fixed output-token cap — even when the
    entire SSE stream is a single `response.incomplete` event and no
    `response.completed` ever arrives.
    — `meat/openai_test.go:197-217`: stub sends exactly one event,
    `type:"response.incomplete"`, `incomplete_details.reason:
    "max_output_tokens"`, `output: []`; asserts the error contains
    `"max_output_tokens"`. Mechanism: the terminal-event switch treats
    `response.incomplete` the same as `response.completed`/`response.failed`
    (`meat/openai.go:407-411`), satisfying the "must have a final event"
    check (`:441-443`) with no completed event at all; error text `"openai
    response incomplete (%s); max_output_tokens=%d"` `meat/openai.go:199`,
    falling back to `"unknown"` if the reason is absent (`:195-198`).

G26. The Responses API URL is derived from a base by trimming one trailing
    slash, then appending `/responses` if the trimmed base already ends in
    `/v1`, else appending `/v1/responses`.
    — `meat/openai_test.go:219-228` (table: `"https://api.openai.com"` →
    `.../v1/responses`; `"https://proxy.example/v1/"` → `.../v1/responses`,
    no duplicated `/v1`). Mechanism: `openAIResponsesURL`
    `meat/openai.go:219-225`.

G27. Each call's returned token counts come from that same call's
    `usage.input_tokens`/`usage.output_tokens` on the completed event — a
    per-call figure; summing across calls is the caller's job, not
    `Generate`'s.
    — `meat/openai_test.go:162-164`: two calls each reporting 10/5 sum to the
    end-to-end test's asserted totals 20/10. Mechanism:
    `meat/openai.go:205-208` (`out.InputTokens = resp.Usage.InputTokens`,
    etc.), fed by `openAIUsage` (`meat/openai.go:110-113`).

## Mechanism

Covers `provider.go` and `gateway.go`. `anthropic.go` and `openai.go`'s wire
translation and retry mechanism are specified in a later stage 2 batch (see
`specs/INDEX.md`); their Guarantees above already stand on their own.

### Model resolution & backend dispatch (`provider.go`)

`provider.go` makes exactly two decisions, both pure, local, and free of I/O
beyond one environment read: which model id string is used, and which of the
two built-in backends constructs it.

**Fallback chain** (`resolveModel`, `meat/provider.go:19-27`), given a caller
model string and a fallback:
1. If the model string is empty, replace it with `os.Getenv("MEAT_MODEL")`
   (`meat/provider.go:21`) — this read only happens on this branch; a
   non-empty explicit model never triggers an environment lookup at all.
2. If still empty, replace it with the fallback.
3. Return the model string.

`ResolveModel(model)` (`meat/provider.go:15-17`) calls this with
`fallback = DefaultModel` (`= DefaultOpenAIModel`, `meat/provider.go:10`) —
the public three-step chain: explicit → `$MEAT_MODEL` → `DefaultModel`.
`resolveModel` is reused directly by `anthropic.go:49` and `openai.go:50`
with their own backend-specific fallbacks (`DefaultAnthropicModel`,
`DefaultOpenAIModel`), not reimplemented per provider.

**Backend classification** (`isAnthropicModel`, `meat/provider.go:39-42`),
given a model id:
1. Strip one leading occurrence of the literal prefix `"anthropic/"`, if
   present (`strings.TrimPrefix`) — at most once; a doubled prefix strips to
   a single remaining `"anthropic/"`.
2. Return whether the result starts with the literal prefix `"claude-"`.

This operates on a local copy; it cannot and does not mutate the caller's
string (see Invariants).

**Dispatch** (`NewModelFromEnv`, `meat/provider.go:31-37`):
1. Resolve the model id via the fallback chain above → `resolved`.
2. Classify `resolved` via `isAnthropicModel`.
3. If Anthropic, construct via `NewAnthropicFromEnv(ctx, resolved)`.
4. Otherwise, construct via `NewOpenAIFromEnv(ctx, resolved)`.

Both branches pass `resolved` itself — the pre-classification string, not the
prefix-stripped value computed inside step 2 (see Invariants). `ctx` is
accepted and forwarded but never consulted by any logic in this file (H6
belongs to the two constructors, not here).

### exe.dev managed gateway discovery (`gateway.go`)

The file exports one function, `discoverExeGatewayBase(ctx, httpc) string`
(`meat/gateway.go:28-73`), called by both provider constructors as their
last-resort fallback when no explicit credential is configured. Two
package-level `var`s configure it and double as test-injection seams:
`exeDevMarkerPath` (`meat/gateway.go:14`, default `"/exe.dev"`) and
`reflectionIntegrationsURL` (`meat/gateway.go:18`, default
`"https://reflection.int.exe.xyz/integrations"`).

Algorithm, in order — the marker check *must* precede any network attempt,
so that every invocation off exe.dev costs one filesystem stat and nothing
else:

1. Stat the marker path (`meat/gateway.go:29-31`). Any `os.Stat` error at
   all — not only "does not exist," also e.g. permission-denied — aborts
   discovery immediately, returning `""`. The marker's content is never
   read, only its path's existence.
2. If the caller passed a nil `*http.Client`, build a fresh one scoped to
   this call with a 5-second timeout (`meat/gateway.go:32-34`); a
   caller-supplied client keeps its own timeout.
3. Unconditionally derive a child context from the caller's `ctx` with an
   independent 5-second timeout, deferring cancel (`meat/gateway.go:36-37`)
   — applies regardless of which client is in play.
4. Build and execute a GET request against `reflectionIntegrationsURL`,
   bound to that context (`meat/gateway.go:38,42`). Request-construction
   failure, and any transport-level failure (DNS, connection refused, TLS,
   either timeout, caller cancellation), both return `""`
   (`meat/gateway.go:39-44`).
5. Require HTTP status exactly 200; any other status returns `""` with no
   retry (`meat/gateway.go:47-49`).
6. Decode the body as JSON via a streaming `json.Decoder`
   (`meat/gateway.go:51-60`) into a list of integrations, each with a name,
   a type, and an optional team flag. Unknown response fields are ignored;
   an absent field leaves its struct field at Go's zero value. Any decode
   failure returns `""`.
7. Scan the integrations **in server-returned array order**
   (`meat/gateway.go:62`) — not sorted, not deduplicated. Skip any entry
   whose type isn't exactly `"llm"` or whose name is empty. The **first**
   entry passing both checks wins; later matches are never considered
   (`meat/gateway.go:63-71`).
8. Build the host as `<name>.int.exe.xyz`, or `<name>.team.exe.xyz` if that
   entry's `team` field is exactly `true` (`meat/gateway.go:66-69`). Return
   `"https://" + host` — bare origin, no path, no trailing slash.
9. If the scan exhausts the list with no match, return `""`
   (`meat/gateway.go:72`).

**"Available" means** all of: marker stat succeeds, the request completes
with transport success, status is 200, the body decodes into the expected
shape, and at least one integration in server-returned order has
`type=="llm"` and a non-empty name. Every other combination — including
"marker present but everything downstream fails" — is invisible to the
caller as anything but plain "not available." Appending a provider-specific
path segment (`/anthropic`, `/openai`) onto the returned origin is each
provider constructor's own responsibility, not this file's (see G8, G17).

## Invariants

- **`provider.go`: no I/O beyond one env read.** `ResolveModel`/
  `resolveModel` never touch the network or read credentials
  (`meat/provider.go:19-27`) — this is what lets `ResolveModel` be called
  cheaply for cache-key computation (`cmd/meat/main.go:159`) before any
  provider is constructed.
- **`provider.go`: precedence is one-directional.** `$MEAT_MODEL` is
  consulted only when the explicit argument is empty; it can never override
  a non-empty explicit value (`meat/provider.go:20-22`). Reversing the check
  order inverts G1's guaranteed precedence.
- **`provider.go`: the stripped id is classification-only.**
  `isAnthropicModel` reassigns only its own local parameter
  (`meat/provider.go:40`); the string `NewModelFromEnv` threads into the
  constructor (`meat/provider.go:34,36`) is `resolved` from before
  stripping, not the stripped value. So an id of
  `"anthropic/claude-sonnet-4-6"` reaches `NewAnthropicFromEnv` — and
  therefore the wire — with its `"anthropic/"` prefix intact. A port that
  reused one mutated variable for both the classification check and the
  constructor argument would silently produce an unprefixed id where Go
  keeps the prefix. **Untested** — no fixture in `resolvemodel_test.go` or
  `gateway_test.go` supplies a prefixed id (see Open questions).
- **`gateway.go`: the marker check must precede network construction**
  (`meat/gateway.go:29-31` before `:32-70`) — reordering would add a real
  network round-trip (and potential 5s stall) to the common case of running
  off exe.dev.
- **`gateway.go`: every failure path converges on the same signal, `""`**,
  with no side channel distinguishing why (no returned `error`, no
  logging). Both provider constructors rely on treating `""` uniformly as
  "fall through to the next credential source."
- **`gateway.go`: the integration scan is first-match, in server-returned
  order, with no sort and no dedup** (`meat/gateway.go:62-71`). A port that
  scanned last-match, or sorted by name, would silently pick a different
  gateway host than Go does whenever a response carries more than one
  `"llm"`-type entry — untested in Go too (see existing Open questions on
  multiple/empty-name integrations).

## Hazards

- **H1**, `provider.go`: `strings.HasPrefix`/`TrimPrefix`
  (`meat/provider.go:40-41`) compare only ASCII literal prefixes at the
  string's start — a byte-prefix match agrees exactly with a UTF-16
  `.startsWith()` here, regardless of any multi-byte characters later in
  the string. No byte-offset slicing occurs, so H1 does not bite.
- **H6**, `gateway.go`: the context timeout at `meat/gateway.go:36-37` is
  the composing-timeout pattern H6 describes (`AbortSignal.any([parent,
  AbortSignal.timeout(5000)])`), consumed by the request at
  `meat/gateway.go:38,42`. `http.Client{Timeout: 5s}`
  (`meat/gateway.go:33`) is a **second**, client-level timeout independent
  of the context — a port needs both; either alone is not equivalent.
- **H6**, `provider.go`: `NewModelFromEnv` accepts and forwards `ctx` but
  never reads it (`meat/provider.go:31`) — H6 applies only to the two
  constructors it dispatches to, not to this file's own logic.
- **H15**, `gateway.go`: the `Team bool` field's `omitempty`
  (`meat/gateway.go:55`) affects encoding only; on decode, an absent
  `"team"` key leaves the field at Go's zero value `false`, read as falsy
  at `meat/gateway.go:67`. A port whose JSON layer leaves the field
  `undefined` when absent must treat `undefined` identically to `false`.
- Adjacent to H12 (not itself a listed hazard, flagged for awareness):
  unlike `tools.go`'s 1 MiB scanner or `openai.go`'s 16 MiB SSE cap, the
  reflection-response body read (`meat/gateway.go:58`) has **no explicit
  size limit** — bounded only by the 5s timeouts, not by bytes.

## Errors

- `provider.go` defines no error-returning function of its own —
  `ResolveModel`/`resolveModel`/`isAnthropicModel` cannot fail;
  `NewModelFromEnv`'s `(Model, error)` is exactly whatever
  `NewAnthropicFromEnv`/`NewOpenAIFromEnv` returns, unwrapped
  (`meat/provider.go:34,36`) — their error text is `anthropic.go`/
  `openai.go`'s to specify (see G9, G18 above).
- `gateway.go` never returns a Go `error` and never logs. Every failure mode
  — marker stat failure, request-construction failure, transport failure,
  non-200 status, JSON-decode failure, no matching integration — collapses
  to the same empty-string signal (`meat/gateway.go:29-31,39-49,58-60,72`).
  There is no exact message text to cite; "fall back silently" is the
  deliberate contract, in contrast to the two provider constructors' own
  credential-resolution errors, which do have exact wire text (G9, G18).

## Constants

New rows for `constants.md` (not duplicated here — see that file for the full
table):

- Gateway HTTP client timeout — `5s` — `meat/gateway.go:33`.
- Gateway discovery context timeout — `5s` — `meat/gateway.go:36`.
- `DefaultModel` (= `DefaultOpenAIModel`) — `meat/provider.go:10`.
- `DefaultAnthropicModel` — `"claude-opus-4-8"` — `meat/anthropic.go:17`.
- `maxOutputTokens` (Anthropic) — `16384` tokens — `meat/anthropic.go:31`.
- `maxAttempts` (shared retry loop) — `4` — `meat/anthropic.go:172`.
- `retryBaseDelay` (`var`, default `1s`, doubled per attempt) —
  `meat/anthropic.go:176`.
- `DefaultOpenAIModel` — `"gpt-5.6-sol"` — `meat/openai.go:17`.
- `DefaultReasoningEffort` — `"medium"` — `meat/openai.go:21`.
- `maxOpenAIOutputTokens` — `32768` tokens — `meat/openai.go:25`.

## Open questions

- **Error message text unpinned in two places**: the "no credentials" errors
  for both Anthropic (`meat/anthropic.go:66`) and OpenAI (`meat/openai.go:71`)
  are only checked for non-nilness by their respective tests
  (`meat/gateway_test.go:118-128,200-210`), never for exact text. Recorded
  above from reading the source directly, but not test-pinned.
- **Timeout/deadline paths in gateway discovery are untested**: no test sends
  a slow/hanging reflection server or an already-expired context; the two
  5-second timeouts (`meat/gateway.go:33,36`) exist but are never triggered.
- **Non-200, malformed-JSON, and transport-failure reflection responses are
  untested**: `withReflection`'s stub always answers `200 OK` with valid JSON;
  the `StatusCode != 200` branch, the decode-failure branch, and a
  `httpc.Do` transport error are all present in `gateway.go` but unexercised.
- **Multiple/empty-name `"llm"` integrations untested**: the selection loop
  returns on the first match; no fixture has two-or-more `type:"llm"` entries
  (to confirm first-wins ordering) or an entry with an empty `name` (which
  should be skipped).
- **Caller-supplied `*http.Client` untested**: every gateway-discovery call in
  `gateway_test.go` passes `nil`; the branch where a non-nil client is
  supplied is unexercised there.
- **`BaseURL`-only credential trigger untested in isolation**: both
  providers' explicit-credential gate is `key != "" || baseURL != ""`; every
  "prefers explicit" test sets the *key*, none sets only the base URL with an
  empty key.
- **Team-gateway path not verified end-to-end through a provider
  constructor**: G6 confirms team-suffix host construction only via the bare
  `discoverExeGatewayBase` call; no test confirms either provider constructor
  correctly appends its path segment onto a *team* gateway base.
- **Anthropic: request headers unverified** — `x-api-key`,
  `anthropic-version: 2023-06-01`, `content-type` (`meat/anthropic.go:184-187,210`)
  are set on every request but no test inspects `r.Header`.
- **Anthropic: several defaulting/error branches untested** — empty-`APIKey`
  guard, `Model`/`BaseURL` defaulting and trailing-slash trim, default
  `HTTPC` timeout, malformed-200-body decode failure, a 200 response with a
  top-level `error` object, transport-level `client.Do` errors, and
  mid-flight context cancellation during backoff or the request itself —
  none of these are constructed by any fixture in `anthropic_test.go`.
- **Anthropic: multi-block and non-text/tool_use content blocks untested** —
  every fixture returns exactly one content block per response; a block of
  an unrecognized type is silently dropped by the decode loop
  (`meat/anthropic.go:160-167`), untested; likewise a successful (non-error)
  `tool_result` (every fixture's `tool_result` has `IsError: true`), and
  exact wire fidelity of a replayed prior assistant `tool_use` block's
  `id`/`name`/`input` fields (only the end-to-end outcome is checked, not
  that specific message's fields).
- **OpenAI: several decode/error branches untested** — a plain (non-SSE)
  JSON response body, the SSE `error` event type, a decoded response with a
  top-level `error` object, a status value other than `""`/`"completed"`/
  `"incomplete"`, the missing-credentials guard, default `HTTPC` construction,
  non-default `Model`/`ReasoningEffort` overrides, the manual `tool_use`
  re-encoding branch in `toOpenAIInput` (never reached because every
  OpenAI-sourced `tool_use` block already carries provider data and takes the
  verbatim-replay path — see G22), empty-arguments/`ToolInput` fallbacks to
  `"{}"`, all three `toOpenAIInput` error branches (invalid-JSON provider
  state, missing opaque data, unsupported block type), the `"refusal"`
  content part and zero-parts fallback in `blocksFromOpenAIItem`, its
  `default:` case for an unfamiliar output-item type, the SSE scanner's
  64KB/16MB line-buffer sizing, and the `data: [DONE]` sentinel line real
  OpenAI streams send (no fixture constructs it).
- **OpenAI: absent-Authorization-header behavior is only incidentally true**
  — two tests construct `OpenAIModel` with no `APIKey`, which by construction
  skips setting the header, but neither test's stub inspects `r.Header`, so
  "no key ⇒ no Authorization header sent" is never directly asserted.
- **G4's mechanism is broader than its fixture**: the marker check
  (`meat/gateway.go:29-31`) short-circuits on *any* `os.Stat` error, not only
  "file does not exist" — e.g. a permission-denied marker path behaves
  identically to an absent one. `gateway_test.go:49-56` only exercises the
  absent case; the broader "any stat error" claim is a stage 2 mechanism
  reading, not itself test-pinned.
- **G2's "exact id threaded through" is more specific than it reads**: the id
  passed to `NewAnthropicFromEnv`/`NewOpenAIFromEnv` is the *pre-classification*
  resolved id, not the `anthropic/`-prefix-stripped value `isAnthropicModel`
  computes internally for its own check. An id of
  `"anthropic/claude-sonnet-4-6"` therefore reaches the Anthropic wire with
  its `anthropic/` prefix intact — untested by any fixture in
  `resolvemodel_test.go` or `gateway_test.go`.
- **`gateway.go`'s reflection-response body read has no explicit size
  cap** (`meat/gateway.go:58`), unlike `tools.go`'s 1 MiB scanner or
  `openai.go`'s 16 MiB SSE cap — bounded only by the 5s timeouts, not bytes.
  Not itself a bug, but an asymmetry with the rest of the codebase's
  stream-reading convention; untested either way.
