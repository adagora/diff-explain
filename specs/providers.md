# providers

> Status: stage 1 ✅ | stage 2 ✅
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

Covers `provider.go`, `gateway.go`, `anthropic.go`, and `openai.go` — all
four Go sources for this subject.

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

### Anthropic Messages wire translation and retry (`anthropic.go`)

`anthropic.go` is responsible for two things `provider.go`/`gateway.go` do
not cover: (1) turning environment state into a live `*AnthropicModel`, and
(2) implementing `Model.Generate` for it — translating meat's generic
`Message`/`Block`/`Tool` vocabulary to and from Anthropic's Messages API
JSON shape, over HTTP, with retry. `AnthropicModel` is also a plain exported
struct (`meat/anthropic.go:21-26`) that an embedder may construct directly,
bypassing `NewAnthropicFromEnv` entirely — every field defaulting therefore
has to happen lazily, inside `Generate`, not only in the constructor (see
Invariants).

#### Credential resolution (`NewAnthropicFromEnv`, `meat/anthropic.go:48-67`)

Already guaranteed by G7-G9; the algorithm, with two nuances those
guarantees don't state:

1. Resolve the model id via the shared three-step chain
   (`resolveModel(model, DefaultAnthropicModel)`, `meat/anthropic.go:49`) —
   see `provider.go`'s mechanism above.
2. Read `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`
   (`meat/anthropic.go:51-52`).
3. If either is non-empty, return immediately with `APIKey=key,
   Model=model, BaseURL=baseURL` (`meat/anthropic.go:53-55`) — **`HTTPC`
   is left at its zero value (`nil`) on this path**, not defaulted here;
   the 2-minute default client is constructed later, per call, inside
   `Generate` (`meat/anthropic.go:133-136`), not once in the constructor.
4. Otherwise call `discoverExeGatewayBase(ctx, nil)`
   (`meat/anthropic.go:58`); on a non-empty result, return
   `APIKey=implicitGatewayKey ("implicit")`, `Model=model`,
   `BaseURL=base+"/anthropic"` (`meat/anthropic.go:59-64`) — again
   `HTTPC` stays `nil`.
5. Otherwise return `nil, fmt.Errorf("no LLM credentials: set
   ANTHROPIC_API_KEY, or run on an exe.dev VM with an attached 'llm'
   integration")` (`meat/anthropic.go:66`).

Because `Generate` re-defaults `Model` unconditionally via
`cmpOr(m.Model, DefaultAnthropicModel)` (`meat/anthropic.go:121`), the
constructor's `model` resolution and `Generate`'s per-call defaulting are
two independent, redundant applications of the same fallback value — a
port must keep both, not just the constructor's, since a direct-construction
caller skips the constructor's version entirely.

#### Request construction and URL building (`Generate`, `meat/anthropic.go:115-136`)

1. Reject an empty `APIKey` immediately: `fmt.Errorf("meat:
   AnthropicModel.APIKey is empty")` (`meat/anthropic.go:116-118`). This
   checks only for the empty string — the gateway's placeholder
   `"implicit"` passes trivially, by design.
2. Build the request body (`meat/anthropic.go:120-126`): `Model` =
   `cmpOr(m.Model, DefaultAnthropicModel)`; `MaxTokens` = the fixed
   constant `maxOutputTokens` (16384) unconditionally, independent of
   conversation size (`meat/anthropic.go:122,31` — G15); `System` = the
   `system` argument verbatim, as a plain string field, not a message;
   `Messages` = `toAntMessages(messages)`; `Tools` = `toAntTools(tools)`.
3. `json.Marshal` the body; on failure, return the raw marshal error
   unwrapped, with no added text (`meat/anthropic.go:127-130`).
4. Build the URL: `strings.TrimRight(cmpOr(m.BaseURL,
   "https://api.anthropic.com"), "/") + "/v1/messages"`
   (`meat/anthropic.go:132`). `TrimRight` strips **every** trailing `/`,
   not just one. This builder is unconditional — it always appends the
   literal suffix `/v1/messages`, with no check for whether the base
   already ends in `/v1` (contrast OpenAI's `openAIResponsesURL`, G26,
   which conditionally avoids doubling `/v1`). A port must not share one
   URL-building helper between the two providers; the two algorithms
   genuinely differ.
5. Pick the client: `m.HTTPC` if non-nil, else a fresh `&http.Client{Timeout:
   2 * time.Minute}` constructed on this call (`meat/anthropic.go:133-136`)
   — this is a **client-level** wall-clock cap on the whole round trip
   (connect + read body), independent of `ctx`'s own deadline; see
   Hazards (H6).

#### The retry loop (`postWithRetry` → `postJSONWithRetry`, `meat/anthropic.go:178-245`)

`postWithRetry` (`meat/anthropic.go:183-188`) is a thin wrapper fixing
`provider="anthropic"` and a header-setter that sets `x-api-key` and
`anthropic-version: 2023-06-01`; `content-type: application/json` is set
unconditionally by the shared function itself (`meat/anthropic.go:210`),
not by this wrapper. No other header (`Accept`, `User-Agent`) is ever set.

`postJSONWithRetry(ctx, client, url, body, provider, setHeaders)`
(`meat/anthropic.go:193-238`), for `attempt` = 0..3 (`maxAttempts = 4`,
`meat/anthropic.go:172,195`):

1. **Backoff** (skipped on `attempt == 0`): `delay := retryBaseDelay <<
   (attempt-1)` — with the default `retryBaseDelay = 1s` this yields
   waits of 1s, 2s, 4s before attempts 2, 3, 4 respectively
   (`meat/anthropic.go:196-198`). The wait itself races `ctx.Done()`
   against `time.After(delay)` (`meat/anthropic.go:199-203`); if the
   context finishes first, return `nil, ctx.Err()` immediately,
   abandoning the whole retry loop (bare context error text, e.g. Go's
   `"context canceled"`/`"context deadline exceeded"` — never wrapped).
2. **Build the request** fresh every attempt via
   `http.NewRequestWithContext(ctx, POST, url, bytes.NewReader(body))`
   (`meat/anthropic.go:206`) — a new body reader each time, since the
   previous attempt consumed it. Construction failure returns `nil, err`
   immediately, unwrapped (`meat/anthropic.go:207-209`); this can only
   realistically fire on the first attempt since `url`/`body` never
   change between attempts.
3. Set `content-type` (`meat/anthropic.go:210`), then call
   `setHeaders(req)` if non-nil (`meat/anthropic.go:211-213`).
4. **Execute** `client.Do(req)` (`meat/anthropic.go:215`). On error:
   check `ctx.Err()` *first* — if the context is done, return `nil,
   ctx.Err()` directly, bypassing retry (`meat/anthropic.go:217-219`);
   this takes priority over treating the failure as generic transport
   noise, and it inspects the context object directly rather than
   unwrapping/pattern-matching the error `Do()` returned (H5). Otherwise,
   record the error as `lastErr` and `continue` to the next attempt —
   **every** transport-level failure (DNS, connection refused, TLS,
   non-context timeout) is retried up to the attempt budget,
   unconditionally (`meat/anthropic.go:220-221`).
