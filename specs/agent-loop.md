# agent-loop

## Current scope and assurance limits

This contract concerns meat's **API engine loop**. External subscription
execution via `-agent` belongs to [cli](cli.md) and
[agent.ts](../src/cli/agent.ts).

Source-observed behavior in [meat.ts](../src/meat/meat.ts): each model chunk
receives its own turn/time limits (defaults: 24 turns and four minutes).
Chunks run sequentially; the public request has no aggregate token/cost limit.
Provider HTTP retries are additional attempts within a model call.
Only usage returned by successful model responses is accumulated; failed
attempts may have unreported cost.

A valid draft retained for refinement can return as fallback after later
failure or exhaustion. Caller cancellation takes precedence. The public Result
does not distinguish fallback from ordinary completion, and a later chunk
failure throws without exposing earlier completed chunks or their usage.
See [loop tests](../test/meat/meat.test.ts) for constrained cases.

Compilation establishes source-derived elisions and specified structural
invariants. It does not prove semantic completeness or summary accuracy.
Chunk move checks apply when both full sides map contiguously into the same
chunk; concatenation adds no global move-symmetry validation. Evidence:
[mapMovesToChunk](../src/meat/chunk.ts), [compiler](../src/meat/editplan.ts).
The proposed receipt/budget/recovery contracts are in
[agent interface](agent-interface.md), implemented only by future
[roadmap](../docs/roadmap.md) work.

## Historical Go baseline

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `meat/meat.go`
> Go tests: `meat/meat_test.go` (29 tests, the primary source), `meat/chunk_test.go` (Request compatibility, per-chunk run scoping)

## Purpose

`Abridge` is the package's one entry point: given a raw diff and a `Model`,
it drives a bounded loop of model round-trips (a "run"), dispatching tool
calls, until the model submits a plan or the run's turn/time budget is
exhausted. A run is either the whole diff or one chunk of a split diff (see
`chunk.md`). This spec covers the loop's control flow — turn dispatch,
nudging, refinement, and fallback under a deadline or cancellation — as
distinct from what the tools do (`tools.md`) or what the model is told
(`rubric.md`).

## Vocabulary

- **Turn** — one full round-trip through the agent loop's body: one call to
  `model.Generate`, plus dispatch of every tool call in its reply, plus
  appending the resulting messages to history. Turns are 1-indexed in
  progress messages (`"turn 1"`) but 0-indexed internally
  (`meat/meat.go:165`).
- **Run** — one execution of `abridgeOne` — either the whole diff (when it
  fits in one run) or exactly one chunk of a split diff. Each run has its
  own turn budget, its own wall-clock budget, and its own toolbox/1-based
  line numbering.
- **Fallback** — a previously-submitted plan (specifically, the draft
  submission that triggered a refinement turn) held in reserve so that if
  the refinement turn cannot complete — because the model errors out
  (deadline) or the turn budget runs out — `Abridge` can still return a
  valid result instead of failing the whole run. Only ever set right before
  a refinement turn is offered (`meat/meat.go:206`).
- **Nudge** — the fixed text sent back to the model when it produces a
  reply with no tool call at all (`noToolCallNudge`, `meat/meat.go:109`),
  telling it to call `preview_plan` or `submit`.
- **Retention pressure** — see `tools.md` for the exact formula; the signal
  that triggers exactly one refinement turn per run.

## Test infrastructure

The `Model` interface (`meat/model.go:77-79`) has one method: `Generate(ctx,
system string, messages []Message, tools []Tool) (*Response, error)`. A
`Message` has a `Role` and a slice of `Block`; a `Block`'s meaningful fields
depend on its `Type` (`"text"`, `"tool_use"`, `"tool_result"`); a `Response`
carries `Content []Block` plus `InputTokens`/`OutputTokens`
(`meat/model.go:11-68`).

- **`scriptedModel`** (`meat/meat_test.go:18-33`) — the primary fake. Built
  from a fixed, pre-baked list of `*Response` turns; `Generate` records the
  `tools` seen on the most recent call and appends a defensive copy of the
  full `messages` slice on every call to `seenMessages`, so
  `m.seenMessages[k]` is exactly what the model saw on its `(k+1)`-th call.
  `m.seen` counts total calls made. Once scripted turns are exhausted, the
  fake replays the *last* turn forever rather than erroring — exploited by
  chunking tests where one scripted `submit` response serves every chunk's
  call. No thread safety; determinism comes from the fixed slice and
  single-goroutine use.
- **Response/block builders**: `toolUse(id, name, input)` JSON-marshals a
  domain struct (`readFileInput`, `grepInput`, `editPlan`, `submission`)
  into a `tool_use` block (`meat/meat_test.go:67-70`); `assistant(...)`
  wraps blocks into a `*Response` with **fixed** `InputTokens: 100,
  OutputTokens: 20` per turn (`meat/meat_test.go:72-74`) — every scripted
  turn contributes exactly 100/20 tokens, which is how token-accumulation
  assertions are satisfied without needing exact-sum checks; `textBlock(s)`
  (`meat/model.go:82`) builds a text-only block for "prose, no tool call"
  turns.
