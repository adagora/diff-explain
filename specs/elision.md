# elision

> Status: stage 1 🟡 | stage 2 ⬜
> Go sources: `meat/elision.go`
> Go tests: `meat/chunk_test.go` (elision manifest survives chunking), `meat/editplan_test.go` (baseline single-diff case); `meat/elision_test.go` (11 tests, the file that directly targets `elision.go`'s own shapes) not yet processed

## Purpose

`ElisionLine` produces the one-line, locally-computed manifest a user sees
summarizing how much of a diff was hidden — "kept 12/240 changed lines in
3/7 files" — by comparing the original diff against the compiled reading
diff. It is never reported by the model; it is counted mechanically from
the two diff texts. See `glossary.md`.

## Guarantees

G1. `ElisionLine(raw, abridged)` returns the exact format `"kept %d/%d
    changed lines in %d/%d files"` when comparing a diff against itself
    unabridged (all lines, all files retained).
    — `meat/editplan_test.go:737-739` (`"kept 2/2 changed lines in 1/1
    files"`). Mechanism: `meat/elision.go:18-31` (branch at 28-29),
    `diffStats` counts `diffLineHunkChange` and `diffLineHeader` kinds via
    the diff layout classifier.

G2. `ElisionLine`, computed over (original diff, merged `SmartDiff`), still
    reports correct file counts across a whole *chunked and merged* diff —
    chunking does not break the elision-manifest contract; it is computed
    once at the top level, over the whole original diff and the whole
    merged result, not per chunk.
    — `meat/chunk_test.go:471-474` (`"in 2/2 files"` after a 2-file chunked
    run). Mechanism: `meat/elision.go:18`, invoked at the top of
    `abridgeChunked`'s result path (see `chunk.md`).

## Open questions

- No test in the files processed so far exercises a genuinely *partial*
  elision (some changed lines hidden, some files entirely dropped) —
  `python_golden_test.go`'s golden fixtures compute retention stats
  (`editplan.md` G6) but do not appear to assert on `ElisionLine`'s rendered
  string directly. Coverage for the general "kept N/M changed lines in X/Y
  files" case with N&lt;M and X&lt;Y should be confirmed once remaining test
  files (`imports_test.go`, `moves_test.go`, `cmd/meat/render_test.go`) are
  processed — `render_test.go` in particular likely exercises this at the
  CLI/JSON-output layer.
