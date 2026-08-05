# diff

> Status: stage 1 🟡 | stage 2 ⬜
> Go sources: `meat/diff.go`
> Go tests: `meat/meat_test.go` (rejection guarantees via `Abridge`), `meat/editplan_test.go` (structural edge cases), `meat/chunk_test.go` (layout use, not yet separately mined for diff.go-only tests)

## Purpose

**Foundation.** Parses a unified diff into an immutable line-oriented
layout: classifies every physical line (header, hunk change, context,
no-newline marker, mail signature, etc.) and tags each with its file, hunk,
and source language. Everything downstream — editplan, chunk, imports,
moves — consumes this layout and never re-parses the diff text. See
`glossary.md`.

## Guarantees

G1. A diff containing a combined-diff marker (a `diff --cc `/`diff
    --combined ` header, or a `@@@` combined hunk header) is rejected with
    an error containing `"combined diff"`, never reaching the model.
    — `meat/meat_test.go:414-424`. Exact messages: `meat/diff.go:110-111`
    (header form: `"combined diff on line %d is unsupported; use a normal
    first-parent or two-tree diff"`) and `meat/diff.go:117-118` (hunk form).

G2. A hunk whose `@@ ... @@` header line counts don't match the actual
    number of context/change lines in its body is rejected with an error
    containing `"counts inconsistent"`, never reaching the model.
    — `meat/meat_test.go:402-412` (`@@ -1 +1 @@` claiming 1 old/1 new line
    against a body of 1 removed + 2 added lines). Exact message:
    `meat/diff.go:191-194` (`"hunk header on line %d has counts inconsistent
    with its body near line %d"`), raised inside `analyzeDiff`
    (`meat/diff.go:165` onward).

G3. A hunk's own change lines are distinguished from a genuine `---`/`+++`
    file-header pair by structural position and remaining old/new line
    counts (tracked from the enclosing `@@` header via `parseHunkCounts`),
    not by text pattern — so a hunk body line that reads byte-for-byte
    `--- a/foo` immediately followed by `+++ b/foo` remains ordinary,
    removable/replaceable hunk source.
    — `meat/editplan_test.go:709-764` (`TestApplyEditPlan_GitHunkLinesThatResembleFileHeaders`,
    built from a real `git diff --no-index` fixture). Mechanism:
    `analyzeDiff` (`meat/diff.go:165-352`) — the `countsKnown &&
    oldRemain==0 && newRemain==0` gate at line 230 is what lets a real
    trailing file header be recognized only once the hunk's own counts are
    exhausted.

G4. `git format-patch` output — a diff preceded by commit-message prose and
    followed by a `-- ` mail signature (both of which may themselves
    contain diff-like text, e.g. `"@@@ this is commit prose"`, `"rename
    from old behavior"`) — is valid `Abridge` input; an identity plan
    reproduces it byte-for-byte, and the entire diff body (from the `diff
    --git` line up to, but not including, the signature) can be elided as
    one unit while the signature survives untouched.
    — `meat/editplan_test.go:636-707` (`TestAbridge_AcceptsGitFormatPatch`).
    Mechanism: `isFormatPatchSignature` (`meat/diff.go:463-465`),
    `diffLineMailSignature` classification (`meat/diff.go:304-309`), used as
    a scan-stop boundary (e.g. `meat/editplan.go:682-683`,
    `meat/python.go:69-71`).

G5. `numberedDiff` prefixes every physical line of the original diff with a
    `N|` gutter (1-based) and produces no phantom trailing numbered line
    even when the input has no trailing newline.
    — `meat/editplan_test.go:894-904` (`"α\n\n+β"` with no final newline →
    `"1|α\n2|\n3|+β\n"`, explicit check that no `"4|"` appears);
    corroborated by `meat/meat_test.go:716-727` (3-physical-line, no-final-
    newline fixture, must not contain `4|`). Mechanism: `meat/diff.go:126-137`
    (`numberedDiff`), relying on `splitSourceLines` never emitting a phantom
    empty final line (`meat/diff.go:63-86`). See `rubric.md` for how this
    feeds the model-visible prompt.

## Open questions

- This fragment covers only what `meat_test.go` and `editplan_test.go`
  incidentally pin about `diff.go`'s classifier. `chunk_test.go` exercises
  the classifier heavily (line-kind classification, no-newline markers,
  language tagging, string-interior scanning) but those guarantees are
  routed to `chunk.md` since they're framed as splitting behavior, not
  `diff.go` behavior in isolation. A dedicated pass over any remaining
  `diff.go`-focused assertions (there is no `diff_test.go` in the stage 1
  checklist — its behavior is only exercised indirectly through other test
  files) should double check nothing diff.go-specific is missing once all
  test files are processed.
- Physical-line classification details (header/hunk/context/change/mail-
  signature/no-newline, and the full set of `diffLineKind` values) are not
  yet enumerated here — they should be pulled from source directly in stage
  2, cross-checked against citations already gathered in `chunk.md`'s
  vocabulary (`inString`, `origins`, no-newline marker linkage) and
  `editplan.md`'s structural-retention guarantees (E15-E22, which depend on
  header/marker classification).