- **Deadline vs. cancellation fakes** — the second most important piece of
  infrastructure, because `Abridge` must react differently to the two:
  - **`deadlineFallbackModel`** (`meat_test.go:35-48`): call 1 returns a
    fixed empty-plan `submit` (the draft); call 2+ blocks on
    `<-ctx.Done()` then returns `nil, ctx.Err()` — simulating a model call
    that hangs past the *internal* per-run budget.
  - **`callerCancelFallbackModel`** (`meat_test.go:50-65`): identical
    shape, but holds a `cancel context.CancelFunc` captured from the
    *caller's own* context; on call 2 it explicitly cancels the caller's
    context (not just the per-run timeout) before blocking.
  Both surface as the same `ctx.Done()`/`ctx.Err()` shape to `Generate`, so
  the distinguishing logic must live in `Abridge` itself via a second,
  outer context captured before the timeout wrap (`callerCtx := ctx` at
  `meat/meat.go:144`, checked at `meat/meat.go:169`). A port needs an
  equivalent two-signal scheme (e.g. an inner `AbortSignal` tied to a
  timeout, plus a check of the outer caller-supplied signal before honoring
  any fallback).
- **`modelFunc`** (`meat/chunk_test.go:20-25`) — a bare `func(ctx)
  (*Response, error)` adapter to `Model`, used only to inject a raw
  `ctx.Err()` and test error-chain preservation without scripting turns.
- **`gitRepo`** (`meat/meat_test.go:76-102`) — creates a real throwaway git
  repository under `t.TempDir()` (`git init`, fixed `user.email`/`user.name`,
  writes files, commits), because the `grep` tool shells out to real `git
  grep` (see `tools.md`) and needs committed content to search. A port
  needs either a real git binary in its test harness or an explicit fake
  for this tool's git dependency.

## Guarantees

G1. Calling `Abridge` with a `nil` model returns an error immediately
    (`"meat: nil model"`) rather than panicking.
    — mechanism `meat/meat.go:116-118`.

G2. A diff that is empty or all whitespace short-circuits before any model
    call: the result has an empty `SmartDiff` and the model is never
    invoked.
    — `meat/meat_test.go:175-187` (asserts `m.seen != 0` fails). Mechanism
    `meat/meat.go:119-121`.

G3. Malformed or oversize input is rejected before the model is ever called
    — `m.seen == 0` in every rejection test.
    — `meat/meat_test.go:368-424` (oversize, unsplittable-oversize,
    inconsistent-hunk-counts, combined-diff cases; see `chunk.md` and
    `diff.md` for the exact per-case messages). Mechanism: the validation
    gate runs before the turn loop starts (`meat/meat.go:122-130`).

G4. A whole agent run is driven by a bounded loop of model round-trips: on
    each turn the loop sends the system prompt, running message history,
    and tool schemas, appends the assistant's reply to history, dispatches
    every `tool_use` block through the toolbox, and appends the tool
    results as the next user turn — repeating until `submit` is seen or the
    turn budget is exhausted.
    — `meat/meat_test.go:104-173` (`TestAbridge_PreviewThenSubmit`,
    `TestAbridge_ReadThenSubmit`). Mechanism `meat/meat.go:165-225`.

G5. Token usage (`InputTokens`, `OutputTokens`) accumulates across every
    model turn in a run, not just the last one.
    — `meat/meat_test.go:167-169` (both fields non-zero after 2 turns of
    100/20 each). Mechanism `meat/meat.go:176-177`.

G6. When the model replies with text but no tool call, the loop sends a
    fixed nudge message (`noToolCallNudge`) as the next user turn and
    continues, rather than treating "no tool call" as an error or a
    submission.
    — mechanism `meat/meat.go:109,215-223`. Mechanically exercised as one
    step inside `TestAbridge_HighRetentionDraftIsFallback`'s longer
    sequence; no test in this file independently scripts a bare no-tool-call
    turn and asserts the nudge reaches the *next* call verbatim (see Open
    questions). The nudge's exact text is separately locked down by
    `rubric.md`'s frozen-surface guarantees.

G7. Only `tool_use` content blocks are ever acted on by the loop; `text`
    blocks in an assistant reply are never parsed for diff-like content and
    cannot influence `SmartDiff`. The final `SmartDiff` is derived solely
    from the toolbox's compiled submission against the immutable original
    diff.
    — `meat/meat_test.go:541-564` (`TestAbridge_IgnoresAssistantAuthoredDiffText`:
    a fabricated `diff --git a/invented.go ...` text block alongside a
    legitimate `submit` call leaves no trace of "invented" in the result).
    Mechanism: `meat/meat.go:181-194` (only `tool_use` blocks dispatched)
    and `196-202` (`Result.SmartDiff` always `tb.smartDiff`, set only by the
    `submit` handler — see `tools.md`).

G8. A tool result with `ToolError == true` does not abort the run or discard
    remaining turn budget — it is fed back to the model as an ordinary tool
    result, and the model gets another turn to correct its plan.
    — `meat/meat_test.go:498-539` (`TestAbridge_InvalidEditPlanRetries`: a
    rejected out-of-range `submit`, then a corrected `submit` on the next
    turn succeeds). Mechanism: `meat/meat.go:224` (error and non-error tool
    results appended identically).

G9. When a submitted plan's retention stats cross the high-retention
    threshold (see `tools.md` for the exact formula), the run gets exactly
    one additional "refinement" turn: the first (draft) submission is held
    back as a fallback candidate, the submission state is cleared, and the
    model is given another turn seeded with plan feedback reporting
    "Pressure: high retention" and an exact preview of its own draft. A
    second refinement is never offered, regardless of the second
    submission's own retention.
    — `meat/meat_test.go:219-254` (`TestAbridge_HighRetentionGetsOneRefinementTurn`,
    exactly 2 model calls). Mechanism: `meat/meat.go:196-213` (`canRefine`
    requires `!retentionNudged && turn+1 < maxTurns && ... &&
    retentionPressure(...)`; `retentionNudged` is set `true` unconditionally
    on first use, permanently disabling further refinement in that run).

