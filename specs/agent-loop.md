# agent-loop

> Status: stage 1 ✅ | stage 2 ⬜
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
