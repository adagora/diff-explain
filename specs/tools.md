# tools

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `meat/tools.go`
> Go tests: `meat/meat_test.go` (17 of 29 tests touch the toolbox)

## Purpose

The agent's toolbox: `read_file`, `grep` (via `git grep`), `preview_plan`,
`submit`, confined to the repo root and bounded at a fixed per-result byte
cap. This subject covers the tools' own behavior — schemas, validation,
path confinement, truncation — as distinct from the loop that calls them
(`agent-loop.md`).

## Vocabulary

- **Retention pressure** — a boolean computed from a compiled plan's
  `planStats` (`rawChanged`, `visibleChanged`) that signals "the plan is
  keeping too much" and should trigger one refinement pass (see
  `agent-loop.md` G9). See G1 below for the exact formula and boundary
  values.
- **Retention / visible changed rows** — in plan feedback, "N/M visible
  changed rows" reports how many of the diff's `M` raw changed (`+`/`-`)
  lines survive as fully visible after the plan is applied (`N`); a folded
  range contributes 0 to `N` for its interior lines but the fold's own
  placeholder row adds 1 back — folding a block still leaves one visible
  row representing it.
- **Preview vs. submit** — `preview_plan` compiles and renders a plan's
  effect (including retention feedback) without recording it as the final
  answer; `submit` performs the same compilation but additionally records
  the result as the run's output and prevents further submissions in that
  run. Both take an identical plan shape (`remove`/`replace`/`fold`); only
  `submit` additionally requires a `summary`.

## Guarantees

G1. `retentionPressure` is `false` whenever `rawChanged < 40` or
    `visibleChanged < 20`; otherwise it is `true` iff `visibleChanged >= 80`
    **or** `visibleChanged*100 >= rawChanged*45` (i.e. visible retention at
    or above 45%). Exact boundary cases: `{39,39}` → false (below raw
    floor); `{100,19}` → false (below visible floor); `{100,44}` → false
    (44% &lt; 45%); `{100,45}` → true (exactly the threshold); `{200,80}` →
    true (visible-changed absolute-80 floor).
    — `meat/meat_test.go:189-205` (`TestRetentionPressure`). Mechanism:
    `meat/tools.go:248-253`.

G2. Without a `RepoRoot`, the toolbox advertises exactly two tools, in this
    order: `preview_plan`, then `submit` — `read_file`/`grep` are not
    offered at all.
    — `meat/meat_test.go:332-344` (`TestAbridge_NoRepoOffersPlanTools`).
    Mechanism `meat/tools.go:84-87`.

G3. `grep` runs as `git grep -n -I --no-color -e <pattern> [-- <path>]`
    scoped to the toolbox's repo root, and its textual result includes
    matching file names.
    — `meat/meat_test.go:346-357` (`TestToolboxGrepAndPathConfinement`,
    fixture repo, searching `func Foo`, result contains `a.go`). Mechanism
    `meat/tools.go:173-201`.

G4. `read_file` (and any path-taking tool) rejects a path that would escape
    the repo root (e.g. `../../../etc/passwd`) as an error, rather than
    reading it.
    — `meat/meat_test.go:359-362`. Mechanism `meat/tools.go:123-140`
    (`resolveInRoot`: cleans the path, rejects absolute paths, requires the
    resolved absolute path to equal or be a strict child of the resolved
    root).

G5. `preview_plan` validates and renders a plan's projected reading diff and
    retention feedback, but never mutates the toolbox's submission state
    (`submitSeen`, `submitted`, `smartDiff` all remain at their zero
    values) — it can be called any number of times without side effects on
    the eventual submission. The exact rendered feedback for a 4-line
    all-added hunk with one 2-line fold is `"Retention: 3/4"` and contains
    `"hidden by 1 folds"`, `"+    ..."`, and `"+    assert result"` (the
    fold's own placeholder row counts as one visible row in addition to the
    truly-unhidden rows).
    — `meat/meat_test.go:566-580` (`TestPreviewPlanShowsExactFoldAndDoesNotSubmit`).
    Mechanism: `meat/tools.go:210-223` (no toolbox field written);
    `meat/editplan.go:501-529` (the second loop at 522-527 credits each
    `+`/`-`-polarity fold with one visible row).

