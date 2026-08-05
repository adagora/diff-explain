# moves

> Status: stage 1 🟡 | stage 2 ⬜
> Go sources: `meat/moves.go`
> Go tests: `meat/python_golden_test.go` (one real-world detection + one
> symmetry-violation case), `meat/chunk_test.go` (move detection/enforcement
> interactions with chunking); `meat/moves_test.go` (the file that directly
> targets `moves.go`'s own detection algorithm) not yet processed

## Purpose

Exact, source-evidenced detection of code relocated between two different
hunks of the same diff — a **move**. A move is real only when both sides are
byte-identical modulo a constant per-row indentation offset; nothing here
guesses. Once a move is detected, every row on both sides must receive
identical compression treatment (kept, removed, or folded, including fold
boundaries) — **move symmetry** — or the plan is rejected. See `glossary.md`
for move / move pair / move symmetry.

## Guarantees

G1. Running move detection over the raw pytest golden fixture
    (`pytest-b4e846616cbb.diff`) finds the exact pair: removed lines 72–81
    aligned with added lines 23–32 — among whatever else it may find.
    — expected value `meat/python_golden_test.go:121-124`, asserted
    `meat/python_golden_test.go:173-178` via `containsDetectedMove`
    (`meat/python_golden_test.go:281-288`, exact struct equality, order-
    independent). Mechanism: `detectedMovesInDiff` `meat/moves.go:441-448`,
    algorithm `detectExactMoves` `meat/moves.go:58-198`.

G2. Breaking symmetry on even one row of a detected move is always rejected,
    and the rejection names the move's full coordinates on both sides — not
    just the offending sub-range. Concretely: taking the pytest golden plan
    (symmetric across its move) and additionally hiding only the first row of
    the removed side (`Remove: [{72,72}]`), without any matching change to
    the added side, makes `compileEditPlan` fail with an error containing
    both the literal substring `"move symmetry"` and the literal substring
    `"removed lines 72-81 match added lines 23-32"`.
    — `meat/python_golden_test.go:210-221`. Mechanism: `validateMoveSymmetry`
    `meat/moves.go:352-394`; message template `"move symmetry: removed lines
    %d-%d match added lines %d-%d after indentation normalization; %s. Keep,
    remove, or fold corresponding move rows identically, including fold
    boundaries"` `meat/moves.go:384`, with the `%d`s filled from the move's
    full `Removed`/`Added` ranges regardless of which row triggered it.

### Interaction with chunking (`chunk_test.go`)

G3. An exact move pairing an import block in one file with the identical
    block relocated into a *different* file is hidden on both sides by
    whole-diff compilation via move-precedence extension — even though the
    destination file's extension alone would not classify it as import
    content. When the two files land in different chunks, no chunk-local
    pass could see the cross-file pairing, so the splitter pre-drops both
    sides during segmentation rather than relying on any chunk-local move
    detection (chunk runs never detect moves at all — G4).
    — `meat/chunk_test.go:1117-1169`, mechanism
    `applyMandatoryMovePrecedence(detectExactMoves(lines, layout),
    b.hidden)` computed globally before any cutting (`meat/chunk.go:170`),
    `meat/moves.go:265-280` (`applyMandatoryMovePrecedence`). See
    `imports.md` G6, `chunk.md`.

G4. Move detection is strictly a whole-diff property: a block occurring
    three times globally (removed once, added twice) is deliberately
    ambiguous and yields no detected move at all, even though a chunk
    containing exactly one of the removals and one of the additions would
    look locally unique. Per-chunk agent runs never perform move detection
    themselves; a chunk-local plan that treats the two sides of a
    would-be pair asymmetrically is accepted (not rejected for asymmetry)
    because the chunk enforces no move at all there.
    — `meat/chunk_test.go:1176-1241` (fold-only-the-removal-side plan
    succeeds; prompt check confirms absence of the move-hint sentence over
    the ambiguous block), mechanism `meat/tools.go:24-38,218,236`
    (`compileEditPlanMoves(tb.rawDiff, in, tb.moves, !tb.noMoves)` —
    `detect=false` for chunk runs) and `meat/chunk.go:926` (`wholeMoves :=
    detectedMovesInDiff(req.UnifiedDiff)`, run once over the whole original
    diff, so the 3-occurrence block never enters `wholeMoves`).

G5. A genuine (non-ambiguous) whole-diff move whose two sides land in the
    *same* chunk keeps full symmetry enforcement there: the whole-diff move
    set is translated into that chunk's own 1-based coordinates and hinted
    in the chunk's prompt using those chunk coordinates (e.g. `"-6..9 ↔
    +16..19"`, not the original coordinates).
    — `meat/chunk_test.go:1384-1420`, mechanism `meat/chunk.go:1003-1041`
    (`mapMovesToChunk`) and `meat/moves.go:464-479` (`formatMovePairs`,
    separator `"-%d..%d ↔ +%d..%d"` at line 474) via `meat/meat.go:244,258-260`
    (`userPromptMoves`).

G6. Inside such a chunk, an asymmetric plan (folding only one side of the
    mapped move) is rejected with a tool error containing `"move"`; a
    symmetric plan (folding both sides identically) is accepted.
    — `meat/chunk_test.go:1421-1435`, mechanism `meat/moves.go:352-394`
    (`validateMoveSymmetry`).

G7. A move maps into a chunk only when both complete sides land
    contiguously within that single chunk; a move split across chunks
    cannot be enforced there (a documented cost of chunking).
    — `meat/chunk_test.go:1387-1389` (fixture engineered so both sides land
    in chunk 1), mechanism `meat/chunk.go:1003-1031` (`mapMovesToChunk`'s
    `mapRange`, which fails the whole move if any row's chunk-line position
    isn't contiguous).

## Constants

See `constants.md`: `minMoveSubstantiveRows`, `minMoveNonspaceBytes`,
`maxMoveHints`. G1's pytest move is large enough to clear
`minMoveSubstantiveRows`/`minMoveNonspaceBytes`, but no fixture in this test
file exercises their exact boundary values, and `maxMoveHints` is never
approached (at most one move per fixture here).

## Open questions

- The django and flask golden fixtures never assert their move count — their
  `expectedMoves` field is unset (nil) in the test, so the test only checks
  that compilation doesn't hit a symmetry error against the golden plan, not
  what `detectedMovesInDiff` actually returns for them. If either fixture
  secretly contains a detected move, its exact coordinates are unverified.
  Flagging as unconfirmed intent rather than guessing —
  `meat/python_golden_test.go` case structs for django/flask, cf. pytest's
  `expectedMoves` at `:121-124`.
- Move-detection tie-breaking (H7, the sort at `meat/moves.go:118,172`) is
  not exercised — every fixture here yields at most one unambiguous
  candidate. Coverage should come from `moves_test.go`.
- The fold-boundary-mismatch variant of the symmetry message
  (`"folded with different boundaries"`, `meat/moves.go:381`) is never
  triggered by this file — its one symmetry violation is a keep-vs-remove
  mismatch, not a fold-boundary mismatch.
- `validateMoveReplacementSymmetry` (`meat/moves.go:396-439`) is untouched —
  no fixture here uses `replace`.
- A move split across chunks (partial mapping failure, the "documented
  cost of chunking" the code comments assert at `meat/chunk.go:1006-1007`)
  is not directly tested — G7 proves both-sides-in-one-chunk is enforced,
  but no test shows a move whose sides land in different chunks silently
  drops out of enforcement. See `chunk.md` Open questions.
