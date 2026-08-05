# editplan

> Status: stage 1 ✅ | stage 2 ⬜
> Go sources: `meat/editplan.go`
> Go tests: `meat/python_golden_test.go` (byte-exact golden compilation), `meat/editplan_test.go` (50 tests, structural/replace/fold validation), `meat/meat_test.go` (1 cross-cutting aggregation guarantee)

## Purpose

`compileEditPlan` is the compiler from a proposed **edit plan** — remove /
replace / fold operations expressed in the raw diff's own line coordinates —
to the rendered **reading diff** a human reviews. It validates the plan's
structure before rendering, and it never trusts a caller's hiding decisions
for import-declaration lines: those are merged in automatically regardless of
what the plan says. See `glossary.md` for the shared vocabulary (edit plan,
remove, fold, replace, reading diff).

## Guarantees

G1. The python golden corpus's three raw fixtures (`django-526b1b414d8e`,
    `flask-c17f37939073`, `pytest-b4e846616cbb`) have exact, pinned
    changed-line counts, physical-row counts, and byte lengths: django
    178/329/14,468; flask 124/234/8,803; pytest 109/159/6,468. Summed across
    the corpus: 411 changed / 722 rows / 29,739 bytes.
    — `meat/python_golden_test.go:41-155,27-30`, asserted at
    `meat/python_golden_test.go:164-169,245-247`. Mechanism: `diffStats`
    `meat/elision.go:36-47` (counts `diffLineHunkChange` and `diffLineHeader`
    kinds via the diff layout classifier), `splitSourceLines`
    `meat/diff.go:66-86`.

G2. A plan whose only operation is removing the entire raw diff (`Remove:
    [{1, N}]`, `N` = total physical line count) is legal and compiles to an
    empty reading diff, for every fixture.
    — `meat/python_golden_test.go:179-181`. Mechanism: `compileEditPlan`
    `meat/editplan.go:155-157`; the render loop skips every hidden line
    `meat/editplan.go:399-401`; `validateRetainedStructure`
    `meat/editplan.go:669-734` permits this because no header or body is
    retained.

G3. A hand-authored plan fixture decoded from JSON must have non-nil
    `Remove`, `Replace`, and `Fold` slices even when a field is empty (all
    three golden fixtures have `"replace": []`) — Go's nil-vs-empty-slice
    distinction is load-bearing here, not incidental.
    — `meat/python_golden_test.go:182-188`, exact failure text `"golden plan
    arrays must be non-null"` (`meat/python_golden_test.go:187`). Structure:
    `editPlan{Remove, Replace, Fold}` `meat/editplan.go:51-55`.

G4. The golden plan for every fixture compiles against its raw diff without
    error.
    — `meat/python_golden_test.go:190-193`. Mechanism: `compileEditPlan` /
    `compileEditPlanMoves` `meat/editplan.go:155-165`, full validation
    pipeline `meat/editplan.go:166-382`.

G5. Compiling the golden plan yields an exact, fixed fold count per fixture:
    django 1, flask 1, pytest 2.
    — `meat/python_golden_test.go:194-196`. Mechanism: `computePlanStats`,
    `foldCount = len(state.folds)` `meat/editplan.go:522`. `state.folds` also
    absorbs compiler-owned Python-suite placeholder folds
    (`meat/imports.go:12-55`), but none of these three fixtures triggers one,
    so the count equals the plan's authored fold count exactly.

G6. Per-fixture visible-changed-row ceiling: `compiled.stats.visibleChanged`
    must not exceed django 89, flask 63, pytest 42. Aggregated across the
    corpus it must not exceed 194 — a check independent of, and in addition
    to, the per-fixture ceilings.
    — `meat/python_golden_test.go:197-199,31,248-250`. Mechanism:
    `computePlanStats` `meat/editplan.go:501-529` — counts un-hidden,
    un-folded `diffLineHunkChange` rows, plus one per `+`/`-`-marked fold (a
    context-only fold does not count).

