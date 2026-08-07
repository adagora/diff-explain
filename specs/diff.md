# diff

> Status: stage 1 🟡 | stage 2 ✅
> Go sources: `meat/diff.go`
> Go tests: `meat/meat_test.go` (rejection guarantees via `Abridge`), `meat/editplan_test.go` (structural edge cases), `meat/chunk_test.go` (layout use, not yet separately mined for diff.go-only tests)

## Purpose

**Foundation.** Parses a unified diff into an immutable line-oriented
layout: classifies every physical line (header, hunk change, context,
no-newline marker, mail signature, etc.) and tags each with its file, hunk,
and source language. Everything downstream — editplan, chunk, imports,
moves — consumes this layout and never re-parses the diff text. See
`glossary.md`.

## Vocabulary

`glossary.md` has no section for `diff.go` yet (its grouped sections start at
"Edit plans"). These terms are introduced here since every other spec's stage
2 needs them:

- **Physical line** — one line of the raw diff text as split by
  `splitSourceLines`: a text span plus the exact byte sequence that ended it
  (`"\n"`, `"\r\n"`, or empty for a final unterminated line).
  `meat/diff.go:17-20,63-86`.
- **Layout (`diffLayout`)** — the whole-diff, parallel-array classification
  result: one entry per physical line for its kind, file id, hunk id,
  language, Python-ness, and no-newline-marker ownership, plus a list of
  structural problems found while producing it. `meat/diff.go:53-61`.
- **Line kind (`diffLineKind`)** — the classification tag on one physical
  line; the full enumeration is under Mechanism below. `meat/diff.go:22-39`.
- **Source language (`sourceLanguage`)** — the per-line language tag derived
  from a file's path extension, used by the Python-specific validators and
  (per `chunk.md`) by string-interior tracking. `meat/diff.go:41-51`.
- **Hunk source** — a line classified as `diffLineHunkContext` or
  `diffLineHunkChange`, i.e. a line that is part of a hunk's body content as
  opposed to a header/marker line. `meat/diff.go:158-160` (`isHunkSource`).

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

## Mechanism

### Responsibility and dependents

`diff.go` turns diff text into two artifacts that never change again: the
physical-line split (`sourceLine[]`) and the classification layout
(`diffLayout`) produced by `analyzeDiff`. Every other Go source file that
touches diff structure — `editplan.go`, `chunk.go`, `imports.go`, `moves.go`,
`python.go`, `elision.go` — takes a `[]sourceLine` and a `diffLayout` as
input and reads them; none of them re-split or re-derive line kinds.
Confirmed by direct inspection: every non-test call site of
`analyzeDiff`/`splitSourceLines` in the package is in `diff.go` itself,
`elision.go:37,55-57`, `editplan.go:168,172`, `imports.go` (consumes
`diffLayout` only, never calls `analyzeDiff`), `moves.go:442-443`,
`chunk.go:151-152`, `python.go` (consumes only). `chunk.go`'s own
string-interior mask (`stringInteriorMask`, `meat/chunk.go:265-291`) is a
*separate*, chunk-local construct that consumes `diff.go`'s
`layout.language`/`layout.python`/`layout.kinds` as input — it is not part
of `diff.go`'s own classification. String-interior tracking belongs to
`chunk.md`; `diff.go` only supplies the language/kind facts that make it
possible.

### Data shapes

- **`sourceLine`**: one physical line's text (without its terminator) and
  its terminator (`""`, `"\n"`, or `"\r\n"`). `meat/diff.go:17-20`.