G10. The one-time refinement offer applies even when the draft submission's
     own preview/plan feedback is itself large enough to be truncated (see
     `tools.md`) — the refinement turn still fires and the model still
     receives a (truncated, explicitly marked) preview.
     — `meat/meat_test.go:256-289` (`TestAbridge_OversizedHighRetentionStillGetsRefinementTurn`,
     100-line/220-byte-per-line diff, tool result fed to the second turn
     contains `"truncated"`).

G11. If the model's `Generate` call errors (e.g. because the per-run
     wall-clock budget expired) after a refinement was already requested,
     `Abridge` returns the held-back fallback candidate (with token counts
     patched in) as a successful result, rather than propagating the error
     — but only if the caller's own context has not itself been canceled.
     — `meat/meat_test.go:291-313` (`TestAbridge_InternalDeadlineReturnsValidFallback`:
     `abridgeBudget` shrunk to 20ms, `res.SmartDiff == diff`, `m.seen ==
     2`; negative case
     `TestAbridge_CallerCancellationStillWinsOverFallback`: the caller's
     context is canceled mid-run by the fake model itself, and `Abridge`
     returns an error, not the fallback). Mechanism: `meat/meat.go:144-146`
     (`callerCtx` captured before the per-run timeout wrap) and the branch
     at `meat/meat.go:167-175` (`if fallback != nil && callerCtx.Err() ==
     nil { return fallback... }` else `fmt.Errorf("meat: model generate:
     %w", err)`).

G12. If the turn budget is exhausted after a refinement was requested but
     the model never resubmits (e.g. only produces prose, nudged but the
     budget runs out), `Abridge` again returns the held-back draft as a
     fallback rather than erroring.
     — `meat/meat_test.go:315-330` (`TestAbridge_HighRetentionDraftIsFallback`,
     `MaxTurns: 2`, second scripted turn is bare text, `res.SmartDiff ==
     diff`). Mechanism: the post-loop fallback path
     `meat/meat.go:227-234` (same `callerCtx.Err()` guard as G11).

G13. `Request.MaxTurns`, when positive, overrides the default turn budget
     (24, see `constants.md`) for that run.
     — mechanism `meat/meat.go:139-142`; relied upon for termination by
     `meat/meat_test.go:323` (`MaxTurns: 2`).

G14. When `Request.Progress` is set, the run emits one message per model
     turn (`"thinking (turn N)"`, 1-based) and one message per tool call,
     using a fixed rendering per tool: `"read_file <path>"`, `` grep
     "<pattern>" ``, `"previewing"` for `preview_plan`, `"submitting"` for
     `submit`. Progress must not block the run (the default when unset is a
     no-op).
     — `meat/meat_test.go:104-133,474-496` (`TestAbridge_PreviewThenSubmit`,
     `TestAbridge_ProgressCallbacks`). Mechanism: `meat/meat.go:156-159`
     (no-op default), `166` (turn message), `186` (per-tool-call message via
     `describeToolCall`, `meat/meat.go:274-295`).

G15. `Request`'s exported field order/shape is unaffected by the chunking
     feature: chunk-internal bookkeeping lives in a separate `runOptions`
     type, not in `Request`, so a positional struct literal
     (`Request{"", diff, 0, nil}`) still compiles and populates
     `UnifiedDiff` correctly.
     — `meat/chunk_test.go:1541-1546`, pinned against `meat/meat.go:62-76`
     (`Request` fields: `RepoRoot, UnifiedDiff, MaxTurns, Progress`) and
     `meat/meat.go:78-90` (`runOptions`, kept separate).

## Constants

| Name | Value | Unit | Citation | Exercised by |
|---|---|---|---|---|
| `defaultMaxTurns` | `24` | turns (model round-trips) | `meat/meat.go:36` | Applies per run (whole diff or one chunk), not per whole abridgement. Overridden via `MaxTurns` in G13's test. |
| `defaultBudget` | `4 * time.Minute` | ns (wall clock) | `meat/meat.go:40` | Same per-run scoping as above. |
| `abridgeBudget` (var, defaults to `defaultBudget`) | shrunk to `20ms` in test | ns (wall clock) | `meat/meat.go:44`; overridden `meat_test.go:292-294` | G11 |

## Mechanism

### 1. `Abridge` — top-level dispatch

`Abridge(ctx, model, req)` runs a fixed gate sequence before any model call
is possible, in this exact order (the order is load-bearing: each step can
short-circuit the rest, and every rejection must happen before
`model.Generate` is ever invoked, per G1–G3):

1. If `model == nil`, return `nil, error("meat: nil model")` —
   `meat/meat.go:116-118`.
2. Trim `req.UnifiedDiff` with Go's Unicode-whitespace trim; if the trimmed
   result is empty, return `&Result{Summary: "No changes."}` (all other
   fields at zero value) without calling the model — `meat/meat.go:119-121`.
   This is not an error path; it is a successful empty result. **[H14]**
3. If `len(req.UnifiedDiff)` (a **byte** length, not a codepoint count)
   exceeds `maxTotalDiffBytes` (4 MiB, `meat/chunk.go:42`), return the
   oversize error (exact text below) — `meat/meat.go:122-124`. **[H1]**
4. Run `validateSupportedDiff(req.UnifiedDiff)`; any structural rejection
   is wrapped as `"meat: %w"` and returned — `meat/meat.go:125-127`.
