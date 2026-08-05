# tools

> Status: stage 1 ✅ | stage 2 ⬜
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