- **`diffLayout`**: for a diff of N physical lines, N-entry parallel arrays:
  - `kinds` — this line's `diffLineKind`.
  - `markerOwner` — for a no-newline-marker line, the index of the
    hunk-source line it terminates, or `-1` if the marker doesn't directly
    follow hunk source. `meat/diff.go:55,174-175,234-236,257-259`.
  - `python` — whether this line's file is Python.
  - `language` — this line's `sourceLanguage`.
  - `fileID` — a 0-based counter identifying which file section this line
    belongs to, or `-1` before any file section starts.
  - `hunkID` — a 0-based counter identifying which hunk this line belongs
    to, or `-1` outside any hunk.
  - `problems` — accumulated structural errors (currently only "counts
    inconsistent" errors), collected rather than raised immediately so a
    single pass can report anything wrong with the whole diff.
    `meat/diff.go:53-61,166-178`.

### Algorithm 1 — `splitSourceLines` (`meat/diff.go:66-86`)

1. Empty input produces `nil` (zero lines), not a single empty line.
   `meat/diff.go:67-69`.
2. Repeatedly find the next `'\n'` by byte search.
3. If none remains, the rest of the text is emitted as one final line with
   an empty terminator (`eol: ""`) and the loop stops. **This is the
   no-phantom-trailing-line guarantee**: text with no trailing newline gets
   exactly as many lines as there are actual line bodies, never one more for
   "after the last newline." `meat/diff.go:73-76`.
4. Otherwise, the line runs up to (not including) the `'\n'`. If it ends in
   `'\r'`, that `'\r'` is stripped from the line body and the terminator
   recorded is `"\r\n"`; otherwise the terminator is `"\n"`.
   `meat/diff.go:77-82`.
5. Advance past the consumed `'\n'` and repeat from step 2 against the
   remainder.

Consequence of the no-phantom-line guarantee: a diff ending exactly at a
`'\n'` produces no trailing empty `sourceLine` for "the line after the last
newline" — the terminator of the last real line simply records that a
newline was present. This is what lets `numberedDiff` (below) avoid a
phantom final gutter entry, and it is why a chunk merge step must synthesize
`"\n"` only *between* pieces, never after the last (see `chunk.md`).

### Algorithm 2 — `validateSupportedDiffLines` / combined-diff pre-pass (`meat/diff.go:104-122`)

This runs once, before `analyzeDiff`, on the raw physical lines. It is a
linear scan tracking one boolean, `inPatch`:

1. For each line, in order:
   - If the line is a mail signature (`isFormatPatchSignature`, exactly
     `"-- "`), set `inPatch = false`.
   - Else if the line starts with `"diff --cc "` or `"diff --combined "`,
     fail immediately with the combined-diff header error (see Errors).
   - Else if the line is a `diff --git ` header, set `inPatch = true`.
   - Else if the line is a raw old-file header (see `isRawOldFileHeader`
     below), set `inPatch = true`.
2. Independent of the above, if `inPatch` is true (after any update just
   made for this same line) and the line starts with `"@@@"`, fail
   immediately with the combined-diff hunk error.
3. No match found on any line: return no error.

This function, not `analyzeDiff`, is what rejects combined diffs (G1). See
Invariants for why this matters: `analyzeDiff` itself performs no
combined-diff gating.

### Algorithm 3 — `analyzeDiff` state machine (`meat/diff.go:165-352`)

State carried across the scan: `inHunk`, `countsKnown`,
`hunkProblemReported` (all bool); `oldRemain`, `newRemain`,
`hunkHeaderLine` (ints); `currentLanguage`; `currentFileID`, `currentHunkID`
(start at `-1`); `gitFileSection`, `inFileSection` (bools, start false).

The outer loop walks physical lines by index `i`, manually incremented (not
a `range` loop), because several branches need to re-inspect the same `i`
under a different mode (via `continue` without incrementing). Per
iteration:

1. **File/language bookkeeping** (runs only when not already inside a hunk,
   `meat/diff.go:200-218`):
   - A `diff --git ` line always starts a new file: `currentFileID++`,
     `gitFileSection = true`, `inFileSection = true`, and `currentLanguage`
     is recomputed from the header's path fields (`diffHeaderLanguage`).
   - A raw old-file header (`isRawOldFileHeader`, the `"--- "`/`"+++ "`
     pair) starts a new file **only if not already inside a git-style
     section** (`if !gitFileSection { currentFileID++ }`) — this is what
     keeps a git section's own `---`/`+++` pair from creating a spurious
     second file id, while still correctly incrementing per-file for bare
     (non-`diff --git`) multi-file diffs. It also re-derives
     `currentLanguage`, independently, from `fileMarkerLanguage` on both the
     old and new path lines — see the "language tagging" decision boundary
     below.
2. **Per-line tag stamping** (`meat/diff.go:220-222`, runs every
   iteration): `layout.language[i]`, `layout.python[i]` (`= currentLanguage
   == sourceLanguagePython`), and `layout.fileID[i]` are set from current
   state. **Exception:** the `+++` line of a raw file-header pair is
   consumed in the *same* iteration as its `---` partner (the loop advances
   `i += 2`, `meat/diff.go:328-334`), so it never passes through this
   per-iteration stamping step; its `language`/`python`/`fileID` are set
   explicitly, inline, at `meat/diff.go:331-333`. A port that stamps tags
   line-by-line in a simple `for` loop must replicate this two-line special
   case explicitly, not assume uniform per-line stamping.
3. **Inside a hunk** (`meat/diff.go:223-302`):
   a. If a hunk header's counts couldn't be parsed at all (`!countsKnown`)
      and the current line is a raw old-file header, immediately drop out of
      hunk mode and re-process this same line as a structural line
      (`meat/diff.go:224-229`) — an unparseable `@@` header can't tell
      "exhausted" from "not exhausted," so the classifier falls back to
      recognizing only an explicit, complete file-header pair as the exit
      signal.
   b. Else if counts are known and both sides are fully consumed
      (`countsKnown && oldRemain==0 && newRemain==0`,
      `meat/diff.go:230-253`): a no-newline marker here is still tagged and
      hunk-owned; a raw old-file header, a `diff --git` header, any
      `@@`-prefixed line, or a mail signature ends the hunk (re-processed
      structurally); any other `' '`/`'+'`/`'-'`-prefixed line is treated as
      extra hunk-source content — this is what raises "counts inconsistent"
      for a hunk claiming fewer body lines than it actually has (see
      Errors) while *still* classifying and keeping the extra line as hunk
      source; anything else ends the hunk.
   c. Else (still inside declared counts, `meat/diff.go:254-301`): a
      no-newline marker is tagged and owned; otherwise, if the line's first
      byte is `' '`/`'+'`/`'-'` (`hunkSourceKind`), it is hunk source — when
      counts are known, the matching side's remaining count must be `> 0`
      or the "counts inconsistent" problem is raised (still classified as
      hunk source regardless); when the line doesn't look like hunk source
      at all, if counts are known and either side still has undeclared
      remaining lines, "counts inconsistent" is raised (declared more body
      than was present), and the hunk ends, re-processing this line
      structurally.
4. **Structural classification** (`meat/diff.go:304-346`, reached only when
   not in a hunk): in priority order — mail signature; `diff --git` header;
   (inside a file section) `index `/`similarity index `/`dissimilarity
   index `, `rename from `/`rename to `, `copy from `/`copy to `; a raw
   old/new file-header pair (consumes two lines at once, see step 2's
   exception); a hunk header (gated — see decision boundary below);
   anything else falls through unclassified (default zero value,
   `diffLineOther`).
5. **End of input** (`meat/diff.go:348-350`): if the scan ends still inside
   a hunk with known, unexhausted counts, one final "counts inconsistent"
   problem is raised, pointing at the last physical line — this is what
   catches a hunk that promised more lines than the diff actually contains
   before EOF.

### Algorithm 4 — hunk header count validation, precisely (four sites)

"Counts inconsistent" (`hunkProblemReported`, reset to `false` each time a
new `@@` header is parsed, `meat/diff.go:342`) is raised at exactly these
four points, each reporting only once per hunk:
1. Body has more lines than declared, discovered *after* both sides already
   hit zero (`meat/diff.go:244-246`).
2. Body has more lines on one specific side than that side declared,
   discovered mid-hunk (`meat/diff.go:266-288`, the per-sigil `valid`
   check).
3. Body ends (hits a non-hunk-source line) while either side still has
   undeclared remaining count (`meat/diff.go:296-298`).
4. The whole diff ends while still inside a hunk with nonzero remaining
   count on either side (`meat/diff.go:348-350`).

### Algorithm 5 — `parseHunkCounts` / `parseHunkRange` (`meat/diff.go:368-399`)

1. Split the header line on whitespace (`strings.Fields`). Reject (not
   `ok`) unless there are at least 4 fields and the first and fourth are
   exactly `"@@"` — anything after the fourth field (the "hunk section
   text", per `glossary.md`) is ignored here. `meat/diff.go:369-371`.
2. Parse the old-side field (must start with `'-'`) and the new-side field
   (must start with `'+'`) independently via `parseHunkRange`.
3. `parseHunkRange`: the field must be at least 2 bytes and start with the
   expected sign byte. If a comma is present, the count is the integer
   after the comma (must parse and be `>= 0`); the substring before the
   comma is validated as parsing as an integer too **but its value is
   discarded** — only well-formedness of the start-line number is checked,
   not its value. If there's no comma, the whole remainder must parse as an
   integer and the count defaults to `1`. `meat/diff.go:381-398`.
4. Both sides must independently succeed for `countsKnown` to be true.

A port must reproduce the "start-line field must parse as an integer but
its value is never used" behavior exactly: an `@@ -x,3 +1,3 @@`
(non-numeric start) must be treated as `countsKnown = false` even though the
*count* fields are both fine, because the start-field's own parse failure
fails the whole call.

### Algorithm 6 — `numberedDiff` (`meat/diff.go:126-137`)

1. Split into physical lines; empty input returns `""`.
2. Compute the gutter width as the decimal digit width of the *line count*
   (not of any byte length).
3. Emit each line as `"%*d|%s\n"` — a right-justified 1-based line number,
   `|`, the line's original text, then a literal `\n` (the gutter's own
   newline is always LF, regardless of the source line's own terminator,
   and it is appended even to the diff's last line even if that line had no
   terminator in the source).
4. Because `splitSourceLines` never emits a phantom trailing empty line
   (Algorithm 1, step 3), the gutter never gets a spurious final entry —
   this is the direct mechanism behind G5.

### Algorithm 7 — language tagging (`meat/diff.go:401-451`)

1. `diffHeaderLanguage` (for a `diff --git a/old b/new` line): split on
   whitespace, require ≥4 fields, then scan fields `[2:]` (i.e. both the
   `a/...` and `b/...` paths) left to right, keeping the **last**
   non-`Unknown` result from `pathLanguage`. Net effect: the destination
   (`b/...`) path's extension wins when recognized; the source path's
   extension is used only as a fallback when the destination extension is
   unrecognized (e.g. renamed to `/dev/null` or an extensionless name).
   `meat/diff.go:401-414`.
2. `fileMarkerLanguage` (for a `"--- path"`/`"+++ path"` line): take the
   substring after the fixed 4-byte prefix (marker + one space/tab), trim
   it, cut it at the first tab (git appends `\t<timestamp>` on some diff
   variants), then run `pathLanguage`. `meat/diff.go:416-425`.
3. `pathLanguage`: lowercase, strip surrounding `"` quote bytes, then match
   a fixed suffix table: `.go`→Go; `.py`/`.pyi`→Python; `.js`/`.jsx`/`.mjs`/
   `.cjs`/`.ts`/`.tsx`/`.mts`/`.cts`→JavaScript; `.rs`→Rust; `.c`/`.h`/
   `.cc`/`.hh`/`.cpp`/`.hpp`/`.cxx`/`.hxx`→C; `.java`/`.kt`/`.kts`→Java;
   anything else→Unknown. `meat/diff.go:427-451`.
4. **Decision boundary — double derivation:** for a git-style file section,
   language is first set from the `diff --git` line (step 1) and then
   *unconditionally re-derived* from the `---`/`+++` pair a few lines later
   (step 2, applied to old then new path, each only overriding when
   non-`Unknown`) once that pair is reached. Both derivations use the
   identical "prefer destination, fall back to source" rule, so for
   ordinary files (including same-extension renames) the second
   computation reproduces the first. It only has a chance to visibly matter
   when the destination side of the `---`/`+++` pair is unrecognized (e.g.
   `+++ /dev/null` on a deletion) — in which case the *old*-path-derived
   language from that second computation survives, which was already what
   the first computation would have produced from the `diff --git` line's
   own fallback rule. No case was found where the two computations disagree
   in their final result.

### `diffLineKind` — full enumeration (`meat/diff.go:22-39`)

| Kind | Assigned when | Cite |
|---|---|---|
| `diffLineOther` (zero value) | Default for anything not explicitly matched below: blank lines, commit-message/mail-body prose, unrecognized extended-header lines (see decision boundary below), preamble/trailer text. | `meat/diff.go:25,344-346` |
| `diffLineHeader` | A `diff --git ` line. | `meat/diff.go:310-312` |
| `diffLineIndex` | Inside a file section, a line starting with `index `, `similarity index `, or `dissimilarity index `. | `meat/diff.go:313-315` |
| `diffLineRenameFrom` / `diffLineRenameTo` | Inside a file section, `rename from ` / `rename to `. | `meat/diff.go:316-321` |
| `diffLineCopyFrom` / `diffLineCopyTo` | Inside a file section, `copy from ` / `copy to `. | `meat/diff.go:322-327` |
| `diffLineMailSignature` | Line is exactly `"-- "` (three bytes). | `meat/diff.go:304-306,463-465` |
| `diffLineOldFile` / `diffLineNewFile` | A `---`/`+++` pair recognized structurally (outside a hunk, or via the hunk-exit recovery paths). Always assigned together, two lines at once. | `meat/diff.go:328-334,453-457` |
| `diffLineHunkHeader` | A line starting with `@@` that also either is inside a file section, or is exactly `"@@"`, or starts with `"@@ "` — see decision boundary below. | `meat/diff.go:335-343` |
| `diffLineHunkContext` | Inside a hunk, a line whose first byte is `' '`. | `meat/diff.go:358-360` |
| `diffLineHunkChange` | Inside a hunk, a line whose first byte is `'+'` or `'-'`. | `meat/diff.go:361-362` |
| `diffLineNoNewline` | Inside a hunk, a line exactly equal to `` `\ No newline at end of file` ``. | `meat/diff.go:231-233,254-256,467-469` |

**Gap in the enumeration, confirmed by grep:** extended git header lines for
mode changes (`old mode `, `new mode `, `deleted file mode `, `new file
mode `) and binary-file markers (`Binary files … differ`, `GIT binary
patch`) have no dedicated `diffLineKind` anywhere in the codebase — they
fall through to `diffLineOther`, indistinguishable from ordinary prose.
`chunk.md` G6's binary-file fixture works precisely because the whole
section is treated as "no hunks to split," not because binary markers are
recognized as such.

### Decision boundary: hunk header vs. everything else (`meat/diff.go:335`)

```
(inFileSection || text == "@@" || strings.HasPrefix(text, "@@ ")) && strings.HasPrefix(text, "@@")
```

A line is a hunk header if it starts with `@@` **and** (it's inside a
recognized file section, **or** it is the bare two-character string `"@@"`,
**or** it starts with `"@@ "` — two `@` then a space). Note the third
disjunct does not require `inFileSection`: a line starting with `"@@ "` is
classified as a hunk header even before any `diff --git`/file-header line
has been seen. See "Open questions" below for the consequence.

### Decision boundary: hunk source vs. genuine trailing file header (G3's mechanism, precisely)

Only reachable while `inHunk` is true and `countsKnown` is true: a body line
that reads exactly like a `---`/`+++` pair remains ordinary hunk source for
as long as `oldRemain > 0 || newRemain > 0` (checked implicitly — the
`isRawOldFileHeader` check that would reclassify it only runs in the
`oldRemain==0 && newRemain==0` branch, `meat/diff.go:230,240`). Once both
sides are exhausted, the same textual pattern is instead treated as the
start of the next file/hunk. When counts are *not* known at all
(`!countsKnown`), there is no "remaining" quantity to exhaust, so the
classifier takes the conservative alternative path: **any** raw old-file
header seen while inside such a hunk ends it immediately
(`meat/diff.go:224-229`), regardless of how much body has been seen.

### Decision boundary: file-id assignment for non-git (raw) multi-file diffs

`currentFileID` increments on every `diff --git` line unconditionally, but
on a raw `---`/`+++` pair only when `!gitFileSection`
(`meat/diff.go:203-204,208-210`). `gitFileSection` is set `true` by any
`diff --git` line and reset to `false` only by a mail signature
(`meat/diff.go:307-308`) — there is no other reset. This means: in a
git-style diff, the `---`/`+++` pair belonging to the file just announced by
`diff --git` correctly shares that file's id; in a bare, non-git unified
diff, each `---`/`+++` pair starts a new file id on its own.

## Invariants

- **Classification never changes after parsing; downstream never
  re-parses.** Verified by exhaustive grep: no file other than `diff.go`
  calls `analyzeDiff`/`splitSourceLines` and then mutates a `diffLayout`'s
  `kinds`/`fileID`/`hunkID`/`language`/`python` fields — every consumer
  (`editplan.go`, `chunk.go`, `imports.go`, `moves.go`, `python.go`,
  `elision.go`) only reads them. Breaking this (e.g. a downstream stage
  adjusting a line's kind after a plan is applied) would silently
  desynchronize every other stage's assumptions about that line, since they
  all index into the same layout by physical line number.
- **`analyzeDiff` performs no combined-diff gating itself.** Combined-diff
  rejection (G1) is entirely the job of `validateSupportedDiffLines`,
  called *before* `analyzeDiff` in every validation path
  (`diff.go:88-98`, `editplan.go:168-172`). Two call sites invoke
  `analyzeDiff` directly without a preceding `validateSupportedDiffLines`
  call: `elision.go:37,55-57` (`diffStats`/`retainedDiffStats`, used only
  for post-hoc reporting on diffs that reached `ElisionLine` after already
  passing through a successful `Abridge`) and `moves.go:441-443`
  (`detectedMovesInDiff`). `chunk.go:148-150` documents its own
  precondition explicitly in a comment: "`raw` must already have passed
  `validateSupportedDiff`." Breaking this invariant — calling `analyzeDiff`
  on unvalidated, combined-diff-containing text — does not crash; it
  produces a plausible-looking (and wrong) layout, because `analyzeDiff`'s
  own hunk-header gate (see decision boundary above) will accept `"@@@
  ..."` text as an (uncounted) ordinary hunk header whenever it appears
  inside a file section, silently treating the resolved/combined hunk's
  `+`/`-` lines as normal hunk source.
- **The no-newline marker's `markerOwner` link is set only when it
  immediately follows a line already classified as hunk source**
  (`isHunkSource(layout.kinds[i-1])`, `meat/diff.go:234,257`), not merely
  "the previous physical line." A marker following anything else (e.g.
  immediately after a hunk header, which cannot happen in a well-formed
  diff, or after another marker) gets `markerOwner == -1`. Downstream code
  (`imports.go:223`) uses this link to decide whether hiding a hunk-source
  row must also hide its trailing no-newline marker; an unlinked marker
  would be left behind, visibly orphaned.
- **The `+++` line of a raw file-header pair is stamped out-of-band**
  (Mechanism, Algorithm 3 step 2's exception). A port that assumes uniform
  per-physical-line tagging in a single pass will silently leave this
  line's `fileID`/`language`/`python` at their zero values unless it
  reproduces the two-line special case.

## Hazards

- **H1** — central here per `migration/HAZARDS.md`, which names `diff.go`
  explicitly as one of the concentration points. `splitSourceLines`'s
  line/terminator split (`meat/diff.go:72-83`) is the very first
  byte-consuming operation in the whole pipeline; every downstream byte
  budget is ultimately measured over text this function produced.
  `migration/HAZARDS.md` names "split-lines" explicitly as the first
  byte-slice utility the port needs — that utility *is* `splitSourceLines`.
  Within `diff.go` itself the byte operations are narrow and ASCII-anchored
  — `strings.IndexByte(text, '\n')` (`meat/diff.go:72`), fixed 3/4-byte
  prefix checks (`isFileMarker`, `meat/diff.go:459-461`;
  `fileMarkerLanguage`'s `line[4:]`, `meat/diff.go:420`), and single-byte
  sigil checks (`text[0]`, `meat/diff.go:268,358`) — all position-safe
  under either byte or UTF-16 indexing individually, *provided* the chosen
  indexing scheme is used consistently end-to-end. The actual risk is not
  internal to `diff.go`; it is that `diff.go`'s output (line boundaries,
  and `numberedDiff`'s gutter text) is the thing every downstream
  byte-budget check measures, so if the port represents `sourceLine.text`
  as a JS string and later measures it with `.length` instead of a UTF-8
  byte count, budgets silently drift on any non-ASCII diff content.
- **H14** — `fileMarkerLanguage` calls `strings.TrimSpace(line[4:])`
  (`meat/diff.go:420`) to strip padding before looking for a tab-separated
  timestamp. Per `migration/HAZARDS.md`, Go's `TrimSpace` includes U+0085
  (NEL) and excludes U+FEFF, the opposite of JS's `.trim()`. A path
  preceded/followed by one of those two codepoints (implausible for a
  git-generated `---`/`+++` line in practice, but not excluded by anything
  upstream) would trim differently, potentially shifting the path passed to
  `pathLanguage` and changing the detected language.
- Related but unregistered: `parseHunkCounts`/`diffHeaderLanguage` both use
  `strings.Fields` (`meat/diff.go:369,402`), which splits on Go's
  `unicode.IsSpace` set — a third, distinct whitespace definition from both
  H3's regex `\s` and H14's `TrimSpace` (it additionally includes U+0085
  like `TrimSpace`, but is a *split*, not a *trim*). This only matters if a
  hunk header or `diff --git` line ever contains non-ASCII whitespace
  between its fields, which normal git output does not produce; flagging
  for completeness rather than as an active risk.
- **H2/H3/H7/H13** — not applicable. `diff.go` does no rune-level
  iteration, no regex, no sorting, and no map iteration.

## Errors

- **Combined diff, header form:** `"combined diff on line %d is
  unsupported; use a normal first-parent or two-tree diff"`, 1-based line
  number. `meat/diff.go:111`. Raised by `validateSupportedDiffLines` for
  any `diff --cc ` or `diff --combined ` line, unconditionally (not gated
  on `inPatch`).
- **Combined diff, hunk form:** `"combined diff hunk on line %d is
  unsupported; use a normal first-parent or two-tree diff"`, 1-based line
  number. `meat/diff.go:118`. Raised only while `inPatch` is true and the
  line starts with `"@@@"`.
- **Hunk counts inconsistent:** `"hunk header on line %d has counts
  inconsistent with its body near line %d"` — first `%d` is the 1-based
  line of the `@@` header that made the claim, second is the 1-based line
  where the mismatch was detected (or the diff's last line, for the EOF
  case). `meat/diff.go:191-194`. Raised by `analyzeDiff` at exactly the
  four sites enumerated in Algorithm 4; collected into `layout.problems`
  rather than returned immediately, then joined at each call site
  (`meat/diff.go:94-96`, and equivalently in `editplan.go:173-174`,
  `chunk.go:153-154`, `moves.go:443-444`).
- All three error paths are pure rejections: none of them mutate or
  partially classify — the caller (`validateSupportedDiff`, `Abridge` via
  `meat.go:125`) returns the error to the caller without ever reaching the
  model, matching G1/G2's "never reaching the model" guarantee.

Ordering Go leaves unspecified: none found. `diff.go` contains no map
iteration, no sorting, and no concurrency — every classification decision
is a single deterministic left-to-right scan over physical lines, and the
one "keep the best candidate" pattern (`diffHeaderLanguage`'s
last-non-`Unknown`-wins loop over `fields[2:]`, `meat/diff.go:406-412`)
iterates a slice in fixed order, not a map. Nothing here is analogous to
`chunk.go`/`moves.go`'s sort-stability concerns (H7).

## Open questions

- **A bare two-`@` line (`"@@ ..."`, not the three-`@` combined-diff form)
  is classified as a hunk header wherever it appears, even in
  commit-message prose before any `diff --git` line** — the hunk-header
  gate's second disjunct (`strings.HasPrefix(text, "@@ ")`,
  `meat/diff.go:335`) does not require `inFileSection`.
  `validateSupportedDiffLines`'s combined-diff pre-pass only rejects
  `"@@@"` (three or more `@`), and only while `inPatch`; it does nothing
  about a plain `"@@ "` line, anywhere. Traced concretely: if such a line
  appears in preamble text, `analyzeDiff` opens a "hunk" with
  `countsKnown` almost certainly false (the fabricated header won't parse
  as `@@ -n,m +n,m @@`); every subsequent physical line that happens to
  start with `' '`, `'+'`, or `'-'` is then misclassified as
  `diffLineHunkContext`/`diffLineHunkChange` — plausible for the very
  common commit-message idiom of a `-`-prefixed bullet list — until a line
  is reached that doesn't start with one of those three bytes, which pops
  back out to structural classification via the generic fallthrough
  (`meat/diff.go:296-301`). This is confirmed reachable and deliberately
  dodged rather than fixed: `TestAbridge_AcceptsGitFormatPatch`
  (`meat/editplan_test.go:640`) constructs its commit-message fixture with
  the literal string `"@@@ this is commit prose"` (three `@`s)
  specifically — one `@` short of what would trigger this path, and the
  combined-diff pre-pass wouldn't even reject it outside a file section. No
  test uses a plain two-`@` prose line, so this classification behavior is
  currently unpinned by any guarantee. Whether this ever produces an
  externally visible wrong answer depends on whether anything reads
  `diffLineKind` for lines with `fileID == -1` (preamble); nothing in the
  current codebase appears to (chunk.go's preamble handling keys off
  `fileID`, not `kind`), but a port replicating adversarial-input behavior
  faithfully should know this quirk exists.
- **Mode-change and binary-marker lines have no dedicated kind** (see the
  `diffLineKind` table's "Gap in the enumeration" note) — they are
  indistinguishable from arbitrary prose (`diffLineOther`). No guarantee in
  `chunk.md`/`diff.md` constrains this beyond G6's "no hunks to split"
  behavior for a whole binary-marker section.
- **Quoted paths containing spaces** in a `diff --git "a/my file.go" "b/my
  file.go"` line would be split incorrectly by `strings.Fields` in
  `diffHeaderLanguage` (each quoted path becomes two fields), potentially
  feeding `pathLanguage` a fragment like `"a/my` instead of the full path.
  `pathLanguage`'s own quote-trimming (`strings.Trim(path, "\"")`) only
  strips a quote char at the very start/end of *whichever fragment it
  receives*, so a split-apart quoted path degrades gracefully rather than
  crashing, but this is untested and not analyzed further here.
- **Dead or unreachable code: none found.** Every function defined in
  `diff.go` has at least one production call site outside `diff.go` itself,
  or is called by another function in `diff.go` that does. Confirmed by
  grep across all non-`_test.go` files in `meat/`.
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
