# elision

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `meat/elision.go`
> Go tests: `meat/elision_test.go` (11 tests, the file that directly targets
> `elision.go`'s own shapes), `meat/chunk_test.go` (elision manifest survives
> chunking), `meat/editplan_test.go` (baseline single-diff case)

## Purpose

`ElisionLine` produces the one-line, locally-computed manifest a user sees
summarizing how much of a diff was hidden — "kept 12/240 changed lines in
3/7 files" — by comparing the original diff against the compiled reading
diff. It is never reported by the model; it is counted mechanically from
the two diff texts. See `glossary.md`.

## Vocabulary

- **Elision manifest / `ElisionLine`** — the one-line, mechanically-computed
  summary string described above. Three renderings: `"kept X/Y changed
  lines in A/B files"` (partial retention, at least one file header
  survived), `"kept X/Y changed lines"` (partial retention, but no
  `diff --git` header survived — see G5), and `"elided all N changed lines
  in M files"` (nothing survived at all — see G4).
- **Raw / kept changed-line and file counts** — `diffStats(raw)` yields the
  denominator (raw changed lines, raw files); `retainedDiffStats(raw,
  abridged)` yields the numerator by *aligning* the abridged diff back onto
  raw physical-line positions — this alignment is the hard part, not the
  counting.
- **Exact match vs. projection match (alignment)** — two ways a kept line is
  credited against a raw line. An *exact* match is an identical
  (classified-kind, text) pair, found via a lookup index. A *projection*
  match is a placeholder-bearing kept line matched against a raw line
  through a compiled wildcard regex (`compileElisionProjection`,
  `meat/editplan.go:571`) — the same projection mechanism `editplan.md`
  uses to validate replacements, reused here for counting.
- **Elision placeholder (matching) vs. fold placeholder (rendering)** — the
  glossary's "Fold" entry (`editplan.md`) states the *rendered* fold
  placeholder is always ASCII `"..."`, never `…`. Matching is looser:
  `containsElisionPlaceholder` (`meat/elision.go:129-131`) treats **either**
  `"..."` or `…` as a placeholder signal, because a model-authored
  `Replace`'s free text might legitimately contain `…` even though a
  mechanically-generated `Fold` never does.
- **Fixed fold line** — a kept line whose entire body (after its marker
  byte) trims to exactly `"..."`. Recognized structurally
  (`isFixedFoldLine`, `meat/elision.go:133-138`) and short-circuits
  alignment entirely: it is credited as one row without ever being matched
  against a specific raw position. See G8, G9.
- **Composed / adjacent elision** — two or more model-authored `Replace`
  placeholders landing on the same output line and merging into one longer
  dot run (`isComposedElisionProjection`, `meat/editplan.go:562-564`). See
  G5.

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

### Partial retention, alignment, and formatting (`elision_test.go`)

G3. For a two-file raw diff, `ElisionLine` reports the true partial-retention
    shape on both axes at once — fewer changed lines kept than exist, and
    fewer files touched than exist — not just an all-or-nothing count.
    — `meat/elision_test.go:25-36`. Fixture `rawTwoFiles`
    (`meat/elision_test.go:9-23`): two `diff --git` sections, `a.go` (3
    changed rows plus 1 untouched context row) and `b.pb.go` (2 changed
    rows, and a hunk header that itself over-declares its old-line count
    against zero actual old rows — an internal staleness the counter never
    validates, see G12). Abridged keeps only `a.go`'s header, its hunk
    header, and one changed row. Exact result: `"kept 1/5 changed lines in
    1/2 files"`. Mechanism: `ElisionLine` `meat/elision.go:18-31`;
    `rawLines,rawFiles := diffStats(raw)` (`:19`); `keptLines,keptFiles :=
    retainedDiffStats(raw, abridged)` (`:20`); formatting branch at `:27-29`.

G4. When the abridged diff is empty (all content elided), the manifest
    switches to a distinct "elided all" phrasing rather than reporting
    `0/N`.
    — `meat/elision_test.go:38-43`: `ElisionLine(rawTwoFiles, "")` contains
    `"elided all 5 changed lines"`. Mechanism: `meat/elision.go:24-26` —
    triggered by `strings.TrimSpace(abridged) == ""`, formats unconditionally
    as `"elided all %d changed lines in %d files"` using `rawLines`/
    `rawFiles`. Unlike the kept-branch (G5), this format has no guard for
    `rawFiles == 0` — untested at that boundary (see Open questions).