5. Decide single-run vs. chunked via `fitsSingleRun(req.UnifiedDiff,
   singleRunDiffBytes)`, which checks both the raw byte length and the
   numbered (gutter-prefixed) form's length (see `chunk.md` G41–G42); if it
   doesn't fit, delegate the whole request to `abridgeChunked` and return
   its result directly — `meat/meat.go:128-129`.
6. Otherwise, run `abridgeOne(ctx, model, req, runOptions{})` once, on the
   whole diff, with an empty (zero-value) `runOptions` — `meat/meat.go:131`.

For a chunked run, `abridgeChunked` calls `abridgeOne(ctx, model, sub,
opts)` once per model-visible chunk, passing through the **same,
un-derived** `ctx` it itself received — `meat/chunk.go:963`. That means
"the caller's context" as seen from inside any one chunk's `abridgeOne`
call is still the original caller-supplied context, not something chunking
has already wrapped; each chunk independently derives its own
`abridgeBudget`-bound timeout on top of it (see step 3 of the setup
below).

### 2. `abridgeOne` — per-run setup

Given one single-run-sized diff (the whole input, or one chunk):

1. Compute the numbered (gutter-prefixed) form once, up front, via
   `numberedDiff(req.UnifiedDiff)` — `meat/meat.go:137`. This numbered
   text is embedded in the very first user-turn message only; it is never
   recomputed or re-inserted for later turns (see turn loop, below).
2. Resolve the turn budget: `req.MaxTurns` if `> 0`, else `defaultMaxTurns`
   (24) — `meat/meat.go:139-142`.
3. Capture the incoming context as `callerCtx` **before** deriving anything
   from it, then derive a budget-bound `ctx` via
   `context.WithTimeout(ctx, abridgeBudget)`, deferring its cancel —
   `meat/meat.go:144-146`. From this point every model call and every tool
   dispatch in this run receives the **derived** `ctx`, not `callerCtx`
   (dispatch call site: `meat/meat.go:187`) — so a subprocess-backed tool
   (`git grep`, via `tools.md` G3) is bound by the run's own wall-clock
   budget, not merely by direct caller cancellation. **[H6]**
4. Construct one `toolbox{root: req.RepoRoot, rawDiff: req.UnifiedDiff,
   noMoves: opts.chunkRun, moves: opts.chunkMoves}` and fetch its
   advertised tool list once via `tb.tools()` — `meat/meat.go:148-149`.
   Both the toolbox and the tool list are computed exactly once per run and
   reused unchanged on every turn (the same `tools` value is passed to
   every `model.Generate` call, `meat/meat.go:167`).
5. Seed the conversation with exactly one message — role user, one text
   block built by `buildUserPrompt(req, opts, numbered)` (§7 below) —
   `meat/meat.go:151-154`.
6. Resolve the progress callback: `req.Progress` if set, else a no-op
   `func(string){}` — `meat/meat.go:156-159`.
7. Initialize per-run accumulators: `inTok`, `outTok` (both 0),
   `retentionNudged` (false), `fallback *Result` (nil) —
   `meat/meat.go:161-163`.

### 3. The turn loop — control flow

`for turn := 0; turn < maxTurns; turn++` (0-indexed internally; `turn+1`
is used only for the 1-based progress label — `meat/meat.go:165-166`).
Each iteration proceeds in this fixed order, and the order is load-bearing
at every step marked (†):

1. Progress: `"thinking (turn %d)"` with `turn+1` — `meat/meat.go:166`.
2. **(†) Model call.** `model.Generate(ctx, systemPrompt, messages,
   tools)` — `meat/meat.go:167`. `messages` is the **entire accumulated
   history**, retransmitted whole on every call (this is a stateless-API
   loop, not a server-side conversation); this is what the source comment
   at `meat/meat.go:47-48` means by "sent up front (and re-sent every
   turn)" — the numbered diff is inserted into `messages` exactly once
   (step 2.5 of setup) but its bytes are part of every subsequent
   `Generate` call's payload because the whole slice travels each time.
   This cost is what makes `maxDiffBytes`/chunking necessary in the first
   place.
3. **On error:**
   - **(†)** If `fallback != nil` **and** `callerCtx.Err() == nil` (the
     caller's own context, not the run's derived one, has *not* been
     canceled): patch `fallback.InputTokens`/`fallback.OutputTokens` to
     the current cumulative totals and return `fallback, nil` —
     `meat/meat.go:169-173`. **[H5]**
   - Otherwise return `nil, fmt.Errorf("meat: model generate: %w", err)`
     — `meat/meat.go:174`. Wrapping with `%w` preserves the underlying
     error's identity (e.g. `context.DeadlineExceeded` vs.
     `context.Canceled`) through `errors.Is`/`errors.As` for any caller
     that inspects it. **[H5]**
4. **On success:** `inTok += resp.InputTokens; outTok += resp.OutputTokens`
   — `meat/meat.go:176-177` (G5).
5. **(†)** Append the assistant's reply (`resp.Content`, unexamined — may
   contain `text`, `tool_use`, and/or opaque `provider_state` blocks) to
   `messages` as one assistant-role message. This happens **before** any
   tool is dispatched and **before** the submission decision below —
   `meat/meat.go:179`.
6. **(†) Tool dispatch.** Iterate `resp.Content` in the model's emitted
   order; skip every block whose `Type != "tool_use"` entirely (never
   parsed, never inspected for diff-like text — G7) —
   `meat/meat.go:181-185`. For each `tool_use` block: emit a progress
   message via `describeToolCall(b)` (§8) **before** running the tool,
   then call `tb.run(ctx, b.ToolName, b.ToolInput)` and append one
   `tool_result` block (`ToolUseID`, `ToolResult` text, `ToolError` bit)
   to a local `results` slice — `meat/meat.go:186-193`. An erroring tool
   result (`ToolError == true`) is appended identically to a successful
   one; nothing here branches on `isErr` (G8).