5. **Read the body** via `io.ReadAll`, then close it
   (`meat/anthropic.go:223-224`) — no explicit size cap (contrast
   `openai.go`'s bounded SSE scanner; see Hazards). A read failure is
   recorded as `lastErr` and retried exactly like a transport error,
   **without ever inspecting the HTTP status that came with that
   response** (`meat/anthropic.go:225-228`).
6. **Status 200** returns the raw bytes immediately — success
   (`meat/anthropic.go:229-231`). No other status is ever treated as
   success (e.g. 201/204 would fall through to the error path below).
7. Otherwise build `lastErr = fmt.Errorf("%s API %d: %s", provider,
   httpResp.StatusCode, strings.TrimSpace(string(raw)))` — the message
   embeds the entire trimmed response body, whatever shape it is
   (`meat/anthropic.go:232`). If `!retryableStatus(httpResp.StatusCode)`,
   return `nil, lastErr` **immediately, on any attempt including the
   last** (`meat/anthropic.go:233-235`) — bare message, no `"after N
   attempts"` wrapper.
8. If the loop runs out of attempts without an early return, return
   `fmt.Errorf("after %d attempts: %w", maxAttempts, lastErr)`
   (`meat/anthropic.go:237`), wrapping whichever `lastErr` was last
   recorded (a per-attempt HTTP-status error from step 7, or a
   transport/read error from steps 4-5 — never a context error, since
   those always return early and are never stored into `lastErr`).

`retryableStatus(code)` = `code == 408 || code == 429 || code >= 500`
(`meat/anthropic.go:243-245`) — no upper bound, so any non-standard 5xx
(Anthropic's `529`) is retryable. Everything else (4xx other than
408/429, and any theoretical <400) is not.

**A precise, untested boundary**: the `"after N attempts: …"` wrapped
message appears *only* when the final (4th) attempt's own failure was
itself of a retryable kind (transport/read error, or a retryable status).
If the 4th attempt instead returns a non-retryable status (e.g., a
500,500,500,400 sequence), step 7's immediate return still fires on that
last attempt, and the caller sees the bare `"anthropic API 400: …"`
message, not the wrapped one — even though three prior attempts happened.
No fixture in `anthropic_test.go` exercises a mixed
retryable/non-retryable sequence, so this exact interaction is
source-derived, not test-pinned.

#### Response decoding and decision boundaries (`Generate`, `meat/anthropic.go:142-168`)

1. `json.Unmarshal(raw, &resp)`; failure → `fmt.Errorf("decode response:
   %w", err)` (`meat/anthropic.go:142-145`) — wrapped, so
   `errors.Is`/`errors.As` can reach the underlying JSON error.
2. If `resp.Error != nil` (a top-level API error object present
   **despite HTTP 200** — the retry loop never looks inside the body of
   a 200), return `fmt.Errorf("anthropic error: %s: %s", resp.Error.Type,
   resp.Error.Message)` (`meat/anthropic.go:146-148`) — plain text,
   **not** wrapped with `%w`; this is a terminal, un-retried failure even
   though the transport layer saw success.
3. **`stop_reason` is interpreted for exactly one literal value.** If
   `resp.StopReason == "max_tokens"`, return `fmt.Errorf("anthropic
   response truncated at max_tokens (%d); the diff may be too large to
   abridge in one pass", maxOutputTokens)` (`meat/anthropic.go:152-154`,
   `%d` = 16384) — the rationale, per the comment immediately above
   (`meat/anthropic.go:149-151`), is that a `max_tokens` cutoff likely
   lands mid-`tool_use`-JSON and using it would silently produce (and
   risk caching) a truncated plan. **Every other `stop_reason` value —
   `"end_turn"`, `"tool_use"`, `"stop_sequence"`, or anything else — is
   decoded and then discarded.** `Response` (`meat/model.go:64-68`) has
   no field for it at all; a port cannot recover which stop reason ended
   a successful turn from `Generate`'s return value, only whether it was
   the one fatal value.
4. Build `out := &Response{InputTokens: resp.Usage.InputTokens,
   OutputTokens: resp.Usage.OutputTokens}` (`meat/anthropic.go:156-159`)
   — per-call figures only, no cross-call accumulation (mirrors the
   OpenAI side's G27).
5. Walk `resp.Content` **in array order** and translate each block
   (`meat/anthropic.go:160-167`): `"text"` → `Block{Type:"text", Text:
   b.Text}`; `"tool_use"` → `Block{Type:"tool_use", ID: b.ID, ToolName:
   b.Name, ToolInput: b.Input}` (raw JSON bytes preserved verbatim, see
   Hazards/H4 below). **Any other block type is silently dropped** — no
   error, no fallback, the switch has no `default`. Output order matches
   input order exactly (no map, no sort — see Ordering, below).
6. Return `out, nil` (`meat/anthropic.go:168`). Note: a `resp.Content`
   that is present but empty (valid 200, `stop_reason` not
   `"max_tokens"`, no top-level `Error`) is not itself an error condition
   — `Generate` returns a `Response` with `Content: nil` and whatever
   usage counts came back. Untested; not guarded against.

**"Error vs. success" summary, as a decision table**: an HTTP
transport/status failure is an error unless status is exactly 200
(retried per `retryableStatus` until then or attempts exhaust). A 200 is
*then* an error if `resp.Error != nil`, *or* if `resp.StopReason ==
"max_tokens"`, *or* if the body fails to decode as JSON at all. A 200
that clears all three checks is success, regardless of how many
(including zero) content blocks it carries or what its `stop_reason`
actually is.

#### Message and tool translation to wire shape (`toAntMessages`, `toAntTools`, `meat/anthropic.go:247-272`)

`toAntTools(tools)` (`meat/anthropic.go:247-253`): builds a fresh,
always-non-nil slice (`make(..., 0, len(tools))`) and copies `Name`,
`Description`, `InputSchema` through unchanged, one `antTool` per input
`Tool`, same order.

`toAntMessages(messages)` (`meat/anthropic.go:255-272`), for each
`Message` in order:
1. `am := antMessage{Role: string(m.Role)}` — `Role` is a defined string
   type (`"user"`/`"assistant"`), stringified directly, no validation
   (`meat/anthropic.go:258`).
2. For each `Block` in `m.Content`, in order, translate by `Type`:
   - `"text"` → `antBlock{Type:"text", Text: b.Text}`
     (`meat/anthropic.go:261-262`).
   - `"tool_use"` → `antBlock{Type:"tool_use", ID: b.ID, Name:
     b.ToolName, Input: b.ToolInput}` — `Input` carries `b.ToolInput`'s
     raw JSON bytes through unparsed (`meat/anthropic.go:263-264`).
   - `"tool_result"` → `antBlock{Type:"tool_result", ToolUseID:
     b.ToolUseID, Content: b.ToolResult, IsError: b.ToolError}`
     (`meat/anthropic.go:265-266`).
   - **Any other `Type`** — including `"provider_state"` (the generic
     opaque-state block kind, `meat/model.go:21,41-47`), an empty/unset
     `Type`, or a typo — matches no case; the switch has **no
     `default`**; nothing is appended for that block
     (`meat/anthropic.go:260-267`).
3. `am` is appended to `out` regardless — **even if every block in that
   message was of an unrecognized type**, so `am.Content` is left at its
   Go zero value, `nil` (`meat/anthropic.go:258-259,269`).

`antMessage.Content`'s JSON tag carries **no `omitempty`**
(`meat/anthropic.go:81`), unlike almost every other field in this file's
wire structs. A `nil` slice marshals to JSON `null`, not `[]`. So a
message whose content is entirely unrecognized block types (or genuinely
empty to start with) serializes onto the wire as `{"role": "...",
"content": null}` — a shape the real Anthropic API almost certainly
rejects, since it expects an array. This is reachable purely by
construction (a caller-assembled `Message` with a `"provider_state"` or
empty-`Type` block, e.g. history reused across a provider swap) and is
exercised by no fixture in `anthropic_test.go`.

`cmpOr(a, b)` (`meat/anthropic.go:274-279`) is the shared "use `a` unless
empty" helper backing every default in this file (`Model`, `BaseURL`).

#### Data shapes (by meaning, not Go syntax)

- **Request** — one object per call: model id, a fixed output-token
  ceiling, the system prompt as a bare string (not a message), an
  ordered list of conversation messages, and an ordered list of tool
  declarations (the tools key is entirely absent from the wire when
  there are none — see Hazards, H9).
- **Message (wire)** — a role tag plus an ordered list of content
  blocks; can legally end up with an empty or `null` block list (see
  above).
- **Content block (wire, outgoing)** — a `type`-tagged union: text (a
  string); tool-use (an id, a tool name, and an arguments value carried
  as opaque unreparsed JSON); tool-result (the id of the tool-use it
  answers, a plain-string result body, and an error flag present on the
  wire *only when true* — a non-error result omits the key entirely
  rather than sending `false`).
- **Tool declaration** — name, human description, and a JSON Schema
  object for arguments, passed through unparsed.
- **Response (wire)** — an ordered list of content blocks (the assistant
  side of the API only ever emits `"text"` and `"tool_use"` kinds —
  `"tool_result"` is input-only, from the user turn, and Anthropic never
  echoes it back), a stop-reason string, per-call input/output token
  counts, and an optional top-level error object that can coexist with
  HTTP 200.
- **Generic `Response`** — an ordered list of generic blocks (only
  `"text"`/`"tool_use"` ever appear post-translation) and the two token
  counts from that one call; no stop-reason is carried through at all.

### OpenAI Responses wire protocol and streaming (`meat/openai.go`)

`openai.go` builds an `OpenAIModel` (`meat/openai.go:30-36`, fields
`APIKey`, `Model`, `BaseURL`, `ReasoningEffort`, `HTTPC`) implementing the
single-method `Model` interface (`meat/model.go:77-79`). Its job has four
parts: resolve credentials from the environment; translate the generic
`Message`/`Block`/`Tool` shapes into one Responses API request body; POST
it (via the shared retry helper defined in `anthropic.go`, above) and
consume the reply, which may be plain JSON or an SSE stream; and translate
the reply's output items back into generic `Block`s, preserving
provider-specific state opaquely wherever the wire item cannot be
losslessly normalized.

#### Credential resolution (`NewOpenAIFromEnv`, `meat/openai.go:49-72`)

1. Resolve the model id via the shared three-step fallback chain already
   described under `provider.go`'s Mechanism (explicit → `$MEAT_MODEL` →
   `DefaultOpenAIModel`): `resolveModel(model, DefaultOpenAIModel)`
   (`meat/openai.go:50`).
2. Read `OPENAI_API_KEY` and `OPENAI_BASE_URL` from the environment
   (`meat/openai.go:52-53`).
3. If either is non-empty, return an `OpenAIModel` built directly from
   them — `APIKey`/`BaseURL` set to whatever was read (one may be empty),
   `Model` the resolved id, `ReasoningEffort` the fixed default
   `"medium"` — without ever attempting gateway discovery
   (`meat/openai.go:54-61`).
4. Otherwise call `discoverExeGatewayBase(ctx, nil)`
   (`meat/openai.go:63`); passing a `nil` client means gateway discovery
   builds its own request-scoped client per that file's own mechanism
   (already specified above under `gateway.go`).
5. If discovery returns a non-empty base, return an `OpenAIModel` with
   `BaseURL = base + "/openai"`, `Model` the resolved id,
   `ReasoningEffort` the default — **and `APIKey` left at Go's zero
   value, the empty string** (`meat/openai.go:64-68`). No field is set to
   any placeholder value.
6. Otherwise return the error `"no OpenAI credentials: set
   OPENAI_API_KEY, OPENAI_BASE_URL, or run on an exe.dev VM with an
   attached 'llm' integration"` (`meat/openai.go:71`).

**Notable asymmetry with Anthropic's gateway fallback (G8):** Anthropic's
gateway branch sets `APIKey` to the fixed placeholder `"implicit"`
(`meat/anthropic.go:36,58-64`) so the edge gateway has something to
substitute. OpenAI's gateway branch sends **no placeholder at all** —
`APIKey` stays `""`. Since `Generate` only sets the `authorization`
header `if m.APIKey != ""` (`meat/openai.go:179-181`), a gateway-routed
OpenAI request carries **no `Authorization` header whatsoever**; the doc
comment confirms this is deliberate ("optional for an exe.dev integration
or a keyless custom base URL", `meat/openai.go:31`). A port must not
invent a placeholder key for this path — the absence of the header is
the actual contract.

#### Request construction (`Generate`, `meat/openai.go:148-217`)

1. Guard: if both `APIKey` and `BaseURL` are empty, fail immediately with
   `"meat: OpenAIModel needs APIKey or BaseURL"` (`meat/openai.go:149-151`).
   This duplicates `NewOpenAIFromEnv`'s own guarantee defensively — it
   only fires for a hand-constructed `OpenAIModel{}` that bypassed the
   constructor (e.g. direct embedder use), never for anything
   `NewOpenAIFromEnv` itself produces.
2. Translate `messages` via `toOpenAIInput` (below); propagate any error
   unchanged (`meat/openai.go:153-156`).
3. Build the request body with these fixed characteristics
   (`meat/openai.go:157-167`):
   - `model`: resolved via `cmpOr(m.Model, DefaultOpenAIModel)` — first
     non-empty of the two.
   - `instructions`: the `system` argument verbatim; omitted entirely
     from the wire body when empty (`omitempty` on this field only).
   - `input`: the translated item array (see below).
   - `tools`: from `toOpenAITools` (below).
   - `reasoning.effort`: `cmpOr(m.ReasoningEffort, DefaultReasoningEffort)`.
   - `include`: always the fixed one-element list
     `["reasoning.encrypted_content"]` — no `omitempty`, always present.
   - `store`: always `false`.
   - `stream`: always `true`.
   - `max_output_tokens`: always the fixed constant `32768`
     (`maxOpenAIOutputTokens`, `meat/openai.go:25`).
   None of `include`/`store`/`stream`/`max_output_tokens` are
   caller-configurable — there is no field on `OpenAIModel` for any of
   them.
4. `json.Marshal` the body (`meat/openai.go:168-171`). This is an
   ordinary marshal — Go's default HTML-escaping is **not** disabled
   here (contrast `render.go`'s `SetEscapeHTML(false)`, per H4). This is
   harmless for this file specifically: the only fields requiring
   byte-exact preservation are the `json.RawMessage`-typed ones (see the
   opaque-replay case below and `Tool.InputSchema`/`openAITool.Parameters`),
   and those are spliced in as pre-existing bytes, not passed through
   this marshal call's string-escaping logic at all — HTML-escaping only
   touches ordinary Go `string` fields (`model`, `instructions`,
   plain-text `content`, tool `name`/`description`), which OpenAI's JSON
   parser reads identically whether `<` arrives literal or as `<`.
5. Build the URL via `openAIResponsesURL` (below) from
   `cmpOr(m.BaseURL, "https://api.openai.com")` (`meat/openai.go:173`).
6. Select the HTTP client: `m.HTTPC` if set, else a fresh
   `&http.Client{Timeout: 5 * time.Minute}` (`meat/openai.go:174-177`) —
   a **five-minute** default, distinct from `gateway.go`'s 5-second
   discovery timeout, sized for a full streaming reasoning-model turn.
7. POST via the shared retry helper `postJSONWithRetry(ctx, client, url,
   body, "openai", setHeaders)` (`meat/openai.go:178-182`), where
   `setHeaders` sets `authorization: Bearer <APIKey>` only when
   `APIKey != ""` (`meat/openai.go:179-181`). This function is defined
   once in `anthropic.go:193-238` and shared by both providers — its
   retry/backoff/status-classification algorithm is specified above
   under the `anthropic.go` mechanism (G11-G13), but two things matter
   specifically for this file: (a) it fully drains the HTTP response
   body via `io.ReadAll` before returning (`meat/anthropic.go:223`)
   **regardless of `stream:true`** — so despite the wire-level SSE
   framing, `Generate` is not itself an incremental/streaming API at the
   application layer: it blocks until the entire SSE stream has arrived,
   then parses the buffered bytes as a whole (`meat/openai.go:27-29` doc
   comment: "It uses streaming responses because ChatGPT-backed exe.dev
   integrations require streaming, but Generate still returns one
   complete provider-agnostic reply"); (b) a context cancellation that
   lands *during* that body read is not distinguished from an ordinary
   read error at that call site (`meat/anthropic.go:223-228` has no
   `ctx.Err()` check, unlike the transport-error branch at `:216-219`
   which does) — it becomes a retryable `lastErr` and is only actually
   caught on the *next* attempt's backoff `select`
   (`meat/anthropic.go:199-203`), or, if no attempts remain, surfaces
   wrapped as `"after %d attempts: %w"` rather than as a bare context
   error. A port's AbortSignal wiring for the OpenAI streaming path
   should account for this: cancelling mid-stream-read does not
   necessarily short-circuit as cleanly as cancelling before the request
   starts.
8. Decode the raw response bytes via `decodeOpenAIResponse` (below);
   propagate decode errors unchanged (`meat/openai.go:187-190`).
9. Error-priority ladder, in this exact order (`meat/openai.go:191-203`):
   a. If the decoded response carries a non-nil top-level `error`
      object, fail with `"openai error: %s: %s"` where the first `%s` is
      `cmpOr(resp.Error.Code, resp.Error.Type)` (code preferred over
      type) and the second is the message (`meat/openai.go:191-193`).
   b. Else if `status == "incomplete"`, fail with `"openai response
      incomplete (%s); max_output_tokens=%d"`, where the reason is
      `resp.IncompleteDetails.Reason` if present and non-empty, else the
      literal string `"unknown"`, and the integer is the fixed constant
      `32768` (`meat/openai.go:194-200`).
   c. Else if `status` is non-empty and not `"completed"` (covers e.g.
      `"failed"`, `"cancelled"`, `"queued"`, or any other value a
      gateway might emit), fail with `"openai response ended with status
      %q"` (`meat/openai.go:201-203`).
   d. An **empty** status string is *not* an error — it is treated as
      success (relevant for minimal/compatible-gateway replies that omit
      the field entirely).
10. Build the `Response`: `InputTokens`/`OutputTokens` copied straight
    from `resp.Usage` (`meat/openai.go:205-208`) — purely per-call
    figures; no accumulation across calls happens in this file.
11. Decode every element of `resp.Output` via `blocksFromOpenAIItem`
    (below), in array order, appending each item's block(s) to
    `out.Content` (`meat/openai.go:209-215`). **The first decode failure
    aborts the whole call** — `Generate` returns `nil, err` immediately,
    discarding any blocks already decoded from earlier items in the same
    response (`meat/openai.go:210-213`); there is no partial-success
    return.

#### URL construction (`openAIResponsesURL`, `meat/openai.go:219-225`)

1. Trim **every** trailing `/` character from the base
   (`strings.TrimRight(base, "/")` — this removes all trailing slashes,
   not just one; see Open questions).
2. If the trimmed base ends in the literal suffix `/v1`, return
   `base + "/responses"`.
3. Otherwise return `base + "/v1/responses"`.

#### Tool translation (`toOpenAITools`, `meat/openai.go:227-238`)

For each generic `Tool`, emit `{type: "function", name, description,
parameters}` where `parameters` is the tool's `InputSchema` embedded
**unchanged** — never parsed, never reformatted (it is `json.RawMessage`;
see H4 below). An empty tool list produces an empty (not nil, though this
is immaterial since the request struct's `Tools` field carries
`omitempty`) array.

#### Input-item translation (`toOpenAIInput`, `meat/openai.go:240-317`)

For each `Message`, blocks are visited in order and folded into a flat,
ordered list of wire input items. A pending run of consecutive `"text"`
blocks (with no opaque provider data — see below) is buffered in a local
accumulator and only turned into one wire item — `{role, content: <joined
text>}` — when something else forces a flush: hitting a non-text block,
or reaching the end of the message's block list (`flushText`,
`meat/openai.go:244-258`). Consecutive text is joined with `"\n"` before
flushing.

**Decision boundary — the opaque-replay short-circuit, checked first, for
every block, regardless of its `Type`:**

```
if block.Provider == "openai" && len(block.ProviderData) > 0:
    flush any pending text
    require block.ProviderData to be syntactically valid JSON, else error
    append a byte-for-byte clone of block.ProviderData as the next input item
    move to the next block — the type switch below is never reached for this block
```
(`meat/openai.go:261-270`). This check is **type-agnostic** — it fires
the same way for a `"tool_use"` block, a `"text"` block, or a
`"provider_state"` block, as long as it carries non-empty OpenAI provider
data. Concretely, since `blocksFromOpenAIItem`'s `"message"` case tags
**normal assistant text replies** with `Provider`/`ProviderData` too
(`meat/openai.go:354-359`), a previously-received OpenAI text turn is
replayed on the next request as the original `"message"`-typed output
item (with its own `id`, `status`, `role`, `content` array) spliced in
raw — **not** re-encoded through `flushText`'s simpler `{role, content}`
shape. Only a text block with no attached provider data (freshly
authored by the caller, or sourced from a different provider) goes
through the plain accumulate-and-join path.

Only when this check fails does the block fall through to the type
switch (`meat/openai.go:272-310`):

- **`"text"`**: append `block.Text` to the pending accumulator (no wire
  item yet) (`meat/openai.go:273-274`).
- **`"tool_use"`**: flush pending text; take `block.ToolInput`, trim
  surrounding whitespace, and if the trimmed result is empty substitute
  the literal 2-byte string `"{}"` (`meat/openai.go:279-282`) — no
  JSON-validity check is performed on this branch (contrast the
  opaque-replay branch's `json.Valid` check); emit `{type:
  "function_call", call_id: block.ID, name: block.ToolName, arguments:
  <that string>}` (`meat/openai.go:283-292`). Note `arguments` is a JSON
  **string** field (`Arguments string` in the anonymous wire struct)
  holding JSON-encoded text — a double-encoding, matching the decode
  side's `Arguments string` field on `openAIOutputItem`
  (`meat/openai.go:135`) — distinct from `Tool.InputSchema`/
  `openAITool.Parameters`, which are embedded as raw JSON, not as a JSON
  string.
- **`"tool_result"`**: flush pending text; emit `{type:
  "function_call_output", call_id: block.ToolUseID, output:
  block.ToolResult}` (`meat/openai.go:293-305`). **`block.ToolError` is
  never read here** — unlike Anthropic's translation, which encodes an
  `is_error` flag (`meat/anthropic.go:266`), OpenAI's wire shape in this
  implementation carries no error indicator at all; a tool error and a
  tool success look identical on the wire to OpenAI.
- **`"provider_state"`**: always an error, `"openai provider state is
  missing opaque response data"` (`meat/openai.go:306-307`). This case
  is reached only when a block is explicitly typed `"provider_state"`
  but *fails* the opaque-replay precondition above — i.e. its `Provider`
  field isn't exactly `"openai"`, or its `ProviderData` is empty. No
  code path inside this package currently produces such a block
  (Anthropic's own decode never emits `"provider_state"` blocks at all
  — see Open questions), so this is reachable only via a hand-built or
  corrupted message history.
- **default** (any other `block.Type`): error `"openai: unsupported
  message block type %q"` with the offending type interpolated
  (`meat/openai.go:308-309`).

After the block loop, one final `flushText` call catches any trailing
accumulated text (`meat/openai.go:312-314`).

#### Response decoding entry point (`decodeOpenAIResponse`, `meat/openai.go:371-456`)

1. Trim leading/trailing whitespace from the raw bytes; an all-whitespace
   or empty body is the error `"decode openai response: empty body"`
   (`meat/openai.go:372-375`).
2. **Dispatch on the first non-whitespace byte** (`meat/openai.go:376`):
   if it is `{`, treat the whole body as one ordinary JSON `openAIResp`
   object, decode directly, and return — errors wrapped as `"decode
   openai response: %w"` (`meat/openai.go:376-382`). This path never
   touches a map and has no ordering concern at all — `resp.Output`'s
   order is simply JSON-array order as received.
3. Otherwise, treat the body as an SSE stream (below).

#### SSE consumption (the `consume()` closure inside `decodeOpenAIResponse`, `meat/openai.go:389-416`, driven by the scan loop at `:418-431`)

State carried across the whole decode: `items` (an index → raw-item-bytes
map), `final` (the most recently seen terminal event's response
snapshot, or nil), `streamErr` (set if any `"error"`-typed event was
seen), and `data` (the lines accumulated for the SSE event currently
being assembled).

Scan loop, line by line (`bufio.Scanner`, buffer sized `64*1024` initial
/ `16*1024*1024` (16 MiB) maximum — `meat/openai.go:418-419`, see H12
below):
1. Strip a trailing `\r` from each scanned line, to tolerate CRLF
   framing (`meat/openai.go:421`).
2. A **blank line** is the SSE event delimiter: call `consume()` on the
   lines accumulated so far, then continue (`meat/openai.go:422-427`).
3. A line starting with the literal prefix `data:` has that prefix
   stripped and the remainder trimmed of surrounding whitespace, then
   appended to the `data` accumulator (`meat/openai.go:428-430`).
4. **Any other non-blank line — an `event:` field, an `id:` field, a
   `retry:` field, a comment line — is silently ignored.** The decoder
   never inspects the SSE `event:` field to classify events;
   classification comes entirely from the JSON body's own `"type"` key,
   decoded inside `consume()`.

`consume()`, given the accumulated `data` lines for one event:
1. If nothing was accumulated, no-op (`meat/openai.go:390-392`) — this
   is what makes consecutive blank lines, or a stray blank line before
   the stream even starts, harmless.
2. Join the lines with `"\n"` (per the SSE multi-`data:`-line
   convention) and clear the accumulator (`meat/openai.go:393-394`).
3. If the joined text is exactly the literal string `"[DONE]"`, treat it
   as a no-op sentinel and return (`meat/openai.go:395-397`) — real
   OpenAI streams terminate with a `data: [DONE]` line; this path exists
   specifically to swallow it without erroring, since it isn't a JSON
   event.
4. Otherwise, unmarshal the joined text as a stream event; a JSON syntax
   error here aborts the entire decode with `"decode openai stream
   event: %w"` (`meat/openai.go:398-401`) — this propagates all the way
   out of the scan loop immediately (the caller checks `consume()`'s
   return on every call site).
5. Dispatch on the event's `"type"` field (`meat/openai.go:402-414`):
   - **`"response.output_item.done"`**: if the event carries a
     non-empty `"item"` payload, clone its raw bytes into
     `items[event.OutputIndex]` (`meat/openai.go:403-406`) — a plain map
     assignment, so a duplicate `output_index` (e.g. a repeated/retried
     event) silently overwrites the earlier bytes for that index; there
     is no duplicate-detection error. An `output_item.done` event with
     no `"item"` field contributes nothing — that index simply never
     appears in `items`.
   - **`"response.completed"`, `"response.incomplete"`, or
     `"response.failed"`**: these three are **all** terminal, treated
     identically here. If the event carries a non-nil `"response"`
     object, that whole struct is shallow-copied and stored as `final`,
     **overwriting** any previous terminal event's snapshot
     (`meat/openai.go:407-411`) — if the stream sends more than one
     terminal-shaped event, only the last one's
     `status`/`usage`/`error`/`incomplete_details`/`id` survive; if a
     terminal event's `"response"` field is itself absent/null, `final`
     is left untouched by that event (it behaves as if that event
     weren't terminal at all, for this purpose).
   - **`"error"`**: records `streamErr = "openai stream error %s: %s"`
     (event code, event message) (`meat/openai.go:412-413`). This does
     **not** stop the scan loop — it keeps consuming subsequent
     lines/events — but is checked and takes priority once the loop ends
     (see below).
   - Any other `"type"` value (e.g. `response.created`,
     `response.output_text.delta`, `response.content_part.added`, and
     the many other real Responses API streaming event types) is
     **silently ignored** — no default branch exists.

After the scan loop exits (`meat/openai.go:432-443`), in this exact
order:
1. If the scanner itself failed (I/O error, or — critically — a single
   SSE data line exceeding the 16 MiB cap, `bufio.ErrTooLong`), fail with
   `"read openai stream: %w"` (`meat/openai.go:432-434`). Exceeding the
   buffer cap is an error, never a silent truncation.
2. Flush any still-buffered trailing event data one final time via
   `consume()` (handles a stream that ends without a final blank line) —
   propagate any decode error from that (`meat/openai.go:435-437`).
3. If `streamErr` was ever set (an `"error"`-typed event was seen
   anywhere), return it — **this takes priority even over a `final` that
   was also successfully captured** (`meat/openai.go:438-440`); i.e. an
   error event anywhere in the stream wins regardless of whether a
   terminal completion event also arrived.
4. If, after all that, `final` is still nil, fail with `"openai stream
   ended without a final response event"` (`meat/openai.go:441-443`) —
   this is what a stream containing only `output_item.done` events and
   no completed/incomplete/failed event (or only malformed ones missing
   their `"response"` payload) produces.

#### Sort-and-reassemble (`meat/openai.go:444-453`)

1. **Only if `items` is non-empty**: collect its keys (output indices)
   into a slice, sort them ascending with `sort.Ints` (a total order on
   distinct integers — no ties possible, since map keys are unique),
   reset `final.Output` to length zero, then append `items[index]` for
   each sorted index in turn, rebuilding `final.Output` in
   ascending-index order (`meat/openai.go:444-453`).
2. **If `items` is empty** (no `output_item.done` events were ever
   captured), this whole step is skipped — `final.Output` is left
   exactly as it came from the terminal event's own `"output"` field.
   This is a real, distinct branch: the item-map override only happens
   when at least one buffered item exists; it is not an unconditional
   discard of the terminal snapshot's own output array (see Open
   questions, G23 note).

#### Output-item → Block decoding (`blocksFromOpenAIItem`, `meat/openai.go:319-365`)

For each raw output item (from either wire path):
1. Unmarshal it into a typed peek struct (`openAIOutputItem`: type, id,
   call_id, name, arguments, encrypted_content, content parts) — a
   genuine JSON syntax/shape error here is the *only* way this function
   fails, `"decode openai output item: %w"` (`meat/openai.go:320-323`).
   Note the struct has an `EncryptedContent` field
   (`meat/openai.go:136`), but **no code anywhere reads it** — the
   encrypted reasoning payload only ever reaches the caller via the raw
   byte clone below, never via a normalized field.
2. Clone the entire raw item's bytes into `state` (`meat/openai.go:324`)
   — this is what becomes `ProviderData` in every branch below.
3. Dispatch on `item.Type`:
   - **`"reasoning"`**: return exactly one `Block{Type: "provider_state",
     Provider: "openai", ProviderData: state}` — no normalized fields at
     all; the block is opaque in its entirety (`meat/openai.go:326-327`).
   - **`"function_call"`**: `ToolInput` is `item.Arguments` reinterpreted
     as raw JSON, or the literal `{}` if `Arguments` is empty/
     whitespace-only after trimming (`meat/openai.go:329-332`). Return
     one `Block{Type: "tool_use", ID: item.CallID, ToolName: item.Name,
     ToolInput: input, Provider: "openai", ProviderData: state}`
     (`meat/openai.go:333-340`). **The normalized `ID` is populated from
     `item.CallID`, not from the item's own internal `"id"` field** —
     that internal id is discarded from the normalized view but
     survives inside the opaque `state` bytes; on replay (opaque-replay
     short-circuit above), it comes back verbatim, which is exactly what
     G22's "including fields meat's own encoder never emits (e.g. the
     item's own 'id')" describes.
   - **`"message"`**: iterate `item.Content` (a JSON-array-backed slice
     — order is wire order, deterministic by construction, no map/sort
     involved) and, for each part, append `content.Text` if its type is
     `"output_text"`, or `content.Refusal` if its type is `"refusal"`
     (`meat/openai.go:343-350`); any other content-part type is silently
     skipped and contributes nothing. If zero parts were collected
     (empty `Content` array, or every part had an unrecognized type),
     return the same minimal opaque wrapper as the `"reasoning"` case —
     `Block{Type: "provider_state", ...}` (`meat/openai.go:351-353`).
     Otherwise return `Block{Type: "text", Text: strings.Join(parts,
     "\n"), Provider: "openai", ProviderData: state}`
     (`meat/openai.go:354-359`) — text and refusal parts are joined with
     `"\n"` in their original wire order, with no delimiter
     distinguishing which parts were refusals versus ordinary text.
   - **default** (any unrecognized `item.Type`): the same minimal opaque
     wrapper as `"reasoning"` (`meat/openai.go:360-364`), with an
     explicit rationale in the source comment: preserve state a newer
     Responses API model may require on a later turn, rather than
     silently dropping it.

Every branch returns exactly one `Block` in its slice —
`blocksFromOpenAIItem` never fans one output item out into multiple
blocks or drops an item entirely (every item produces exactly one block,
possibly an opaque wrapper).

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
- **`anthropic.go`: `MaxTokens` is a fixed constant, never derived or
  overridable.** (`meat/anthropic.go:31,122` — G15.) There is no
  `AnthropicModel` field to change it. Consequence of breaking: the
  `max_tokens`-is-always-an-error decision stops being a reliable
  truncation signal the moment the cap can vary per call — the whole
  design assumes "hit the ceiling" always means "unwanted truncation."
- **`anthropic.go`: `HTTPC` is defaulted lazily, per call, not once at
  construction** (`meat/anthropic.go:133-136`), because `AnthropicModel`
  is a plain struct callers may build directly (`meat/anthropic.go:19-26`).
  Consequence: a port that defaults the client only in a constructor
  function will diverge for any caller that builds the model value
  directly with `HTTPC` unset.
- **`anthropic.go`: `Model` is defaulted twice, independently** — once in
  `NewAnthropicFromEnv` via `resolveModel` (`meat/anthropic.go:49`),
  again in `Generate` via `cmpOr` (`meat/anthropic.go:121`). Consequence:
  a port that removes either defaulting step breaks direct-construction
  callers (removing the `Generate`-side one) or nothing observable today
  (removing the constructor-side one, since `Generate` still catches it)
  — but the two are not redundant from every call path, so both must be
  ported.
- **`anthropic.go`: the empty-`APIKey` guard is an exact-empty-string
  check, not a format check** (`meat/anthropic.go:116-118`). Consequence:
  the gateway's placeholder `"implicit"` deliberately passes it; a port
  that adds stronger validation (minimum length, prefix check) would
  break the exe.dev gateway path silently.
- **`anthropic.go`: retry decisions never inspect response *content*,
  only the HTTP status code**; decode/stop-reason/top-level-error
  decisions never trigger a retry, only ever a terminal error (they
  happen strictly after the retry loop has already returned success).
  Consequence: a port that folds these two decision layers together
  (e.g., retrying on `stop_reason == "max_tokens"`) changes retry-budget
  consumption and could silently retry something the design intends to
  fail loudly instead.
- **`anthropic.go`: `json.RawMessage` fields (`antBlock.Input`,
  `antTool.InputSchema`) are passed through byte-for-byte**, never
  re-parsed or re-marshaled as a Go value (`meat/anthropic.go:89,98,
  165,250,264`). See H4 below.
- **`anthropic.go`: translation order is preserved end-to-end with no
  sort or map.** A port that buffers blocks in a keyed structure before
  re-emitting them (as `openai.go` deliberately does, per H13) would
  need to add back an explicit sort that this file's design doesn't
  need — doing so is unnecessary complexity, not a bug fix.
- **`openai.go`: opaque-replay takes priority over normalized
  re-encoding, for any block, checked before the type switch even runs**
  (`meat/openai.go:261-270`). Breaking this — e.g. porting `toOpenAIInput`
  so it dispatches on `block.Type` *first* and only checks for provider
  data inside the `"tool_use"`/`"text"` cases — would cause an
  OpenAI-sourced assistant text reply or tool call to be re-encoded from
  its normalized fields on the next turn instead of replayed verbatim.
  For reasoning items this is worse than cosmetic: the encrypted payload
  is cryptographically bound to its exact bytes, and no normalized-field
  reconstruction exists for a `"reasoning"` block at all (it carries no
  `Text`/`ToolInput`), so any implementation gap here isn't a formatting
  difference, it's data loss the provider will reject on the next call.
- **`openai.go`: sort-before-reassemble** (`meat/openai.go:444-449`,
  H13): the collected `output_index → bytes` map must be rebuilt into
  `final.Output` in ascending numeric-index order, not arrival/insertion
  order. Breaking this could silently reorder a response's output items
  whenever SSE events arrive (or are buffered/retried) out of index
  order — which the sort exists specifically to guard against even
  though it doesn't currently appear to be exercised by any fixture.
- **`openai.go`: the item-map override on `final.Output` is conditional,
  not unconditional** (`meat/openai.go:444`): it only fires when at
  least one `output_item.done` event was captured. A port that always
  discards the terminal event's own `output` field (rather than falling
  back to it when the item map is empty) would diverge from Go whenever
  a minimal/compatible gateway sends output only inline on the terminal
  event with no separate per-item `done` events.
- **`openai.go`: a single malformed output item invalidates the whole
  response** (`meat/openai.go:209-213`): `Generate` returns no partial
  `Content` on the first `blocksFromOpenAIItem` decode error, even if
  earlier items in the same `Output` array decoded successfully.
- **`openai.go`: the 16 MiB SSE line-buffer cap is a hard error
  boundary, not a truncation point** (`meat/openai.go:418-419`, H12): a
  single `data:` line (one SSE frame) larger than 16 MiB fails the whole
  decode via `scanner.Err()`; it is never silently cut short.
- **`openai.go`: `ToolError` has no wire representation toward OpenAI**
  (`meat/openai.go:293-305`): unlike the Anthropic translation's
  `is_error` flag, a `tool_result` block's `ToolError` is dropped
  entirely when encoding to OpenAI's `function_call_output` shape. A
  port must not "helpfully" add an error flag OpenAI's Responses API
  might also support — Go doesn't send one, so a byte-faithful port
  doesn't either.
- **`openai.go`: `EncryptedContent` is decoded but never consulted**
  (`meat/openai.go:136` vs. `:326-327`): the reasoning payload only ever
  reaches the caller as opaque bytes inside `ProviderData`. A port must
  not "helpfully" surface it as a normalized string field — no code path
  treats it as anything but part of the opaque blob.

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
- **H4**, `anthropic.go`: applies at `meat/anthropic.go:89`
  (`antBlock.Input`), `:98` (`antTool.InputSchema`), `:165` (decode:
  `ToolInput: b.Input`, preserving the exact bytes Anthropic sent for a
  tool call's arguments), `:250` (`InputSchema: t.InputSchema`), and
  `:264` (encode: `Input: b.ToolInput`, re-splicing those same bytes back
  onto the wire when a prior `tool_use` block is replayed in a later
  turn's history). This is the same byte-preservation concern H4
  describes for OpenAI, but **narrower**: Anthropic's translation layer
  has no `ProviderData`/`Provider` wrapper at all — it never reads or
  writes `Block.Provider`/`Block.ProviderData` (`meat/model.go:45-46`)
  anywhere in this file. The only opaque-byte-preservation happening here
  is for `ToolInput`/`InputSchema`, via plain `json.RawMessage`
  assignment (a Go slice-header copy, not a `bytes.Clone`, and with **no
  `json.Valid` check** on either the decode or encode side — contrast
  `openai.go:265-268`'s explicit `json.Valid`+`bytes.Clone` pair for
  `ProviderData`). A `JSON.parse`→`JSON.stringify` round trip on either
  field would corrupt it identically to the OpenAI case. Related: a
  `Block` of type `"provider_state"` has **no translation case at all**
  in `toAntMessages` (`meat/anthropic.go:260-267`, no `default`) — it is
  silently dropped rather than replayed, since Anthropic's own wire
  protocol has no equivalent of OpenAI's encrypted-reasoning-item replay.
  A port must not assume `toAntMessages`'s silent-drop is a deliberate,
  portable no-op.
- **H9**, `anthropic.go`: `antReq.Tools` (`meat/anthropic.go:76`,
  `omitempty`) omits the `tools` key entirely whenever `toAntTools`
  returns a zero-length slice, whether the input was `nil` or an
  explicit empty slice — Go's `omitempty` on a slice tests length only,
  so H9's nil-vs-`[]` ambiguity happens not to bite here. Separately:
  `antBlock.IsError` (`meat/anthropic.go:92`, `omitempty`) omits
  `is_error` whenever `false` — a non-error `tool_result` never sends
  `"is_error": false`, only ever `true` or nothing. And
  `antMessage.Content` (`meat/anthropic.go:81`) has **no** `omitempty`
  and can be a genuine `nil` slice (an all-unrecognized-block-type
  message), which *does* marshal as `"content": null` — an actual,
  reachable instance of H9's exact concern, not merely a near-miss.
- **H5**, `anthropic.go`: `postJSONWithRetry`'s context-cancellation
  check (`ctx.Err() != nil`, `meat/anthropic.go:217-219`, mirrored in
  the backoff wait at `:200-201`) inspects the context object's own
  error directly rather than unwrapping/pattern-matching whatever
  `client.Do` returned. Also: `fmt.Errorf("decode response: %w", err)`
  (`:144`) and `fmt.Errorf("after %d attempts: %w", maxAttempts,
  lastErr)` (`:237`) wrap with `%w`; `fmt.Errorf("anthropic error: %s:
  %s", ...)` (`:147`) and the per-attempt `"%s API %d: %s"` (`:232`) do
  **not** — an aggregate retry-exhaustion error is always unwrappable
  back to its underlying cause, but a top-level API error object is an
  opaque leaf. A port's `hasCause` walker must be able to distinguish
  these.
- **H6**, `anthropic.go`: the retry loop honors `ctx` at two independent
  points: during the backoff sleep (`select` against `ctx.Done()`,
  `:199-203`) and via the request's own context
  (`http.NewRequestWithContext`, `:206`). A port needs an `AbortSignal`
  wired into both the timer and the `fetch` call, not just one.
  Separately, `Generate`'s default `http.Client{Timeout: 2*time.Minute}`
  (`:135`) is a **second, client-level** timeout independent of `ctx`'s
  own deadline — the same composing pattern as `gateway.go`'s client
  above, but a distinct site.
- **H14**, `anthropic.go`: `strings.TrimSpace(string(raw))` at
  `meat/anthropic.go:232` trims the raw HTTP error-response body before
  embedding it in the per-attempt error text. Go's `TrimSpace` and JS's
  `.trim()` disagree at U+0085 and U+FEFF. Not currently exercised by
  any fixture. By contrast, `strings.TrimRight(..., "/")` at `:132` is
  an explicit ASCII-cutset trim (only `/`), not a Unicode-whitespace
  trim — H14 does not apply there.
- Adjacent to H12 (not itself a listed hazard), `anthropic.go`: unlike
  `openai.go`'s SSE reader (bounded at 16 MiB, per H12),
  `anthropic.go`'s response-body read is a plain
  `io.ReadAll(httpResp.Body)` with **no explicit size limit at all**
  (`meat/anthropic.go:223`), bounded only by the active client/context
  timeouts, not by bytes. This file does no subprocess work and no SSE
  streaming — Anthropic's Messages API here is a single buffered JSON
  response — so H12's scanner-cap concern doesn't transfer directly, but
  the unboundedness is worth flagging for parity with the rest of the
  codebase's stream-reading convention.
- **H4** (critical), `openai.go`: `Block.ProviderData` is the carrier
  for opaque provider state. Capture side validates with `json.Valid`
  and copies with `bytes.Clone` at the **replay** site
  (`meat/openai.go:265-268`); the **capture** side
  (`blocksFromOpenAIItem`) clones the entire raw output item with
  `bytes.Clone(raw)` at `meat/openai.go:324` for every item type,
  without ever parsing it into normalized fields for `"reasoning"`
  items. `Tool.InputSchema`/`openAITool.Parameters`
  (`meat/openai.go:96,234`) and `Block.ToolInput`/`function_call.arguments`
  (`meat/openai.go:329,336`) are the other `RawMessage`-typed fields —
  the schema fields are embedded raw and untouched; `arguments`/
  `ToolInput` specifically is a JSON-encoded **string**, a different
  serialization shape from the raw-embedded schema, so a port's
  "never parse this" rule must apply to it in its string form, not by
  treating it as embeddable raw JSON directly. A
  `JSON.parse`→`JSON.stringify` round-trip anywhere on the
  `ProviderData` path corrupts the cryptographic binding of encrypted
  reasoning items — this is the single highest-consequence mechanism in
  this file.
- **H6**, `openai.go`: `ctx` flows straight into `postJSONWithRetry`
  (`meat/openai.go:178`). Separately, when `HTTPC` is nil, a
  client-level 5-minute timeout is installed (`meat/openai.go:174-177`)
  — independent of `ctx`, same "two timeouts" pattern as `gateway.go`
  above; a port needs both. Additionally: a cancellation that lands
  during the full-body SSE read (`io.ReadAll` inside the shared
  `postJSONWithRetry`, `meat/anthropic.go:223-228`) is not distinguished
  from an ordinary transient read failure at that exact call site — it
  gets one retry-loop iteration before being caught, or surfaces wrapped
  inside `"after %d attempts: %w"` rather than as a clean abort signal.
  This matters most for `openai.go` because it is the only caller of
  this shared function whose responses are routinely large, slow SSE
  streams rather than small JSON bodies.
- **H12**, `openai.go`: `bufio.Scanner` buffer explicitly sized
  `make([]byte, 64*1024)` initial capacity, `16*1024*1024` (16 MiB)
  maximum, at `meat/openai.go:419`. Exceeding 16 MiB on any single SSE
  line is `bufio.ErrTooLong`, surfaced as `"read openai stream: %w"`
  (`meat/openai.go:432-434`) — an explicit error, never a silent
  truncation. A Node stream-based port has no equivalent cap by default
  and must impose one explicitly to preserve this error path.
- **H13**, `openai.go`: `items := make(map[int]json.RawMessage)`
  (`meat/openai.go:384`), populated at `meat/openai.go:405`, reassembled
  via explicit `sort.Ints` at `meat/openai.go:449` before rebuilding
  `final.Output` at `meat/openai.go:450-453`. This ports directly (Go's
  map here is already made deterministic by the sort) — the requirement
  is to **keep the sort** even in a JS port where a `Map` would
  otherwise preserve insertion order, because insertion order (SSE
  arrival order) is not provably identical to ascending `output_index`
  order; the sort is the actual contract, not an incidental detail.
- Adjacent to H9 (not itself a listed hazard, since H9's "Affects" line
  names only the CLI's `-json` output), `openai.go`: the outgoing
  request's `Input []json.RawMessage` field has **no `omitempty` tag**
  (`meat/openai.go:79`), while `toOpenAIInput`'s local accumulator `var
  out []json.RawMessage` (`meat/openai.go:241`) starts as a Go `nil`
  slice and is only ever turned non-nil by an `append`. A `messages`
  argument that yields zero wire items would therefore marshal as
  `"input": null` rather than `"input": []`. Every real call path always
  produces at least one item, so this is untested and likely
  unreachable in practice, but a port using a JS array (which serializes
  empty as `[]`, never `null`) would diverge from Go's literal wire
  bytes in this specific, currently-unexercised corner.

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

### `anthropic.go` — every failure mode, exact text

- Missing credentials (constructor): `"no LLM credentials: set
  ANTHROPIC_API_KEY, or run on an exe.dev VM with an attached 'llm'
  integration"` `meat/anthropic.go:66`. Not wrapped. (= G9)
- Empty API key (call time): `"meat: AnthropicModel.APIKey is empty"`
  `meat/anthropic.go:117`. Not wrapped.
- Request-body marshal failure: raw `json.Marshal` error, no added text
  `meat/anthropic.go:129`.
- Request construction failure (inside retry loop): raw
  `http.NewRequestWithContext` error, no added text `meat/anthropic.go:208`.
- Context done during backoff wait or after a transport failure: bare
  `ctx.Err()` (Go's own `"context canceled"`/`"context deadline
  exceeded"` text) `meat/anthropic.go:201,218`. Not wrapped.
- Per-attempt non-2xx HTTP status: `"%s API %d: %s"` (provider, status
  code, trimmed body) `meat/anthropic.go:232` — e.g. `"anthropic API
  400: {...}"`. Not wrapped. Returned bare if that status is
  non-retryable (`:234`), or folded into the next error if retryable.
- Retry budget exhausted: `"after %d attempts: %w"` (`maxAttempts`=4,
  wrapping the last per-attempt or transport/read error)
  `meat/anthropic.go:237`. Wrapped.
- Response decode failure: `"decode response: %w"` `meat/anthropic.go:144`.
  Wrapped.
- Top-level API error object present on an HTTP 200: `"anthropic error:
  %s: %s"` (`resp.Error.Type`, `resp.Error.Message`) `meat/anthropic.go:147`.
  Not wrapped.
- `stop_reason == "max_tokens"`: `"anthropic response truncated at
  max_tokens (%d); the diff may be too large to abridge in one pass"`
  (`%d` = `maxOutputTokens` = 16384) `meat/anthropic.go:153`. Not
  wrapped. (= G14)

### `openai.go` — every failure mode, exact text

- `"meat: OpenAIModel needs APIKey or BaseURL"` — `Generate`'s own
  credential guard, `meat/openai.go:150`.
- `"no OpenAI credentials: set OPENAI_API_KEY, OPENAI_BASE_URL, or run on
  an exe.dev VM with an attached 'llm' integration"` —
  `NewOpenAIFromEnv`, `meat/openai.go:71` (= G18).
- `"openai error: %s: %s"` (code-or-type, message) — top-level error
  object on a decoded response, `meat/openai.go:192`.
- `"openai response incomplete (%s); max_output_tokens=%d"` (reason or
  `"unknown"`, fixed cap) — `meat/openai.go:199` (= G25).
- `"openai response ended with status %q"` — any non-empty, non-
  `"completed"` status, `meat/openai.go:202`.
- `"openai provider state is not valid JSON"` — opaque-replay branch,
  `json.Valid` failure, `meat/openai.go:266`.
- `"openai provider state is missing opaque response data"` — a
  `"provider_state"`-typed block that doesn't qualify for the
  opaque-replay fast path, `meat/openai.go:307`.
- `"openai: unsupported message block type %q"` — default case in
  `toOpenAIInput`'s switch, `meat/openai.go:309`.
- `"decode openai output item: %w"` — malformed output item JSON,
  `meat/openai.go:322`.
- `"decode openai response: empty body"` — `meat/openai.go:374`.
- `"decode openai response: %w"` — plain-JSON parse failure,
  `meat/openai.go:379`.
- `"decode openai stream event: %w"` — malformed SSE event JSON,
  `meat/openai.go:400`.
- `"openai stream error %s: %s"` (code, message) — an `"error"`-typed
  SSE event, `meat/openai.go:413`.
- `"read openai stream: %w"` — scanner failure, including the 16 MiB
  buffer-cap overflow, `meat/openai.go:433`.
- `"openai stream ended without a final response event"` — no terminal
  event ever captured, `meat/openai.go:442`.

Two shared errors from `postJSONWithRetry` (defined in `anthropic.go`,
reused here with `provider = "openai"`) also surface through `Generate`:
`"%s API %d: %s"` → literally `"openai API %d: %s"`
(`meat/anthropic.go:232`) for a non-retryable or exhausted HTTP status,
and `"after %d attempts: %w"` (`meat/anthropic.go:237`) when retries are
exhausted.

## Ordering that Go leaves unspecified

- **`provider.go`, `gateway.go`, `anthropic.go`: none.** No map, no
  sort, no goroutine-driven concurrency in any of the three — every list
  each produces is built by sequential iteration over an already-ordered
  input slice or JSON array, preserving source order exactly.
- **`openai.go`: one site, made deterministic by an explicit sort.** The
  SSE reassembly's `items map[int]json.RawMessage`
  (`meat/openai.go:384`) is the only place in this whole subject where
  iteration order is not already fixed by a data structure; it is
  restored to ascending-`output_index` order by an explicit `sort.Ints`
  before rebuilding `final.Output` (`meat/openai.go:444-449`) — this is
  H13's subject and the sort must be preserved explicitly in a port even
  though a JS `Map`/plain object would otherwise preserve *insertion*
  (arrival) order, which is not provably identical to ascending
  output-index order. Every other iteration in `openai.go` — `Message.Content`,
  `messages`, `resp.Output` (plain-JSON path), `item.Content` (message
  parts) — is over an ordinary slice, preserving source order with no
  additional handling required.

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
- Anthropic default HTTP client timeout — `2 minutes` —
  `meat/anthropic.go:135` — only used when `AnthropicModel.HTTPC` is
  nil; wall-clock cap on the whole round trip, independent of `ctx`.
- OpenAI default HTTP client timeout — `5 minutes` — `meat/openai.go:175`
  — only used when `OpenAIModel.HTTPC` is nil; sized for a full
  streaming reasoning-model turn.

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

### Stage 2 findings — `anthropic.go`

- **Reconciliation: G7-G15 all confirmed, no mismatches.** Re-verified
  directly against source: the `key != "" || baseURL != ""` short-circuit,
  the gateway-fallback branch, the exact "no LLM credentials" text,
  `toAntTools`/`toAntMessages`/decode field behavior, `retryableStatus`
  for 429/529/400/500, the backoff-doubling formula, the
  exhausted-retries wrapped text, and the `max_tokens`-is-fixed-16384
  assertion.
- **`toAntMessages`'s encode-side silent drop of unrecognized block
  types** (`meat/anthropic.go:260-267`) leaves `antMessage.Content` at
  Go's `nil` zero value when every block in a message is unrecognized —
  and because that field has no `omitempty` (`:81`), it marshals as
  `"content": null`, a shape the real API almost certainly rejects.
  Untested; new finding distinct from the already-known decode-side drop.
- **The exact boundary for which retry-exhaustion error message
  appears** is untested: a non-retryable status on the *last* attempt
  still returns the bare per-attempt message (no `"after N attempts"`
  wrapper) even after several prior retryable failures — no fixture
  constructs a mixed retryable/non-retryable attempt sequence.
- **`stop_reason` values other than `"max_tokens"` are decoded and then
  discarded entirely** — `Response` carries no stop-reason field, so a
  port cannot recover which reason ended a successful turn.
- **Anthropic's URL builder never checks for an already-present `/v1`**
  in `BaseURL`, unlike OpenAI's `openAIResponsesURL` (G26) — the two
  providers' URL-building rules are genuinely asymmetric, not a shared
  helper.
- A 200 response with an empty/absent `content` array is not itself an
  error — `Generate` returns `Response{Content: nil, ...}` silently.
  Untested either way.
- `antTool.InputSchema` (`:98`) has no `omitempty`; a `Tool` constructed
  with a `nil` schema would marshal `"input_schema": null` rather than
  an object — plausible only if `tools.go` ever produces such a `Tool`
  (not verified, out of this file's scope).
- No dead or unreachable code found in `anthropic.go`. `antBlock`'s
  `ToolUseID`/`Content`/`IsError` fields are populated only on the
  encode side and never read on decode, because Anthropic's API
  structurally never returns a `tool_result`-shaped block in an
  assistant reply — inherent to the API shape, not latent dead code.

### Stage 2 findings — `openai.go`

- **Reconciliation: G16-G22, G24, G25, G27 confirmed with no
  discrepancy. G23 and G26 need qualifiers, not corrections to the
  mechanism — their prose overstates/misstates a boundary:**
  - **G23** ("overrides whatever output array shipped on the terminal
    event") is only true **when `items` is non-empty** — i.e. at least
    one `output_item.done` event was captured (`meat/openai.go:444`).
    Every existing fixture happens to satisfy this, so no test
    contradicts G23, but a stream that sends output only inline on the
    terminal event with zero `output_item.done` events would use that
    terminal `output` array as-is, not discard it.
  - **G26** ("trimming one trailing slash") — the actual call is
    `strings.TrimRight(base, "/")`, which strips **every** trailing `/`
    character, not just one (`meat/openai.go:220`). The existing fixture
    (a single trailing slash) can't distinguish "trim one" from "trim
    all"; untested at the 2+-slash boundary.
- **The conditional item-map-override branch itself** (items empty ⇒
  terminal output stands as-is) has no fixture at all.
- **Multiple terminal-shaped events in one stream**
  (`meat/openai.go:407-411`): last-one-wins overwrite of `final` is
  unexercised.
- **`streamErr` takes priority over a captured `final`**
  (`meat/openai.go:438-440`): no fixture sends both a valid terminal
  event *and* an `"error"`-typed event in the same stream.
- **Duplicate `output_index` values across two `output_item.done`
  events** (last-received silently wins, `:405`) and **an
  `output_item.done` event with a missing/empty `"item"` payload**
  (contributes nothing) are both untested.
- **OpenAI's gateway-fallback path sends no `Authorization` header at
  all** (`APIKey` stays `""`, unlike Anthropic's `"implicit"`
  placeholder) — not explicitly asserted by any test either way.
- **`EncryptedContent` is decoded but never read anywhere** — worth
  flagging so a port doesn't "complete" the struct by wiring it up as a
  normalized field; only the raw-byte clone path carries it.
- **`ToolError`'s silent drop toward OpenAI** (no `is_error`-equivalent
  field sent, unlike Anthropic's `IsError` encoding) is unverified by
  any test, only by reading the source.
- **The "manual `tool_use` re-encoding branch in `toOpenAIInput`"**
  (`meat/openai.go:275-292`), previously flagged as unreachable because
  every OpenAI-sourced `tool_use` block already carries provider data,
  is **not actually dead code**: it is unreachable only within `meat`'s
  own internal call graph (a single `Model` is threaded through one
  run). But `OpenAIModel`/`Generate` are exported specifically so
  embedders can supply their own models or replay history across
  providers (`meat/model.go:70-73`) — and `anthropic.go`'s own `tool_use`
  decode never sets `Block.Provider` at all (confirmed by grep), so an
  embedder replaying an Anthropic-originated `tool_use` block through
  `OpenAIModel.Generate` (a provider-fallback/switch scenario) would
  reach this branch. A port should implement it faithfully rather than
  omit it as unreachable.