G5. When the abridged diff keeps hunk content but drops every per-file
    header, the manifest falls back to a lines-only phrasing rather than
    claiming "0 files" (which would misleadingly suggest nothing survived
    from any file).
    — `meat/elision_test.go:45-53`: abridged keeps one hunk header plus one
    changed row but no `diff --git` line → exactly `"kept 1/5 changed
    lines"` (no files clause). Mechanism: `meat/elision.go:30` — the
    `keptFiles > 0 && rawFiles > 0` guard at `:27` fails when `keptFiles ==
    0`, falling through to the two-number format.

G6. Alignment between the abridged and raw diff is classification-sensitive
    — a line lexically identical to a file-header row but appearing *inside*
    a hunk body (because it starts with `-`/`+`) is counted as a changed
    row, never a file-header row — and strictly forward-moving: matching a
    kept line never re-matches an earlier, already-consumed raw position,
    even when duplicate text/kind pairs recur later in the raw diff.
    — `meat/elision_test.go:55-76`. Fixture: a hunk body is satisfied by
    literal lines that read exactly like `---`/`+++` file headers (each
    starts with `-`/`+`, so each classifies as a hunk-change row), followed
    by a second, genuine occurrence of that same pair as real file headers
    plus a real hunk. Abridged repeats only the second occurrence. Exact
    result: `"kept 2/4 changed lines"` (no files clause: no `diff --git`
    header exists anywhere in this fixture). Mechanism:
    `meat/elision.go:33-35` doc comment states the rationale directly ("a
    `--` / `++` counter is not mistaken for `---`/`+++` metadata");
    classification is `isGitDiffHeader` (`meat/diff.go:100,310-312`) vs.
    `isRawOldFileHeader` (`meat/diff.go:453`) vs. in-hunk `hunkSourceKind`
    (`meat/diff.go:354-366`) — owned by `diff.md`, load-bearing here.
    Forward-only alignment: `exactPositions` built once over raw in
    ascending order (`meat/elision.go:62-66`), looked up via
    `nextReadingLineAtOrAfter` — a binary search for the first stored
    position `>= rawPos` (`meat/elision.go:121-127`), with `rawPos` advanced
    to `matchedAt+1` after every credited match (`meat/elision.go:111`).

G7. Two adjacent model-authored `Replace` operations on the same source
    line, whose placeholders compose into one longer ellipsis run in the
    rendered output, are still recognized as exactly one kept/changed row of
    the *original* line — not zero (mismatched), and not counted per
    replacement.
    — `meat/elision_test.go:78-96`. Fixture: raw `"+abcdef"`; abridged built
    by compiling (not hand-writing) two adjacent `Replace` operations via
    `applyEditPlan` (`meat/editplan.go:126`), which compose into `"+......ef"`.
    Exact result: `"kept 1/1 changed lines in 1/1 files"`. Mechanism: the
    composed line contains `...`, so `isHunkSource(keptKind) &&
    containsElisionPlaceholder(...)` (`meat/elision.go:85,129-131`) engages
    the projection path — `compileElisionProjection`
    (`meat/editplan.go:571`, called from `meat/elision.go:86`) turns the
    composed placeholder into a wildcard regex matching the original
    `abcdef` body, crediting one `diffLineHunkChange` row
    (`meat/elision.go:105-107`).

G8. When a kept line carrying an elision placeholder could match either an
    earlier raw row via wildcard projection or a later, textually-identical
    literal raw row via exact match, the earlier candidate wins — matching
    consumes raw rows in strict left-to-right ("greedy") order rather than
    snapping to the nearest literal duplicate.
    — `meat/elision_test.go:98-104`. Raw: `+aSECRETz`, `+after-first`,
    `+a...z` (literal), `+after-exact` (4 rows, 1 file). Abridged: `+a...z`,
    `+after-first` — this kept `+a...z` is both an exact match against raw
    row 3 and a projection match against raw row 1 (`aSECRETz`). Exact
    result: `"kept 2/4 changed lines in 1/1 files"` — row 1 (via
    projection) and row 2 (via exact match) are credited; row 3's literal
    duplicate is never separately consumed. Mechanism: `meat/elision.go:77-101`.
    `exactAt` is computed first (`:78`) and defaults `matchedAt := exactAt`
    (`:79`); the projection scan is bounded to `[rawPos, exactAt)` — strictly
    *before* the exact-match position when one exists (`:87-90`) — and
    overwrites `matchedAt` with the first raw row at/after `rawPos` sharing
    both kind and marker byte (`:91-92`) whose remainder matches the
    compiled regex (`:95-98`), stopping at the first hit (`:96-97`).

G9. A run of many kept lines that each carry a never-matching elision
    placeholder (so none can align to any raw row) completes within a hard,
    generous wall-clock ceiling and correctly credits zero of them as kept —
    a scalability regression guard, not a correctness edge case per se.
    — `meat/elision_test.go:106-125`, skipped under `testing.Short()`.
    Fixture: 1000 raw `+raw` rows vs. 1000 abridged `+missing...zzz` rows
    that can never regex-match. Assertion: `elapsed > 2*time.Second` fails
    the test; functional result: `"kept 0/1000 changed lines in 1/1
    files"`. Mechanism/hazard: `splitSourceLines`/`analyzeDiff` run exactly
    once per side (`meat/elision.go:54-57`), not per candidate line. Per
    kept line, `compileElisionProjection` is compiled once (`:86`) and
    reused for a bounded linear scan `[rawPos, end)` (`:87-99`); because
    none of the 1000 kept lines ever matches, `matchedAt` stays negative and
    the `continue` at `:102-103` skips the `rawPos` advance — so `rawPos`
    never moves past its starting point, and each of the 1000 iterations
    scans roughly the same ~1000-row window. The 2s ceiling bounds that cost
    generously; it does **not** prove the algorithm is sub-quadratic, only
    that compiling the regex once per kept line (not per candidate row)
    keeps this specific adversarial case cheap enough.

G10. A synthetic, machine-generated fold placeholder that collapses several
    original changed rows into one ellipsis row is credited as exactly
    **one** kept/changed row — never the number of rows it stands for,
    never zero.
    — `meat/elision_test.go:127-139`. Fixture: three raw `+`-rows folded
    into one row via `applyEditPlan(raw, submission{Fold: [...]})`. Exact
    result: `"kept 1/3 changed lines in 1/1 files"`. Mechanism:
    `isFixedFoldLine` (`meat/elision.go:133-138`) recognizes any kept line
    whose marker byte is `+`, `-`, or `' '` and whose trimmed remainder is
    exactly `"..."`; the caller (`meat/elision.go:70-75`) checks this
    **before** computing exact-or-projection alignment at all, and if the
    marker is `+` or `-` credits exactly one changed row via `continue` —
    bypassing the raw-position lookup entirely (the credit is unconditional
    on any raw content actually existing at that position).

G11. A model-authored fold's synthetic ellipsis row and a raw diff's own,
    unrelated **literal** source line that happens to consist solely of
    `"..."` are each independently credited as one kept row — the fold does
    not "consume" (align away) the later literal row, and the literal row
    is not mistaken for part of the fold.
    — `meat/elision_test.go:141-150`. Fixture: raw has 5 changed rows
    including a genuine literal `+...` line; `Fold` collapses two earlier
    rows into one placeholder row. Exact result: `"kept 4/5 changed lines
    in 1/1 files"` (fold row, one exact-matched row, the literal `...` row,
    one more exact-matched row). Mechanism: because `isFixedFoldLine`
    (`meat/elision.go:70-75`) checks only the kept line's own trimmed text
    — with no attempt to align it to a specific raw row and no advancement
    of `rawPos` (the `continue` at `:74` skips the `rawPos = matchedAt + 1`
    update, at both the fold row and the literal `...` row) — the general
    placeholder-projection scan (`:85-101`, which could otherwise match the
    fold's placeholder against the raw's later, real `+...` row) never runs
    for either row. This is what keeps the two occurrences from being
    conflated into a single credit.

G12. A reading diff's `@@` hunk header may be internally stale (its
    declared old/new counts no longer match its actual body-row count,
    because a row was removed without recomputing the header) without
    perturbing the elision count — counting operates purely on classified
    body rows, never on hunk-declared counts.
    — `meat/elision_test.go:152-181`. Raw: two file diffs, each hunk
    declared `@@ -1,2 +1,2 @@` with one context row and one changed row per
    side (4 changed rows total). Abridged removes one changed row from the
    first hunk but leaves that hunk's `@@` header text unchanged (now
    stale). Exact result: `"kept 3/4 changed lines"` (no files clause: no
    `diff --git` header anywhere in this fixture). Mechanism:
    `meat/elision.go:49-51` doc comment states the rationale directly
    ("avoids reparsing deliberately stale `@@` counts after lines were
    removed"); confirmed by the exact-match/projection loop (`:69-111`)
    never reading `oldRemain`/`newRemain` or any hunk-header field — only
    classified kinds and line text.

G13. Per-file `diff --git …` header lines count toward the "files" total;
    the paired `---`/`+++` old/new-file header lines do **not** — confirmed
    directly at the `diffStats` level, independent of `ElisionLine`'s
    formatting.
    — `meat/elision_test.go:183-189`: `diffStats(rawTwoFiles)` returns
    exactly `(5, 2)`. Mechanism: `diffStats` (`meat/elision.go:36-47`)
    switches only on `diffLineHunkChange` (`:40-41`) and `diffLineHeader`
    (`:42-43`); `diffLineHeader` is assigned only by `isGitDiffHeader`
    (`meat/diff.go:100,310-312`), which matches `diff --git …` specifically
    — the `---`/`+++` pair is a *different* kind (`diffLineOldFile`/
    `diffLineNewFile`, `meat/diff.go:453,328-334`) that `diffStats`'s switch
    does not handle.

## Mechanism

**Responsibility and callers.** `elision.go` has exactly one exported entry
point, `ElisionLine`, with exactly one caller in the whole tree:
`cmd/meat/main.go:147`, called once per CLI invocation as
`meat.ElisionLine(diff, res.SmartDiff)` — the original raw diff text the user
supplied, and the final `Result.SmartDiff` produced by `meat.Abridge`. Its
output feeds two renderers: `renderResult`/`formatBody`
(`cmd/meat/render.go:83-86`, printed as a `# …` line only when non-empty) and
`renderJSON` (`cmd/meat/render.go:16-26`, wire field `elision`,
`json:"elision,omitempty"` — H9 governs the omission). `elision.go` itself has
zero awareness of chunking: when the diff was split, `chunk.go` assembles
`merged.SmartDiff` by concatenating per-chunk pieces first
(`meat/chunk.go:969-998`), and only that already-merged string, together with
the *original, unsplit* raw diff, ever reaches `ElisionLine`. Nothing inside
`elision.go` calls into or is called from `chunk.go`.

Do not confuse this with `tools.md`'s "retention pressure"
(`rawChanged`/`visibleChanged`, `tools.md` G1): that is a per-plan boolean
computed *during* compilation to trigger a refinement turn; `ElisionLine` is a
purely descriptive, post-hoc string computed once at the very end, never fed
back into the agent loop.

**Data shapes** (by meaning, not Go types):
- *Physical line record* — one row of diff text: its content with the
  trailing line terminator stripped, plus that terminator recorded separately
  (owned by `diff.md`; `elision.go` only consumes it).
- *Classified line kind* — an enumerated role tag per physical line (file-open
  header, old/new-file marker, hunk boundary, in-hunk context row, in-hunk
  changed row, plus several kinds `elision.go` never inspects). Two diff texts
  are always classified independently, in isolation from each other.
- *Diff layout* — a whole diff's physical lines paired 1:1 with their
  classified kinds, the output of one classification pass over one text.
- *Alignment key* — the pair (classified kind, exact line content) used to
  decide whether an abridged line and a raw line count as "the same line" for
  exact matching. Note this key deliberately omits the line terminator
  (`meat/elision.go:64` builds the key from `.text` only, never `.eol`) — a
  raw LF line and an otherwise-identical kept CRLF line (or vice versa) are an
  exact match under this key.
- *Alignment cursor* — a single position marking the earliest raw physical
  line still eligible to be matched against any subsequent kept line.

**Algorithm: `diffStats(diff)`** (`meat/elision.go:36-47`) — the denominator.
1. Split the text into physical line records and classify them, once, in
   isolation (`:37`).
2. Walk the classified kinds in physical order. Increment `changed` once per
   line classified as an in-hunk changed row; increment `files` once per line
   classified as a file-open header row (`diff --git …`). Every other
   classification (old/new-file marker, hunk boundary, context row, etc.) is
   ignored for both counters (`:38-45`).

**Algorithm: `retainedDiffStats(raw, abridged)`** (`meat/elision.go:53-114`) —
the numerator, by aligning kept lines back onto raw physical positions.
1. Split and classify both texts independently — `rawLayout` over `raw`
   alone, `keptLayout` over `abridged` alone (`:54-57`). The abridged text's
   classification is entirely self-derived; it does not inherit anything from
   the raw text's parse.
2. Build an exact-match lookup, once, before scanning any kept line: for
   every raw physical line in ascending physical order, append its index to
   the list stored under the key (that raw line's own classified kind, its
   exact text) (`:62-66`). Because this is a single forward pass with
   `append`-only growth, every key's index list is sorted ascending *by
   construction* — nothing re-sorts it afterward, and nothing checks that it
   stayed sorted.
3. Initialize the cursor `rawPos` to 0 (`:68`).
4. Walk the kept (abridged) lines once, left to right, in physical order
   (`:69`). For each kept line:
   a. **Fixed-fold short-circuit.** If the kept line's first byte is `+`,
      `-`, or space, and its remainder — trimmed of surrounding whitespace —
      is exactly the three characters `...`, this is a fixed fold line
      (`isFixedFoldLine`, `:133-138`, tested at `:70`). Credit one changed
      row if the marker is `+` or `-`; credit nothing if the marker is space
      (`:71-73`). Either way, `continue` immediately (`:74`): do **not**
      attempt any alignment, and do **not** move `rawPos`. Proceed to the
      next kept line. A fixed-fold row can never be credited toward the file
      count — only `changed++` exists on this path.
   b. Otherwise, read this kept line's own classified kind, `keptKind`
      (`:77`).
   c. **Exact-match lookup.** Look up the index list for the key `(keptKind,
      kept line's exact text)`; binary-search it for the first stored index
      `>= rawPos` (`nextReadingLineAtOrAfter`, `:78,121-127` — a thin wrapper
      over `sort.SearchInts`). Call the result `exactAt` (or "none" if the
      search runs off the end of the list, `:123-125`). Provisionally set
      `matchedAt = exactAt` (`:79`).
   d. **Projection-match scan**, attempted only when: the kept kind is a
      hunk-source kind (context or changed, per `isHunkSource`,
      `meat/diff.go:158-160`), the kept line has more than one byte, and its
      text after the marker byte contains a placeholder signal — a literal
      `...` substring or a literal `…` rune (`containsElisionPlaceholder`,
      `:129-131`, gated at `:85`). Compile a wildcard-matching pattern from
      the kept line's post-marker text using the **non-strict** mode of the
      shared compiler (`compileElisionProjection(kept.text[1:], false)`,
      `:86`, compiler at `meat/editplan.go:571-632`) — meaning a run of
      three-*or-more* consecutive dots collapses to one wildcard span (not
      exactly three, contrast the strict validator `editplan.md` G19
      describes for authoring), and two wildcard spans immediately adjacent
      to each other silently merge into one rather than being rejected. If
      compilation fails (only possible when no placeholder survived, since a
      wildcard-free pattern is always rejected, `meat/editplan.go:627-629`),
      skip this sub-step entirely. Otherwise scan raw physical lines by
      ascending index, starting at `rawPos`, stopping strictly *before*
      `exactAt` when an exact match exists, or through the last raw line when
      it does not (`:87-90`). At each candidate index `i`: skip unless
      `rawLayout.kinds[i] == keptKind`, the raw line has at least one byte,
      and its first byte equals the kept line's first byte (`:92`); then test
      the compiled pattern against the raw line's text after its marker
      (`:95`). The **first** candidate that passes wins — `matchedAt = i;
      break` (`:96-97`); this is a leftmost/first-fit scan across the allowed
      window, not a best-fit search over it.
   e. If `matchedAt` is still "none" after (c) and (d), this kept line is not
      credited to anything; `continue` without moving `rawPos` (`:102-103`).
   f. Otherwise credit one unit according to how **the matched raw line**
      classifies (`rawLayout.kinds[matchedAt]`, not the kept line's own kind —
      though by this point the two are always equal, since every path to a
      non-negative `matchedAt` already required kind equality):
      `diffLineHunkChange` → `changed++`, `diffLineHeader` → `files++`
      (`:105-110`). Advance the cursor: `rawPos = matchedAt + 1` (`:111`).
5. Return the accumulated `(changed, files)` (`:113`).

**`ElisionLine`'s format selection** (`meat/elision.go:18-31`) — evaluated in
this exact order, and note steps 1–2 below always execute in full *before*
the early-return check, regardless of its outcome:
1. Unconditionally compute `rawLines, rawFiles := diffStats(raw)` (`:19`) and
   `keptLines, keptFiles := retainedDiffStats(raw, abridged)` (`:20`) — the
   full alignment scan runs even on inputs that will hit the next branch and
   discard the result.
2. If `rawLines == 0`, return the empty string `""` immediately (`:21-23`) —
   `keptLines`/`keptFiles` computed above are discarded unused.
3. Else if `strings.TrimSpace(abridged) == ""`, return `"elided all %d
   changed lines in %d files"` using **`rawLines`/`rawFiles`** (`:24-26`).
   This branch entirely ignores whatever `retainedDiffStats` computed at step
   1 — it cannot do otherwise, but it is worth stating explicitly: an
   abridged text that is merely whitespace (not literally `""`) still
   triggers this branch and still reports raw-side counts, not zero.
4. Else if `keptFiles > 0 && rawFiles > 0`, return `"kept %d/%d changed lines
   in %d/%d files"` with all four counts (`:27-28`) — the "files" clause is
   included only when *both* sides saw at least one file header.
5. Else (i.e. `keptFiles == 0`, whether or not `rawFiles > 0`), return `"kept
   %d/%d changed lines"` with no files clause (`:30`).

## Invariants

- **`rawPos` never decreases.** It starts at 0 and is only ever reassigned to
  `matchedAt + 1` after a credited match (`:68,111`), and every accepted
  `matchedAt` — from either the exact lookup (bounded below by the search
  floor `rawPos`, `:78`) or the projection scan (loop starts at `rawPos`,
  `:91`) — is `>= rawPos` at the moment it's found. *Consequence if
  violated:* a single raw physical line could be credited to two different
  kept lines, inflating `keptLines`/`keptFiles` past `rawLines`/`rawFiles`
  and silently breaking the "kept ≤ raw" arithmetic every guarantee in this
  spec assumes.
- **Exact-match index lists are sorted only because of construction order,
  never enforced.** `exactPositions` is populated by a single forward pass
  over `rawLines` in ascending physical order (`:63-66`); nothing sorts the
  lists afterward, and `sort.SearchInts` (`:122`) does not validate that its
  input is sorted — it will return a plausible-looking but wrong index if it
  isn't. *Consequence if violated:* a refactor that builds the same lookup by
  any means other than one ascending forward pass (e.g. merging per-kind
  sub-passes, or processing lines out of physical order) would silently
  corrupt every binary search downstream with no exception and no obviously-
  wrong output — this is exactly the shape of bug H7 warns is invisible
  until a specific fixture exposes it.
- **The projection scan can only move `matchedAt` earlier than the exact
  match, never later.** The scan window's upper bound is `exactAt` itself
  when an exact match exists (`:87-90`); `matchedAt` starts pre-set to
  `exactAt` and is only overwritten by a *strictly earlier* raw index.
  *Consequence if violated* (e.g. the bound were removed and the scan ran to
  end-of-raw regardless): a later, spurious projection match past the
  correct exact match could overwrite it, contradicting the greedy-earliest
  semantics stage 1's G8 pins.
- **Fixed-fold crediting never touches raw content and never moves the
  cursor** (`:70-75`, `continue` at `:74` skips both the alignment lookup and
  the `rawPos` update). *Consequence if violated* (e.g. a fold credit were
  made to also advance `rawPos` speculatively): it would swallow real raw
  content between the old and new cursor position, undercounting whatever
  kept line should have matched there next.
- **`keptFiles > 0` implies `rawFiles > 0`.** Both `diffStats`'s `rawFiles`
  (`:37,42-43`) and every file credited inside `retainedDiffStats`
  (`:56,108-109`) come from classifying the identical raw text with the
  identical classifier; they cannot disagree. See Open questions below for
  whether the redundant guard is deliberate.
- **Byte-indexing the marker is safe only because the marker alphabet is
  fixed ASCII.** Every direct byte access in this file — `kept.text[0]`,
  `kept.text[1:]` (`:71,85-86`), `rawLines[i].text[0]`, `rawLines[i].text[1:]`
  (`:92,95`), `line[0]`, `line[1:]` (`:134,137`) — assumes byte offset 0 is
  the marker and offset 1 starts the body. That is only correct because the
  markers this file recognizes (`+`, `-`, `' '`) are single ASCII bytes, and
  ASCII bytes never occur as a continuation byte of a multi-byte UTF-8
  sequence. *Consequence for the port:* this indexing style ports directly
  onto a byte buffer (head/tail split at offset 1) with no adjustment — but
  only because no offset other than 0/1 is ever computed here; do not
  "helpfully" decode to a UTF-16 string first (see Hazards, H1).
- **Zero-length lines are defensively skipped, not indexed.** `:92`'s
  `len(rawLines[i].text) < 1` guard and `:85`'s `len(kept.text) > 1` guard
  both run before any byte access on that line. No line in this file is ever
  indexed without a preceding length check.

## Hazards

- **H1** — byte-marker indexing at `meat/elision.go:71,85-86,92,95,134,137`.
  Safe today for the ASCII-marker reason given under Invariants above; when
  ported, keep this on the raw byte buffer per the engine-wide H1 decision —
  do not decode to a JS string first "just to slice off the marker."
- **H2** (boundary, not internal) — `elision.go:86` calls
  `compileElisionProjection` (`meat/editplan.go:571-632`), which iterates
  `[]rune(new)` (`meat/editplan.go:572`) — full Unicode codepoints.
  `elision.go` itself never iterates runes, but a porter working only from
  this file could miss that the object it calls into must be codepoint-based,
  not UTF-16-unit-based, when a kept line's placeholder body is matched
  against raw text containing multi-byte characters.
- **H3(a)/(c)** — the same `compileElisionProjection` call at `elision.go:86`
  is the function HAZARDS.md flags for catastrophic-backtracking risk and
  byte-vs-UTF-16 regex offsets. `editplan.go`'s call site is not the only
  one; whatever literal-scan replacement H3(a) prescribes for the compiler
  must also serve this call site — `elision.go`'s own scan (`:91-99`) is
  bounded, but each candidate still needs a full pattern-match test against
  the compiled projection.
- **H7** — `sort.SearchInts` at `meat/elision.go:122`, exactly the site
  HAZARDS.md names. The register only says "no JS equivalent, write it"; the
  sharper point (see Invariants) is that correctness depends equally on the
  *construction* loop (`:63-66`) staying a single ascending forward pass —
  porting a correct binary search alone is not sufficient if the equivalent
  lookup-building step is restructured.
- **H14** — two `strings.TrimSpace` call sites not currently listed in the
  register: `elision.go:24` (decides "elided all" vs. a kept-count phrasing —
  a branch-selecting trim, the same category HAZARDS.md calls out for
  `meat.go:119`) and `elision.go:137` (decides whether a line is a fixed fold
  at all). Both are U+0085/U+FEFF-divergence-sensitive between Go and JS trim
  semantics; worth an explicit trim helper rather than `.trim()` at both
  sites, same as the register's existing guidance.

## Errors

`elision.go` has **no error type and no panic path reachable from arbitrary
`(raw, abridged)` string pairs.** `ElisionLine` always returns a string;
there is no `error` return anywhere in the file. Every direct byte access is
preceded by a length check (`:70,85,92,133-134`), `containsElisionPlaceholder`
and `compileElisionProjection`'s failure mode is a boolean/`ok` return rather
than a panic, and `nextReadingLineAtOrAfter` returns a sentinel `-1` rather
than indexing out of bounds when nothing is found (`:123-125`). The one
non-formatted output is the empty string returned when `rawLines == 0`
(`:21-23`) — a sentinel meaning "nothing to report," not an error message;
callers must and do check for it explicitly (`cmd/meat/render.go:83` guards
on `elision != ""` before printing; the JSON encoder's `omitempty` on the
`Elision` field, `cmd/meat/render.go:18`, drops the key entirely — H9 applies
to that field). This file performs no validation of whether `abridged` is
actually derived from `raw`; an unrelated pair of strings does not error, it
simply produces a low or zero kept count.

## Open questions

- **Vocabulary/mechanism mismatch:** the Vocabulary section above cites
  `isComposedElisionProjection` (`meat/editplan.go:562-564`) as the mechanism
  behind "Composed / adjacent elision." A repo-wide search shows that
  function has **zero call sites anywhere** — not from `elision.go`, not from
  anywhere else (`editplan.md`'s own Open questions independently confirm
  this). The actual mechanism achieving composed-placeholder recognition at
  counting time is `elision.go:86`'s *direct* call to the shared
  `compileElisionProjection(..., false)` — the non-strict mode — never
  through the named wrapper. The vocabulary citation should probably point at
  `elision.go:86` (and `editplan.go:571-632`'s non-strict branches) rather
  than at dead code. Not rewritten here per the "don't overwrite stage 1"
  rule; flagging for reconciliation.
- **Is the `rawFiles > 0` conjunct at `elision.go:27` intentional defense or
  dead weight?** `keptFiles > 0` already implies `rawFiles > 0` given how
  both are derived from the same raw classification (see Invariants); no
  current test distinguishes `if keptFiles > 0` from `if keptFiles > 0 &&
  rawFiles > 0`. Not proposing a change — a port should preserve the guard as
  written — but worth confirming whether it's deliberate belt-and-suspenders
  or vestigial.
- **Is running `retainedDiffStats` unconditionally before the `rawLines == 0`
  check (`elision.go:19-23`) load-bearing or incidental Go evaluation
  order?** It currently has no observable effect (empty/degenerate `raw`
  makes every step a no-op), but a porter restructuring for early-return-
  first should confirm `retainedDiffStats` truly has no side effects worth
  preserving in that order.
- **Is CRLF-vs-LF-insensitive alignment deliberate?** `readingLineKey` omits
  the line terminator (`elision.go:64` uses only `.text`), so a raw line
  ending in `\r\n` and an otherwise-identical kept line ending in `\n` count
  as an exact match. No test isolates a mixed-line-ending fixture, so it's
  unclear whether this is a deliberate "line endings are cosmetic" design
  choice or simply never came up.
- **`ElisionLine`'s `rawLines == 0` branch is untested anywhere in the whole
  suite** (`meat/elision.go:21-23`, returns `""`). Checked every call site
  across `meat/*.go` and `cmd/meat/*.go` — none passes an empty/whitespace-
  only raw diff. A cross-file gap, not specific to `elision_test.go`.
- **The "elided all" branch's file-count format is untested at `rawFiles ==
  0`** (G4): that branch always formats a files clause unconditionally,
  unlike the kept-partial branch's guard (G5) — what it renders when there
  are zero raw files too is unverified.
- **Context-marker (`' '`) fold/literal rows credit nothing, and no test
  proves it.** `meat/elision.go:71`'s guard means a folded *context* line —
  or a literal context-side `"..."` line — contributes zero to the changed
  count. Both fold tests (G10, G11) only use `+` rows.
- **No test combines a fold or composed-replacement scenario with
  multi-file counting** (an `X/Y` result with `X<Y` files). All three fold/
  composed-replacement tests (G7, G10, G11) are single-file, `1/1`-files
  fixtures.
- **G6's and G11's mechanism claims lean on `diff.go`'s hunk-boundary
  parser**, which is `diff.md` territory and was only traced here for its
  elision-counting consequence — worth a cross-check once `diff.md` is
  written.
