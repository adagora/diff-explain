# moves

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `meat/moves.go`
> Go tests: `meat/python_golden_test.go` (one real-world detection + one
> symmetry-violation case), `meat/chunk_test.go` (move detection/enforcement
> interactions with chunking), `meat/moves_test.go` (detection algorithm,
> symmetry, replace symmetry, import precedence, agent correction)

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

### Detection algorithm (`moves_test.go`)

G8. A canonical cross-file relocation of four indented statements,
    re-indented uniformly (4 spaces → 8 spaces) and with non-matching
    surrounding context on each side, is detected as **exactly one** move:
    removed physical lines **6–9** aligned with added physical lines
    **16–19**.
    — `meat/moves_test.go:19-24`
    (`TestDetectExactMoves_CrossFileUniformReindent`); fixture alias
    `exactMoveDiff = surfaceFixtureDiff` `meat/moves_test.go:12` / body
    `meat/rubric.go:18-36`; expected pair `meat/moves_test.go:14-17`.
    Mechanism: `detectedMovesInDiff` `meat/moves.go:441-448` →
    `detectExactMoves` `meat/moves.go:58-198`; indent normalization
    `normalizeMoveLine` / `moveRowsMatch` `meat/moves.go:200-238`.

G9. The same kind of exact relocation **within one file across two
    different hunks** (delete-only hunk then add-only hunk), with a uniform
    +4-space reindent on the added side, is detected as one move: removed
    **5–8** ↔ added **10–13**.
    — `meat/moves_test.go:26-48`
    (`TestDetectExactMoves_SameFileCrossHunk`). Fixture shape: single
    `a.txt` file; first hunk `@@ -1,4 +1,0 @@` with four `-` unique-
    operation rows; second hunk `@@ -20,0 +17,4 @@` with the same four
    bodies each prefixed by four spaces after `+`. Mechanism:
    `detectExactMoves` same-hunk-ID filter requires **different** hunk IDs
    `meat/moves.go:136-138`.

G10. When change runs share only an interior sequence (different wrapper
     lines outside), detection reports **only the matching interior**, not
     the wrappers. Fixture: six-line delete-only and six-line add-only
     hunks; wrappers `old_wrapper_begin/end` vs `new_wrapper_begin/end`;
     interior four statements with uniform extra indent on the add side.
     Detected move is removed **6–9** ↔ added **13–16** (not 5–10 / 12–17).
     — `meat/moves_test.go:50-76`
     (`TestDetectExactMoves_ExactInteriorOnly`). Mechanism: anchor +
     bidirectional extension while `moveRowsMatch` holds, bounded by run
     edges `meat/moves.go:146-156`.

G11. Trailing ASCII spaces and tabs on move bodies do **not** prevent a
     match: the interior fixture’s first two added bodies carry trailing
     spaces and a trailing tab respectively (`meat/moves_test.go:63-64`),
     and the pair still matches G10’s coordinates.
     — same test `meat/moves_test.go:50-76`. Mechanism:
     `strings.TrimRight(body, " \t")` in `normalizeMoveLine`
     `meat/moves.go:200-201`.

G12. No move is reported for any of the following inputs (each yields an
     empty move list):

     1. **Ambiguous repeated block** — the same three unique lines deleted
        in two separate delete-only hunks and added once (three global
        occurrences of each substantive line).
     2. **Tiny coincidence** — only **two** substantive rows deleted and
        re-added across hunks (`"return first"`, `"return second"`).
     3. **Same-hunk replacement** — identical three-line block removed and
        added inside a single hunk (`@@ -1,3 +1,3 @@`).
     4. **Nonconstant indentation shift** — three unique lines deleted,
        re-added with per-row indents `4 / 8 / 4` spaces (not one constant
        offset).

     — `meat/moves_test.go:78-109`
     (`TestDetectExactMoves_IgnoresTinyAmbiguousAndSameHunkMatches`),
     subtest names at `meat/moves_test.go:97-101`. Helpers:
     `deletedOnlyHunk` / `addedOnlyHunk` `meat/moves_test.go:111-127`
     (added helper always prefixes four spaces after `+`). Mechanisms:
     unique-occurrence anchor requires exactly two hits with opposite
     markers `meat/moves.go:101-117`; same-hunk skip
     `meat/moves.go:136-138`; size gate `substantialMove`
     `meat/moves.go:240-254`; constant indent via `moveRowsMatch`
     `meat/moves.go:230-238`.

### Keep / remove / fold symmetry

G13. On the canonical surface move (6–9 ↔ 16–19), any **symmetric** plan
     compiles successfully: keep both sides (empty plan); remove both full
     ranges; fold both full ranges; or remove the entire diff (1–20).
     — `meat/moves_test.go:129-145`
     (`TestCompileEditPlan_MoveSymmetry` passing cases). Mechanism:
     `compileEditPlan` → `validateMoveSymmetry` `meat/moves.go:352-394`
     via `meat/editplan.go:263-265`.

G14. On that same move, **asymmetric** keep/remove/fold treatment is
     rejected. Every failure’s error contains the shared prefix naming the
     full pair coordinates, and a case-specific detail substring:

     | Plan shape | Detail needle asserted |
     |---|---|
     | Remove only removed side 6–9 | `removed lines 6-9 are removed while added lines 16-19 are kept` |
     | Fold 6–9 and remove 16–19 | `removed lines 6-9 are folded while added lines 16-19 are removed` |
     | Fold only added side 16–19 | `removed lines 6-9 are kept while added lines 16-19 are folded` |
     | Fold removed as partitions 6–7 and 8–9, added as single fold 16–19 | `folded with different boundaries` |

     Shared required substring on every failure:
     `removed lines 6-9 match added lines 16-19`.
     — `meat/moves_test.go:147-164`. Message templates: kind-mismatch
     detail `meat/moves.go:379`; both-folded different boundaries
     `meat/moves.go:380-381`; outer frame `meat/moves.go:383-386`:
     `move symmetry: removed lines %d-%d match added lines %d-%d after indentation normalization; %s. Keep, remove, or fold corresponding move rows identically, including fold boundaries`.