G7. Per-fixture visible physical-row ceiling:
    `len(splitSourceLines(compiled.smartDiff))` must not exceed django 155,
    flask 120, pytest 65; the corpus sum must not exceed 340.
    — `meat/python_golden_test.go:200-203,32,248-250`. Mechanism:
    `splitSourceLines` `meat/diff.go:66-86` applied to the rendered output.

G8. Per-fixture visible byte ceiling: `len(compiled.smartDiff)` must not
    exceed django 6,685, flask 5,037, pytest 2,615 bytes; the corpus sum must
    not exceed 14,337 bytes.
    — `meat/python_golden_test.go:204-206,33,248-250`.
    (H1: these are Go byte lengths. A port must measure UTF-8-encoded byte
    length, not UTF-16 code units or `.length` — though these three fixtures
    are pure ASCII, so the distinction is never actually stress-tested here.)

G9. Compiled output retains a fixed set of exact substrings per fixture
    ("semantic anchors" — the contract, transformation logic, representative
    call sites, and outcomes the fixture is protecting; rationale in
    `meat/testdata/python/README.md:11-13`): django 14 strings, flask 17,
    pytest 20.
    — asserted at `meat/python_golden_test.go:222-226`; failure text `"golden
    missing semantic anchor %q"` (`:224`). Examples: django
    `` `+def split_header_value(value, sep=","):` `` (`:53`); flask `` `+    def
    session(self) -> SessionMixin:` `` (`:90`); pytest `` `+    @contextlib.contextmanager` `` (`:126`).

G10. Compiled output excludes a fixed set of exact substrings per fixture
     ("folded noise" — mechanical rename duplicates, changelog prose, and
     the pre-mandatory-removal import-line text itself): django 14 strings,
     flask 10, pytest 10.
     — asserted at `meat/python_golden_test.go:227-231`; failure text
     `"golden retained folded noise %q"` (`:229`). Example: django
     `"from django.utils.cache import"` (`:73`) — proving the import merge,
     not plan content, removed those lines (see `imports.md` G1).

G11. The compiled reading diff is byte-for-byte identical to the checked-in
     golden fixture, for every case — no trailing-whitespace or line-ending
     tolerance.
     — `meat/python_golden_test.go:233-242`; mismatch text `"reading diff
     does not match %s; run UPDATE_GOLDEN=1 go test ./meat -run
     TestPythonGoldenCommits"` (`:241`). Harness mechanics in
     `test-infrastructure.md`.

### Fold rendering and stats (`editplan_test.go`)

G12. A fold's rendered output is exactly: the shared diff marker of its
     folded lines, their common leading whitespace, the literal `...`, and
     the line ending of the fold's last original line — even across CRLF
     endings, tab indentation, and a missing final newline.
     — `meat/editplan.go:391-397` (render), `meat/editplan.go:421-470`
     (`prepareFold`, indent via `leadingWhitespace`/`commonPrefix` at
     452-458, eol at 468), pinned by `meat/editplan_test.go:18-35` (LF,
     spaces, `def rebuild():` fold) and `meat/editplan_test.go:37-51` (CRLF,
     tabs, no trailing newline).

G13. Plan statistics distinguish four counts over a hunk's `+`/`-` lines:
     `rawChanged` (every change line), `foldedChanged` (change lines
     subsumed into a fold), `removedChanged` (change lines hidden by a
     plain removal), and `visibleChanged` (unhidden, unfolded change lines
     plus one for every non-context fold, since each such fold itself
     renders as one visible line). `foldCount` is the number of folds
     actually committed.
     — `computePlanStats` `meat/editplan.go:501-529`, pinned by
     `meat/editplan_test.go:32-34` (5 raw / 3 visible / 3 folded / 1 fold).

### Fold structural validation (language-agnostic)

G14. A fold must span at least two lines; `StartLine == EndLine` is
     rejected: `"fold[%d]: want at least two lines in an inclusive range,
     got %d-%d"`.
     — `meat/editplan.go:422-424`, pinned by `meat/editplan_test.go:364`
     (needle "at least two").