7. **(†) If a submission was accepted this turn** (`tb.submitSeen`, set
   only by a successful `submit` inside step 6):
   - Build `candidate := &Result{SmartDiff: tb.smartDiff, Summary:
     tb.submitted.Summary, InputTokens: inTok, OutputTokens: outTok}` —
     `meat/meat.go:197-202`.
   - Compute `canRefine := !retentionNudged && turn+1 < maxTurns &&
     tb.submittedPlan != nil && retentionPressure(tb.submittedPlan.stats)`
     — `meat/meat.go:203-204`. All four conjuncts are required:
     - `!retentionNudged` — a refinement has never already been offered
       in this run (this is what makes the offer *exactly one per run*,
       not "one per high-retention submission").
     - `turn+1 < maxTurns` — at least one turn slot remains after this
       one; refinement shares the run's ordinary turn budget, it does not
       add to it.
     - `tb.submittedPlan != nil` — a defensive nil-guard before
       dereferencing `.stats`; see **[H15]** below.
     - `retentionPressure(tb.submittedPlan.stats)` — the compiled plan's
       retention stats cross the threshold (`tools.md` G1).
   - **If `canRefine`:** `fallback = candidate`; `retentionNudged = true`
     (latched for the rest of the run — a second high-retention submission
     later cannot trigger a second refinement, regardless of its own
     stats); `tb.clearSubmission()` (resets
     `submitSeen`/`submitted`/`submittedPlan`/`smartDiff`/`submitFeedback`
     to zero values — `meat/tools.go:292-298` — so the next `submit` call
     is accepted rather than rejected as a duplicate, `meat/tools.go:226-227`);
     append `results` (which already contains the just-submitted plan's
     own feedback text — the `"Pressure: high retention…"` phrasing and a
     full preview of the draft, `meat/tools.go:260,282-283,287-288`) as
     the next user-role message; `continue` — `meat/meat.go:205-211`.
   - **Otherwise:** return `candidate, nil` immediately —
     `meat/meat.go:212`. The `results` computed in step 6 are discarded;
     the function returns before they would ever be appended to
     `messages`.
8. **(†) Else, if no tool was dispatched at all this turn**
   (`len(results) == 0` — the reply was text-only): append the fixed
   `noToolCallNudge` text as the next user-role message and `continue` —
   `meat/meat.go:215-223` (G6).
9. **(†) Else** (one or more non-submitting tool calls happened —
   `read_file`, `grep`, `preview_plan`, or a rejected `submit`): append
   `results` as the next user-role message and `continue` —
   `meat/meat.go:224`.

**Post-loop** (reached only when the `for` condition `turn < maxTurns`
becomes false — i.e. every one of `maxTurns` iterations completed a
successful `Generate` call without returning early):

10. If `fallback != nil`: check `callerCtx.Err()`. If non-nil, return
    `nil, fmt.Errorf("meat: caller context: %w", err)` —
    `meat/meat.go:227-230`. **[H5]** Otherwise patch `fallback`'s token
    fields to the final cumulative totals and return it —
    `meat/meat.go:231-233`.
11. If `fallback == nil`, return `nil, fmt.Errorf("meat: agent did not
    submit within %d turns", maxTurns)` — `meat/meat.go:235`.

### 4. The retention-nudge / refinement mechanism

The refinement offer is not a separate code path — it is the single
branch at turn-loop step 7 ("If `canRefine`"). It is offered at most once
per run because `retentionNudged` is a run-scoped flag set unconditionally
the first (and only) time the branch is taken (`meat/meat.go:207`); no
later high-retention submission in the same run can re-trigger it, no
matter how much higher its own retention. The exact retention formula
lives in `tools.md` (G1); this file only composes the boolean gate.

The `turn+1 < maxTurns` conjunct exists to avoid offering a refinement
with no turn left to use it: if it were offered anyway at the last
possible turn, the very next loop condition check would be false, the
loop would exit immediately without another `Generate` call, and the
post-loop fallback path (step 10) would return the identical `candidate`
— so omitting the guard would not change the *result*, only route it
through a different, more wasteful path (a discarded `clearSubmission()`).
The guard is a correctness/clarity optimization, not something that
changes final output.

### 5. The fallback mechanism

`fallback` is written exactly once per run, only inside the refinement
branch (step 7), and is read at exactly two sites — the mid-loop
`Generate` error branch (step 3) and the post-loop exhaustion branch (step
10) — both gated on `callerCtx.Err()`, never on the derived `ctx`'s own
error, which is what lets the run distinguish "our own budget expired"
from "the caller cancelled us" (**H5**, `meat/meat.go:169,228`).