### Local-elision / replace symmetry

G15. Equivalent model-authored local elisions on both kept endpoints of a
     move are accepted and applied on **both** sides. Fixture: replace
     `beta`→`...` on lines **8** and **18** of `exactMoveDiff`; compiled
     reading diff contains exactly two occurrences of `publish(...)`.
     — `meat/moves_test.go:168-179` (`TestCompileEditPlan_MoveReplacementSymmetry` equivalent elisions). Mechanism:
     `validateMoveReplacementSymmetry` `meat/moves.go:396-439`
     (post-replace bodies compared via
     `normalizeMoveLine(...).normalized` `meat/moves.go:425-426`); applied
     through `compileEditPlan` `meat/editplan.go:363-366`.

G16. One-sided local elision on a move is rejected. Replacing only line 8
     (`beta`→`...`) fails with an error containing **all** of:

     - `move symmetry`
     - `removed lines 6-9 match added lines 16-19`
     - `corresponding kept lines 8 and 18 have different model-authored local elisions`

     — `meat/moves_test.go:181-194` (`TestCompileEditPlan_MoveReplacementSymmetry` one-sided). Full template `meat/moves.go:429-431`:
     `move symmetry: removed lines %d-%d match added lines %d-%d after indentation normalization; corresponding kept lines %d and %d have different model-authored local elisions. Apply equivalent replacements to both sides or keep both lines verbatim`.

G17. Different local elisions on the two kept endpoints are rejected the
     same way (needle `different model-authored local elisions`). Fixture:
     line 8 `beta`→`...`, line 18 `beta`→`b...`.
     — `meat/moves_test.go:196-204` (`TestCompileEditPlan_MoveReplacementSymmetry` different elisions).

G18. A replacement **outside** the detected move does not trigger
     move-replacement symmetry failure. Fixture: line **20**
     `location_ready`→`location_...` on `exactMoveDiff` succeeds.
     — `meat/moves_test.go:206-212` (`TestCompileEditPlan_MoveReplacementSymmetry` outside move). Mechanism: loop only over
     move-aligned offsets `meat/moves.go:398-402`.

### Mandatory imports vs move enforcement

G19. Compiler-mandatory import hiding runs **before** (and with priority
     over) model move-symmetry enforcement: an identity plan on an
     import-only Python relocate still auto-hides all `import ` lines,
     keeps the suite skeleton (`-class RuntimeDependencies:` /
     `+class RuntimeDependencies:` plus exactly one `    ...`
     placeholder), and does not leak import text. A partial plan that only
     removes the non-import markers (lines 5 and 11) likewise leaves no
     `location_marker` or `import ` text and still exactly one `    ...`.
     — `meat/moves_test.go:262-294`
     (`TestCompileEditPlan_MandatoryImportsPrecedeMoveSymmetry`); fixture
     `importOnlyPythonMoveDiff` `meat/moves_test.go:215-229`. Mechanism:
     `mandatoryImportRemovalPlan` + `applyMandatoryMovePrecedence` then
     `validateMoveSymmetry` treating mandatory rows as removed
     `meat/moves.go:260-280,292-299,348-351`; suite placeholders via
     edit-plan Python path.

G20. When a Python relocate mixes a mandatory import row with behavioral
     rows, symmetric model removal of only the behavioral tails (removed
     7–9 and added 13–15 of `mixedPythonMoveDiff`) succeeds; the reading
     diff contains neither `import ` nor the removed `configure_` /
     `publish_` text, and still has exactly one suite `    ...`.
     Asymmetric removal of only the removed-side behavioral tail (7–9) is
     rejected with `move symmetry` and
     `removed lines 7-9 are removed while added lines 13-15 are kept`.
     — success `meat/moves_test.go:296-310`; rejection
     `meat/moves_test.go:337-343`
     (`TestCompileEditPlan_MandatoryImportsPreserveBehavioralMoveEnforcement`);
     fixture `mixedPythonMoveDiff` `meat/moves_test.go:231-245`.

G21. Cross-language move-precedence: identical `require(...)` bodies
     removed from a `.js` file and added into a `.py` file form **one**
     detected move, but extension-specific classification marks only the
     **removed** side as mandatory-import (added side false for each of
     three offsets). After precedence, identity compilation yields an
     **empty** reading diff (both sides hidden as counterparts).
     — `meat/moves_test.go:312-334`; fixture
     `crossLanguageImportMoveDiff` `meat/moves_test.go:247-260`.
     Mechanism: `detectExactMoves` +
     `mandatoryRemovalMask`/`mandatoryImportRemovalPlan` +
     `applyMandatoryMovePrecedence` `meat/moves.go:265-280`.

### Plan feedback and agent-loop surface

G22. Successful symmetric fold of both move endpoints produces plan
     feedback containing `Moves: 1 exact cross-hunk/cross-file`,
     `treated symmetrically`, and the pair notation `-6..9 ↔ +16..19`.
     — `meat/moves_test.go:345-356`
     (`TestPlanFeedback_ReportsSymmetricMoves`). Mechanism:
     `planFeedback` `meat/tools.go:264-289` using
     `feedbackMoves = "Moves: %d exact cross-hunk/cross-file span(s) treated symmetrically (%s).\n"`
     `meat/tools.go:259` and `formatMovePairs` `meat/moves.go:464-479`
     (pair format `"-%d..%d ↔ +%d..%d"` at `meat/moves.go:474`).

G23. End-to-end `Abridge` rejects a first submit that folds only the added
     side (16–19), returns a tool error naming the pair and the
     keep-vs-fold detail, then accepts a second submit that folds both
     sides; result uses two model turns and the smart diff contains two
     `...` rows. The **initial** user prompt already contains the move
     hint `-6..9 ↔ +16..19` and the instruction fragments
     `keep/remove/fold/replace treatment`, `equivalent local elisions`,
     and `Asymmetric plans are rejected`.
     — `meat/moves_test.go:358-398`
     (`TestAbridge_RejectsAsymmetricMoveThenAcceptsCorrection`). Prompt
     template `userPromptMoves` `meat/meat.go:244`; symmetry error as in
     G14 (`meat/moves.go:383-386`).