G15. Every line in a fold range must carry the same diff marker; a range
     mixing `-` and `+` is rejected: `"fold[%d]: mixed diff markers %q and
     %q in range %d-%d"`.
     — `meat/editplan.go:438-442`, pinned by `meat/editplan_test.go:365`
     (needle "mixed diff markers").

G16. Every line in a fold range must be hunk source (context or change); a
     range touching a structural line such as the `@@` header is rejected:
     `"fold[%d]: line %d is not source inside one diff hunk"`.
     — `meat/editplan.go:433-436`, pinned by `meat/editplan_test.go:366`
     (needle "not source").

G17. A fold cannot overlap a line already hidden by an explicit `remove` or
     an earlier fold; the message names which: `"fold[%d]: overlaps remove
     at line %d"` or `"...overlaps fold at line %d"`.
     — `meat/editplan.go:237-251` (kind selection 245-248, message 249),
     pinned by `meat/editplan_test.go:367-368` (cases "remove overlap",
     "fold overlap").

G18. A `replace` may not target a line a fold has already hidden:
     `"replace[%d]: line %d is also folded"` (or `"...also removed"` when
     hidden by a plain removal).
     — `meat/editplan.go:297-304`, pinned by `meat/editplan_test.go:369`
     (case "replace overlap", needle "also folded").

### Elision-projection mechanism

G19. `isElisionProjection(old, new)` accepts `new` as a valid placeholder
     rewrite of `old` iff: (a) `new` is `old` with zero or more spans
     replaced by a placeholder — exactly three ASCII dots `...` or one `…`
     rune; (b) at least one placeholder is present; (c) each placeholder
     must stand for at least one omitted character in `old`; (d) two
     placeholders may never sit adjacent to each other; (e) a run of dots
     must be exactly three — a run of four (or one/two) is never treated as
     a placeholder at all, so the whole match fails.
     — `isElisionProjection` `meat/editplan.go:555-557` →
     `compileElisionProjection` `meat/editplan.go:571-632` (dot-run strict-3
     rule 598-601, adjacent-wildcard rejection 607-611, "at least 1 char"
     via `.+` at 616, zero-wildcard rejection 627-629), pinned by
     `meat/editplan_test.go:390-409` (all 9 table cases, including
     `("x","....")` → false and a four-dot run treated as literal text
     rather than a placeholder).

G20. A replacement's `Old` need not span the whole line — it is spliced in
     place at its unique matched offset, leaving the rest of the line
     untouched.
     — `uniqueSubstringIndex` `meat/editplan.go:542-553`,
     `applyPlannedReplacements` `meat/editplan.go:413-419`, pinned by
     `meat/editplan_test.go:411-424` (`.sshKeyID` elided from
     `rd.sshKeyID`, LHS preserved) and `meat/editplan_test.go:882-892`
     (context-line replacement, confirming context lines are valid
     replacement targets too, via `isHunkSource` `meat/diff.go:158-160`).

G21. Multiple replacements on one line are allowed when their matched spans
     are disjoint; each is matched and applied against the original line
     body (not the result of a prior replacement on that line), then
     spliced together right-to-left.
     — `applyPlannedReplacements` `meat/editplan.go:413-419`,
     overlap/sort grouping `meat/editplan.go:353-362`, pinned by
     `meat/editplan_test.go:856-869`.

G22. Two replacements on one line whose matched spans overlap — including
     overlapping (not just nested) occurrences — are rejected as
     ambiguous, with `"span overlaps"` in the message.
     — `meat/editplan.go:353-362` (message at 357), `uniqueSubstringIndex`'s
     one-byte-forward rescan `meat/editplan.go:546-551`, pinned by
     `meat/editplan_test.go:101-110,845-854,871-880` (Python and Go
     fixtures, confirming the rule is language-agnostic).