G6. The `submit` tool's JSON schema requires `remove`, `replace`, and `fold`
    arrays (plus `summary`) and does not accept a model-authored
    `smart_diff` field at all.
    — `meat/meat_test.go:582-593` (`TestSubmitToolUsesEditPlanSchema`:
    schema string must not contain `"smart_diff"`, must contain `"remove"`,
    `"replace"`, `"fold"`, `"start_line"`, `"old"`, `"new"`). Mechanism
    `meat/tools.go:75-81,40-63`.

G7. Submitting a legacy payload containing `smart_diff` is rejected with an
    error containing `"unknown field"`, and no submission is recorded.
    — `meat/meat_test.go:595-604` (`TestSubmitRejectsLegacySmartDiff`).
    Mechanism: `decodeStrict` (`meat/tools.go:300-313`) uses a strict JSON
    decoder that disallows unknown fields, invoked from `submit`
    (`meat/tools.go:230-232`).

G8. `submit` (and by the same code path, `preview_plan`) requires `remove`,
    `replace`, and `fold` to all be present as JSON arrays (`[]` when
    empty, never `null` or omitted) — any of them being `null`/absent
    produces an error containing `"must all be JSON arrays"`.
    — `meat/meat_test.go:606-619` (`TestSubmitRequiresEditArrays`, four
    cases). Mechanism `meat/tools.go:203-208,233-235`.

G9. However large the set of independently-detectable validation errors in
    a submitted plan, the textual error returned by `submit` is bounded to
    the same tool-output cap as any other tool result (`maxToolOutput`),
    with an explicit `"truncated"` marker appended — pathological
    validation-error volume cannot itself blow the model's context.
    — `meat/meat_test.go:621-638` (`TestSubmitTruncatesValidationErrors`,
    2000 invalid `replace` entries, `len(out) <= maxToolOutput+100`,
    `"truncated"` present). Mechanism: `meat/tools.go:236-239` wraps the
    aggregated validation error (`joinEditPlanErrors`,
    `meat/editplan.go:531-539`) through `truncateForTool`
    (`meat/tools.go:350-359`).

G10. A rejected `submit` call (invalid arrays, unknown field, or a failed
     plan compile) never sets `submitSeen`.
     — `meat/meat_test.go:601-603`; implied by
     `TestAbridge_InvalidEditPlanRetries`'s two-call sequence
     (`agent-loop.md` G8).

## Mechanism

### Toolbox state

