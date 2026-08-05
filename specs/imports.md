# imports

> Status: stage 1 🟡 | stage 2 ⬜
> Go sources: `meat/imports.go`
> Go tests: `meat/python_golden_test.go` (one non-targeting guarantee),
> `meat/chunk_test.go` (import-mask interactions with splitting);
> `meat/imports_test.go` (the file that directly targets `imports.go`'s own
> shapes) not yet processed

## Purpose

Import-declaration lines are hidden by a deterministic pass that runs
regardless of what any plan says — **compiler-owned**, in the sense that
authored plans (model or hand-written) may not target them. See
`glossary.md` for mandatory import removal / compiler-owned.

## Guarantees

G1. A golden plan must never explicitly target a compiler-owned import row:
    none of its `Remove` ranges, `Fold` ranges, or `Replace` lines may touch
    a physical line that the mandatory-import pass marks hidden. True for all
    three python golden fixtures.
    — asserted via `assertGoldenPlanLeavesImportsAutomatic`
    (`meat/python_golden_test.go:253-279`), called at
    `meat/python_golden_test.go:189`. Exact failure text: `"%s[%d] explicitly
    targets compiler-owned import line %d; leave import hiding automatic"`
    (`meat/python_golden_test.go:266`, `kind` ∈ {`"remove"`, `"fold"`,
    `"replace"`}). Mechanism: `mandatoryImportRemovalPlan`
    `meat/imports.go:156-250`.

Corroborating evidence for G1: the compiled output for every fixture excludes
the raw import-line text itself (e.g. django's
`"from django.utils.cache import"`, `meat/python_golden_test.go:73`) even
though no plan operation removes it — proof the import merge, not plan
content, is what hides those lines. See `editplan.md` G10.

### Interaction with chunking (`chunk_test.go`)

G2. The whole-diff mandatory import mask is computed once, globally, before
    any chunk cut, and never re-derived per chunk — so import scaffolding
    (an opener, its members, its closer) never appears in any chunk of a
    split diff, even under an adversarial budget sized to place a naive
    per-line cut mid-block.
    — `meat/chunk_test.go:300-356`, mechanism `meat/chunk.go:164-174`,
    `meat/imports.go:156-250`. See `chunk.md` G10-G11.

G3. A package rename (paired `-package`/`-import` and `+package`/`+import`
    rows) whose import rows are hidden while package rows stay visible
    continues to hold identically when a mid-hunk cut forces the two sides
    into different chunks — because the per-side masks are computed over
    the whole hunk before any cut, not per chunk.
    — `meat/chunk_test.go:713-759`, mechanism `meat/imports.go:168-181`,
    `meat/chunk.go:164-174`. Reference (monolithic) behavior pinned by
    `TestCompileEditPlan_MandatoryImportsPreservePackageRenames`
    (`meat/imports_test.go:212`). See `chunk.md` G25.

G4. Import-like text embedded inside a source string literal (e.g. `import
    pytest` inside a template literal) is recognized from the string's
    opener and hidden by the mandatory pass; a cut separating the opener
    from the embedded rows does not defeat this, since the mask is
    precomputed globally before any splitting.
    — `meat/chunk_test.go:766-812`, mechanism `meat/chunk.go:257-291`
    (`stringInteriorMask`), `meat/imports.go:625` (`embeddedSourceLines`).
    See `chunk.md` G26.

G5. When the mandatory import pass would empty a visible Python suite
    owner's body, whole-diff rendering emits a fixed `"..."` placeholder
    row in its place; this placeholder decision is precomputed globally and
    carried into chunk segment emission even when a cut lands at the owner
    line or at the dropped import line itself.
    — `meat/chunk_test.go:1067-1109`, mechanism `meat/chunk.go:175-182`
    (`addMandatoryPythonSuitePlaceholders`, `meat/imports.go:12-55`),
    `meat/chunk.go:766-775` (`placeholderRow`). See `chunk.md` G33,
    `python.md`.

G6. A section containing rows hidden only by move-precedence extension (see
    `moves.md`) — not by the plain import mask — is never packed verbatim
    into a chunk even if it would otherwise fit whole; it is forced through
    row-dropping segmentation so those rows are actually dropped from the
    emitted text.
    — `meat/chunk_test.go:1140-1145`, mechanism `meat/chunk.go:171-174,213-224`.
    See `chunk.md` G34, `moves.md`.

## Open questions

- This test file only proves golden plans *don't* target import rows and
  that the merge happens; it says nothing about `mandatoryImportRemovalPlan`'s
  own correctness across shapes (multiline blocks, imports inside embedded
  source strings, move-precedence extension, Python suite placeholders,
  non-Python languages). All of that must come from `imports_test.go`, not
  yet processed. `meat/testdata/python/README.md:4-5` explicitly disclaims
  non-Python files from these three fixtures, so this file gives zero
  coverage of imports.go's non-Python-language paths.