### Replace validation (each named failure mode, exact messages)

G23. Table of rejected replacements, pinned by
     `meat/editplan_test.go:815-843` (`TestApplyEditPlan_RejectsInvalidReplacements`):

     | Case | Rule | Message | Impl |
     |---|---|---|---|
     | outside diff | `Line` outside `1..len(lines)` | `"replace[%d]: line %d is outside the diff (1-%d)"` | `meat/editplan.go:286-289` |
     | empty old | `Old == ""` | `"replace[%d]: old must not be empty"` | `meat/editplan.go:305-308` |
     | metadata / hunk header | target line isn't hunk source | `"replace[%d]: line %d is not a source line inside a diff hunk"` — fires even when `Old`'s text literally occurs in that metadata line | `meat/editplan.go:325-328` |
     | removed line | target also in `Remove` | `"replace[%d]: line %d is also removed"` | `meat/editplan.go:297-304` |
     | missing/ambiguous old | `Old` found 0 or 2+ times | `"...old must occur exactly once after the diff marker on line %d"` | `meat/editplan.go:341-345`, `uniqueSubstringIndex` |
     | newline old / new | embedded newline | `"%s must be a single printable line"` | `validateSingleLineText` `meat/editplan.go:647-664` |
     | invented new | `New` not an elision projection of `Old` | `"...new must match all of old, with every omitted span represented by ... or …"` | `meat/editplan.go:321-324` |
     | no-op new | `New == Old` | `"replace[%d]: new must elide some part of old"` | `meat/editplan.go:317-320` |

     Also bounded by `maxReplacementBytes` (see Constants).

### Remove validation

G24. A `remove` range is rejected when `StartLine < 1` or `StartLine >
     EndLine` (`"remove[%d]: invalid inclusive range %d-%d"`), when
     `EndLine` exceeds the diff's line count (`"...line %d is past end of
     diff (%d lines)"`), or when it overlaps an earlier remove range in the
     same plan (`"...overlaps an earlier range at line %d"`) — and exactly
     one overlap diagnostic is produced per offending range regardless of
     how many lines the overlap spans (verified against a 1000-line
     fixture with a 701-line overlap → exactly one message).
     — `meat/editplan.go:187-213` (messages 189, 194, 211; `firstOverlap`
     captured once at 201-203), pinned by
     `meat/editplan_test.go:495-514,516-532`.

G25. All structural-retention violations across the whole diff are
     collected into one aggregated error, not short-circuited at the first
     failure — demonstrated with two independent files each missing their
     retained diff header, producing two "diff header" messages in one
     error.
     — `validateRetainedStructure` accumulates into `problems` across its
     full loop `meat/editplan.go:670-729`, joined by `joinEditPlanErrors`
     `meat/editplan.go:531-540`, pinned by `meat/editplan_test.go:534-550`.

### Retained-structure / orphaned-structure rules

All pinned by `meat/editplan_test.go:585-609`
(`TestApplyEditPlan_RejectsOrphanedStructure`, 9 named subtests over the
shared `editableDiff` fixture) unless noted; mechanism
`validateRetainedStructure` `meat/editplan.go:666-733`:

G26. A file's `diff --git` header must be retained exactly when any
     meaningful content of that file section is retained (and vice versa)
     — `"remove: diff header on line %d must be retained exactly when its
     file body is retained"`. — `meat/editplan.go:680-691`.

G27. The paired `---`/`+++` file-marker lines must be removed or retained
     together — `"...---/+++ headers on lines %d-%d must be removed or
     retained together"` — and must be retained exactly when their file
     body is retained. — `meat/editplan.go:692-703`.

G28. A hunk's `@@ ... @@` header must be present whenever any context or
     change line of that hunk is retained — `"...retained context/change
     lines require hunk header on line %d"`. — `meat/editplan.go:716-723`.