G24. End-to-end `Abridge` likewise rejects one-sided replace on line 8,
     surfaces a tool error containing
     `removed lines 6-9 match added lines 16-19` and
     `corresponding kept lines 8 and 18 have different model-authored local elisions`,
     then accepts the corrected two-sided replace; result smart diff
     contains two `publish(...)` occurrences after two turns.
     — `meat/moves_test.go:400-439`
     (`TestAbridge_RejectsAsymmetricMoveReplacementThenAcceptsCorrection`).
     Mechanism: G16 message path `meat/moves.go:429-431`.

## Mechanism

### Responsibility and dependents

`moves.go` has five jobs, each used by a different caller:

1. **Detection** (`detectExactMoves`, `meat/moves.go:58-198`) — a pure
   function of the parsed diff (`lines`, `layout`) that finds exact
   relocations. Called from three places, each for a different purpose:
   `detectedMovesInDiff` (`meat/moves.go:441-448`, used by whole-diff
   compilation `meat/editplan.go:178` and by the prompt builder
   `meat/meat.go:254`), and directly by the chunk splitter
   (`meat/chunk.go:170`) to compute the whole-diff mandatory-hiding
   extension before any cutting happens.
2. **Symmetry enforcement** (`validateMoveSymmetry`, `meat/moves.go:352-394`)
   — gates `compileEditPlanMoves` (`meat/editplan.go:263-265`), the single
   choke point used by both `compileEditPlan` (whole diff,
   `meat/editplan.go:155-157`) and chunk runs
   (`compileEditPlanMoves(tb.rawDiff, in, tb.moves, !tb.noMoves)`,
   `meat/tools.go:218,236`).
3. **Replacement (local-elision) symmetry**
   (`validateMoveReplacementSymmetry`, `meat/moves.go:396-439`) — same choke
   point, `meat/editplan.go:364-366`.
4. **Mandatory-import precedence propagation**
   (`applyMandatoryMovePrecedence`, `meat/moves.go:265-280`) — runs inside
   both `compileEditPlanMoves` (`meat/editplan.go:182`) and the chunk
   splitter (`meat/chunk.go:170`), mutating the import-mandatory mask each
   caller already computed.
5. **Coordinate formatting for models** (`formatMovePairs`,
   `meat/moves.go:464-480`) — feeds the initial user prompt
   (`meat/meat.go:258-260`, via `userPromptMoves` `meat/meat.go:244`) and
   post-submission tool feedback (`meat/tools.go:279-281`, via
   `feedbackMoves` `meat/tools.go:259`).

`meat/chunk.go`'s `mapMovesToChunk` (`meat/chunk.go:1003-1041`) is a sixth
consumer: it does not call anything in `moves.go` directly but re-expresses
`detectedMove` coordinates in a chunk's local numbering (glossary's
"Chunk-coordinate move mapping").

### Data shapes, by meaning

- **Detected move** (`meat/moves.go:17-23`) — the only shape that survives
  detection: two 1-based, inclusive physical-line ranges in the *original*
  diff (removed side, added side), one per side of the relocation. It
  carries nothing else — no file identity, no hunk id, no cached body text,
  no indent offset. Every consumer (symmetry, replacement-symmetry,
  precedence propagation, chunk mapping, hint formatting) re-derives
  whatever else it needs by re-reading the diff lines/layout/plan state at
  those coordinates each time. This is why a detected move is safe to pass
  across the chunk boundary as plain data.
- **Move run** (`meat/moves.go:25-29`) — a zero-based, inclusive index range
  into the flat physical-line array: one maximal run of same-marker (`-` or
  `+`), same-hunk, changed hunk-source lines. Pure detection-time
  scaffolding; never returned.
- **Move line info** (`meat/moves.go:31-35`) — one hunk-source line's
  comparison key: its normalized body (after marker/trailing-space/leading-
  indent stripped), its indent (tab-expanded column width of the stripped
  leading run), and whether it's substantive (contains a letter or digit).
- **Move occurrence** (`meat/moves.go:37-40`) — one hunk-source line's flat
  index plus its literal first byte (space, `-`, or `+`), bucketed by its
  normalized text.
- **Move anchor** (`meat/moves.go:42-45`) — a candidate pairing of exactly
  one `-`-marked index with exactly one `+`-marked index sharing the same
  globally-unique normalized-text bucket. Before promotion, this is *all* a
  candidate is: a single seed row pair, not yet a range.
- **Move alignment** (`meat/moves.go:47-51`) — the identity of "this run
  pair at this specific line-count offset"; used only as a dedup key so a
  second anchor deep inside an already-captured window can't spawn a
  redundant, near-duplicate candidate.
- **Move compression** (5-valued: kept / removed / fold-start / fold-middle
  / fold-end, `meat/moves.go:282-290`) and its coarser 3-valued **move
  compression kind** (`meat/moves.go:318-335`) — the "how was this move row
  disposed of" signal, computed on demand from plan state plus the
  mandatory mask by `compressionAt` (`meat/moves.go:292-316`); never
  stored, always recomputed at the coordinate being compared.

### Algorithm: `detectExactMoves` (`meat/moves.go:58-198`)

0. Guard: empty lines, or a layout-kind length mismatch, returns no moves
   immediately (`meat/moves.go:59-61`).
1. **Per-line normalization.** For every line `i` where it is hunk source
   (context *or* change, `meat/diff.go:158-159`) and the line has at least
   one byte, compute its line info via `normalizeMoveLine` on the body
   *after* the diff marker (`meat/moves.go:65-70`).