What it captures: `SmartDiff` and `Summary` are frozen at the moment the
draft was submitted (step 7's `candidate` construction) and never change
afterward — they are **not** re-derived from any later, failed refinement
attempt. `InputTokens`/`OutputTokens`, by contrast, are **not** frozen:
both read sites overwrite them with the accumulators' *current* value at
the moment of return (`meat/meat.go:170-171,231-232`), which is the true
cumulative total through the last successful `Generate` call in the run —
including any refinement-turn cost incurred after the draft, even though
that turn's output was ultimately discarded. So a returned fallback's
token counts reflect real spend beyond the draft turn, while its diff
content does not reflect anything past the draft turn. This split is
fully determined by the code but not independently pinned by any test
(see Open questions).

### 6. Progress reporting

The default (unset `Progress`) is a genuine no-op, never invoked with
meaningful cost — `meat/meat.go:156-159`. When set, it receives exactly
one message per turn (`"thinking (turn %d)"`, 1-based) and one message per
dispatched tool call, in dispatch order, interleaved with the turn message
that precedes them within the same iteration — `meat/meat.go:166,186`.

### 7. `buildUserPrompt` — first-turn message assembly

Only the very first user message is built this way; nothing later in the
loop re-derives it. Fragment order (`meat/meat.go:250-270`):
1. `userPromptIntro` then `userPromptImports` (fixed text; exact strings
   owned by `rubric.md`) — `meat/meat.go:252-253`.
2. Moves: for a whole-diff run, `detectedMovesInDiff(req.UnifiedDiff)` is
   computed fresh; for a chunk run (`opts.chunkRun`), the already-chunk-mapped
   `opts.chunkMoves` is used instead and moves are never independently
   re-detected from the chunk's own (partial) text — `meat/meat.go:254-257`.
   If any moves exist, `userPromptMoves` is formatted with
   `formatMovePairs(moves, maxMoveHints)` (`maxMoveHints = 12`,
   `meat/moves.go:14`) — `meat/meat.go:258-260`.
3. Tool guidance: `userPromptTools` if `req.RepoRoot != ""`, else
   `userPromptNoTools` — `meat/meat.go:261-265`.
4. `userPromptProtocol`, then the numbered diff text itself, then a
   closing fence — `meat/meat.go:266-269`.

The exact static strings are `rubric.md`'s responsibility (frozen-surface
hashing, `promptSurface`); this fragment only owns the assembly order and
which branches fire under which conditions.

### 8. `describeToolCall` — progress-string rendering

A pure, side-effect-free rendering of one `tool_use` block into a short
string, independent of and prior to actual tool dispatch
(`meat/meat.go:274-295`):
- `read_file` → `json.Unmarshal(b.ToolInput, &in)` into a `{Path}` struct,
  **ignoring any unmarshal error**, then `"read_file " + in.Path`
  (trimmed) — `meat/meat.go:276-281`. A malformed `ToolInput` here
  silently yields `"read_file "` (empty path) for progress purposes; the
  actual tool dispatch (`tb.run`, step 6 above) performs its own,
  error-checked unmarshal independently.
- `grep` → same ignore-error unmarshal into `{Pattern}`, then
  `fmt.Sprintf("grep %q", in.Pattern)` (trimmed) — `meat/meat.go:282-287`.
  Go's `%q` applies Go-syntax quoting/escaping, not a plain quote-wrap;
  for ASCII patterns without quotes/backslashes this is indistinguishable
  from `"pattern"`, but a pattern containing a `"` or control character
  renders with Go-specific escapes. This only affects the human-readable
  progress string, not any programmatic behavior.
- `preview_plan` → fixed string `"previewing"` — `meat/meat.go:288-289`.
- `submit` → fixed string `"submitting"` — `meat/meat.go:290-291`.
- anything else → the raw tool name, `b.ToolName`, unmodified —
  `meat/meat.go:292-293`. (Reachable only if a real, non-scripted model
  calls an unadvertised tool name; the toolbox's own dispatch
  (`tools.go:116-117`) independently returns `"unknown tool %q"` as the
  tool result, so this is a parallel, cosmetic-only fallback for the
  progress string.)

### Data shapes

- **`Request`** — a whole-diff abridgement request: a repo-root path
  (empty disables `read_file`/`grep`), the required raw unified-diff text,
  an optional per-request turn-count override (`> 0` overrides the
  default), and an optional progress callback that must not block the run
  — `meat/meat.go:57-76`.
- **`runOptions`** — chunk-internal state kept deliberately outside
  `Request` so embedders' struct literals stay source-compatible across
  the chunking feature (G15): a flag marking this as one chunk's own agent
  run (which disables the toolbox's own move re-detection), and the
  whole-diff-detected moves whose both sides land in this chunk, already
  translated into that chunk's coordinates — `meat/meat.go:78-90`.
- **`Result`** — the abridged reading diff: the compiled diff text (empty
  when nothing meaningful survives), a one-line summary, and cumulative
  input/output token counts across the whole run — `meat/meat.go:92-105`.
- **`Message`/`Block`/`Response`/`Tool`** — provider-agnostic conversation
  types (owned by `model.go`, used but not defined here): a `Message` is a
  role plus a list of `Block`s; a `Block`'s meaningful fields depend on its
  type tag (`text`, `tool_use`, `tool_result`, or an opaque
  `provider_state` the agent loop never inspects, only relays); a
  `Response` is one model reply plus its token counts; a `Tool` is a
  name/description/JSON-schema triple — `meat/model.go:8-68`.
- **`toolbox`** (owned by `tools.go`, driven here) — per-run mutable
  state: the confinement root, the immutable raw diff, the compiled
  `smartDiff`/`submission`/`compiledPlan` once a submission is accepted, a
  `submitSeen` latch, and the move-detection override for chunk runs —
  `meat/tools.go:24-38`.
- **`submission`/`compiledPlan`/`planStats`** (owned by `editplan.go`) — a
  submission is a remove/replace/fold plan plus a summary; a compiled plan
  is that plan's rendered `smartDiff`, its retention `planStats` (raw vs.
  visible changed-row counts, removed/folded counts, fold count, file
  counts), and any moves it satisfies — `meat/editplan.go:58-63,108-122`.
  `meat.go` reads `compiledPlan.stats` (for `retentionPressure`) and
  `compiledPlan.smartDiff`/`submission.Summary` (for the `Result`), but
  does not itself construct or validate these — that is `tools.go`'s and
  `editplan.go`'s job.