G29. A hunk header must be retained exactly when the hunk has at least one
     retained change (`+`/`-`) line — retained context alone does not
     justify a retained header, and a retained header with zero retained
     changes is likewise rejected — `"...hunk header on line %d must be
     retained exactly when its hunk has a retained change"`. —
     `meat/editplan.go:724-727` (`anyRetainedHunkChange`
     `meat/editplan.go:763-770`).

G30. `rename from`/`rename to` and `copy from`/`copy to` metadata pairs must
     be removed or retained together — `"...rename metadata on lines %d-%d
     must be removed or retained together"` / `"...copy metadata..."`.
     — `meat/editplan.go:704-715`, pinned by `meat/editplan_test.go:552-571`
     (needle "must be removed or retained together").

G31. A file section that removes all hunk content but leaves only
     non-meaningful metadata retained (e.g. `diff --git` + `index ...`,
     with no `---`/`+++`/hunk survives) is rejected: `"...retains only
     metadata; remove the complete file section"`.
     — `meat/editplan.go:679-691` (`anyRetainedMeaningful` excludes
     `diffLineIndex`/`diffLineNoNewline`, `meat/editplan.go:736-743`),
     pinned by `meat/editplan_test.go:573-583`.

G32. A `\ No newline at end of file` marker is tied to its immediately
     preceding source line ("owner"); removing the owner while the marker
     survives is rejected (`"remove: no-newline marker on line %d requires
     its source line"`), but removing owner and marker together is valid.
     — `meat/editplan.go:671-677` (marker→owner link built in `analyzeDiff`,
     `meat/diff.go:231-236,254-259`), pinned by
     `meat/editplan_test.go:766-784`.

G33. A complete hunk (header + all its lines) may be removed entirely while
     the rest of its file survives, and a complete file (or the entire
     diff) may be removed entirely — both vacuously satisfy every
     pairing/retention rule and, for whole-diff removal, yield an empty
     string.
     — `meat/editplan.go:669-733` (every rule is conditioned on something
     being represented), pinned by `meat/editplan_test.go:444-462` (identity
     and full-diff removal→`""`) and `meat/editplan_test.go:611-634` (one
     hunk of two removed, then the whole file).

### Coordinates, rendering, and multi-file diffs

G34. All `remove`/`replace`/`fold` line coordinates are physical line
     numbers into the original, unmodified diff text; removing earlier
     lines never shifts the numbering later operations in the same plan
     use.
     — the whole compiler operates over one fixed
     `lines := splitSourceLines(raw)` slice `meat/editplan.go:168`, indexed
     directly by every operation, pinned by `meat/editplan_test.go:464-476`
     (line 6 removed, but a replace on line 7 still matches against the
     untouched original).

G35. A hunk's `@@ -old,oldCount +new,newCount @@` header text is never
     recomputed to reflect hidden/replaced/folded lines — the compiled
     "smart diff" is a reading view over the original text, not a
     machine-appliable patch.
     — render loop `meat/editplan.go:387-408` only ever hides, folds, or
     emits a header verbatim, pinned by `meat/editplan_test.go:426-442`
     (header unchanged after removing a `+` line from the hunk).

G36. Line endings are preserved per physical line (LF vs CRLF), and a final
     source line with no trailing newline renders with no trailing newline
     — even when that line is a replacement target.
     — `splitSourceLines` `meat/diff.go:66-86` (per-line `eol`, default
     `""` at 74), render loop `meat/editplan.go:406-407`, pinned by
     `meat/editplan_test.go:478-493`.

G37. A `replace` targeting any part of a `---`/`+++` file-marker line's
     text is rejected — the "not a source line inside a diff hunk" rule
     (G23) applies identically in a concatenated unified diff with no
     `diff --git` separators between files, regardless of whether the
     intervening `@@` header is well-formed, bare, or has different
     self-consistent counts. A complete second file section can
     nonetheless be removed wholesale from such a diff, leaving the first
     file's content intact — file-section boundaries are recognized from
     the `---`/`+++` pairing itself (`isRawOldFileHeader`
     `meat/diff.go:453-457`, used at `meat/diff.go:207-218`), not only from
     a preceding `diff --git` line.
     — pinned by `meat/editplan_test.go:786-813`
     (`TestApplyEditPlan_ProtectsConcatenatedUnifiedDiffHeaders`).