2. **Occurrence bucketing.** For every line whose normalized body is
   substantive, append `{index, marker}` to the bucket for that normalized
   text (`meat/moves.go:71-73`). Critically, this bucketing runs over
   **both context and change lines** — not only changed ones — because step
   1's hunk-source filter admits context too.
3. **Run construction.** Walk the lines once; wherever a line is a hunk
   change line with marker `-` or `+`, extend a run forward while the next
   line has the *same marker byte* and the *same hunk id*
   (`meat/moves.go:81-97`). Context lines and lines outside any hunk never
   belong to a run.
4. **Anchor formation.** For each occurrence bucket with **exactly 2**
   entries (`meat/moves.go:102`), scan both entries: a `-` marker sets the
   anchor's removed side, a `+` marker sets its added side
   (`meat/moves.go:106-112`); a context marker (space) matches neither and
   sets nothing. The anchor is kept only if **both** sides ended up set
   (`meat/moves.go:114-116`). Consequences, precisely: a bucket with 0, 1,
   or ≥3 total hunk-source occurrences (of *any* marker, including context)
   never forms an anchor; a bucket with exactly 2 occurrences that share a
   marker, or where one of the two is context, never forms an anchor
   either.
5. **Anchor sort** (`meat/moves.go:118-123`) by removed index ascending,
   then added index ascending — see Hazards (H7) for why the second key is
   unreachable.
6. **Per-anchor candidate extension**, in that sorted order:
   a. Skip if either endpoint isn't inside a run (`meat/moves.go:129-131`)
      — an anchor built from a context-line occurrence can't reach this far
      by construction, but this also guards any other non-run hunk-source
      line.
   b. Skip if the removed run's hunk id is invalid (defensive; shouldn't
      occur given step 3) **or** the two runs share a hunk id — same-hunk
      matches are never a move (`meat/moves.go:136-138`; this is the
      mechanism behind G9's cross-hunk requirement and G12 case 3's
      same-hunk exclusion).
   c. Compute the alignment key (run pair identity, offset = removed index
      minus added index). If an earlier candidate already recorded under
      this exact alignment contains this anchor's row pair, skip — this
      suppresses a redundant candidate from a second anchor already inside
      a captured window (`meat/moves.go:139-144`).
   d. `indentOffset := added.indent - removed.indent` (`meat/moves.go:146`)
      — the one constant offset this candidate will enforce for every row
      it extends over.
   e. Extend backward while both sides have run-room left **and**
      `moveRowsMatch` holds under that offset; extend forward symmetrically
      (`meat/moves.go:149-156`). Both pointers always move together — this
      is why the removed and added ranges always end up the same length
      (see Invariants).
   f. Build the 1-based inclusive move from the final window
      (`meat/moves.go:158-161`), record it unconditionally under its
      alignment key (even if it will fail the size gate, so later anchors
      can still dedup against it) (`meat/moves.go:162`), then admit it into
      the candidate set (deduplicated by full equality) **only if**
      `substantialMove` passes (`meat/moves.go:163-165`).
7. **Candidate sort** (`meat/moves.go:168-180`) by removed-start ascending,
   then added-start ascending, then removed-end ascending — no further
   tiebreak field exists; see Hazards (H7).
8. **Ambiguity/overlap filter.** For every pair of candidates in that sorted
   slice, if their removed ranges overlap **or** their added ranges overlap,
   mark **both** ambiguous (`meat/moves.go:182-190`); range overlap is
   inclusive-range overlap (`meat/moves.go:256-258`).
9. Return the non-ambiguous candidates, in the sorted order from step 7
   (`meat/moves.go:191-197`).

### Algorithm: `normalizeMoveLine` / `indentationColumns` / `moveRowsMatch` (`meat/moves.go:200-238`)

`normalizeMoveLine(body)`:
1. Trim only literal ASCII space and tab from the right — **not** a full
   Unicode-whitespace trim (`meat/moves.go:201`).
2. Take the maximal prefix of literal space/tab bytes as the indent text
   (`meat/editplan.go:480-487`, a shared helper, not moves-specific).
3. The normalized body is everything after that indent text.
4. It is substantive iff a rune-by-rune scan of the normalized body finds
   any Unicode letter or number, short-circuiting at the first hit
   (`meat/moves.go:205-210`).
5. Its indent is `indentationColumns` of the stripped indent text.

`indentationColumns(indent)` (`meat/moves.go:218-228`): walk the indent text
rune by rune; a literal tab advances the running column count to the next
multiple of 8; any other character (only space can occur, since the indent
text admits only space/tab) advances the count by exactly 1.

`moveRowsMatch(removed, added, indentOffset)` (`meat/moves.go:230-238`):
1. If the two normalized bodies differ (plain string inequality), no match.
2. If both normalized strings are empty (a fully blank/whitespace-only row
   on both sides — the only way normalized can be empty), it matches
   **unconditionally** — no indent constraint is applied to blank rows
   (`meat/moves.go:234-236`).
3. Otherwise, match iff `added.indent - removed.indent == indentOffset` —
   the single running offset fixed once per candidate at extension start
   (step 6d above).

### Algorithm: `substantialMove` (`meat/moves.go:240-254`)

Over the **entire candidate window** (not just the anchor row):
1. Count substantive rows: one per row whose precomputed substantive flag
   is true.
2. Count nonspace bytes: for **every** row in the window (substantive or
   not), scan its normalized text rune by rune; for every rune that is not
   Unicode space, add its UTF-8 byte length to the running total.
3. Passes iff the substantive-row count is `>= minMoveSubstantiveRows` (3)
   **and** the nonspace-byte count is `>= minMoveNonspaceBytes` (48)
   (`meat/moves.go:12-13`).

The two counters are computed over the same window but from different
signals: a punctuation-only row (e.g. a lone `);` or `}`) contributes to the
byte count but never to the row count. A window can therefore be long in
bytes via few letter/digit rows padded by punctuation-only rows and still
fail the row gate, or have exactly 3 tiny substantive rows and still fail
the byte gate — the two gates are computed together but are not
implications of one another.

### Decision boundaries, in the exact order checked

