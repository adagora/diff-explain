# chunk

> Status: stage 1 ✅ | stage 2 ✅
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

## Mechanism

### 1. The design costs chunking accepts (`meat/chunk.go:1-27`)

The file's own header comment is the binding design document; the port must preserve every cost stated here exactly, not "fix" any of them.

**What stays the same on the model-visible surface.** A single agent run re-sends the whole numbered diff every turn, so splitting only ever happens because that per-turn payload is bounded (`meat/chunk.go:4-5`, `maxDiffBytes`/`singleRunDiffBytes`, see Constants). Once split, each chunk is abridged by its own agent run using the **same rubric** and its own **fresh 1-based line numbering**, restarting at 1 regardless of the chunk's position in the original diff (`meat/chunk.go:13-14`, pinned by G15). Nothing else about the model-visible prompt surface changes — the model reasoning about chunk 3 of 5 sees a self-contained, well-formed unified diff and cannot tell it is a fragment except via the move hint (§11) and progress-label prefixing (G17).

**What is pre-resolved once and mirrored into every chunk.** Three whole-diff analyses that a fragment cannot reproduce on its own are computed once, before any cut, and then carried into segment/piece construction rather than re-derived per chunk (`meat/chunk.go:15-19`):
- the mandatory import mask, **including** move-precedence extension (§2) and Python suite placeholders (§2);
- string interiors and no-newline markers, which a cut must never land inside (§3, §7);
- moves: **per-chunk agent runs skip move detection entirely** (`meat/chunk.go:19-20`) — "fragment-local occurrence counts would invent moves the whole diff rejects as ambiguous" (`meat/chunk.go:20-21`) is the literal reason given; the splitter instead maps the whole-diff move set into per-chunk coordinates for enforcement (§11-§12).

**The genuine, accepted cost: judgment locality** (`meat/chunk.go:22-26`). Three things are real losses, stated as accepted, not as bugs to eventually close:
1. The model reasons over **one chunk at a time** — it never sees the rest of the diff.
2. **Cross-chunk Python reference validation is per-chunk only.** `validateHiddenReferences` (`python.md` G20-G21) scans "every other hunk-source line in the same file" — but a chunk-local run only has its own chunk's text, so a reference living in a sibling chunk is invisible to that check.
3. **A move or Python suite whose parts land in different chunks cannot be enforced or kept atomic beyond the owner's first body row.** For moves this is exactly G38/G7 (`mapMovesToChunk` drops any move whose sides aren't both contiguous in one chunk, §12). For Python suites this is the `unitEnd` owner-absorption mechanism (§7): it guarantees atomicity only through the owner's *first* body row — a suite whose *later* body content spans a further cut is not further protected.

"Splitting prefers file boundaries, then hunk boundaries, to keep those costs rare" (`meat/chunk.go:27`) — this is why the splitter is a three-level *escalation* (§5→§6→§7), not a single uniform algorithm: each level is tried only when the previous one couldn't avoid a cut, specifically to minimize how often the judgment-locality cost above is actually paid.

**This is a guarantee the port must preserve exactly.** In particular, a port that "improves" cross-chunk Python reference validation to actually work across chunks, or that makes a split move partially enforceable, would silently produce *different* accepted/rejected plans than the Go implementation and its golden/differential tests (`chunk_sanity_test.go`, G46) establish as correct — this is not merely a missing feature to add later, it is behavior the existing test suite is calibrated against.

### 2. `chunkBuilder` setup (`splitDiffForAbridging`, `meat/chunk.go:150-244`; struct `meat/chunk.go:110-145`)

Exact sequential order of setup, before any splitting decision is made:

