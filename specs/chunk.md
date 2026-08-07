# chunk

> Status: stage 1 ✅ | stage 2 ⬜
> Go sources: `meat/chunk.go`
> Go tests: `meat/chunk_test.go` (36 tests, splitting/merging), `meat/meat_test.go` (3 tests, chunking triggers from `Abridge`'s perspective), `meat/chunk_sanity_test.go` (1 test, env-gated on `CHUNK_SANITY_DIFF`, opt-in real-world differential check)

## Purpose

When a diff is too large for one model context, it is split at structural
boundaries — file, then hunk, then sub-hunk — into independently valid
chunks, each abridged by its own agent run, then merged back into one
reading diff. Chunking must reproduce exactly what whole-diff compilation
would have produced: nothing is lost, nothing extra leaks, and cross-cutting
whole-diff analyses (mandatory import removal, move detection) are computed
once, globally, before any cut — never re-derived per chunk. See
`glossary.md` for shared vocabulary.

## Vocabulary

Terms specific to splitting/merging; see `glossary.md` for `edit plan`,
`fold`, `move`, etc.

- **Chunk** (`diffChunk`) — one independently abridgeable slice of the
  original diff; every chunk is itself a well-formed unified diff (passes
  `validateSupportedDiff`). `meat/chunk.go:52-78`.
- **File section** ("section") — the span of lines belonging to one file,
  from its `diff --git`/`---` header through the line before the next file
  or trailer — chunking's first-choice split boundary. `meat/chunk.go:340-355`.
- **Hunk run** — a maximal contiguous group of whole hunks packed into one
  piece of a split section (as opposed to a synthesized sub-hunk).
  `meat/chunk.go:490-522`.
- **Segment / sub-hunk** — a synthesized slice of *one* hunk's body, smaller
  than the whole hunk, emitted with its own synthesized `@@` header — the
  last-resort split level, used only when even one hunk doesn't fit.
  `meat/chunk.go:557-689`.
- **Cut** — the boundary point at which the splitter divides a section or
  hunk into two pieces.
- **Atomic unit** — the minimal span of physical lines a cut may never
  sever: a source line plus any trailing no-newline markers, any following
  lines that begin inside a multiline string/continuation on either side,
  and (Python) a suite owner through its first line that will actually emit
  as body. `meat/chunk.go:588-621`.
- **Continuation** (chunk field) — marks a piece that begins mid-file-section
  (not the section's first piece); its `metaPrefix` duplicates already-carried
  metadata, dropped by the merge step once the file has surfaced.
  `meat/chunk.go:64-67`.
- **Passthrough** — a chunk with no hunk content at all (stranded preamble or
  trailer prose); copied into the merged result verbatim with **no** agent
  run. `meat/chunk.go:68-72`.
- **metaPrefix** — the file-metadata block replicated onto every piece of a
  split section; the merge step uses it to detect and strip duplicate
  headers. `meat/chunk.go:56-59`.
- **sectionID** — groups pieces that came from splitting the same original
  file section, so the merge step knows which pieces' metadata may need
  deduping against each other. `meat/chunk.go:60-63`.
- **origins** — a per-chunk-line map back to the original diff's physical
  line index (`-1` for synthesized/placeholder lines); used to translate
  whole-diff move coordinates into a chunk's own coordinates.
  `meat/chunk.go:73-77,1003-1041`.
- **hidden / extraHidden** — `hidden` marks every line the whole-diff
  mandatory pass (import removal plus move-precedence extension) would
  remove; `extraHidden` isolates the subset a chunk-local compiler could
  *not* re-derive on its own (rows hidden only via a cross-chunk move
  pairing), forcing that section through row-dropping segmentation instead
  of verbatim packing. `meat/chunk.go:118-129,164-174`.
- **Gap convention** — the unified-diff header convention that a side with
  zero rows in a segment names the line immediately *before* the gap it
  left, rather than a hypothetical starting row. `meat/chunk.go:829-847`.
- **Owner (Python suite owner)** — a decorator or suite-header line
  (`if`/`def`/`for`/`while`/`with`/etc.) on the kept/added side that must
  stay attached through its first line that will actually render as body.
  `meat/chunk.go:780-789`.
- **Emits as body / semantic body row** — a row that will actually appear as
  content in a chunk's rendered output: a kept row with real (non-comment,
  non-blank) code, or a hidden row rendering as a mandatory placeholder.
  Comments, blanks, and dropped-without-placeholder rows do not count.
  `meat/chunk.go:791-803`.
- **String interior mask (`inString`)** — a per-line flag marking a hunk-body
  row that begins while either diff side is already inside a multiline
  string/continuation; built to match `embeddedSourceLines`'s per-side
  transitions exactly, so the splitter and each chunk's own import
  classifier never disagree about what counts as "inside a string".
  `meat/chunk.go:257-291`.
- **Numbered form** — the gutter-added rendering of a diff sent to the model
  (`numberedDiff`); chunk budgets are checked against *both* raw byte length
  and this numbered-form length. `meat/chunk.go:80-103`.
- **Single-run budget vs. `maxDiffBytes`** — `singleRunDiffBytes` is a `var`
  seam distinct from the immutable `maxDiffBytes` constant, letting tests
  shrink the effective per-run budget to force real splitting with tiny
  fixtures. `meat/meat.go:46-55`; seam `meat/chunk_test.go:13-18`.

## Guarantees

G1. When several whole file sections each fit the budget, the splitter
    greedily packs consecutive sections into one chunk rather than emitting
    one chunk per file; only when the next section would overflow the
    accumulator does it close that chunk and start fresh. Concatenating all
    chunks' text in order reproduces the original diff byte-for-byte
    (whole-section chunks are literal slices, not re-encoded).
    — `meat/chunk_test.go:69-90`, pinned against `meat/chunk.go:204-239`
    (greedy-pack loop; `spanFits`/`open`/`openEnd` accumulate at
    chunk.go:225-235) and `meat/chunk.go:340-355` (`sections()`, partitions by
    `fileID`).

G2. A file section too large to fit whole is split at hunk boundaries: every
    piece replicates the file's metadata block (`diff --git`/`---`/`+++`)
    verbatim, pieces after the first are marked `continuation`, and all
    pieces of the same split section share a `sectionID`. Hunk-boundary
    splits keep the original `@@` headers, headings included, on every piece
    — no synthesis is needed because cuts land exactly at hunk starts. No
    hunk-body row is lost or reordered across pieces.
    — `meat/chunk_test.go:92-129` (6 hunks in one file, each well under
    budget, file over), pinned against `meat/chunk.go:394-460` (`splitSection`:
    metadata replication in `emit`) and `meat/chunk.go:490-522` (per-hunk
    packing loop).

G3. When even a single hunk is oversized, it is cut into synthesized
    sub-hunks ("segments"), each with its own `@@` header whose counts match
    exactly the rows it carries — checked structurally by running
    `validateSupportedDiff` on every chunk. All changed (`+`/`-`) rows
    survive across segments in original order; a change-free trailing
    segment may drop context rows.
    — `meat/chunk_test.go:131-185` (30-row hunk, budget forcing ~3-way
    split), pinned against `meat/chunk.go:579-689` (`splitHunk`, per-segment
    fits-check loop at 653-657).

G4. Of the segments synthesized from one oversized hunk, only the first (the
    one that begins at the true top of the hunk body) keeps the original
    start offsets and the original heading; every later segment omits the
    heading, since a heading describing enclosing context does not describe
    context the segment starts inside.
    — `meat/chunk_test.go:171-184`, pinned against `meat/chunk.go:646-652`
    (`segHeading` set only `if atBodyStart`) and `meat/chunk.go:833-837`
    (`synthHunkHeader`).

G5. A `\ No newline at end of file` marker is never separated from its
    owning source line by a cut, even when the budget is sized to force a
    split right around it.
    — `meat/chunk_test.go:187-211`, pinned against `meat/chunk.go:588-592`
    (`unitEnd`'s atomic-unit extension over `diffLineNoNewline`/`inString`).

G6. A file section with no hunks to divide (e.g. a binary-file marker
    followed by junk lines) cannot be split; splitting fails with an error
    advising a narrower range rather than truncating or crashing.
    — `meat/chunk_test.go:213-219` (asserts error contains `"narrower"`),
    exact text at `meat/chunk.go:402-405`: `"file section at line %d is %dKB
    with no hunks to split — try a narrower diff (per-file with \`git diff --
    <path> | meat\`)"`.

G7. Synthesized segment `@@` headers follow unified-diff's gap convention: a
    side with rows in the segment names its first row, continuing the
    original start by rows already consumed on that side; a side with no
    rows in the segment (whose original count was nonzero) names the line
    immediately before the gap. Exact fixture: splitting `@@ -10,2 +20,2 @@`
    at single-row granularity produces exactly `@@ -10,1 +19,0 @@`,
    `@@ -11,1 +19,0 @@`, `@@ -11,0 +20,1 @@`, `@@ -11,0 +21,1 @@` — verified
    by exact string equality.
    — `meat/chunk_test.go:225-248`, pinned against `meat/chunk.go:829-847`
    (`synthHunkHeader` / `gapAdjustedStart`).

G8. When a hunk side's original count was already zero (a pure insertion),
    splitting must not re-decrement that side's start on subsequent segments
    — it already names the line before the gap. The other (nonzero) side's
    start advances correctly by rows already consumed per segment.
    — `meat/chunk_test.go:253-275`, pinned against `meat/chunk.go:839-846`
    (`gapAdjustedStart`'s `originallyZero` guard) fed by `meat/chunk.go:869-871,878-892`.

G9. Splitting a new-file hunk (`@@ -0,0 ...`) never synthesizes a negative
    old-side start; it clamps at zero.
    — `meat/chunk_test.go:279-293`, pinned against `meat/chunk.go:839-846`.

G10. The splitter pre-applies the whole-diff mandatory import mask before
     cutting, so import scaffolding (an `import (` opener, its members, its
     closer) never appears in any chunk — not merely kept intact within one
     chunk — even under an adversarial budget sized to place a naive
     per-line greedy cut mid-block.
     — `meat/chunk_test.go:300-336`, pinned against `meat/chunk.go:164-174`
     (whole-diff `hidden`/`extraHidden` computed before any section/hunk
     iteration) and `meat/imports.go:156-250` (`mandatoryImportRemovalPlan`).
     See `imports.md`.

G11. End-to-end: running `Abridge` over an import-block fixture with an
     identity model plan, the merged reading diff contains zero
     import-scaffolding text and retains every behavioral row before/after
     the block — chunking reproduces exactly what whole-diff mandatory-import
     compilation would produce.
     — `meat/chunk_test.go:337-356`, pinned against `meat/chunk.go:703-743`
     (`unitStats` drops hidden rows from segment bodies) and
     `meat/chunk.go:915-1001` (`abridgeChunked`, the merge). See `imports.md`.

G12. When the source diff uses CRLF line endings, every emitted line of
     every chunk — including synthesized `@@` headers — uses CRLF too; no
     chunk contains a bare LF line.
     — `meat/chunk_test.go:360-382`, pinned against `meat/chunk.go:582-584`
     (`headerEOL := b.lines[h.start].eol`), used at `meat/chunk.go:681-682`.

G13. A single physical source line longer than the whole budget cannot be
     split (cuts occur only between physical lines); splitting fails with
     narrower-range advice rather than truncating a line's bytes.
     — `meat/chunk_test.go:384-390`, pinned against `meat/chunk.go:653-657`
     (per-unit fits-check `break`s before any row is accepted), error at
     `meat/chunk.go:674-676`: `"cannot split the diff near line %d into a
     chunk under the size limit — try a narrower diff (...)"`.

G14. A diff exceeding the (test-shrunk) single-run budget, whose individual
     file sections each fit alone, splits into one chunk per section and
     each chunk gets its own full agent run.
     — `meat/chunk_test.go:397-436`, pinned against `meat/chunk.go:915-966`
     (`abridgeChunked`'s per-chunk `abridgeOne` call).

G15. Each chunk's line numbering restarts at 1 regardless of the chunk's
     position in the original diff, and each chunk's model-visible prompt
     contains only that chunk's file content — chunks are fully isolated on
     the model-visible surface.
     — `meat/chunk_test.go:437-451`, pinned against `meat/chunk.go:959-963`
     (`sub.UnifiedDiff = chunk.text` fed fresh into `abridgeOne`, numbered per
     `meat/meat.go:137`).

G16. The merged result concatenates each chunk's reading diff in original
     order, joins distinct per-chunk summaries with a single space, and sums
     token usage across chunks.
     — `meat/chunk_test.go:452-463`, pinned against `meat/chunk.go:967-968`
     (token sum), `meat/chunk.go:986-990,998-999` (summary dedup/join).

G17. Progress callbacks during a chunked run report `"large diff: abridging N
     chunks"` once up front, then every inner progress message is prefixed
     `"chunk i/N: "`.
     — `meat/chunk_test.go:464-469`, pinned against `meat/chunk.go:931-933`
     and `meat/chunk.go:957-961` (`label := fmt.Sprintf("chunk %d/%d", run,
     modelChunks)`).

G18. When a file is split into pieces and both pieces retain content, the
     merged reading diff carries that file's metadata block exactly once,
     while every piece's hunk content survives. Identical summaries from
     different chunks are deduplicated.
     — `meat/chunk_test.go:480-517`, pinned against `meat/chunk.go:970-981`
     (`emittedMeta`/`stripReplicatedMeta` dedup) and `meat/chunk.go:987-990,946`
     (`seenSummary`).

G19. When the first piece of a split file abridges to nothing (its model
     plan removes all its lines), the continuation piece's replicated
     metadata is the file's only header in the merged output and must
     survive un-stripped — deduping requires the metadata to have actually
     surfaced once first.
     — `meat/chunk_test.go:522-555`, pinned against `meat/chunk.go:976-981`:
     `emittedMeta[chunk.sectionID]` is set true only when
     `pieceContainsLine(piece, firstLineText(chunk.metaPrefix))`.

G20. Non-file preamble text (e.g. a git-show commit message) preceding a
     section that later gets split rides only the first piece verbatim; it
     is never replicated onto continuation pieces. `metaPrefix` never
     contains the preamble — only the file's own metadata block — even on
     the first piece.
     — `meat/chunk_test.go:561-593`, pinned against `meat/chunk.go:406-421`
     (identifying `preamble` vs `meta` spans) and `meat/chunk.go:441-460`
     (`emit`: `metaPrefix: metaText` excludes preamble at line 451; preamble
     only prepended to piece 0's `text` at line 446).

G21. When the first piece's plan elides its whole file-section body but
     retains the preceding preamble prose, the continuation piece's
     replicated file header is not stripped as a duplicate — there is no
     surfaced header to dedupe against — otherwise its hunks would be
     orphaned under the commit message with no file header at all.
     — `meat/chunk_test.go:600-641`, pinned against the same gating as G19
     (`meat/chunk.go:970-981`).

G22. If the chunked source diff's last physical line has no trailing
     newline, an identity abridgement (nothing removed anywhere) reproduces
     the input byte-for-byte after merging — the merge step never appends a
     spurious trailing newline.
     — `meat/chunk_test.go:646-664`, pinned against `meat/chunk.go:938-945`
     (`appendPiece`: a synthetic `"\n"` is inserted only between joined
     parts, never after the last).

G23. If any one chunk's agent run fails, the whole abridgement fails — no
     silently partial result — and the error names the failing chunk as
     `"chunk N/M"`.
     — `meat/chunk_test.go:669-684`, pinned against `meat/chunk.go:894-908`
     (`chunkError`) and `meat/chunk.go:957-966` (label + wrap).

G24. A chunk failure's error still satisfies `errors.Is` against the
     underlying cause through `Unwrap`, while its `Error()` string still
     names `"chunk N/M"`.
     — `meat/chunk_test.go:689-705`, pinned against `meat/chunk.go:902-908`
     (`chunkError.Error()`/`.Unwrap()`).

G25. A package rename (paired `-package`/`-import` and `+package`/`+import`
     rows) that whole-diff compilation keeps visible (package rows) while
     hiding (import rows) continues to hold when a mid-hunk cut forces the
     removed side into one chunk and the added side into another, each
     seeing a one-sided change. The merged chunked result still contains
     both sides' `package` rows and no `import` text at all.
     — `meat/chunk_test.go:713-759`, pinned against `meat/imports.go:168-181`
     (per-side masks computed over the whole hunk before any cut) combined
     with `meat/chunk.go:164-174` (mask computed globally before splitting).
     Reference behavior pinned monolithically by
     `TestCompileEditPlan_MandatoryImportsPreservePackageRenames`
     (`meat/imports_test.go:212`). See `imports.md`.

G26. Import-like statements textually embedded inside a source string literal
     (e.g. `import pytest` inside a JS/Go backtick template) are recognized
     from the string's opener and hidden by whole-diff compilation. When a
     cut separates the opener from the embedded rows, the merged chunked
     result still hides exactly what whole-diff compilation hides, while
     genuinely behavioral rows outside the string survive.
     — `meat/chunk_test.go:766-812`, pinned against `meat/chunk.go:257-291`
     (`stringInteriorMask`) and `meat/imports.go:625` (`embeddedSourceLines`).
     See `imports.md`.

G27. Pathological amplification (a huge single hunk whose per-piece overhead
     leaves almost no body budget, forcing near one-row-per-piece) is
     refused outright rather than exploding into hundreds of
     chunks/agent runs; the error advises a narrower range.
     — `meat/chunk_test.go:817-834`, pinned against `meat/chunk.go:249-255`
     (`add`: `if len(b.chunks) >= maxChunks { ... }`). See Constants.

G28. A format-patch mail-signature/version trailer following the last hunk of
     a split section survives splitting; identity chunked abridgement
     reproduces the entire input byte-for-byte, trailer included.
     — `meat/chunk_test.go:839-862`, pinned against `meat/chunk.go:418-429`
     (`tailStart` identification) and `meat/chunk.go:527-553` (tail
     attachment / passthrough prose piece).

G29. For every candidate cut point landing inside a multiline string's
     interior or immediately after it, cuts systematically avoid starting a
     segment there (a chunk-local compiler would otherwise misread the
     closing delimiter as an opener and misclassify following rows).
     Verified across three forced cut positions that the chunked result
     never loses a behavioral row outside the string and never leaks the
     string's interior text.
     — `meat/chunk_test.go:869-914`, pinned against `meat/chunk.go:590`
     (`unitEnd`'s `b.inString[j]` extension) built by
     `meat/chunk.go:257-291` (`stringInteriorMask`).

G30. An oversized diff whose every changed row is import scaffolding splits
     into zero model-visible chunks; no model call is made at all, and the
     result is an empty `SmartDiff` with the fixed `Summary` text `"Only
     imports and unchanged context; nothing to read."`.
     — `meat/chunk_test.go:919-946`, pinned against `meat/chunk.go:205-212`
     (`spanFullyHidden` skips the section) and `meat/chunk.go:992-996` (the
     `modelChunks == 0` short-circuit).

G31. String-interior tracking is per diff side but the scan advances in
     physical line order across the whole hunk (not filtered to one side
     first): a row of the other polarity physically interleaved between one
     side's string opener and its closer is also treated as uncuttable,
     because starting a segment there would desynchronize that side's
     lexical state.
     — `meat/chunk_test.go:952-1000`, pinned against `meat/chunk.go:265-291`
     (`stringInteriorMask`: both scanners advance on every physical line).

G32. When greedy hunk-run packing fills a section's final piece to the
     brim, the trailer becomes its own passthrough piece rather than causing
     a refusal; identity chunked abridgement stays byte-exact. **Weaker than
     the guarantee sounds**: the "own piece" claim is only soft-asserted
     (`t.Logf`, non-failing) in the source test — only the end-to-end
     byte-identity is a hard assertion.
     — `meat/chunk_test.go:1030-1061` (soft check at 1048; hard check at
     1058-1060), pinned against `meat/chunk.go:533-541` (`fitsSingleRun`
     gate) and `meat/chunk.go:542-553` (passthrough piece emission).

G33. When the mandatory import pass would empty a visible Python suite
     owner's body, whole-diff rendering emits a fixed `"..."` placeholder row
     in its place. When a cut lands at the owner line or at the dropped
     import line itself (kept in the same segment by owner-atomicity, see
     python.md), the chunk containing them still emits that placeholder row
     exactly as whole-diff rendering would — the splitter pre-computes the
     placeholder decision from whole-diff analysis and carries it into
     segment emission.
     — `meat/chunk_test.go:1067-1109`, pinned against `meat/chunk.go:175-182`
     (`b.foldAt`/`b.folds` populated from `addMandatoryPythonSuitePlaceholders`,
     `meat/imports.go:12-55`) and `meat/chunk.go:766-775` (`placeholderRow`).
     See `imports.md`, `python.md`.

G34. A section containing rows hidden only by whole-diff move-precedence
     (not by the plain import mask) is never packed verbatim into a chunk,
     even if it would otherwise fit whole — it is forced through the
     row-dropping segmentation path so those rows are actually dropped from
     the emitted text.
     — `meat/chunk_test.go:1140-1145`, pinned against `meat/chunk.go:171-174`
     (`extraHidden` isolates move-only-hidden rows) and `meat/chunk.go:213-224`
     (`spanHasExtraHidden` forces segmentation instead of verbatim packing).
     See `moves.md`.

G35. A cut must never land directly after a Python suite-owner row (decorator
     or `if`/`def`/`for`/etc.) leaving its body in a different chunk: for
     every forced cut at the owner row, no chunk contains the owner text
     without also containing its first body row. This holds whether the
     owner is a changed row or an unchanged (context) row whose kept/added
     body follows removed old rows — the cut must not land between the
     owner (or interleaved removed rows) and the first kept body row.
     — `meat/chunk_test.go:1248-1300`, pinned against `meat/chunk.go:780-789`
     (`pythonOwnerLine`), `meat/chunk.go:600-619` (`unitEnd`'s owner-absorption
     loop), and `meat/chunk.go:794-803` (`emitsPythonBody`'s exclusion of
     removed-side rows). See `python.md`.

G36. Rows immediately following an owner that are a dropped import row, then
     a comment — neither of which counts as emitted semantic body — do not
     satisfy the atomic unit; it extends through the first row that will
     actually emit as body, skipping the dropped import (unless it emits a
     mandatory placeholder) and the comment.
     — `meat/chunk_test.go:1302-1327`, pinned against `meat/chunk.go:791-803`
     (`emitsPythonBody`).

G37. File sections/hunks the whole-diff compiler removes entirely (pure
     import churn) are skipped by the splitter — no chunk, no agent run —
     so a many-file import-churn diff pays for one agent run per behavioral
     file shell, not one per file shell touched.
     — `meat/chunk_test.go:1333-1367`, pinned against `meat/chunk.go:205-212`
     (`spanFullyHidden` skips the whole section without emitting any chunk).

G38. A move maps into a chunk only when both complete sides land contiguously
     within that single chunk; a move split across chunks cannot be enforced
     there (a documented cost of chunking).
     — `meat/chunk_test.go:1387-1389`, pinned against `meat/chunk.go:1003-1031`
     (`mapMovesToChunk`'s `mapRange`, which fails the whole move if any row's
     chunk-line position isn't contiguous). See `moves.md`.

G39. Explicit Python backslash line continuations and open bracket
     expressions are never severed by a cut: for every forced cut at each
     continuation row, a chunk either contains both the opener and its
     continuation/closer, or neither.
     — `meat/chunk_test.go:1443-1473`, pinned against
     `meat/chunk.go:296-336` (`stringScanState.scan`: `s.backslash` via
     `endsPythonBackslash`, `s.brackets` via
     `pythonDelimiterBalanceWithState`), consumed identically to string
     interiors at `meat/chunk.go:590`. See `python.md`.

G40. End-to-end: at a budget placing a continuation opener and its bracket
     body in the same chunk, a plan that removes only the continuation-opener
     line (orphaning its tail) is rejected inside the chunk with a tool error
     containing `"continuation"`, exactly as whole-diff compilation would
     reject it; the merged final result (after a valid resubmission) still
     contains both the opener and its tail.
     — `meat/chunk_test.go:1475-1536` (rejection check at line 1524), pinned
     against `meat/python.go:521-570` (`validatePythonBackslashContinuations`),
     exact error at `meat/python.go:562`: `"remove/fold: Python backslash
     continuation on lines %d-%d must be retained or hidden together"`.

G41. `fitsSingleRun`'s boundary is exact: a diff whose numbered-form size
     equals the budget fits; one byte under that size does not fit; and a
     raw (un-numbered) size already over budget never fits regardless of
     numbered size — the raw-length check alone is sufficient to reject,
     without needing valid diff structure.
     — `meat/chunk_test.go:1548-1559`, pinned against `meat/chunk.go:91-103`
     (`fitsSingleRun`, raw-length short-circuit at 94-96, numbered check at
     101-102) and `meat/chunk.go:80-89` (`numberedLen`).

G42. A diff whose raw bytes fit the per-run budget but whose numbered form
     (with the `N|` gutter) does not is still split into chunks rather than
     sent whole — the numbering overhead itself can force chunking. Each
     per-chunk run receives a user prompt whose total size never exceeds the
     per-chunk raw-diff budget plus the fixed byte lengths of the standing
     prompt fragments (plus a small fixed slack for fence/formatting bytes).
     — `meat/meat_test.go:430-470` (two 40-line file sections, ~360 raw bytes
     vs. a 400-byte test budget via `setSingleRunBudget`; asserts `m.seen >=
     2` and every observed prompt length `<= 400 + len(userPromptIntro) +
     len(userPromptImports) + len(userPromptNoTools) + len(userPromptProtocol)
     + 8`). Mechanism: the raw-vs-numbered dual check in `fitsSingleRun`
     (`meat/chunk.go:93-103`), fixed prompt fragments (`meat/meat.go:242-247`)
     assembled by `buildUserPrompt` (`meat/meat.go:250-270`).

G43. A diff whose raw byte length exceeds the total chunking cap
     (`maxTotalDiffBytes`) is refused up front with an error advising a
     narrower range, and never reaches the model.
     — `meat/meat_test.go:365-381` (error contains `"narrower"`, `m.seen ==
     0`). Exact message and mechanism: `meat/meat.go:122-124`.

G44. A diff that fits under the total cap but contains one file section with
     no hunks at all to split on — and is itself too large for a single
     agent run — is refused with an error advising a narrower diff, rather
     than being sent to the model unsplit or causing a panic.
     — `meat/meat_test.go:383-400` (single file section, no `@@` hunk header,
     sized at `maxDiffBytes`; error contains `"narrower"`, `m.seen == 0`).
     Mechanism: `meat/chunk.go:394-404` (`splitSection`, error at 403),
     reached via `splitDiffForAbridging` (`meat/chunk.go:150`) from
     `abridgeChunked` (`meat/chunk.go:915-919`).

G45. `Request`'s exported field order/shape is unaffected by the chunking
     feature: chunk-internal bookkeeping lives in a separate `runOptions`
     type, not in `Request`, so a positional struct literal still compiles
     and populates `UnifiedDiff` correctly. This is a compile-time
     source-compatibility guarantee for embedders, pinned specifically
     because chunking was added without changing `Request`.
     — `meat/chunk_test.go:1541-1546`, pinned against `meat/meat.go:62-76`
     (`Request` fields) and `meat/meat.go:78-90` (`runOptions`, kept
     separate). See `agent-loop.md`.

### Real-world differential sanity check (`chunk_sanity_test.go`)

G46. Splitting an arbitrary, externally-supplied real-world diff — not a
     curated synthetic fixture — at the production single-run budget and at
     three shrunken budgets (200KB, 64KB, 16KB) always succeeds, and every
     resulting chunk independently fits the same budget and independently
     passes structural diff validation. Across all chunks of one run,
     concatenating in chunk order exactly the changed rows that survive the
     whole-diff mandatory pass (import removal plus move-precedence
     extension, placeholder rows excluded) reproduces, byte-for-byte and in
     the same order, the same computation run once over the whole, unsplit
     diff — chunking loses, duplicates, and reorders none of what
     whole-diff compilation would have kept. A budget smaller than twice
     the fixture's longest single physical line is exempted from this
     check and only logged, not asserted: a single physical line is never
     split, so a budget that tight legitimately refuses rather than
     violating the guarantee. Generalizes, against arbitrary input, the
     same invariant G10/G11/G25/G26/G34 pin with synthetic fixtures.
     — `meat/chunk_sanity_test.go:17-61` (env gate `:18-21`, skip-boundary
     `budget < longest*2` at `:38`), oracle `retainedChangedRows`
     (`:66-78`), pinned against `splitDiffForAbridging`
     (`meat/chunk.go:150`), `fitsSingleRun` (`meat/chunk.go:93-103`),
     `validateSupportedDiff` (`meat/diff.go:88`), `mandatoryRemovalMask`
     (`meat/imports.go:341-349`), `mandatoryImportRemovalPlan`
     (`meat/imports.go:156-250`), `detectExactMoves` (`meat/moves.go:58`),
     `applyMandatoryMovePrecedence` (`meat/moves.go:265-280`), and
     `isFixedFoldLine` (`meat/elision.go:133-138`, excludes synthesized
     `"..."` placeholder rows the splitter itself writes in place of a
     hidden Python-suite-owner import row — see `elision.md`).

## Constants

| Name | Value | Unit | Citation | At the boundary |
|---|---|---|---|---|
| `maxChunks` | `32` | count | `meat/chunk.go:50` | Refusal: `"diff splits into more than %d chunks — try a narrower range (...)"` — `meat/chunk.go:251`. Pinned (blowup case) by G27; the exact 32/33 boundary itself is untested. |
| `maxTotalDiffBytes` | `4 << 20` (4,194,304) | bytes | `meat/chunk.go:42` | Hard error, `meat/meat.go:122-124`. Pinned by G43. |
| `singleRunDiffBytes` (var, defaults to `maxDiffBytes`) | test-shrunk in every chunking test | bytes | `meat/meat.go:55` (`var`, not `const`) | Per-run byte budget checked by `fitsSingleRun`; test-injectable via `setSingleRunBudget` (`meat/chunk_test.go:13-18`) — the seam every chunking test in this file depends on. |
| `maxDiffBytes` | `400 << 10` (~400KB) | bytes | `meat/meat.go:51` | Diffs over this are split into chunks; production default for `singleRunDiffBytes`. |

## Open questions

- **`extraHidden` sandwiching behavior is unverified.** A fully-hidden
  section always flushes any in-progress whole-section packing run before
  continuing (`meat/chunk.go:205-212`). No test has two small behavioral
  sections flanking a fully-import-hidden section to check whether they are
  forced into separate chunks or would otherwise pack together across the
  gap.
- **The `piece == 0` prose path in `splitSection` is untested with both
  preamble and tail non-empty** — when every hunk of a section is fully
  hidden but the section has both leading preamble and a trailing tail,
  `meat/chunk.go:542-545` builds a combined prose piece; no test exercises
  all three conditions together.
- **"Cannot fit the diff trailer" error path is unexercised**
  (`meat/chunk.go:546-549`, `fitsSingleRun(prose, b.budget)` failing).
- **Nested Python owners are untested at the chunk level** — e.g. a
  decorator followed by a `def` followed by an `if`; only a single-level
  owner is exercised (G35).
- **A move split across chunks (partial mapping failure) is not directly
  tested** — G38 proves both-sides-in-one-chunk is enforced, but no test
  shows a move whose sides land in different chunks silently drops out of
  enforcement.
- **Java package-rename-across-cut is untested** — `isImportOnlyFramingRow`
  (`meat/imports.go:274-300`) treats `package` specially for both Go and
  Java, but G25 only exercises Go.
- **Exact `maxChunks` boundary is untested** — no test shows exactly 32
  chunks succeeding and 33 failing.
- **G32's core claim is soft-asserted**, not enforced by a failing
  assertion — see G32 itself.
- **Cross-hunk Python import continuation** (`hunkStartsImportContinuation`,
  `meat/imports.go:370-394`) is not exercised together with splitting. Likely
  safe by construction (the import mask is computed globally before
  cutting, per G10/G26) but not directly pinned.
- **G46's doc comment doesn't match its code.** `chunk_sanity_test.go`'s doc
  comment says a budget "below the diff's longest physical line" is
  skipped, but the code skips when `budget < longest*2` — twice the
  longest line, not merely at or above it. No rationale for the factor of
  2 is stated anywhere; the guarantee is pinned to the code, not the
  comment.
- **G46 never asserts a split actually occurs.** No check requires
  `len(chunks) > 1` at any budget — a supplied diff smaller than 16KB would
  pass every budget trivially (each producing one whole-diff "chunk")
  without exercising a real cut; only a non-failing `t.Logf` reports chunk
  counts. G46 also has no accommodation for a real-world diff legitimately
  tripping `maxChunks` refusal (G27) or the line-too-long refusal (G13) at
  a small budget — either would `t.Fatalf` the whole test rather than
  being treated as an expected outcome. And G46 never calls
  `abridgeChunked`/`Abridge` or checks a byte-exact merge back to the
  original (that's G22/G28/G32, pinned only via synthetic fixtures) — it
  only splits and structurally re-validates, never abridges or merges.