For two runs to become a reported move, in the order the code actually
gates them:
1. Both endpoint lines are hunk source with non-empty text (line info
   computed at all) — `meat/moves.go:66`.
2. The endpoint's normalized text is **globally unique among hunk-source
   occurrences** (context and change together) with **exactly 2** total
   occurrences — `meat/moves.go:71-73,101-104`.
3. Those 2 occurrences carry **opposite polarity markers**, one `-` and one
   `+` — `meat/moves.go:106-116` (a context/`-` or context/`+` pair, or a
   `-`/`-` pair, never forms an anchor).
4. Both endpoints belong to an actual change **run** —
   `meat/moves.go:129-131`.
5. The two runs are in **different hunks** — `meat/moves.go:136-138`.
6. The anchor is not redundant with an already-recorded candidate for the
   same run-pair-and-offset alignment — `meat/moves.go:139-144`.
7. Extension in both directions is **byte-identical modulo one constant
   per-row indentation offset**, i.e. `moveRowsMatch` under the anchor's
   fixed offset — `meat/moves.go:149-156,230-238`.
8. The resulting window clears **both** size gates (`substantialMove`) —
   `meat/moves.go:163,240-254`.
9. The candidate does not **overlap**, on either its removed or its added
   side, any other surviving candidate — `meat/moves.go:182-190`.

### Algorithm: `validateMoveSymmetry` (`meat/moves.go:352-394`)

For each move (row count from the removed range's length,
`meat/moves.go:355`):
1. Walk each offset from the start of the range. At each offset compute the
   compression state for the corresponding removed-side and added-side
   line via `compressionAt`.
   - `compressionAt` (`meat/moves.go:292-316`): if the line's index is
     mandatory, return "removed" **unconditionally** — this canonicalization
     happens *before* consulting plan state at all, so a compiler-owned
     Python suite placeholder standing in for a mandatory row never reads
     as "folded" here (`meat/moves.go:294-299`, comment explains why).
     Otherwise: not hidden → "kept"; hidden but not inside a fold →
     "removed"; else inside a fold → fold-start/fold-middle/fold-end by
     comparing the line to that fold's boundaries (`meat/moves.go:300-315`).
2. If the two raw (5-valued) compression values are **exactly equal**,
   advance and continue (`meat/moves.go:359-361`). This is the mechanism
   that enforces "matching fold boundaries": two aligned rows that are both
   "folded" in the coarse sense but at different structural positions (one
   fold-start, the other fold-middle) are **not** equal here and start a
   mismatch block — the fine-grained value, not the 3-valued kind, is what
   is compared for equality.