1. **Parse.** `lines := splitSourceLines(raw)` (cite `diff.md` Algorithm 1), `layout := analyzeDiff(lines)` (cite `diff.md` Algorithm 3); if `layout.problems` is non-empty, return immediately via `joinEditPlanErrors` — no further setup runs (`meat/chunk.go:151-155`).
2. **`inString`** is computed as part of the struct literal itself (`stringInteriorMask(lines, layout)`, `meat/chunk.go:162`) — it depends only on the immutable `lines`/`layout`, so its position relative to the other fields is not load-bearing; see §3.
3. **`hidden`/`extraHidden`** (`meat/chunk.go:164-174`):
   - `importMask := mandatoryRemovalMask(len(lines), mandatoryImportRemovalPlan(lines, layout))` — cite `imports.md` Algorithms 1-8, this is the plain import mask with **no** move-precedence extension yet.
   - `b.hidden = append([]bool(nil), importMask...)` — starting from a `nil` slice forces `append` to allocate a **fresh backing array** and copy `importMask`'s contents into it; `b.hidden` and `importMask` are from this point two independent slices over independent memory, sharing no storage.
   - `applyMandatoryMovePrecedence(detectExactMoves(lines, layout), b.hidden)` (cite `moves.md` §"`applyMandatoryMovePrecedence`") mutates the **elements** of `b.hidden`'s backing array in place. Because `b.hidden` was cloned into its own array in the previous step, this mutation is confined to `b.hidden` and **never touches `importMask`'s own backing array** — `importMask` after this call still reflects the plain-import-only mask exactly as `mandatoryRemovalMask` produced it.
   - `b.extraHidden[i] = b.hidden[i] && !importMask[i]` (`meat/chunk.go:172-174`) is therefore precisely the set-difference "rows added by move-precedence extension" — every `i` where `b.hidden[i]` is `true` but `importMask[i]` was `false`, i.e. exactly the rows a chunk-local pass could not re-derive on its own (a chunk-local `mandatoryImportRemovalPlan` over that chunk's own fragment would correctly reproduce `importMask`'s decisions, since plain import classification is a self-contained per-hunk/per-file computation — cite `imports.md`'s Mechanism, "Responsibility and dependents" — but it has no way to know about a move counterpart possibly living in a different chunk). This is `chunk.go`'s own bookkeeping, distinct from what `imports.md`/`moves.md` describe about `applyMandatoryMovePrecedence`'s own effect — those specs describe *what* precedence extension hides; this is *which specific rows* it was the one to add, on top of what plain import classification already hid.
4. **Mandatory Python suite placeholders** (`meat/chunk.go:175-182`): a throwaway `planState` is built purely to harvest `foldAt`/`folds` for later per-line lookups (§7's `placeholderRow`) — it is never used for anything else, never rendered, never mutated again after this block:
   - `placeholderState := newPlanState(len(lines))` — all-`false` `hidden`, all-`-1` `folded`/`foldAt` (cite `editplan.md` §2, `newPlanState`).
   - `copy(placeholderState.hidden, b.hidden)` — seeds `hidden` with the already-extended mandatory mask (post move-precedence), **not** the plain `importMask`.
   - `addMandatoryPythonSuitePlaceholders(lines, layout, &placeholderState, b.hidden)` — cite `imports.md` Algorithm 8; this call mutates `placeholderState` in place, synthesizing one `plannedFold` per owner whose visible body the mandatory mask emptied.
   - `b.foldAt = placeholderState.foldAt; b.folds = placeholderState.folds` — only these two fields of the throwaway state are ever read out; `placeholderState.hidden`/`.folded` are discarded once this block ends.
5. **`prefixText`/`prefixRaw`** (`meat/chunk.go:183-186`): prefix-sum arrays over, respectively, byte length without and with line terminators — `prefixText[i+1] = prefixText[i] + len(lines[i].text)`, `prefixRaw[i+1] = prefixRaw[i] + len(lines[i].text) + len(lines[i].eol)`. **Why this matters as an algorithmic-complexity property, not just a convenience**: every candidate cut point evaluated by the greedy packing loops below (§5, §6) needs the byte size of some span `[a,b)`; with the prefix arrays this is `prefixText[b]-prefixText[a]` — O(1) via subtraction. `b.spanSizes` (`meat/chunk.go:377-379`) is exactly this subtraction. A port that instead rescans the span's bytes on every candidate cut point (a natural-looking, "just measure the substring" implementation) would be **O(n) per check inside an O(n) greedy scan**, i.e. quadratic on a large diff — the prefix arrays exist specifically to keep the whole splitter linear.
6. **`sections := b.sections()`** (§4) is called only after all of the above; if it returns zero spans, splitting fails immediately (`meat/chunk.go:189-191`, error table below).

### 3. `stringInteriorMask` / `stringScanState` (`meat/chunk.go:257-336`)

A per-physical-line, per-diff-side scan deciding which hunk-body lines begin while lexically "inside" a multiline continuation, for cut-avoidance purposes (§7's `unitEnd`).

**Language resets at every hunk header, never carries across a hunk boundary** (`meat/chunk.go:270-273`): `if kind == diffLineHunkHeader { language = layout.language[i]; old, new = stringScanState{}, stringScanState{}; continue }`. Both side-trackers are reset to their zero value at every `@@` line. This means string/bracket/backslash state is scoped strictly *within* one hunk — a triple-quoted string opened in one hunk and (in reality) still open at the start of the next hunk of the same file is **not** tracked across that boundary; the mask only ever reflects what's visible within the current hunk's own body.

**A line's mask value is recorded *before* scanning that line's own text** (`meat/chunk.go:278`, `mask[i] = old.inString() || new.inString()`, evaluated before `old.scan(...)`/`new.scan(...)` on the same line at `:282-288`). So `mask[i]` answers "is the lexical state I'm *entering* line `i` already mid-continuation" — matching the "before" convention `python.md` documents for `pythonNewSideStates`'s `insideTriple`/`depthBefore` (§8 of `python.md`, `meat/python.go:157-193`): both trackers record the state as it stood immediately prior to consuming the current line, then advance.

**Marker-byte branch** (`meat/chunk.go:279-288`): `-` feeds only `old.scan`; `+` feeds only `new.scan`; ` ` (context) feeds **both**. This is correct because a context line's text is byte-identical on both sides of the diff — it exists once physically but represents the *same* content on both the old file and the new file, so both trackers must consume it to stay synchronized with their respective files' true lexical position. Skipping it on one side (as an optimization) would desynchronize that side's state from the next `-`/`+` line it encounters.

**`stringScanState.scan`** (`meat/chunk.go:308-336`), per language:
- **Python/Java**: `scanPythonTripleLine(text, &s.triple)` advances triple-quote state (cite `python.md` §1). Java text blocks share the identical `"""`/`'''` grammar, so the same scanner is reused verbatim (cite `imports.md` Algorithm 3 item 1 for the same cross-language reuse rationale).
- **Python only, additionally**: bracket depth via `s.brackets.add(pythonDelimiterBalanceWithState(text, &tripleForBalance))` (cite `python.md` §2), then **each of the three bracket-kind counts is independently clamped to zero if negative** (`meat/chunk.go:316-324`) — the identical clamp-negative-to-zero pattern `python.md` already documents for `pythonNewSideStates` (`meat/python.go:181-189`, G18's mechanism), reused verbatim here for the same reason: a hunk's leading context can close a bracket opened above the hunk (invisible to this scan), which must not read as "still inside an expression" for the rest of the hunk.
- **Python only, further**: `s.backslash = !inTriple && s.triple == pythonTripleNone && endsPythonBackslash(text)` (`meat/chunk.go:327-329`, cite `python.md` §10 for `endsPythonBackslash`). `inTriple` is captured **before** this line's `scanPythonTripleLine` call (`meat/chunk.go:310`, `inTriple := s.triple != pythonTripleNone`); the condition requires triple state to be `pythonTripleNone` **both before and after** scanning this line. Precisely: if the line was inside a triple-quote when it started, or ends inside one after scanning, a trailing backslash on that line is **not** treated as a continuation-in-progress for this mask's purposes — it is a backslash *inside string content* (or spanning a triple-quote boundary), which the triple-quote sub-state (`s.triple != pythonTripleNone`) already accounts for on its own. Double-counting it as *also* a backslash-continuation would be redundant at best and could produce a spuriously "sticky" continuation state at worst (the mask's `inString()` OR is already true from the triple sub-state regardless).
- **Go/JS**: `countCodeBackticks(text) % 2 == 1` toggles `s.backtick` (cite `imports.md` §3's Algorithm 3 item 2 for `countCodeBackticks`, `meat/imports.go:643-681`).

**`inString()`** (`meat/chunk.go:303-306`) is the OR of all four sub-states: `triple != pythonTripleNone`, `backtick`, `backslash`, or any bracket depth `> 0`. OR is the correct combinator here, not AND: each sub-state independently represents *some* validator's notion of "this line begins mid-continuation" (the triple-quote validators, the backslash-continuation validator, the bracket-balance validator), and a cut landing here would desynchronize *whichever one* is currently true — the mask exists purely to be conservative (a false positive just costs a slightly earlier/later cut; a false negative could sever a continuation a chunk-local compiler can't reconstruct), so it must read `true` if **any** sub-state is mid-continuation, not require all four to agree.

### 4. `sections()` (`meat/chunk.go:340-355`)

Partitions the diff into per-file spans by `fileID` transitions. The boundary condition is `b.layout.fileID[i-1] != id` (`meat/chunk.go:349`) — a change in `fileID` between two *adjacent* physical lines starts a new section; `fileID < 0` lines (preamble, before any file header) are skipped for the purpose of *detecting* a boundary (`meat/chunk.go:344-346`, `if id < 0 { continue }`) but are **not** excluded from span *ranges*. The first span is opened unconditionally at index 0 the moment the loop finds the first `id >= 0` line (`meat/chunk.go:347-348`, `spans = append(spans, lineSpan{start: 0, end: len(b.lines)})`) — regardless of how far into the diff that first real file-header line actually is. This literally means: any preamble (`fileID == -1` lines) before the diff's first file header is included in the **range** of section 0, even though those lines never individually triggered the boundary detection that created the span. See §6 for the consequence this has on `splitSection`'s `preamble` span.

### 5. Top-level greedy packing (`splitDiffForAbridging`'s main loop, `meat/chunk.go:204-243`)

Per section, in this exact decision order:

1. **Fully hidden** (`b.spanFullyHidden(s)`, `meat/chunk.go:205-212`): the whole-diff mandatory pass removes the section entirely (an import-only file shell, cite `imports.md` Algorithm 1 step 7). `flush()` is called **first** (closing any in-progress accumulator run), then the section is skipped entirely — no chunk, no origins, nothing (`continue`).
2. **Extra-hidden** (`b.spanHasExtraHidden(s)`, `meat/chunk.go:213-224`): the span contains rows hidden only by whole-diff move-precedence extension, which a chunk-local pass can't re-derive. `flush()` first, then `b.splitSection(id, s)` is forced regardless of whether the section would otherwise have fit whole.
3. **Fits into the open accumulator** (`meat/chunk.go:225-228`): if a run is already open and extending it to include this section (`b.spanFits(open, s.end)`) still fits, extend `openEnd = s.end` without flushing.
4. **Fits alone** (`meat/chunk.go:229-235`): `flush()` the previous run, then if this section alone fits (`b.spanFits(s.start, s.end)`), open a fresh run at this section.
5. **Else** (`meat/chunk.go:236-238`): `b.splitSection(id, s)`.
6. After the loop, one final `flush()` (`meat/chunk.go:240-242`) closes any run still open at end of input.

`flush` (`meat/chunk.go:195-203`) closes the current whole-section accumulator run as **one** chunk: `emit`s `b.rangeText(open, openEnd)` (a literal, unmodified byte slice — cite G1's "not re-encoded") with `sectionID: -1` (not part of any split section) and `origins := b.rangeOrigins(open, openEnd)` (one origin per physical line, unconditionally, see §14 Data shapes).

**Structural parallel with `splitSection`'s hunk-level loop (§6) — and where the two loops actually diverge.** Both loops share the same shape: a running `open`/`openEnd` accumulator, a `flush` closure, and a fits-check-then-open-fresh-or-split fallback. But their **fully-hidden branch differs in a way that matters**: the top-level loop's fully-hidden branch calls `flush()` before skipping the section (`meat/chunk.go:208-210`) — so a fully-hidden section can never be silently absorbed into a run spanning across it. `splitSection`'s own hunk-level loop's fully-hidden branch does **not** call `flush()` (`meat/chunk.go:491-496` — just `continue`, leaving `open`/`openEnd` untouched from before). Traced precisely: if a section contains hunks `[h1 (visible), h2 (fully import-hidden), h3 (visible)]`, and `h1` opens a run (`open=h1.start, openEnd=h1.end`), then `h2` is skipped **without** extending or closing the run, then `h3` is checked via `runFits(open, h3.end)` — a byte-range fit check computed over the **contiguous** span from `h1.start` to `h3.end`, which numerically includes `h2`'s own bytes (`b.spanSizes` has no concept of "logically hidden," it sums raw byte totals over an index range). If this combined span fits, `openEnd` becomes `h3.end`, and the eventual `flush()` emits `rangeText(h1.start, h3.end)` — the raw text of `h1`+`h2`+`h3` concatenated verbatim, **including `h2`'s fully-hidden import scaffolding**. This is very likely *benign for the final merged output*, because `h2` here is a **complete, self-contained hunk** (header and body both present verbatim in the chunk), and the chunk-local agent run's own `compileEditPlanMoves`→`mandatoryImportRemovalPlan` pass, given that whole hunk, independently re-derives the identical "import-only, hide it" classification the whole-diff pass already made (plain import classification, unlike move-precedence extension, is a self-contained per-hunk computation — cite `imports.md`'s "Responsibility and dependents"). But it means `chunk.text` — the actual bytes sent to the model as that chunk's prompt — **can** contain import-scaffolding text in this scenario, which is a materially different claim from what `splitHunk`'s row-level dropping guarantees (§7) and from what G10's own fixture (`meat/chunk_test.go:300-336`, a single oversized hunk forcing sub-hunk segmentation) actually exercises. See Uncovered mechanism, below, and my separate report to the orchestrator.

**Should the two loops share one implementation in a port?** No — their per-item side effects differ in kind, not just in which closure is called: the top-level loop's `flush`/accumulator bookkeeping is chunk-level (`sectionID: -1`, whole-diff `origins`), while `splitSection`'s hunk-level loop's bookkeeping is section-level (`metaPrefix`/`continuation`/piece-numbering via the `emit` closure, §6) and its fully-hidden branch's flush-omission is (as traced above) a real behavioral difference, not an incidental implementation detail. A port factoring out "the greedy packing shape" as one generic helper parameterized by callbacks would need that helper's fully-hidden branch to be independently parameterizable per call site to reproduce both behaviors exactly — simply unifying them naively would either introduce spurious flushing at the top level or (more dangerously) silently start flushing on fully-hidden hunks inside `splitSection`, changing which hunks get absorbed into a hunk-run's raw bytes.

### 6. `splitSection` (`meat/chunk.go:394-555`)

**Preamble/meta/tail identification** (`meat/chunk.go:394-429`):
- `firstHunk` = the first `diffLineHunkHeader` line in `[s.start, s.end)`; if none exists, error (cite G6, error table below).
- `metaStart` = the first line with `fileID >= 0` at or after `s.start` (`meat/chunk.go:406-412`). **Can `metaStart` ever be `> s.start` for anything but the diff's very first section?** No. `sections()` (§4) opens every span *after* the first one exactly at the index where `fileID` transitions to that section's own value (`meat/chunk.go:349-351`, `spans[len(spans)-1].end = i; spans = append(spans, lineSpan{start: i, ...})` — the new span's `start` is literally `i`, the index whose `fileID` just changed). Per `diff.go`'s file-id assignment (cite `diff.md` "Decision boundary: file-id assignment"), `fileID` only ever increments *at* a file's own opening metadata line (`diff --git`, or a raw `---` header when not already in a git section) — there is no way for a *later* section's span to begin on a non-file-owning (`fileID == -1`) line, because `fileID == -1` is reserved exclusively for the diff's leading preamble, never reused between files. So for every section after the first, `s.start` already **is** the file's own metadata-opening line, and `metaStart == s.start` trivially. `preamble` (`lineSpan{start: s.start, end: metaStart}`) is therefore **empty for every section except possibly the very first section of the whole diff** — and even there, only non-empty when real prose (a `git show` commit message, etc.) precedes the first `diff --git`/`---` line.
- `tailStart`: scanned backward from `s.end` while the line is *not* hunk-source, not a no-newline marker, and not a hunk header (`meat/chunk.go:422-429`) — everything after the true last hunk-body line that isn't itself hunk structure. Unlike `preamble`, **this is not restricted to the last section of the whole diff** — a per-section trailer (stray prose between one file's last hunk and the next file's `diff --git` line) is structurally possible for *any* section, since section boundaries are defined purely by `fileID`, not by hunk content; only the diff's very *final* section's tail can be a true format-patch mail signature/trailer, but a non-final section can in principle carry non-empty tail text too if the input diff is unusual in that way.

**The `emit` closure and piece-0-vs-later prefix distinction** (`meat/chunk.go:442-460`): every piece gets `metaText` prepended; piece 0 *additionally* gets `preambleText` prepended (`prefix = preambleText + metaText`, `meat/chunk.go:446`), but `metaPrefix` on the `diffChunk` itself is always just `metaText` (`meat/chunk.go:451`, **never** includes preamble) — this is the mechanism behind G20 (preamble rides only the first piece, is never treated as replicable metadata for dedup purposes). `piece` increments after each `emit` call and gates `continuation: piece > 0` (`meat/chunk.go:453`).

**`prefixSizes`/`runFits`** (`meat/chunk.go:461-477`): `prefixSizes()` returns the byte/line cost every piece pays before its own hunk-run body — the replicated `meta` span, plus (only when `piece == 0`) the `preamble` span. `runFits(start, end)` adds a candidate hunk-run's own span sizes to `prefixSizes()`'s overhead and checks `b.fits` against the *combined* total. This overhead-inclusion is essential: a segment-budget check that only measured the candidate body's own bytes would let a piece's body fit while the *actually-emitted chunk* (body + replicated metadata prefix, and for piece 0 also the preamble) silently overflows the budget.

**Hunk-level greedy loop** (`meat/chunk.go:490-522`) — see §5 for the parallel with, and precise divergence from, the top-level loop.

**Tail re-attachment** (`meat/chunk.go:527-555`): the tail is first attempted onto the last emitted piece, but *only if the combined result still fits as a single run* (`fitsSingleRun(candidate, b.budget)`, `meat/chunk.go:536`) — a stricter check than the segment-budget arithmetic used elsewhere, since it re-derives fit from scratch on the concatenated text rather than composing precomputed sizes. If it doesn't fit (or no piece was ever emitted, `piece == 0`), the tail (plus, if `piece == 0`, the preamble too — `meat/chunk.go:542-545`, `prose := tailText; if piece == 0 { prose = preambleText + tailText }`) becomes its own `passthrough` piece, provided it fits alone (else error, cite G6/table below). The `piece == 0` case — a section whose every hunk was fully hidden (nothing ever emitted) but which still carries leading preamble and/or trailing tail text — is exactly what survives via this path: cite G20/G21's fixtures for the preamble-only shape; the *combined* preamble+tail-both-nonempty shape is unexercised (existing Open question, unchanged).

### 7. `splitHunk` (`meat/chunk.go:579-689`)

**Header parsing and synthesis setup** (`meat/chunk.go:580-584`): `oldStart, oldZero, newStart, newZero, heading := parseHunkHeaderForSplit(...)` (§9). `headerEOL := b.lines[h.start].eol; if headerEOL == "" { headerEOL = "\n" }`. **When is the fallback actually reachable, and does it ever matter?** `sourceLine.eol` is `""` only for the *literal last physical line of the entire raw diff text* when that text has no trailing newline (cite `diff.md` Algorithm 1 step 3 — only the final unterminated line gets `eol: ""`). If `h.start` (the hunk header's own line) is that last physical line, then `h.end <= len(b.lines) = h.start + 1`, forcing `h.end == h.start + 1` — i.e. this hunk's span is *exactly one line*, the header alone, with **zero body**. Given `bodyStart, bodyEnd := h.start+1, h.end` (`meat/chunk.go:585`), this makes `bodyStart == bodyEnd`, so the segment-building loop below (`for i < bodyEnd`, `meat/chunk.go:626`) never executes even once — `headerEOL`'s value is assigned but never read, since it's only used inside that loop's body (`meat/chunk.go:682`). **The fallback is a real code path but is provably inert**: whenever the condition that triggers it is true, the function that reads it never runs. See §14/Uncovered mechanism for the more consequential fact this same zero-body condition exposes (a zero-body oversized hunk forced into `splitHunk` at all).

**`unitEnd`** (`meat/chunk.go:588-621`) — the atomic-unit-boundary function:

*No-newline/inString absorption* (`meat/chunk.go:589-592`): starting from `j := i+1`, extend `j` forward while the line at `j` is a `diffLineNoNewline` marker or `b.inString[j]` is true — straightforward, matches G5/G29's fixtures.

*Owner-absorption loop* (`meat/chunk.go:601-619`) — traced precisely, byte-by-byte against source:
- `last := i` — the unit's own start index (the candidate cut point, *before* the no-newline/inString extension above is folded in for absorption purposes — `last` tracks "the most recently absorbed row for ownership-testing purposes," separate from `j`, which tracks "how far the unit's span currently extends").
- Outer `for b.pythonOwnerLine(last)`: only entered/continued while the row currently pointed at by `last` is itself a visible Python decorator or suite header (`meat/chunk.go:780-789`). On the very first outer iteration, `last == i`, so this fires only when the unit's *own starting line* is a Python owner.
- Inner loop (`meat/chunk.go:604-615`): `advanced := false`; while `j < bodyEnd` and the line at `j` is hunk source with non-empty text: `row := j; j++`; extend `j` through `row`'s own trailing no-newline/inString tail; `last = row; advanced = true`; `if b.emitsPythonBody(row) { break }`.
- **What `advanced` actually tracks.** It is set `true` unconditionally on the *first* inner-loop iteration that runs at all, regardless of whether that iteration's row satisfies `emitsPythonBody`. So `advanced` answers "did the inner loop consume at least one hunk-source row this pass," **not** "did it find a body row." The outer `for` terminates via `if !advanced { break }` (`meat/chunk.go:616-618`) only when the inner loop made *zero* iterations — i.e. `j` was already at `bodyEnd`, or the very next line isn't hunk source with content (end of the owner's containing hunk-body reached with nothing left to examine).
- **What actually stops the outer loop when a body row *is* found.** The inner loop's early `break` (on `emitsPythonBody(row)` true) exits only the *inner* loop; control returns to the outer `for b.pythonOwnerLine(last)` test, now evaluated against `last == row` (the just-found body row). Since `pythonOwnerLine` requires the trimmed body to start with `@` or pass `isPythonSuiteHeaderStart` (`meat/chunk.go:787-788`, cite `python.md` §4), and `emitsPythonBody` for a non-hidden, non-`-` row is simply `trimPythonCode(...) != ""` (`meat/chunk.go:802`, cite `python.md` §3) — **any** row satisfying `pythonOwnerLine` necessarily also satisfies `emitsPythonBody` (an owner line is, by definition, non-blank real code), but the converse doesn't hold (an ordinary statement satisfies `emitsPythonBody` without being an owner). So:
  - If the found body row is *itself* another owner (a nested owner — decorator → `def` → `if`, each the sole first "body" of the one before it), the outer `for` condition re-tests true and the loop recurses, absorbing one more layer, one outer-iteration per nested owner.
  - If the found body row is a plain statement (not itself an owner), `pythonOwnerLine(last)` is false and the outer loop stops **there**, having absorbed exactly through the first genuine body row.
  - If the inner loop exhausts `bodyEnd` (or hits a non-hunk-source line) without ever satisfying `emitsPythonBody`, `last` is left at whatever row was last consumed — and since we didn't break via `emitsPythonBody`, that row's `emitsPythonBody` was false, which (per the same `trimPythonCode` check both functions share) also forces `pythonOwnerLine(last)` false for a *visible, non-hidden* row (a blank/comment row has `trimPythonCode(...) == ""`, matching neither predicate) — and for a *hidden* row without a placeholder, `pythonOwnerLine` returns `false` immediately regardless via its own explicit `b.hidden[i]` guard (`meat/chunk.go:781`). So the outer loop also correctly stops in this case.
  - This confirms the mechanism is correct by construction (not merely by convention): the owner-absorption loop absorbs recursively through nested owners and terminates exactly at the first body row that is not itself an owner, never over-absorbing past a plain statement. G35/G36 depend on exactly this. The nested-owner case itself remains untested by any fixture (existing Open question, unsharpened but now mechanistically fully traced).

**The segment-building double loop** (`meat/chunk.go:624-687`):
- Outer loop builds one segment at a time until `bodyEnd`. Inner loop (`meat/chunk.go:635-669`) grows the *current* segment unit-by-unit while it still fits.
- **Fits-check** (`meat/chunk.go:653-656`): recomputes `header := synthHunkHeader(segOldStart, segVisOld+u.visOld, ..., segNewStart, segVisNew+u.visNew, ..., segHeading)` — the header for the *hypothetical* size that would result from accepting this one additional candidate unit `u` — then checks `b.fits(pt+len(header)+segTextLen+u.textLen, pr+len(header)+len(headerEOL)+segRawLen+u.rawLen, pc+1+segCount+u.count)`. The header must be included in the fits check because the header's own byte length depends on the row counts it reports — exactly what's being decided by accepting or rejecting this unit — so the check answers "would emitting one more unit still let the whole synthesized line, header included, fit," not merely "does the body still fit."
- **`u.count == 0` short-circuit** (`meat/chunk.go:638-644`): a fully-dropped unit advances `oldOff`/`newOff` only (original-coordinate bookkeeping) and `continue`s — but it **does** set `atBodyStart = false` (`meat/chunk.go:642`), confirmed by direct read. A segment doesn't need to visibly *start* at this point for the "true top of hunk body" condition to become false: any consumed unit — dropped or not — means the true top has been passed, so a later segment beginning here must not carry the original heading.
- **Break-on-doesn't-fit** (`meat/chunk.go:656`) exits only the *inner* loop, leaving `i` unchanged at the unit that failed; the *outer* loop's next iteration starts a fresh segment there.
- **`segStarted`-false-after-inner-loop-ends** (`meat/chunk.go:670-673`): reached when only dropped units remained until `bodyEnd` — nothing left to flush, outer loop `break`s entirely (function returns after the outer loop, via `return nil`).
- **`segCount == 0` error** (`meat/chunk.go:674-676`): reached only when the *first* candidate unit of a brand-new segment already fails to fit (cite G13).
- **`!hasChange` `continue`** (`meat/chunk.go:677-679`): a segment with only dropped/context content and no actual `+`/`-` row is silently discarded — not emitted, not an error. This happens whenever a segment lands entirely in trailing context (or entirely in an already-hidden, non-placeholder-emitting import tail) after the last real change in the hunk's remaining span. Cite this directly against the file header comment's own claim: "Segments left with no changed rows... are not emitted; no plan could retain a change-free hunk either" (`meat/chunk.go:576-578`).

### 8. `unitStats`/`appendUnit` (`meat/chunk.go:703-764`)

**`unitStats`** (`meat/chunk.go:703-743`) classifies each line `i` in `[start,end)` into one of three outcomes, in this exact order: `b.hidden[i]` is checked first. If hidden **and** `b.placeholderRow(i)` succeeds (§9), the line counts as **visible**, contributing the placeholder's own byte length (`len(text)+len(eol)`) to `u.textLen`/`u.rawLen` and `+1` to `u.count`/`visOld`/`visNew` (using the placeholder's own row-count contribution, not the original hidden line's) — **not** the original line's own bytes. If hidden with no placeholder, the line is **dropped**: contributes only to `u.dropOld`/`u.dropNew` (offset bookkeeping), zero bytes, zero count. If not hidden, the line is **fully visible verbatim**: original bytes, `+1` count.

`dropOld`/`dropNew` are tracked even though a dropped row contributes zero visible bytes because a dropped row was still physically *present* in the original hunk's numbering — a later segment's synthesized `@@` header must still account for it when computing `segOldStart`/`segNewStart` via `oldOff`/`newOff` (§7), which sum `visOld+dropOld`/`visNew+dropNew` per accepted unit. Omitting the drop counters would desynchronize every later segment's synthesized start offset from the original hunk's true numbering.

**`appendUnit`** (`meat/chunk.go:749-764`) mirrors the same three-way classification when actually writing bytes: hidden+placeholder emits the placeholder text with origin `-1`; hidden-without-placeholder emits nothing and contributes no origin entry at all; visible emits verbatim with its own original index as origin.

### 9. `placeholderRow` (`meat/chunk.go:768-775`)

`fi := b.foldAt[i]; if fi < 0 { return "", "", false }; f := b.folds[fi]; return string(f.marker) + f.indent + "...", f.eol, true`. This is a pure lookup into the state computed once, up front, in §2 step 4 — no fresh computation happens per call; `b.foldAt`/`b.folds` never change after `splitDiffForAbridging`'s setup phase completes.

### 10. `synthHunkHeader`/`gapAdjustedStart` (`meat/chunk.go:829-847`)

`gapAdjustedStart(start, count, originallyZero)` (`meat/chunk.go:839-846`) fires the "name the line before the gap" decrement **only when `count == 0 && !originallyZero`** — a side that has zero rows *in this segment* **and** whose *original hunk's* count on that side was nonzero. The `!originallyZero` guard specifically prevents re-decrementing a side whose original count was *already* zero (a pure insertion or pure deletion hunk): that side's source header already used the "before-the-gap" convention (its declared start already names the line before where content would be), so a segment carrying zero rows on that side inherits the correct value simply by *not* being decremented — decrementing again would double-apply the convention (cite G8's fixture). The clamp (`meat/chunk.go:842-844`, `if start < 0 { start = 0 }`) prevents a negative synthesized start for a new-file hunk's old side (cite G9). Both `synthHunkHeader`'s calls to `gapAdjustedStart` (once per side, `meat/chunk.go:834-835`) apply this symmetrically — the clamp and the guard both exist on each side independently.

### 11. `parseHunkHeaderForSplit`/`parseHunkStart` (`meat/chunk.go:849-892`)

`parseHunkHeaderForSplit`: `strings.CutPrefix(text, "@@ ")`; find the closing `" @@"`; split the range fields via `strings.Fields`; require exactly 2 fields; parse each with `parseHunkStart`. On any failure at any step, returns `oldStart, newStart = 1, 1`, no heading — no partial credit for a header that parses halfway.

`parseHunkStart(field, sign)`: requires the field's first byte to equal `sign` (`'-'` or `'+'`); if a comma is present, the count is the integer after it (`zeroCount = (that substring == "0")`); otherwise the whole remainder parses as the count, defaulting to `1` implicitly via `parseHunkHeaderForSplit`'s fallback rather than any explicit "no comma" branch inside `parseHunkStart` itself — reading the source precisely, a comma-less field is parsed as the *start* value with `zeroCount` left at its zero value (`false`), i.e. a comma-less field is only ever the start-line number (never a count), matching unified-diff's own `-N` / `-N,M` grammar.

**Is the unparseable-header fallback actually reachable, or dead defensively?** `splitHunk` (and hence `parseHunkHeaderForSplit`) is only ever invoked when a hunk is being split, which requires that hunk to already exist as a structurally-classified `diffLineHunkHeader` in `layout.kinds` — i.e. it already passed `analyzeDiff`'s hunk-header recognition (cite `diff.md`'s decision boundary: a line is a hunk header if it starts with `@@` **and** (`inFileSection` **or** the line is exactly `"@@"` **or** it starts with `"@@ "`)). Recognition as a hunk header is *not* the same as successfully parsing counts: `diff.go`'s own `parseHunkCounts`/`parseHunkRange` (cite `diff.md` Algorithm 5) can fail to determine `countsKnown`, in which case `analyzeDiff` simply stops enforcing "counts inconsistent" for that hunk rather than rejecting the diff outright (cite `diff.md` Algorithm 3 step 3a) — a hunk with an unparseable `@@` header (e.g. the bare two-character line `"@@"`, which `diff.go`'s own decision boundary explicitly recognizes as a valid hunk header regardless of `inFileSection`) is therefore **accepted by upstream validation**, its body classified leniently as ordinary hunk source. So `parseHunkHeaderForSplit`'s fallback is a genuine, reachable defensive path for a header shape `diff.go`'s own structural parser tolerates but does not itself fully trust for numeric content — not dead code, and not merely "hunks so large they must be split" in a hand-wavy sense: it is precisely the intersection of "structurally accepted as a hunk header" and "too large under budget to avoid splitting," which is a real, if unusual, combination (a malformed-but-huge `@@` line's body could plausibly need splitting).

### 12. `chunkError` (`meat/chunk.go:894-908`)

`Error()` (`meat/chunk.go:902-906`): `"meat: " + e.label + ": " + strings.TrimPrefix(e.err.Error(), "meat: ")`. **This is purely a label-splice, never a new message**: it takes whatever `e.err.Error()` already says (which, per `abridgeOne`'s own convention, already begins with `"meat: "`), strips that existing prefix to avoid `"meat: meat: chunk N/M: ..."`, and re-prefixes once with the chunk label spliced in the middle. Cite `HAZARDS.md` H5, which already names this exact site. `Unwrap() error { return e.err }` (`meat/chunk.go:908`) is what lets `errors.Is`/`errors.As` see through the `chunkError` wrapper to the underlying cause (context cancellation, deadline, a typed model error) — `Unwrap` alone is sufficient for both, since `errors.Is` walks the chain via `Unwrap` looking for identity/`Is`-method matches, and `errors.As` does the same looking for a type match; `chunkError` adds exactly one hop to that chain. This is exercised by G24 (`meat/chunk_test.go:689-705`, `TestAbridge_ChunkedErrorPreservesUnwrap`) — confirming both that `Error()`'s label-splice text is correct **and** that `errors.Is` sees through to the wrapped cause.

### 13. `abridgeChunked` (`meat/chunk.go:915-1001`)

Exact order:
1. `chunks, err := splitDiffForAbridging(req.UnifiedDiff, singleRunDiffBytes)` — any error is wrapped once with `"meat: %w"` (`meat/chunk.go:916-919`) — this **is** a new-prefix wrap (distinct from `chunkError`, which never adds a fresh message), since none of `splitDiffForAbridging`'s own error strings begin with `"meat: "` themselves.
2. `modelChunks` is counted (`meat/chunk.go:920-925`) — every chunk that is **not** `passthrough`; `passthrough` chunks (envelope text with no hunk content) never get an agent run.
3. `wholeMoves := detectedMovesInDiff(req.UnifiedDiff)` (`meat/chunk.go:926`, cite `moves.md` "Responsibility and dependents" item 1, `meat/moves.go:441-448`) is computed **once, over the entire original (unsplit) diff text** — not per chunk, and not from `chunks[i].text`. This must run over the original text because move detection is a whole-diff property by construction (`moves.md` G4): a chunk only ever sees a fragment, and `abridgeChunked` is the single place that both detects the whole-diff move set (here) and later maps it per-chunk (`mapMovesToChunk`, §14 below, called per chunk at `meat/chunk.go:962`) — the round trip is: detect once globally → per chunk, translate into that chunk's own coordinates → pass into that chunk's `runOptions.chunkMoves` for enforcement inside that one agent run.
4. Progress-callback prefixing: the outer `progress` (or a no-op default, `meat/chunk.go:927-930`) is invoked once up front with `"large diff: abridging %d chunks"` (only if `modelChunks > 0`, `meat/chunk.go:931-933`, cite G17); each chunk's own `sub.Progress` closure prefixes every inner message with `label + ": "` where `label = "chunk %d/%d"` (`meat/chunk.go:958,961`).
5. Per non-passthrough chunk: `opts := runOptions{chunkRun: true, chunkMoves: mapMovesToChunk(wholeMoves, chunk.origins)}` (`meat/chunk.go:962`) is passed to `abridgeOne`. `chunkRun`/`chunkMoves` are consumed inside `abridgeOne`/`toolbox` (`meat/meat.go:78-89,148`; `meat/tools.go`) — `chunkRun` disables move *detection* for that run (`tb.noMoves = opts.chunkRun`), while `chunkMoves` supplies the already-mapped moves for *enforcement*. `agent-loop.md` is not yet stage-2; this file's scope stops at "chunk.go constructs and passes these fields" — their effect on the agent loop itself belongs to that spec once written.
6. **Metadata-dedup state machine** (`emittedMeta map[int]bool`, keyed by `sectionID`, `meat/chunk.go:970-981`): only set `true` once `pieceContainsLine(piece, firstLineText(chunk.metaPrefix))` confirms the metadata's *first line* actually appears somewhere in the rendered piece's own text (§14). This matters because a piece can legally elide its entire hunk body while retaining non-file preamble (G21) — the metadata never actually surfaced in that piece's output, so the *next* piece carrying the same file's replicated metadata is the first to genuinely surface it and must **not** have its own headers stripped as if they were a duplicate. Only once `emittedMeta[sectionID]` is `true` does a *later* piece of the same section get `stripReplicatedMeta` applied (§14) to drop its now-redundant leading metadata lines.
7. **`appendPiece`** (`meat/chunk.go:938-945`): joins pieces on line boundaries — if the *previous* accumulated part doesn't already end in `"\n"`, one is inserted before appending the next piece, so a missing trailing newline on an *interior* piece never concatenates two pieces' text into one malformed line. The **last** piece's own trailing-newline-or-not state is left untouched (no synthetic `"\n"` is ever appended *after* the final part) — cite G22.
8. **`modelChunks == 0` short-circuit** (`meat/chunk.go:992-996`): every changed row across the whole diff was import scaffolding; the merged result is `&Result{Summary: "Only imports and unchanged context; nothing to read."}` with an entirely empty `SmartDiff` — no `parts`/`summaries` accumulated along the way are used (cite G30). Note this check runs *after* the per-chunk loop (which, for an all-passthrough/all-fully-hidden diff, would have appended only passthrough envelope text into `parts` and no summaries) — the short-circuit **discards** whatever passthrough text was accumulated, per the doc comment's own claim (`meat/chunk.go:993-995`, "passthrough envelope text is dropped along with the change it framed").

### 14. `mapMovesToChunk` (`meat/chunk.go:1003-1041`)

`chunkLine map[int]int` is built **only from origins `>= 0`** (`meat/chunk.go:1014-1018`, `if orig >= 0 { chunkLine[orig] = i + 1 }`): a synthesized line (segment header, mandatory placeholder — origin `-1`) never anchors a mapped range, and the *original* physical line a placeholder stands in for is likewise absent from `chunkLine`, since its own index never appears as any `origins[i]` value at all (the placeholder's origin entry is `-1`, not that original index).

`mapRange(r)` (`meat/chunk.go:1019-1031`): converts `r`'s 1-based inclusive original-diff range to 0-based indices `[r.StartLine-1, r.EndLine-1]` and walks it. **"Contiguous" means exactly**: for every original index `orig` in the range, `chunkLine[orig]` must both (a) exist, **and** (b) satisfy `at == start + (orig - (r.StartLine-1))` — i.e. the chunk-line position must advance by exactly 1 per original-line advance, relative to the range's own start position. Two distinct failure shapes, and precisely which clause catches each:
- **A row entirely absent from `chunkLine`** — either a fully-dropped hidden row with no placeholder (no origin entry emitted for it at all), or the original row a mandatory placeholder stands in for (its own index likewise never appears, only `-1` does) — fails at the `!ok` clause; the whole range is rejected as non-contiguous the instant this row is reached.
- **A synthesized line (`-1` origin) spliced into the middle of what would otherwise be contiguous mapped content** — e.g. a move's range straddling a segment boundary within the same chunk, where a synthesized `@@` header row sits between two originally-adjacent lines in the chunk's physical text — does **not** fail the `ok` lookup (both neighboring original rows *do* have entries in `chunkLine`), but fails the **arithmetic** clause: the synthesized row consumes one physical position in the chunk's text without itself corresponding to any original index, so the chunk-line value for the row *after* the splice is offset by +1 (or more) relative to what `start + (orig - (r.StartLine-1))` predicts, and the inequality fires.

**Neither case slips through undetected** — they are caught by different clauses of the same `if` (`meat/chunk.go:1026`, `if !ok || at != start+(orig-(r.StartLine-1))`), but both are caught. Cite G38.

### 15. `firstLineText`/`pieceContainsLine`/`stripReplicatedMeta` (`meat/chunk.go:1043-1086`)

`firstLineText`/`pieceContainsLine` are straightforward line-based helpers (first physical line's text; whether any physical line of a piece equals a given text, by exact equality via `splitSourceLines`).

`stripReplicatedMeta` (`meat/chunk.go:1065-1086`): an in-order matching walk — a cursor `j` advances through `metaLines`; a piece's leading `smart` line is dropped only if `metaLines[j:]` contains it (found via a forward scan from `j`, advancing `j` past the match), and the walk stops at the first `smart` line that doesn't match any remaining metadata line. The doc comment states this stopping line — the piece's own first `@@` header — "can never appear in the block." **Why this holds structurally, not by content-matching luck**: `meta`'s span is built in `splitSection` as `lineSpan{start: metaStart, end: firstHunk}` (`meat/chunk.go:415`) — by construction, `metaText` (and hence `metaPrefix`) spans only lines strictly *before* the first hunk header, so a `@@`-prefixed line can never be one of `metaLines`'s entries in the first place. The matching walk's termination on the first non-matching line is therefore guaranteed to stop at exactly the piece's hunk content, never accidentally continuing into it.

### Data shapes

**`diffChunk`** (`meat/chunk.go:52-78`):
- `text` — the well-formed unified-diff bytes for this chunk (verbatim slice for whole-section/hunk-run chunks; synthesized for split-hunk segments).
- `metaPrefix` — the replicated file-metadata block, set for every piece of a split section, empty for whole-section chunks; used by the merge step's dedup logic (§13, §15).
- `sectionID` — groups pieces from the same split file section (`-1` for whole-section chunks).
- `continuation` — `true` for a piece that isn't the section's first (`piece > 0` at emission time).
- `passthrough` — `true` for envelope-only text with no hunk content; skips the agent run entirely.
- `origins` — one entry per physical line of `text`, mapping back to the 0-based original-diff line index, or `-1` for synthesized lines. **Confirmed by grep across `meat/chunk.go`: `origins` is used for exactly one purpose in this file** — `mapMovesToChunk(wholeMoves, chunk.origins)` at `meat/chunk.go:962` — no other consumer reads `diffChunk.origins` anywhere in the codebase (confirmed by repo-wide grep for `.origins` outside `chunk.go`).

**`lineSpan`** — a half-open `[start, end)` range of physical line indices, the same convention used throughout the codebase (cite `diff.md`'s `diffLayout` array-indexing convention and `editplan.md`'s coordinate treatment for the analogous convention elsewhere).

**`chunkBuilder`** (`meat/chunk.go:110-145`) — the splitter's mutable working state. `lines`/`layout`/`budget`/`prefixText`/`prefixRaw`/`hidden`/`extraHidden`/`foldAt`/`folds`/`inString` are all computed once during setup (§2) and never mutated again after `splitDiffForAbridging`'s setup phase completes — they are effectively immutable for the rest of the run. Only `chunks` accumulates, via `b.add` (§ "add", `meat/chunk.go:249-255`), which also enforces `maxChunks` (cite G27).

**`unitInfo`** (`meat/chunk.go:691-701`) — the per-atomic-unit aggregate the segment-building loop consumes. It separates `visOld`/`visNew` (rows that will render, whether original or placeholder) from `dropOld`/`dropNew` (rows that won't render but still shift offsets) rather than using a single count, because the two contribute to entirely different downstream computations: `visOld`/`visNew` feed both the byte totals (`textLen`/`rawLen`) *and* the synthesized header's row counts, while `dropOld`/`dropNew` feed *only* the running `oldOff`/`newOff` offset trackers (§7) that keep later segments' synthesized start values correct against the original hunk's true numbering — collapsing them into one counter would make it impossible to recover the original-coordinate offset contribution of a row that contributes zero visible bytes.

## Invariants

- **Atomic-unit invariant.** A cut never lands inside what `unitEnd` computes, by construction: the segment loop only ever advances `i` to `next := unitEnd(i)` (`meat/chunk.go:636,668`), never to any intermediate point within `[i, next)`. Breaking this would let a segment start mid-string-literal, mid-no-newline-marker, or mid-Python-suite-owner's-body — exactly what `unitEnd`'s three absorption layers (no-newline, inString, owner) exist to prevent (cite G5, G29, G35).
- **Origins-length invariant.** Every constructed chunk's `origins` slice has exactly one entry per physical line of that chunk's `text` — verified across all three construction sites: whole-section/hunk-run chunks via `rangeOrigins(start,end)` (`meat/chunk.go:369-375`, one entry per index in the range, matching `rangeText`'s own per-index emission exactly); split-section pieces via `emit`'s `append(prefixOrigins, bodyOrigins...)` (`meat/chunk.go:454`, prefix origins from `rangeOrigins` over the meta/preamble spans, body origins accumulated by the hunk-run's own `flush`/`splitHunk` calls); split-hunk segments via `append([]int{-1}, bodyOrigins...)` (`meat/chunk.go:684`, one leading `-1` for the synthesized header line, then `appendUnit`'s per-emitted-row origins, which by construction append exactly one entry per byte-emitting branch and zero entries for the dropped-without-placeholder branch — matching `appendUnit`'s own text-writing exactly, since both live in the same per-line `if`/`else` in the same function). A violation of this invariant would desynchronize `mapMovesToChunk`'s `chunkLine` construction (§14), which assumes `origins[i]` corresponds to physical line `i+1` of `text`.
- **Budget-conservation invariant.** Every chunk actually emitted is verified to fit at construction time, via one of three distinct checks, never merely assumed: whole-section/hunk-run chunks via `b.spanFits`/`runFits` immediately before the `open`/`splitSection` decision (`meat/chunk.go:225,232,508,515`); split-hunk segments via the per-unit `b.fits` check inside the segment-building loop (`meat/chunk.go:655`); the tail-reattachment and passthrough-prose paths via `fitsSingleRun` (`meat/chunk.go:536,547`).

## Hazards

- **H1** (byte offsets): this file's budgeting arithmetic — `prefixText`/`prefixRaw` (§2), every `fits`/`spanFits`/`runFits`/`fitsSingleRun` call, `numberedLen` (`meat/chunk.go:83-89`) — is entirely byte-length-based; confirmed by grep, zero `[]rune`/rune-`range`-over-string constructs anywhere in `meat/chunk.go`. One caveat worth stating explicitly since it can look H1-relevant but isn't: `numberedLen`'s `width := len(strconv.Itoa(count))` is counting the **decimal digit width of an integer** (how many characters `count` takes to print), not a byte-vs-rune-sensitive measurement of arbitrary text — `strconv.Itoa` always produces ASCII digits, so this specific `len()` call carries no H1 exposure regardless of what encoding scheme the port ultimately chooses.
- **H7** (sort stability): **not applicable.** Confirmed by grep: zero `sort.` calls anywhere in `meat/chunk.go`.
- **H8** (division): **not applicable.** Confirmed by grep: zero division operators in `meat/chunk.go`'s executable code (the one `/` match is inside a doc comment, `meat/chunk.go:114`, describing `prefixText[i]/prefixRaw[i]` as a slash-separated pair of names, not an arithmetic expression).
- **H13** (map iteration order): this file constructs exactly three maps — `seenSummary map[string]bool`, `emittedMeta map[int]bool` (both `meat/chunk.go:946-947`), and `chunkLine map[int]int` (`meat/chunk.go:1013`, inside `mapMovesToChunk`). Confirmed by grep across every use of each identifier: all three are **only ever set or looked up by key** (`seenSummary[s]`, `emittedMeta[chunk.sectionID]`, `chunkLine[orig]`/`chunkLine[r.StartLine-1]`) — none is ever ranged over (`for range`). **`chunk.go` has no H13 exposure.** This contrasts directly with `editplan.go`'s genuine H13 finding (its `replacements map[int][]plannedReplacement` *is* ranged over at `editplan.go:353` to run the per-line overlap check, making the relative order of different lines' overlap errors dependent on Go's randomized map order — cite `editplan.md`'s Hazards section) — a clean, verified "not applicable" here is itself useful signal, matching the pattern other stage-2 specs use.
- **H15** (nil/zero as meaningful state): `diffChunk.sectionID` uses `-1` as the sentinel for "not part of a split section" (as opposed to a real, `>= 0` section index) — the identical sentinel pattern `origins` uses for synthesized lines (`-1`) and `planState.folded`/`.foldAt` already use in `editplan.md` (also `-1`). A TypeScript port must give each of these an explicit sentinel representation (e.g. a tagged union, or `number | null`), not reuse a magic `-1` number and rely on incidental falsiness — `-1` is truthy in JS, so a careless `if (sectionID)` check would silently misbehave differently than Go's explicit `sectionID == -1`/`sectionID >= 0` comparisons.
- **H5** (error wrapping): already registered against this exact file/lines (`chunkError`, `meat/chunk.go:895-908`); §12 above deepens it — confirmed `Unwrap` alone is sufficient for both `errors.Is` and `errors.As` to see through to the wrapped cause, and this is exercised end-to-end by G24.
- **H6** (context/AbortSignal): `abridgeChunked` threads `ctx context.Context` straight through to every per-chunk `abridgeOne(ctx, model, sub, opts)` call (`meat/chunk.go:963`) — the same `ctx` for every chunk, not a fresh per-chunk derivation. A cancellation/deadline on the parent context therefore aborts whichever chunk is currently running (and prevents any *subsequent* chunk from starting, since the loop is sequential) — this file itself does no `context.WithTimeout`/cancellation composition of its own; that machinery belongs to `meat.go`'s per-run budget (cite `HAZARDS.md` H6, out of this file's scope).

No new hazard *class* was found — every observed behavior in `chunk.go` maps onto an existing H-number.

## Errors

Exhaustive; six `fmt.Errorf` call sites, zero `errors.New`, zero `panic` (confirmed by grep).

| Message template | Producer | Line | Classification |
|---|---|---|---|
| `"diff is %dKB with no file sections to split into abridgeable chunks — try a narrower range"` | `splitDiffForAbridging`, zero sections | `:190` | New message |
| `"diff splits into more than %d chunks — try a narrower range (a single commit, or per-file with \`git diff -- <path> \| meat\`)"` | `(*chunkBuilder).add`, `maxChunks` refusal | `:251` | New message |
| `"file section at line %d is %dKB with no hunks to split — try a narrower diff (per-file with \`git diff -- <path> \| meat\`)"` | `splitSection`, no `@@` in span | `:403-404` | New message |
| `"cannot fit the diff trailer at line %d into a chunk under the size limit — try a narrower diff (per-file with \`git diff -- <path> \| meat\`)"` | `splitSection`, tail/preamble prose doesn't fit as a single run | `:548` | New message |
| `"cannot split the diff near line %d into a chunk under the size limit — try a narrower diff (per-file with \`git diff -- <path> \| meat\`)"` | `splitHunk`, `segCount == 0` (first candidate unit of a new segment already too big) | `:675` | New message |
| `"meat: %w"` | `abridgeChunked`, wraps `splitDiffForAbridging`'s error | `:918` | New prefix wrap (none of `splitDiffForAbridging`'s own messages already carry `"meat: "`) |
| `"meat: " + label + ": " + strings.TrimPrefix(e.err.Error(), "meat: ")` | `(*chunkError).Error()` | `:902-906` | **Pure transformation, never a new message** — splices an existing error's own text (already `"meat: "`-prefixed, from `abridgeOne`) with the chunk label; the underlying failure's own wording is untouched. |

All six `fmt.Errorf` sites return immediately (no aggregation with other problems — unlike `editplan.go`'s `problems []error` accumulation pattern); chunk-splitting fails fast on the first structural problem encountered.

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

### Stage 2 findings

Resolution of the items above, now that the mechanism is fully traced:

- **`extraHidden` sandwiching** — the *top-level* section loop's fully-hidden
  branch does flush first, exactly as this open question already states
  (Mechanism §5, item 1). But tracing the mechanism surfaced a related,
  sharper question one level down: `splitSection`'s own hunk-level loop's
  fully-hidden branch does **not** flush (`meat/chunk.go:491-496`) — see the
  new item below. The top-level sandwiching question itself remains open at
  the fixture level.
- **Nested Python owners** — no longer merely "untested"; the mechanism is
  now proven correct by construction (Mechanism §7, the `unitEnd`
  owner-absorption trace): the loop recurses exactly through each nested
  owner layer via the outer `for b.pythonOwnerLine(last)` re-test, and
  terminates exactly at the first body row that is not itself an owner,
  never over-absorbing past a plain statement. Fixture coverage remains a
  separate, still-open gap.
- **`splitSection`'s `preamble` non-emptiness** — resolved precisely, not
  merely inferred: `metaStart > s.start` (and hence non-empty `preamble`)
  is possible **only** for the diff's very first section, by a structural
  argument from `sections()`'s own boundary definition and `diff.go`'s
  `fileID` assignment rules (Mechanism §6). This sharpens (without
  contradicting) the existing "piece == 0 prose path... untested with both
  preamble and tail non-empty" question above: it now reads as "untested,
  and structurally only reachable for the diff's first section."
- **Cross-hunk Python import continuation** — remains an open coverage
  gap; the "likely safe by construction" framing is consistent with
  everything found tracing the mechanism (the import mask is computed
  globally, once, before any cut — Mechanism §2), nothing more to add.

New items found while tracing mechanism, not covered by any guarantee above:

- **`splitSection`'s hunk-run-packing loop can absorb a fully-hidden hunk's
  raw bytes — including its import scaffolding — into an adjacent chunk's
  emitted text, unlike the top-level section loop and unlike `splitHunk`'s
  own row-level dropping.** Traced precisely in Mechanism §5: the hunk-run
  loop's fully-hidden branch (`meat/chunk.go:491-496`) `continue`s without
  flushing, so a visible-hidden-visible hunk sequence within one oversized
  section can have the hidden hunk's complete raw text (header and body)
  silently packed into a subsequent hunk-run chunk, if the combined byte
  span still fits budget. This is very likely harmless for final output
  (the chunk-local agent run's own mandatory-import pass independently
  re-derives the same hiding decision, since plain import classification is
  self-contained per-hunk), but it means the actual model-facing
  `chunk.text` bytes sent to a chunk **can** contain import-scaffolding
  text via this specific path — a materially narrower claim than G10's
  prose ("import scaffolding... never appears in any chunk"), whose own
  fixture only exercises the row-level `splitHunk` path. No fixture
  constructs the "hunk sandwich" shape needed to exercise this packing
  level. Recommend either narrowing G10's prose to scope it explicitly to
  segment-level splitting, or adding a fixture at the hunk-run-packing
  level to confirm the guarantee also holds there.
- **A zero-body oversized hunk (the `@@` header alone, forced into
  `splitHunk` with nothing after it) silently drops its own header text
  from the merged output — no chunk, no error.** Traced in Mechanism §7:
  when a hunk's span is exactly one line (reachable when an oversized hunk
  *heading* alone exceeds the per-chunk budget, and that line happens to be
  the diff's own final, newline-less physical line), `bodyStart ==
  bodyEnd`, the segment-building loop never executes, and `splitHunk`
  returns having emitted nothing. This diverges from whole-diff identity
  compilation, which would render an unhidden header line verbatim. No
  fixture constructs this shape; no guarantee currently constrains it.
- **`headerEOL`'s `""`-fallback (`meat/chunk.go:582-584`) is provably
  inert** — reachable as an assignment, never as a read: the only condition
  producing `eol == ""` for a hunk-header line forces the zero-body-hunk
  shape above, whose segment loop (the only reader of `headerEOL`) never
  runs. Narrower than, but overlapping with, the zero-body-hunk finding.
- **`tailStart`/tail text is not restricted to the diff's final section** —
  unlike `preamble` (first-section-only by the structural argument above),
  a per-section trailer is structurally possible for *any* section, since
  section boundaries are defined purely by `fileID` transitions, not by
  hunk content. No guarantee currently distinguishes "last section's tail"
  (the common real-world format-patch-trailer case, G28) from "an interior
  section's own trailing prose" (structurally possible, untested).
- **G12's citation is one line off.** `meat/chunk.go:582-584` is cited for
  `headerEOL := b.lines[h.start].eol`; that assignment is actually at line
  `581` — `582-584` is the `if headerEOL == "" { headerEOL = "\n" }`
  fallback that follows it (see the finding directly above). The
  guarantee's substance is unaffected; only the citation's exact line
  needs correcting to `581` (or `581-584` to also cover the fallback).

Dead or unreachable code: none found beyond what other stage-2 specs
already note. `parseHunkHeaderForSplit`'s unparseable-header fallback path
(Mechanism §11) looked like a candidate but is confirmed genuinely
reachable — a hunk header `diff.go`'s own structural parser accepts (e.g. a
bare `"@@"` line) but whose counts it doesn't itself fully trust.