G38. `compileSubmission` validates the summary and the edit plan
     independently; when both are invalid, both failures are aggregated
     into one returned error (neither suppresses the other).
     — `meat/editplan.go:138-151` (both checks always attempted, joined at
     148), pinned by `meat/editplan_test.go:906-914`.

G39. A summary is rejected when empty or all-whitespace, when it contains
     an embedded carriage-return or newline, an ANSI escape byte, a
     Unicode line-separator or paragraph-separator character, or any other
     control character (tab excepted); this holds independent of whether
     the plan itself is otherwise valid.
     — `validateSummary` `meat/editplan.go:634-645`,
     `validateSingleLineText` `meat/editplan.go:647-664` (forbidden-rune
     list 655-658), pinned by `meat/editplan_test.go:916-923` (6 bad values,
     including an embedded ANSI color escape and a Unicode line separator).

### Cross-cutting (from `meat_test.go`)

G40. When a submitted plan has multiple, independently-detectable
     structural errors (e.g. an out-of-range `remove` range and an
     out-of-range `replace` line in the same submission), the toolbox
     reports all of them together in one aggregated error, not just the
     first — the corrective turn sees every problem at once rather than
     discovering them one at a time.
     — `meat/meat_test.go:498-539` (`TestAbridge_InvalidEditPlanRetries`,
     one tool-error result whose text contains both `"remove[0]"` and
     `"replace[0]"`). Mechanism: per-item validation appends to a `problems
     []error` slice (`meat/editplan.go:187-210` for `remove`, `286-288` for
     `replace`), joined by `joinEditPlanErrors` (`meat/editplan.go:531-539`).

## Constants

See `constants.md` for `maxReplacementBytes` and `maxSummaryBytes`.
`python_golden_test.go` exercises neither (no fixture uses `replace`, and
`compileEditPlan` — as opposed to `compileSubmission` — takes no summary),
but `editplan_test.go` now exercises both at least partially:
`maxReplacementBytes` bounds the replace-validation table (G23);
`maxSummaryBytes`'s generic single-line-text rules are exercised by G39,
though not the specific byte-length-over-500 branch (see Open questions).

## Open questions

- **`isComposedElisionProjection`** (`meat/editplan.go:562-564`) has zero
  call sites anywhere in the repository (verified by repo-wide grep) and no
  test exercises it. Its doc comment describes recognizing adjacent
  placeholders after multiple replacements are combined, but since nothing
  calls it, its behavior is unconfirmed by any test.
- **Move detection and symmetry are entirely untested by `editplan_test.go`
  itself** — `compileEditPlanMoves` unconditionally runs move detection and
  symmetry validation on every call, and `compiled.moves` is part of every
  result, but no fixture in this file supplies a duplicated block that
  would trigger it. See `moves.md` for the file that does.
- **Mandatory Python-import interactions are entirely untested by
  `editplan_test.go`** — no fixture contains an `import` statement. In
  particular the "fold crosses automatically-removed import rows" error
  path (`meat/editplan.go:230`) and the "import-only fold is redundant,
  silently accepted" path (`meat/editplan.go:233-236`) are not exercised
  here; see `imports.md` and `chunk.md` G33 for where import interactions
  are covered.
- **`maxSummaryBytes`'s length-check branch is not directly pinned** — G39's
  cases test emptiness and forbidden characters, but no case supplies a
  summary literally over 500 bytes to hit `meat/editplan.go:638-640`
  specifically.
- No chunking/splitting is exercised in `editplan_test.go`
  (`splitDiffForAbridging`, `fitsSingleRun`, multi-chunk move-mapping) —
  coverage for that comes from `chunk_test.go`, see `chunk.md`.