3. On the first mismatch, capture the 3-valued kind of each side.
4. **Extend the mismatch block**: while the next offset's raw values still
   differ from each other, **and** its removed side's kind still equals the
   captured removed kind, **and** its added side's kind still equals the
   captured added kind, absorb it (`meat/moves.go:367-374`). A change in
   which *kind* is mismatched (e.g. "removed vs kept" turning into "kept vs
   folded" at the next row) starts a fresh block instead of merging.
5. Build the detail string (`meat/moves.go:379-382`):
   - both kinds folded: `"removed %s and added %s are folded with
     different boundaries"` (`meat/moves.go:380-381`).
   - otherwise: `"removed %s %s %s while added %s %s %s"` filling
     (line-range text, line-range verb, kind) per side (`meat/moves.go:379`;
     the line-range helpers at `meat/moves.go:450-462` render `"line N"`/
     `"is"` for a single line or `"lines N-M"`/`"are"` otherwise).
6. Wrap in the outer template naming the move's **full** coordinates, not
   the mismatched sub-range (`meat/moves.go:383-386`).
7. Continue scanning from the next offset — one move can emit multiple
   distinct error entries if it has multiple, differently-shaped mismatch
   regions (`meat/moves.go:387`).
8. All collected problems across all moves are joined via
   `joinEditPlanErrors` (`meat/moves.go:390-393`; `meat/editplan.go:531-540`
   — returns the bare single error if there's exactly one, else `"edit plan
   has %d errors:\n- …\n- …"`).

### Algorithm: `validateMoveReplacementSymmetry` (`meat/moves.go:396-439`)

Per move, a **flat** per-row scan (no mismatch-block merging, unlike
symmetry validation above):
1. Row count from the removed range's length, same convention
   (`meat/moves.go:399`).
2. Skip the row unless **both** aligned lines are exactly "kept" per
   `compressionAt` (mandatory rows, fully-removed rows, and any folded rows
   are exempt — replacement symmetry only matters where both sides remain
   literal source, `meat/moves.go:407-410`).
3. Skip if neither side has a planned replacement at this offset
   (`meat/moves.go:411-415`).
4. Take each side's raw body and apply that side's edits via
   `applyPlannedReplacements` if present (`meat/moves.go:417-424`; edits
   are applied back-to-front by start offset, `meat/editplan.go:413-419`,
   so earlier spans' indices stay valid).
5. Re-run **both** post-replacement bodies through `normalizeMoveLine` and
   compare only the normalized text (`meat/moves.go:425-427`) — indentation
   is deliberately excluded from this comparison, consistent with
   detection's own tolerance for a constant per-row offset; a differing
   *amount* of leading whitespace after replacement can never by itself
   trigger this check, only differing content can.
6. On mismatch, one error naming the move's full coordinates and the exact
   pair of disagreeing kept line numbers (`meat/moves.go:429-431`).
7. Errors joined the same way as symmetry validation (`meat/moves.go:435-438`).

### `applyMandatoryMovePrecedence` and its ordering with import mandation (`meat/moves.go:260-280`)

Algorithm: for each move, for each aligned offset, compute the two absolute
0-based indices; bounds-check defensively; **if either side is already
mandatory, set both to mandatory** (`meat/moves.go:265-278`) — a single
OR-propagate pass, not a fixpoint. No fixpoint is needed because moves are
pairwise non-overlapping by construction (detection's own postcondition,
step 8/9 above), so no row is shared between two different moves that could
require a second pass to converge.

**Ordering, and why it's forced**, reconstructed from both call sites
(`meat/editplan.go:176-182`, `meat/chunk.go:168-170`):
1. `detectExactMoves` and `mandatoryImportRemovalPlan`
   (`meat/imports.go:156`) are each a pure function of only the diff
   lines/layout — neither depends on the other's output, so their relative
   order doesn't matter *by itself*.
2. `mandatoryRemovalMask` turns the import plan into a boolean array
   (`meat/imports.go:341-349`).
3. `applyMandatoryMovePrecedence` **requires both** of the above as inputs
   — it mutates the mask using the moves — so it is the true ordering
   constraint: it must run after both (1) and (2), and its result (the
   *extended* mask) is what every later step reads.
4. Plan state's hidden-row mask is seeded by copying the **already-extended**
   mask (`meat/editplan.go:184`), before any model remove/fold op is
   applied.
5. `validateMoveSymmetry`/`validateMoveReplacementSymmetry` read mandatory
   status through `compressionAt`'s canonicalization
   (`meat/moves.go:296-299`), which treats a mandatory row as "removed"
   regardless of what plan state or Python-placeholder machinery did to it.

Step 5 is *why* precedence must be fully resolved before symmetry
validation runs: if extension were skipped, one counterpart of a
cross-classification move (e.g. an import block moved across a
file-extension boundary that alone would classify only one side as import,
per G21) would canonicalize as "removed" while its sibling — never marked
mandatory — would be compared as whatever the model plan happened to leave
it, producing a spurious asymmetry error on rows the model was never given
the coordinates to treat identically (mandatory rows are compiler-owned; an
explicit replace targeting one is silently ignored, `meat/editplan.go:291-295`).

### `formatMovePairs` and hint formatting (`meat/moves.go:464-480`)

1. Empty result if there are no moves or the limit is non-positive
   (`meat/moves.go:465-467`).
2. Show the smaller of the move count and the limit (`meat/moves.go:468-471`).
3. Format each shown move (in whatever order the caller's slice already
   carries — for the whole-diff caller this is `detectExactMoves`'s final
   sorted order, i.e. ascending by removed-start primarily) as `"-%d..%d ↔
   +%d..%d"` (`meat/moves.go:472-475`).
4. If more remain, append one final `"and %d more"` segment
   (`meat/moves.go:476-478`).
5. Join with `", "` (`meat/moves.go:479`).

Both call sites pass `maxMoveHints` (12, `meat/moves.go:14`) as the limit:
the initial user prompt (`userPromptMoves` at `meat/meat.go:244`, filled at
`meat/meat.go:258-260`) and post-submission tool feedback (`feedbackMoves`
at `meat/tools.go:259`, filled at `meat/tools.go:279-281`). Because the
shown set always takes the numerically-first N moves (sorted by
removed-side position), the overflowed moves named only by count are always
the ones with the *later* removed-side coordinates, not an arbitrary or
most-recently-found subset.

## Invariants

- **Removed and added ranges of one detected move always have equal
  length.** Guaranteed by construction — bidirectional extension always
  advances both pointers together (`meat/moves.go:149-156`) — and relied on
  by every consumer that zips the two sides offset-by-offset using only the
  removed side's length (`meat/moves.go:355,399`). *Consequence if
  violated:* if a caller-provided move list (the chunk path,
  `meat/editplan.go:165-166`, `meat/tools.go:37`) ever carried a
  mismatched-length pair, both validators would walk past the shorter
  side's real content into whatever text follows it in the file, silently
  comparing unrelated rows and reporting spurious (or missed) asymmetry.
- **The final moves slice returned by `detectExactMoves` has pairwise
  non-overlapping removed ranges and pairwise non-overlapping added
  ranges** — the postcondition of the ambiguity filter
  (`meat/moves.go:182-196`). *Consequence if violated:*
  `applyMandatoryMovePrecedence`'s single-pass OR-propagate (no fixpoint)
  and chunk-coordinate mapping's per-move-independent mapping
  (`meat/chunk.go:1008-1041`) are both only correct because no row is
  shared between two moves; a violation would make results depend on
  iteration order in an unspecified way.
- **`applyMandatoryMovePrecedence`'s output must be threaded into both the
  seeded hidden-row mask and every symmetry/replacement-symmetry check.**
  Breaking this ordering (documented above) produces spurious asymmetry
  errors on rows the model plan has no coordinates to fix, because
  mandatory rows are compiler-owned and not model-addressable
  (`meat/editplan.go:291-295`).
- **`substantialMove`'s two counters are independent measurements over the
  same window, not implications of one another.** A porter must not assume
  clearing one gate implies progress toward the other; collapsing them into
  one measurement would change which candidates survive at the margins.
- **`compressionAt`'s mandatory canonicalization runs before any state/fold
  inspection** (`meat/moves.go:296-299`) — a Python suite placeholder that
  visually looks "folded" in plan state must never be read as model-authored
  folding when its underlying row is mandatory. Breaking this order would
  let a mandatory row's compiler-synthesized placeholder register as a real
  fold and be compared against a genuine model fold on the move's other
  side, again producing spurious asymmetry.

## Hazards

- **H1** (byte budgets): `minMoveNonspaceBytes = 48` at `meat/moves.go:13`,
  measured by summing each non-space rune's UTF-8 byte length in
  `substantialMove` (`meat/moves.go:247-249`). This is not a plain byte-
  length check — it's a sum of individually-measured UTF-8 byte lengths
  taken *after* several transforms (ASCII-only trailing trim, then
  leading-indent strip, then per-rune Unicode-space filtering). A port
  operating on a byte buffer per H1's engine-wide decision must reproduce
  that exact sequence of byte-oriented transforms rather than decode to a
  JS string and use `.length` — a single non-ASCII letter anywhere in a
  candidate window would be undercounted by `.length` (UTF-16 units)
  relative to its true UTF-8 byte length, which can flip a real move across
  the 48-byte boundary.
- **H2** (rune iteration / Unicode properties), three distinct sites in
  this file:
  - `meat/moves.go:205-206` — the letter-or-number scan deciding whether a
    normalized body is substantive. A port must decode by codepoint and use
    the Unicode letter/number property classes, not ASCII ranges — this
    directly gates whether *any* candidate can anchor a move at all.
  - `meat/moves.go:247-248` — the non-space byte-length scan in
    `substantialMove`. Go's Unicode-space test is a full-Unicode-property
    test (includes NEL, several Unicode space separators) — not JS's `\s`
    (see H14's separate NEL/FEFF mismatch) — so this needs an explicit
    helper matching Go's exact set, not a regex shortcut.
  - `meat/moves.go:220` — `indentationColumns` ranges by rune, but in
    practice the indent text (from the shared `leadingWhitespace` helper,
    `meat/editplan.go:480-487`) admits only literal space/tab bytes, so
    every rune here is single-byte ASCII today; the codepoint-vs-code-unit
    distinction is dormant on this specific loop but the loop's *shape*
    (rune-wise) still matters if the definition of "leading whitespace" is
    ever widened.
  - Adjacent but worth flagging precisely: the trailing trim in
    `normalizeMoveLine` (`meat/moves.go:201`) is deliberately
    **ASCII-literal only** (space and tab), not a Unicode-space trim — it
    is a *different* whitespace definition from the Unicode-space scan two
    functions later in the same pipeline. A port must not unify these into
    one "trim whitespace" helper.
- **H7** (sort stability), both call sites named in the register
  (`meat/moves.go:118,172`):
  - **Anchor sort** (`meat/moves.go:118-123`): ties on the primary key
    (removed index) are **structurally unreachable**. Every occurrence
    bucket contributes at most one anchor (step 4 above), and every
    source-line index appears in at most one bucket (it is bucketed under
    its own normalized text), so no two anchors in the slice can ever share
    the same removed index. The secondary key (added index ascending) is
    therefore **dead in every reachable execution** — the primary
    comparison is always decisive given the current uniqueness invariant. A
    stable sort on the removed index alone is behaviorally equivalent; the
    added-index tiebreak may be dropped or kept with no observable effect.
  - **Candidate sort** (`meat/moves.go:172-180`): ties **are** structurally
    reachable here. Two distinct candidate moves (distinguished only by
    their added-range end, the one field the comparator never inspects)
    tie on all three compared keys (removed-start, added-start,
    removed-end) whenever they share the first two. But any two candidates
    tied this way necessarily share their added-range start, and range
    overlap (`meat/moves.go:256-258`) is trivially true whenever two ranges
    share a start line — so the very next step, the pairwise ambiguity
    filter (`meat/moves.go:182-190`), always marks **both** tied candidates
    ambiguous and drops both (`meat/moves.go:191-196`), regardless of which
    order the (non-stable) sort left them in. **Net assessment: H7 is
    technically live on this comparator (a genuine tie can occur, and Go's
    sort is not stable) but provably inconsequential to the returned move
    list** — the tied elements never survive the ambiguity filter either
    way. This resolves the open question below (previously: "no fixture
    exercises ties") with a proof rather than a fixture — though see
    Uncovered mechanism for the caveat that the proof itself has no test
    backstop.
- **H8** (integer arithmetic): the one arithmetic op in this file, the
  modulo-8 computation in `indentationColumns` (`meat/moves.go:222`), is
  safe under H8 — the running column count is always non-negative here,
  and Go/JS `%` agree for non-negative operands. No division occurs in
  `moves.go`.

## Errors

Every failure mode this file can itself produce, with exact templates:

- **Move symmetry (keep/remove/fold mismatch).** Outer frame,
  `meat/moves.go:383-386`:
  `"move symmetry: removed lines %d-%d match added lines %d-%d after
  indentation normalization; %s. Keep, remove, or fold corresponding move
  rows identically, including fold boundaries"` — `%s` filled by one of:
  - kind-mismatch detail, `meat/moves.go:379`: `"removed %s %s %s while
    added %s %s %s"` (e.g. `"removed lines 6-9 are removed while added
    lines 16-19 are kept"`).
  - both-folded-different-boundaries detail, `meat/moves.go:380-381`:
    `"removed %s and added %s are folded with different boundaries"`.
- **Move-replacement (local elision) symmetry.** `meat/moves.go:429-431`:
  `"move symmetry: removed lines %d-%d match added lines %d-%d after
  indentation normalization; corresponding kept lines %d and %d have
  different model-authored local elisions. Apply equivalent replacements to
  both sides or keep both lines verbatim"`
- **Multi-error wrapping** (not move-specific, but shapes how the two
  errors above actually surface to a caller when more than one problem is
  collected in a single compile): `joinEditPlanErrors`
  (`meat/editplan.go:531-540`) returns the bare single error when there's
  exactly one; otherwise `"edit plan has %d errors:%s"` where `%s` is a
  `"\n- %v"` block per problem. A port's error-text assertions must handle
  both surface forms.
- **Adjacent, cross-referenced but not owned by this file**: a fold whose
  range straddles a mandatory-import-extended row and a behavioral row
  fails in `imports.md`/`editplan.md` territory (`"fold[%d]: crosses
  automatically removed import rows and behavioral rows in range %d-%d;
  fold only the behavioral rows"`, `meat/editplan.go:230`) — this can be
  triggered by a move whose precedence extension
  (`applyMandatoryMovePrecedence`) has widened the mandatory mask
  underneath a model-authored fold; worth cross-referencing here since the
  *cause* is move-precedence-specific even though the *error* is emitted by
  `editplan.go`.

## Ordering Go leaves unspecified

- **Map iteration order** over the occurrence-bucket map
  (`meat/moves.go:101`) and over the candidate set (`meat/moves.go:169`) is
  randomized by the Go runtime — this is exactly why an explicit sort
  follows each (steps 5 and 7 above). A port using a JS `Map`/object would
  get deterministic insertion-order iteration for free at these two points,
  but the **contractual** output order is defined by the sort, not by build
  order — a port must still sort explicitly and must not treat its own
  deterministic map order as already correct.
- **Relative order of tied elements in the candidate sort** (H7 above) is
  unspecified by Go, and proven inconsequential to the final move list — a
  port need not reproduce whatever order Go's sort happens to leave them in.
- **`applyMandatoryMovePrecedence`'s iteration order over moves**
  (`meat/moves.go:265`) has no effect on the final mask: moves are
  pairwise non-overlapping and the update is a per-move-independent
  OR-propagate with no cross-move interaction, so any permutation of the
  move list yields the same final mask.
- **The order in which distinct moves' symmetry errors are appended** to
  the problem list (`meat/moves.go:354,383`) follows the (already-sorted,
  hence deterministic) move list — this one *is* portable and need not be
  flagged as Go-specific.

## Constants

See `constants.md`: `minMoveSubstantiveRows`, `minMoveNonspaceBytes`,
`maxMoveHints`.

- G12’s two-row “tiny coincidence” fails the size gate (and is also far
  below `minMoveNonspaceBytes`); positive detections use ≥3 substantive
  rows. The two gates are **not isolated** from each other in any fixture.
- `maxMoveHints` is never approached here (at most one move per case);
  overflow phrasing remains pinned by `rubric.md` G5 /
  `meat_test.go`.

## Open questions

- The django and flask golden fixtures never assert their move count — their
  `expectedMoves` field is unset (nil) in the test, so the test only checks
  that compilation doesn't hit a symmetry error against the golden plan, not
  what `detectedMovesInDiff` actually returns for them. If either fixture
  secretly contains a detected move, its exact coordinates are unverified.
  Flagging as unconfirmed intent rather than guessing —
  `meat/python_golden_test.go` case structs for django/flask, cf. pytest's
  `expectedMoves` at `:121-124`. **Stage 2: unaffected by mechanism tracing —
  a test-corpus question, not a mechanism ambiguity.**
- **`minMoveNonspaceBytes = 48` boundary** — no fixture sits just under/over
  48 nonspace bytes while clearing the row gate. Tiny fails both gates at
  once. **Stage 2: mechanism confirmed fully independent counters (see
  Mechanism, `substantialMove`); the boundary itself remains untested in
  either direction.**
- **`minMoveSubstantiveRows = 3` exact boundary** — 2 fails and ≥3 succeeds
  in practice, but isolation from nonspace remains incomplete for the 2-row
  case. **Stage 2: same status — mechanism is fully determined and
  independent of the byte gate; only the fixture coverage is missing.**
- **`maxMoveHints = 12` and `"and N more"`** — not used in
  `moves_test.go`; still covered only by surface/rubric overflow fixtures.
  **Stage 2: mechanism fully specified (`formatMovePairs`, see Mechanism) —
  overflowed moves are always the numerically-last ones by removed-side
  position, never an arbitrary subset. Coverage gap remains.**
- **Sort stability (H7)** — no multi-candidate fixture exercises anchor
  sort `meat/moves.go:118-123` or candidate sort `meat/moves.go:172-180`
  under ties; every positive case yields a single unambiguous move.
  **Stage 2: resolved by static proof, not by a new fixture — see Hazards,
  H7. Anchor-sort ties are structurally unreachable given the
  occurrence-uniqueness invariant; candidate-sort ties are reachable but
  always land on candidates that necessarily overlap and get dropped by the
  ambiguity filter regardless of sort order. The proof itself has no test
  backstop (see Uncovered mechanism below).**
- A move split across chunks (partial mapping failure, the "documented
  cost of chunking" at `meat/chunk.go:1006-1007`) is not directly tested —
  G7 proves both-sides-in-one-chunk is enforced, but no test shows a move
  whose sides land in different chunks silently drops out of enforcement.
  See `chunk.md` Open questions. **Stage 2: this is chunk.go's mapping
  logic, not moves.go's — unaffected by this pass.**
- **Overlapping-candidate discard** (`ambiguous` flag
  `meat/moves.go:182-196`) — not directly constructed; only multi-occurrence
  ambiguity (G12 case 1) is covered. **Stage 2: mechanism fully specified
  (see Mechanism, `detectExactMoves` step 8) — coverage gap remains.**
- **Blank-line handling inside moves** (`moveRowsMatch` empty-normalized
  short-circuit `meat/moves.go:234-236`) — not fixture-tested here. **Stage
  2: mechanism fully specified (two blank/whitespace-only rows always
  match, no indent constraint applied) — coverage gap remains, see
  Uncovered mechanism.**
- **Tab-based indentation column math** (`indentationColumns` tab→8
  `meat/moves.go:218-227`) — reindent fixtures use spaces only; trailing
  tab is content whitespace, not indent. **Stage 2: mechanism fully
  specified — genuinely never exercised on *leading* indentation in any
  fixture (the one tab in the suite is trailing content, stripped before
  this function runs). See Uncovered mechanism.**
- **Context-line poisoning of the uniqueness gate (new, stage 2).** Anchor
  formation counts hunk-source occurrences across **both context and
  change lines** (`meat/moves.go:65-73`). Two untested consequences: (a) a
  substantive change line that would otherwise anchor a move is silently
  disqualified if the same normalized text also appears, unchanged, as
  ordinary context anywhere else in the diff; (b) a text occurring exactly
  twice with one occurrence as context and one as change forms no anchor at
  all (context's marker satisfies neither switch arm at
  `meat/moves.go:106-112`). No fixture constructs a same-normalized-text
  context collision — every G12 ambiguity case uses only change-marked
  repeats.
- **Replacement symmetry ignores post-replacement indentation (new, stage
  2).** `validateMoveReplacementSymmetry` compares only normalized text,
  never indent (`meat/moves.go:425-427`) — consistent design, not a bug,
  but no fixture explores a `replace` operation whose span reaches into a
  row's leading-indentation region.