## Invariants

- **`callerCtx` must be captured strictly before the budget timeout is
  derived.** Breaking this (e.g. capturing it after
  `context.WithTimeout`) collapses the two abort signals into one, and
  the fallback-vs-hard-error distinction (G11, G12) becomes
  unobservable — every deadline would look like a cancellation and vice
  versa. `meat/meat.go:144-146`. **[H5, H6]**
- **`fallback` is written at most once per run.** `retentionNudged` is
  set unconditionally, permanently true the first time refinement is
  offered (`meat/meat.go:207`); there is no code path that overwrites an
  already-set `fallback` with a later draft. Breaking this would let a
  later, possibly worse, draft silently replace an earlier one as the
  safety net.
- **`tb.clearSubmission()` must run before the loop continues into a
  refinement turn.** Without it, `tb.submitSeen` would still be `true`,
  and the model's next `submit` call would be unconditionally rejected
  with `"a submission has already been accepted"`
  (`meat/tools.go:226-227`), making the refinement offer unusable.
  `meat/meat.go:208`.
- **The assistant's reply is appended to history before tool dispatch and
  before the submission decision, on every turn, unconditionally.**
  `meat/meat.go:179` precedes `181-213`. This ordering does not change
  what a port must reimplement functionally (the function still returns
  before an unused `results` would matter), but a port that dispatches
  tools before recording the model's own turn would build a different
  `messages` history if it were ever inspected mid-run (e.g. by a caller
  streaming state), even though today no caller does.
- **The tool schema list passed to `model.Generate` is fixed for the
  run's whole duration**, computed once (`meat/meat.go:149`) and reused
  unchanged on every call (`meat/meat.go:167`) — it does not shrink or
  grow in response to `submitSeen`/`clearSubmission` state changes
  mid-run.
- **The `ctx` used for tool dispatch is the run's derived, budget-bound
  context, not `callerCtx`.** `meat/meat.go:187` passes the
  timeout-wrapped `ctx`, so tools that shell out to a subprocess (`git
  grep`, `tools.md` G3) are killed at the run's own deadline. **[H6]**
- **`resp.Content` is relayed into history verbatim, untransformed,
  including any `provider_state` blocks.** The loop never reconstructs or
  re-serializes a `Block` before appending it (`meat/meat.go:179`); this
  is what lets an opaque `ProviderData` payload (H4, owned by
  `openai.go`/`anthropic.go`/`model.go`) survive a later turn unmodified,
  even though `meat.go` itself never reads or writes that field.

## Hazards

- **H1** — `len(req.UnifiedDiff)` at `meat/meat.go:122` and the
  `strings.TrimSpace` emptiness check at `meat/meat.go:119` are both
  byte-based Go string operations; a JS port using `.length`/`.trim()` on
  a UTF-16 string will misjudge size and emptiness for any diff
  containing non-ASCII text. The oversize error's `%dMB` figures
  (`meat/meat.go:123`) are computed via `>>20` (right-shift), an exact
  byte-count-to-MiB truncation — a port must replicate the truncation
  (`Math.trunc`/integer-division), not round.
- **H5** — `meat/meat.go:169` (`fallback != nil && callerCtx.Err() ==
  nil`) and `meat/meat.go:228` (`if err := callerCtx.Err(); err != nil`)
  are the two sites that must distinguish "caller cancelled" from "our
  own budget expired." Both check the *outer*, pre-timeout context, never
  the derived one. A port needs two independently observable abort
  signals (an inner timeout-derived signal plus the original
  caller-supplied one), not one signal reused for both checks —
  collapsing them silently breaks G11/G12.
- **H6** — `defaultMaxTurns`/`defaultBudget` (`meat/meat.go:36,40`) and
  the `abridgeBudget`/`singleRunDiffBytes` test-injection seams, declared
  as `var` rather than `const` specifically so tests can shrink them
  (`meat/meat.go:44,55`), need equivalent seams in the port or the
  deadline/fallback tests (G11, G12, `chunk.md` G42) cannot be ported.
  The `context.WithTimeout` composition at `meat/meat.go:145` (fires on
  its own deadline *or* the parent's cancellation) needs
  `AbortSignal.any([...])` or equivalent.
- **H14** — `strings.TrimSpace(req.UnifiedDiff) == ""` at
  `meat/meat.go:119` decides whether the whole run short-circuits to
  `"No changes."` without ever calling the model. Go's trim set includes
  U+0085 (NEL) but not U+FEFF; JS's `.trim()` is the reverse. A diff that
  is, say, a lone BOM byte would be judged empty by Go and non-empty by a
  naive JS `.trim()` port (or vice versa for a lone NEL). No fixture in
  the test suite exercises either codepoint at this boundary.
- **H15** — `tb.submittedPlan != nil` at `meat/meat.go:204` gates whether
  `retentionPressure(tb.submittedPlan.stats)` is even evaluated. In the
  current source this check is always true whenever it's reached
  (`tb.submitSeen` — the enclosing `if` at `meat/meat.go:196` — and
  `tb.submittedPlan` are always set together, atomically, by `tools.go`'s
  `submit`, `meat/tools.go:240-244`, and always cleared together by
  `clearSubmission`, `meat/tools.go:292-298`), so the guard is currently
  redundant in practice but structurally load-bearing: it is the only
  thing standing between this line and a nil-pointer panic (`.stats`
  field access on a nil `*compiledPlan`) if that invariant were ever
  broken elsewhere. A port using a nullable type for the compiled-plan
  state must keep an explicit null check here rather than assuming a
  type system's non-null guarantee makes it unreachable.

## Errors

Every failure mode `Abridge`/`abridgeOne` can return, with exact text:

- Nil model: `"meat: nil model"` — `meat/meat.go:117`.
- Oversize diff: `` "meat: diff is %dMB, over the %dMB limit — try a
  narrower range (a single commit, or per-file with `git diff -- <path> |
  meat`)" `` — `meat/meat.go:123`.
- Structural validation failure: `"meat: %w"` wrapping
  `validateSupportedDiff`'s error (exact per-case text owned by
  `diff.md`) — `meat/meat.go:126`.