A `toolbox` is per-run state: the confinement root (empty string means "no
filesystem access" — see below), the immutable raw diff text the plan is
compiled against, the current reading-diff text (`smartDiff`, empty until a
successful `submit`), the last accepted submission and its compiled form,
the last submit's rendered feedback text, a one-shot `submitSeen` flag, and
two move-detection knobs — `noMoves` and a caller-provided move set — used
only by chunk runs (`meat/tools.go:21-38`). It is constructed once per run
at `meat/meat.go:148`, which is also where `noMoves`/`moves` are wired to
chunk state; that wiring is `chunk.md`/`agent-loop.md` territory, not
repeated here.

### Tool advertisement

`tools()` returns the schemas passed to `Model.Generate`. If `root == ""`,
exactly two tools are advertised, in order `preview_plan`, `submit`
(`meat/tools.go:84-87`; this is G2). Otherwise exactly four, in order
`read_file`, `grep`, `preview_plan`, `submit` (`meat/tools.go:88-101`). The
gate is a plain empty-string check on `root`, not a filesystem check (e.g.
"does this directory exist") — an empty `RepoRoot` in the `Request` is the
only signal.

### Dispatch

`run(ctx, name, input)` is a name switch to one of four handlers, each
returning `(text, isError)`; an unrecognized name returns
`fmt.Sprintf("unknown tool %q", name)` as an error result rather than
panicking (`meat/tools.go:106-119`). Only `grep` receives `ctx` —
`readFile`, `previewPlan`, and `submit` take no context and cannot be
cancelled mid-call; `ctx` only ever reaches a single call site, the `git`
subprocess (`meat/tools.go:109-115,173,188`). This is the exact scope H6
must cover for this file: the loop's per-turn/per-run cancellation only
needs to reach the `grep` dispatch, nothing else in this file blocks.

### Path confinement (`resolveInRoot`) — H10

`resolveInRoot(rel)` is the sole gate between model-supplied path strings
and the filesystem or `git`. It runs as this exact sequence
(`meat/tools.go:123-140`):

1. `clean := filepath.Clean(rel)` — collapse `.`/`..`/redundant separators
   lexically, without touching the filesystem.
2. If `clean` is an absolute path, reject with `"path must be relative to
   the repo root"`. This test is on the *cleaned* path, so `Clean` running
   first is load-bearing: it's what turns a merely-odd input into
   something `IsAbs` can classify correctly.
3. Resolve the confinement root itself to an absolute path (`rootAbs =
   filepath.Abs(root)`); propagate any error unwrapped.
4. Resolve the candidate to an absolute path by joining it under the
   *unresolved* root and cleaning again (`absAbs =
   filepath.Abs(filepath.Join(root, clean))`); propagate any error
   unwrapped.
5. Reject with `"path escapes the repo root"` unless `absAbs` is exactly
   `rootAbs`, or `absAbs` has `rootAbs + separator` as a literal string
   prefix.
6. Otherwise return `absAbs`.

No step resolves symlinks — `filepath.Abs` is lexical only (H10's explicit
decision: a symlink inside the root pointing outside it is not blocked,
and porting with `fs.realpath` would *add* a check Go doesn't have and
change behavior). The separator in step 5 is the OS path separator, so the
prefix check itself is platform-dependent the same way Go's is — this is
the one place H10 says the port must enumerate which edge cases are
actually pinned by tests rather than inventing new ones: the only test
case exercised anywhere is `../../../etc/passwd` against a real repo root
(`meat/meat_test.go:359-362`, backing G4). Absolute-path rejection,
trailing-slash inputs, and an empty path (`Clean("") == "."`, which
resolves *to* the root itself and is therefore accepted, not rejected) are
mechanism-only, unpinned by any test.

`resolveInRoot` is called twice: `readFile` uses its returned absolute
path directly for `os.ReadFile` (`meat/tools.go:153`); `grep`'s optional
`path` argument is validated the same way but the **absolute return value
is discarded** — the unresolved, model-supplied relative string is what's
actually appended as `git`'s pathspec argument (`meat/tools.go:183-186`).
Confinement for `grep` therefore depends entirely on step 2/5 correctly
rejecting bad inputs, since the argument that reaches `git` afterward is
not the validated form; git itself then resolves that pathspec relative to
`cmd.Dir = tb.root`.

### `read_file`

Schema (`meat/tools.go:90-93`): object with required `path` (string) and
optional `start_line`/`end_line` (integers, **no JSON-Schema minimum** —
unlike the edit-plan schemas below — and no `additionalProperties: false`,
so the schema itself doesn't forbid extra keys).

Decode is **lenient**: `json.Unmarshal(raw, &readFileInput{...})`
(`meat/tools.go:150`) — unknown JSON keys are silently ignored, missing
keys zero-value (`Path=""`, `StartLine=0`, `EndLine=0`). Contrast with
`preview_plan`/`submit` below.

1. Lenient decode; on error, `fmt.Sprintf("invalid input: %v", err)`
   (error).
2. `resolveInRoot(path)`; on error, the confinement error is returned
   **verbatim**, with no `"invalid input:"` prefix (`meat/tools.go:155`).
3. `os.ReadFile(abs)`; on error, `fmt.Sprintf("read %s: %v", in.Path,
   err)` — note this reports the original (relative, model-supplied)
   path, not the resolved absolute one, and embeds it directly with no
   length bound (see Errors/Invariants below).
4. The file's bytes are interpreted as a Go string with **no UTF-8
   validation** — a binary or malformed file is passed through as-is.
5. If either `StartLine > 0` or `EndLine > 0` (an OR, not AND — supplying
   just one bound is enough to switch modes), the text is re-rendered
   through `sliceLines`; otherwise the raw file text is returned
   unmodified, with **no line numbers**.
6. The result is passed through `truncateForTool`.

`sliceLines(text, start, end)` (`meat/tools.go:315-331`): split on `"\n"`
(Go's `strings.Split`, which — for text ending in `\n` — yields one extra
trailing empty element representing the position after the final
newline); clamp `start` up to 1 if less; clamp `end` to `len(lines)` if
less than 1 or greater than `len(lines)`; if `start > len(lines)`, return
`""`; otherwise emit one `"%d\t%s\n"` row per line index from `start` to
`end` inclusive (1-based). If the clamped `start > end` (e.g.
`start_line=10, end_line=2` on a 5-line file), the loop body never
executes and the result is an empty string — silently, not an error.
Because of the trailing-empty-element behavior of `Split`, requesting the
full range of a file that ends in `\n` includes one extra numbered "line"
containing only a tab and newline (e.g. a 2-line file `"a\nb\n"` has
`len(lines) == 3`, and an unbounded range renders a `"3\t\n"` row that
doesn't correspond to real file content).

### `grep` — H6, H12

Schema (`meat/tools.go:94-98`): object with required `pattern` (string, no
`minLength`) and optional `path` (string); no `additionalProperties:
false`. Decode is lenient, same as `read_file` (`meat/tools.go:174-177`).

1. Lenient decode; on error, `"invalid input: %v"`.
2. `strings.TrimSpace(pattern) == ""` → `"pattern is required"` (error).
   H14 applies narrowly here: Go's `TrimSpace` and JS `.trim()` disagree
   on U+0085/U+FEFF, so a pattern consisting solely of one of those
   codepoints would be treated as blank by Go and non-blank by a naive JS
   port.
3. Build argv `["grep", "-n", "-I", "--no-color", "-e", pattern]`.
4. If `path != ""`: run `resolveInRoot(path)` for validation only (return
   value discarded, per above); on error, return that error verbatim; on
   success, append `"--", path` — the **original**, unresolved string —
   to argv.
5. Run `git <argv...>` with `cmd.Dir = root` and `ctx` attached via
   `exec.CommandContext` (`meat/tools.go:188`, the exact H6 site). Only
   stdout is captured (`cmd.Output()`); `git`'s stderr is not attached to
   the error text the model sees.
6. Branch on `len(out) == 0`:
   - if the process exited with `*exec.ExitError` and exit code exactly
     `1` → `"(no matches)"` (success) — git's convention for "ran fine,
     no hits."
   - else if any other non-nil error → `fmt.Sprintf("git grep: %v",
     err)` (error).
   - else (empty output, nil error) → `"(no matches)"` (success).
7. **If `out` is non-empty, `err` is never consulted at all**, regardless
   of its value — success is determined purely by "did stdout contain
   anything." Result: `truncateForTool(capLines(string(out), 200))`.

`capLines(s, 200)` (`meat/tools.go:333-348`): scan `s` line-by-line with a
`bufio.Scanner` whose buffer starts at 64 KiB and caps at 1 MiB per line
(`meat/tools.go:335`, the exact H12 site); emit up to 200 lines verbatim
(each re-terminated with a single `\n`, so a `\r\n`-terminated source line
loses its `\r`); on reaching the 200th, emit `"... (truncated, more than
200 lines)\n"` and stop. **The scanner's error (`sc.Err()`) is never
checked.** If any single output line from `git grep` exceeds the 1 MiB
cap, `Scan()` returns `false` exactly as it would at EOF — the function
silently stops and returns everything accumulated so far, with **no
truncation marker and no error**, indistinguishable from having reached
the genuine end of output. This diverges from H12's general framing
("Exceeding them is an error, not a truncation") for this specific call
site: here it is neither — it's silent data loss.

### `preview_plan` / `submit` — shared plan pipeline

Both consume the plan schema built by `editPlanToolSchema(withSummary)`
(`meat/tools.go:40-63`), which authors JSON Schema text directly rather
than deriving it from a struct:

| Field | Shape | Per-item required | Per-item `additionalProperties` |
|---|---|---|---|
| `remove` | array of `{start_line, end_line}` (integers, schema `minimum: 1`) | both | `false` |
| `replace` | array of `{line}` (integer, `minimum: 1`), `{old}` (string, `minLength: 1`), `{new}` (string, no length floor — may be empty) | all three | `false` |
| `fold` | array of `{start_line, end_line}` (integers, `minimum: 1`) | both | `false` |
| `summary` (submit only) | string, no schema-level length bound | — | — |

Top level: `additionalProperties: false`; `required` is
`["remove","replace","fold"]` for `preview_plan`,
`["remove","replace","fold","summary"]` for `submit`. Because `summary`
isn't a property at all in the preview variant, a model that includes it
on `preview_plan` violates the schema *and* is independently rejected at
decode time (the Go `editPlan` struct has no `Summary` field, so strict
decoding below rejects it as unknown regardless of what the JSON Schema
layer enforces on the provider side).

Unlike `read_file`/`grep`, both use `decodeStrict` (`meat/tools.go:300-313`):
decode into the target struct with `DisallowUnknownFields`, then attempt
to decode one more JSON value from the same input into an empty struct —
if that second decode succeeds (a value follows), the whole call fails
with `"multiple JSON values"`; if it fails with anything other than
`io.EOF`, that error (typically an "unknown field" message from the first
decode, or a syntax error) is returned. This is what makes `smart_diff` or
any other stray field an outright rejection rather than a silently-ignored
extra (G7).

**`preview_plan`** validation order (`meat/tools.go:210-223`):
1. `decodeStrict` into `editPlan{remove, replace, fold}` → `"invalid
   input: %v"` on failure.
2. `requirePlanArrays` (below) → `"invalid input: " + err` on failure.
3. `compileEditPlanMoves(rawDiff, plan, tb.moves, !tb.noMoves)` — full
   structural/elision/move-symmetry/language validation and reading-diff
   rendering (`editplan.md`/`moves.md`/`python.md` territory) →
   `truncateForTool("invalid edit plan: %v")` on failure.
4. `truncateForTool(planFeedback(compiled))` on success.
5. No `toolbox` field is written on any path (confirms G5).

**`submit`** validation order (`meat/tools.go:225-246`) — note the gate
comes *before* decoding, so a second submission attempt is rejected
without the new payload ever being parsed:
1. `tb.submitSeen` → `"a submission has already been accepted"` (error),
   short-circuiting everything below.
2. `decodeStrict` into `submission{remove, replace, fold, summary}` →
   `"invalid input: %v"`.
3. `requirePlanArrays` → `"invalid input: " + err`.
4. `compileSubmissionMoves(rawDiff, submission, tb.moves, !tb.noMoves)` —
   this additionally validates `summary` (non-blank after trim, ≤500
   bytes, single-line — `meat/editplan.go:634-645`, out of scope here)
   and aggregates both classes of problem through `joinEditPlanErrors`
   (`meat/editplan.go:531-539`: `"edit plan has %d errors:\n- ...\n- ..."`
   when more than one) → `truncateForTool("invalid edit plan: %v")`.
5. On success only, five fields are set together in one block —
   `submitted`, `submittedPlan`, `smartDiff`, `submitFeedback`,
   `submitSeen = true` (`meat/tools.go:240-244`) — before the same
   `truncateForTool(feedback)` text is returned. This atomicity is what
   lets G10 hold: nothing in between a failed compile and the write can
   leave `submitSeen` true without a corresponding valid `smartDiff`.

`requirePlanArrays(remove, replace, fold)` (`meat/tools.go:203-208`)
rejects if any of the three is Go-`nil` — which is what both a JSON
`null` value *and* an entirely absent key decode to; there is no separate
check that distinguishes "missing" from "explicitly null." An empty array
`[]` decodes to a non-nil empty slice and passes. This is the sole
enforcement of the schema's `required` list at the Go layer —
`DisallowUnknownFields` only catches *extra* keys, never *missing* ones,
so without this explicit nil check a plan omitting `remove` entirely
would decode successfully and only fail much later (or not at all).

`clearSubmission()` (`meat/tools.go:292-298`) resets all five submission
fields to zero value. It is not called anywhere in this file; its only
caller is the agent loop's one-time refinement path (`meat/meat.go:208`,
`agent-loop.md` G9) — the toolbox itself never re-arms `submitSeen`.

### Plan feedback rendering (`planFeedback`)

Shared by `preview_plan` and `submit`'s success paths
(`meat/tools.go:264-290`):
1. `percent = visibleChanged * 100 / rawChanged` if `rawChanged > 0`, else
   `0` — integer division, truncates toward zero (H8 applies to this
   specific ratio).
2. Emit `feedbackRetention`: `"Valid source-derived plan.\nRetention:
   %d/%d visible changed rows (%d%%); %d removed, %d hidden by %d folds"`
   filled with `(visibleChanged, rawChanged, percent, removedChanged,
   foldedChanged, foldCount)`.
3. If `rawFiles > 0`, append `"; files %d/%d"` with `(visibleFiles,
   rawFiles)`.
4. Append `".\n"`.
5. If any moves were compiled, append `feedbackMoves`: `"Moves: %d exact
   cross-hunk/cross-file span(s) treated symmetrically (%s).\n"`, where
   `%s` is `formatMovePairs(moves, maxMoveHints=12)`
   (`meat/moves.go:14,464` — `moves.md` territory, not detailed here).
6. Append `feedbackPressureHigh` or `feedbackPressureOK` depending on
   `retentionPressure(stats)` (already specified exactly by G1;
   mechanism at `meat/tools.go:248-253`). The exact advisory text of
   `feedbackPressureHigh` is a frozen surface consumed by `rubric.md`'s
   prompt-hash guarantees — quoted verbatim at `meat/tools.go:260`, not
   reproduced twice here.
7. Append `"Preview (revised plans still use ORIGINAL line
   coordinates):\n"` followed by `compiled.smartDiff` verbatim.

### Truncation — H1, H12

`truncateForTool(s)` (`meat/tools.go:350-359`) is the `maxToolOutput`
(16,384-byte, H1, `meat/tools.go:19`) enforcement point: if `len(s)` (a
**byte** length) is within budget, return unchanged; otherwise walk
backward from byte offset 16384 while `!utf8.RuneStart(s[cut])` to avoid
splitting a multi-byte codepoint (`meat/tools.go:355`, H1's cited
`utf8.RuneStart` use), then return `s[:cut]` with `"\n... (truncated, %d
total bytes)"` appended, where the digit is the **original**,
pre-truncation byte length. The appended marker itself is not counted
against the 16 KiB budget, so a truncated result's actual returned length
is `~16384 + len(marker)` bytes, not capped at exactly 16384 — this is
why G9's test tolerates `len(out) <= maxToolOutput + 100` rather than
asserting exact equality.

**`truncateForTool` is applied selectively, not to every value this file
returns as a tool result.** It wraps: `readFile`'s success text (`:165`),
`grep`'s match-success text (`:200`), and `previewPlan`/`submit`'s
compile-error and success-feedback texts (`:220,222,238,245`). It does
**not** wrap: any JSON-decode error (`:151,176,213,231`),
`requirePlanArrays`' fixed error (`:216,234`), `resolveInRoot`'s two
fixed errors as surfaced from `readFile`/`grep` (`:155,184`), `"pattern
is required"` (`:179`), `"git grep: %v"` (`:196`), `grep`'s `"(no
matches)"` literals (`:193,198`), `"a submission has already been
accepted"` (`:227`), and `run`'s `"unknown tool %q"` fallback (`:117`).
Most of these are fixed-shape strings and therefore self-bounded
regardless. One is not: `readFile`'s `fmt.Sprintf("read %s: %v", in.Path,
err)` (`:159`) embeds the model-supplied `path` string directly, with no
length bound anywhere upstream (the JSON Schema has no `maxLength`;
`resolveInRoot` rejects on absoluteness/escaping, never on length). A
`path` value that is very long but lexically confined (no `..`, not
absolute) passes confinement, then fails `os.ReadFile` (e.g.
`ENAMETOOLONG`), producing an untruncated tool result whose size is
driven entirely by the attacker/model-controlled input. See Invariants
and Open questions below.

## Invariants

- **Path confinement precedes every filesystem/`git` access.**
  `resolveInRoot` runs before `os.ReadFile` (`meat/tools.go:153→157`) and
  before the `git` argv is finalized (`meat/tools.go:183→188`). Breaking
  this ordering (checking after, or on a different string than the one
  actually used) reopens path traversal — this is exactly the property
  H10 exists to protect, and it must be ported as an ordered sequence of
  checks, not "equivalent" checks in a different order.
- **`preview_plan` never mutates toolbox submission state.** No `tb.`
  write appears anywhere in `previewPlan` (`meat/tools.go:210-223`).
  Breaking this would let an arbitrary number of preview calls silently
  finalize a run's answer, contradicting the "Preview vs. submit"
  vocabulary entry and G5.
- **`submit`'s five state fields are written atomically, only after full
  compilation success.** (`meat/tools.go:240-244`.) Writing `submitSeen`
  independently of the other four (or before validation completes) would
  let `submitSeen == true` coexist with a stale or empty
  `smartDiff`/`submitted`, corrupting the run's eventual result.
- **`submitSeen` is monotonic within a run except for the single,
  externally-triggered reset in `clearSubmission`.**
  (`meat/tools.go:226-227,292-298`, called only from `meat/meat.go:208`.)
  A port that lets any code path other than the one-time refinement clear
  it would allow more than one accepted submission per run, contradicting
  G10.
- **`requirePlanArrays` treats "absent" and "explicit null" identically**
  — both decode to a Go nil slice and are rejected the same way
  (`meat/tools.go:204`). A port using a different missing-vs-null
  representation (e.g. `undefined` vs `null` in TypeScript) must collapse
  both to the same rejection, not treat them as distinct cases, since
  Go's JSON decoder does not distinguish them here.

## Hazards

- **H1** (byte budgets, UTF-8 vs UTF-16): `maxToolOutput = 16 * 1024`
  bytes is defined at `meat/tools.go:19`; `truncateForTool`'s cut point is
  a **byte** offset walked back to the nearest UTF-8 rune boundary via
  `utf8.RuneStart` at `meat/tools.go:355`, not a character-count
  truncation. A JS `.slice(0, 16384)` on a UTF-16 string is both the
  wrong unit and can still split a surrogate pair or, differently, a
  UTF-8 multi-byte sequence once decoded — the port must operate on
  bytes here, matching the engine-wide H1 decision.
- **H6** (`context.Context` → `AbortSignal`): the single subprocess call
  site is `exec.CommandContext(ctx, "git", args...)` at
  `meat/tools.go:188`. As noted under Mechanism, this is the *only* place
  in the file that consumes `ctx` — `readFile`, `previewPlan`, and
  `submit` have no cancellation path at all, so the port's `AbortSignal`
  wiring for this file is scoped to exactly one call.
- **H10** (path confinement, port verbatim): the full algorithm is
  `meat/tools.go:123-140`, specified above as an exact six-step sequence.
  Per the hazard register's own prescription, this is the one place a
  "better" implementation (e.g. substituting `fs.realpath`/symlink
  resolution) is explicitly wrong — it changes security properties Go
  deliberately doesn't provide. Only one confinement case is test-pinned
  (`../../../etc/passwd`, `meat/meat_test.go:359-362`); trailing-slash
  and other `Clean`-vs-`path.normalize` divergences are unverified by any
  fixture.
- **H12** (`bufio.Scanner` buffer caps): the 1 MiB per-line cap is set at
  `meat/tools.go:335`. Contrary to H12's general claim that exceeding
  such a cap is "an error, not a truncation," this specific call site
  (`capLines`, `meat/tools.go:333-348`) never inspects `sc.Err()` —
  exceeding the cap silently truncates output with no error and no
  `"truncated"` marker, indistinguishable from ordinary end-of-output. A
  verbatim port that does check the equivalent Node stream error would
  introduce an error path Go does not have here; a port that (like Go)
  drops it silently reproduces the actual — not the documented — Go
  behavior. This is a concrete instance where H12's blanket statement
  needs a per-site caveat.
- **H14** (whitespace trimming): `strings.TrimSpace(in.Pattern) == ""` at
  `meat/tools.go:178` gates the `"pattern is required"` rejection; Go's
  trim set includes U+0085 and excludes U+FEFF, the opposite of JS
  `.trim()`, per the general H14 entry.
- **H8** (integer division): `percent := stats.visibleChanged * 100 /
  stats.rawChanged` at `meat/tools.go:268` truncates toward zero; needs
  `Math.trunc()`/`| 0` in the port, per H8.

## Errors

Exact message text, all verified against source:

| Message | Site | Wrapped by `truncateForTool`? |
|---|---|---|
| `"path must be relative to the repo root"` | `meat/tools.go:126` | no |
| `"path escapes the repo root"` | `meat/tools.go:137` | no |
| bare Go error from `filepath.Abs` (root or joined path) | `meat/tools.go:129-131,133-135` | no |
| `"invalid input: %v"` (JSON unmarshal error, `read_file`) | `meat/tools.go:151` | no |
| `"read %s: %v"` (embeds original `path`, unbounded) | `meat/tools.go:159` | **no — see finding below** |
| `"invalid input: %v"` (JSON unmarshal error, `grep`) | `meat/tools.go:176` | no |
| `"pattern is required"` | `meat/tools.go:179` | no |
| confinement error, bare (`grep`'s optional `path`) | `meat/tools.go:184` | no |
| `"git grep: %v"` | `meat/tools.go:196` | no |
| `"(no matches)"` (not an error) | `meat/tools.go:193,198` | no |
| `"unknown tool %q"` | `meat/tools.go:117` | no |
| `"remove, replace, and fold must all be JSON arrays (use [] when empty)"` | `meat/tools.go:205` | no |
| `"invalid input: %v"` (`decodeStrict`, `preview_plan`) | `meat/tools.go:213` | no |
| `"invalid input: " + err` (`requirePlanArrays`, `preview_plan`) | `meat/tools.go:216` | no |
| `"invalid edit plan: %v"` (compile failure, `preview_plan`) | `meat/tools.go:220` | **yes** |
| `"a submission has already been accepted"` | `meat/tools.go:227` | no |
| `"invalid input: %v"` (`decodeStrict`, `submit`) | `meat/tools.go:231` | no |
| `"invalid input: " + err` (`requirePlanArrays`, `submit`) | `meat/tools.go:234` | no |
| `"invalid edit plan: %v"` (compile failure, `submit`) | `meat/tools.go:238` | **yes** |
| `"multiple JSON values"` (`decodeStrict`, trailing JSON) | `meat/tools.go:308` | n/a (embedded in one of the above) |
| `"... (truncated, more than %d lines)\n"` (line-count cap marker, `grep` only) | `meat/tools.go:340` | — (applied before the byte cap) |
| `"\n... (truncated, %d total bytes)"` (byte cap marker) | `meat/tools.go:358` | — (this *is* the truncation) |
| `"edit plan has %d errors:%s"` (aggregation, referenced not owned) | `meat/editplan.go:539` | via caller |
| `"summary must not be empty"` (referenced not owned) | `meat/editplan.go:636` | via caller |

## Ordering Go leaves unspecified

None. No unstable sort, no map iteration, and no concurrency appear
anywhere in `meat/tools.go` — the file is straight-line sequential logic
per call. The one externally-observed ordering not decided by this file
is `git grep`'s match order (inherited from git's own deterministic
tree/pathspec traversal, not from any Go-level iteration here) — nothing
here needs a tie-breaker.

## Constants

| Name | Value | Unit | Citation | At the boundary |
|---|---|---|---|---|
| `maxToolOutput` | `16 * 1024` (16,384) | bytes | `meat/tools.go:19` | Every tool result — including `submit`'s validation-error text — is truncated to this cap with a `"truncated"` marker appended. Pinned by G9. |

## Open questions

- **Double-submission rejection is untested anywhere in this package's
  test files** — see `agent-loop.md` Open questions.
- **`unknown tool` dispatch fallback is untested** — see `agent-loop.md`
  Open questions.
- No test directly exercises `read_file`'s success path in isolation
  (reading an existing, in-root file) separate from the confinement
  rejection in G4 — likely covered incidentally elsewhere
  (`TestAbridge_ReadThenSubmit`, routed to `agent-loop.md` G4) but worth
  confirming no edge case (symlinks, directories passed as files) is left
  untested.
- **The Constants table's claim that "every tool result... is truncated
  to this cap" is broader than the mechanism.** Several tool-result
  paths are never passed through `truncateForTool` at all (see the
  Errors table's "Wrapped by `truncateForTool`?" column); most are
  fixed-shape strings and therefore self-bounded regardless, but
  `read_file`'s `"read %s: %v"` error (`meat/tools.go:159`) embeds the
  model-supplied `path` unbounded. G9 itself is still correct — it only
  claims this of `submit`'s validation-error text — but the constants
  table's general framing should be read as "most," not "every."
  Concretely: a very long (but lexically in-root) `path` that fails
  `os.ReadFile` (e.g. `ENAMETOOLONG`) produces an untruncated tool
  result sized by attacker/model-controlled input — a minor DoS-shaped
  gap in an otherwise-enforced 16 KiB cap. No test exercises this size
  boundary either way.
- `capLines`' silent truncation on the 1 MiB `bufio.Scanner` line cap
  (`meat/tools.go:335`) never checks `sc.Err()` — if a single `git grep`
  match line exceeds 1 MiB, output is silently cut with no marker and no
  error, indistinguishable from genuine end-of-output. Untested; the
  port must decide deliberately whether to preserve this silent-loss
  behavior (matching Go) or add an error path (a divergence from Go, per
  H12's general "should be an error" framing).
- `grep`'s success/failure branching is **output-driven, not
  exit-code-driven**: if `len(out) != 0`, the subprocess's error is never
  consulted at all, whatever it is. Only relevant when `git` writes to
  stdout and still exits non-zero for a reason other than "no matches"
  (e.g. a warning-then-partial-output case) — not exercised by any
  fixture.