- Model call failure (no usable fallback): `"meat: model generate: %w"`
  wrapping the underlying error — `meat/meat.go:174`.
- Caller cancelled while a fallback existed: `"meat: caller context: %w"`
  wrapping `callerCtx.Err()` — `meat/meat.go:229`.
- Turn budget exhausted, no fallback ever captured: `"meat: agent did not
  submit within %d turns"` — `meat/meat.go:235`.

Not an error: an empty/whitespace-only diff returns a successful
`&Result{Summary: "No changes."}` — `meat/meat.go:120`.

## Ordering that Go leaves unspecified

None found within `meat.go` itself. The turn loop is a single, strictly
sequential `for` loop over an incrementing integer (`meat/meat.go:165`),
and the only iteration over model output is a `for range` over
`resp.Content`, a slice whose order is exactly the order the `Model`
implementation produced (`meat/meat.go:182`) — preserved, not reordered.
This file declares no maps and calls no sort. Any nondeterminism reaching
a caller of `Abridge` originates upstream, inside a specific `Model`
implementation (e.g. `openai.go`'s streaming-reassembly map, H13) or
inside the toolbox/compiler files (`tools.go`, `editplan.go`, `moves.go`)
that `meat.go` merely calls — those are out of this fragment's scope.

## Open questions

- **Plain turn-exhaustion-without-fallback error path is not exercised.**
  `meat/meat.go:235` (`"meat: agent did not submit within %d turns"`) is
  only reachable when the turn budget runs out *and* no fallback was ever
  set (retention pressure never tripped). Every turn-exhaustion scenario in
  `meat_test.go` goes through the fallback branch instead (G12). No test
  asserts on the literal exhaustion error text or its exact turn count.
- **The no-tool-call nudge's exact delivery is not independently verified**
  — see G6.
- **Double-submission rejection is untested anywhere in this package's
  test files** — `meat/tools.go:226-227` (`"a submission has already been
  accepted"`, gated by `tb.submitSeen`) has no covering test; no scripted
  sequence calls `submit` twice in one run.
- **`unknown tool` dispatch fallback is untested**
  (`meat/tools.go:116-117`, `"unknown tool %q"`) — since `scriptedModel`
  only ever emits tool calls the test author wrote by hand, this path can
  only be hit by a real model calling something unadvertised.
- **Could not confirm an exact expected token sum is deliberately avoided**
  in `TestAbridge_ReadThenSubmit` (checks non-zero, not the knowable exact
  sum of 200/40 for 2 turns) — flagging as likely-deliberate loose coupling
  to the per-turn constant, not a coverage gap.
- **The fallback's token-count semantics are not independently pinned.**
  G11/G12 say "with token counts patched in" but no test asserts that the
  *value* patched in is the full cumulative total through the point of
  failure (including any tokens burned on a refinement turn whose output
  was then discarded) rather than, say, the totals frozen at the moment
  the draft was captured. The mechanism (`meat/meat.go:170-171,231-232`)
  always uses the live accumulators, not a frozen snapshot — documented
  exactly under Mechanism §5, but untested at that precision.
- **The `turn+1 < maxTurns` refinement-suppression boundary is untested.**
  No fixture drives a high-retention submission on the literal last
  available turn (`turn+1 == maxTurns`) to confirm refinement is
  correctly *not* offered there and the draft is returned as-is via the
  immediate-return path (`meat/meat.go:212`) rather than via the
  post-loop fallback path (`meat/meat.go:231-233`) — both currently
  produce the same observable `Result`, but a future change to either
  path could silently diverge them without any test catching it.
- **A same-turn double `submit` (two `tool_use` blocks both named
  `submit` in one reply) is unexercised.** The dispatch loop
  (`meat/meat.go:181-194`) would process both sequentially against the
  same stateful `toolbox`; the second would hit `tools.go`'s "a
  submission has already been accepted" rejection. No scripted test
  constructs a single response with two `submit` blocks.
- **`describeToolCall`'s silent-ignore of a malformed `ToolInput`**
  (`meat/meat.go:280,286`, unchecked `json.Unmarshal`) is unexercised —
  no test sends malformed JSON in a tool call to confirm the progress
  string degrades to `"read_file "`/`` grep "" `` while the actual
  dispatch (`tools.go`) still correctly reports an `"invalid input"` tool
  error.
- **Stage 2 reconciliation:** all 15 existing guarantees (G1–G15) were
  re-verified against `meat/meat.go`'s source and confirmed with no
  contradictions; the gaps above are untested mechanism, not
  source/guarantee disagreements. No dead or unreachable code was found
  in `meat.go` — every branch is reachable via some combination of caller
  inputs, though several (`meat/meat.go:235` plain exhaustion,
  `meat/meat.go:229` caller-cancelled-with-fallback,
  `describeToolCall`'s `default` case at `meat/meat.go:292-293`) are
  reachable but untested by the current suite.
