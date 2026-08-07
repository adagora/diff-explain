# editplan

> Status: stage 1 ✅ | stage 2 ✅
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

## Mechanism

`compileEditPlanMoves` (`meat/editplan.go:165-411`) is the single engine behind every public entry point: `compileEditPlan` (`:155-157`, `detect=true`, no provided moves), `compileSubmission`/`compileSubmissionMoves` (`:134-151`, adds summary validation), and the live-agent paths `toolbox.previewPlan`/`toolbox.submit` (`meat/tools.go:210-221,224-243`), which pass a chunk-precomputed `provided []detectedMove` and `detect=false`. Per the function's own doc comment (`meat/editplan.go:159-164`): move uniqueness is a whole-diff property — a block occurring three times globally is deliberately ambiguous — so a chunk seeing only two of those three occurrences would wrongly treat them as a move if it ran detection locally. Chunk compilation therefore disables detection and instead enforces exactly the moves the splitter already resolved against the whole diff and mapped into chunk coordinates. (`chunk.md` is not yet stage-2, so the chunk-side mapping mechanism itself is not re-described here; `moves.md` G3-G7 covers it from the moves.go side.)

### 0. The overall pipeline (`compileEditPlanMoves`, `meat/editplan.go:165-411`)

In exact sequential order:

1. **Parse + layout** (`:168-175`): `lines := splitSourceLines(raw)`, `validateSupportedDiffLines(lines)` (hard error, returns immediately — not aggregated with anything else), `layout := analyzeDiff(lines)`; if `layout.problems` is non-empty, return immediately via `joinEditPlanErrors` — no plan validation runs at all against a diff whose own structural parse failed.
2. **Move set**: `moves = provided`, or `detectExactMoves(lines, layout)` if `detect` (`:176-179`).
3. **Mandatory-import computation** (`:180-182`): `mandatoryImportRemovalPlan` → `mandatoryRemovalMask` → `applyMandatoryMovePrecedence(moves, mandatoryHidden)` (fully specified in `imports.md`/`moves.md`; not redescribed here).
4. **`planState` init** (`:183-184`): `newPlanState(len(lines))`, then `copy(state.hidden, mandatoryHidden)` — the mandatory mask seeds `hidden` before any model operation is applied.
5. **Remove-range application** (`:185-213`) — see §3.
6. **Fold preparation/application** (`:214-260`) — see §4.
7. **Gate A — `if removalsValid && foldsValid`** (`:261-282`): only inside this gate do `addMandatoryPythonSuitePlaceholders` (mutates `state`), `validateMoveSymmetry`, `stateWithMandatoryImportsRepresented` (builds `pythonValidationState`), and all four Python structural validators (`validateHiddenPythonOwners`, `validateHiddenPythonBoundaries`, `validateHiddenReferences`, `validatePythonSuiteSkeleton`) run.
8. **Replace validation** (`:284-352`) and **replacement-overlap check** (`:353-362`) — always run, ungated by `removalsValid`/`foldsValid`. See §5-§6.
9. **Gate B — `if removalsValid && foldsValid && replacementsValid && len(problems) == 0`** (`:363-367`): only here does `validateMoveReplacementSymmetry` run.
10. **Gate C — `if removalsValid && foldsValid && replacementsValid`** (`:368-382`, no `len(problems)==0` term): `validateTripleQuoteParity`, `validatePythonDelimiterBalance`, `validatePythonBackslashContinuations`, `completeMandatoryImportFraming`, `validateRetainedStructure`.
11. **Aggregate-and-fail** (`:383-385`): if `problems` is non-empty at this point, return `joinEditPlanErrors(problems)`.
12. **Render loop** (`:387-408`) — see §7. `computePlanStats` (`:409`) — see §8.

**Which gate guards what, precisely:**

| Gate | Condition | Guards |
|---|---|---|
| A | `removalsValid && foldsValid` | placeholder synthesis, move symmetry, all 4 Python structural validators |
| B | `removalsValid && foldsValid && replacementsValid && len(problems)==0` | move-replacement symmetry only |
| C | `removalsValid && foldsValid && replacementsValid` | triple-quote parity, delimiter balance, backslash continuations, import-framing completion, retained-structure |

**`replacementsValid` is not "all replacements were individually valid."** It is initialized `true` at `:285` and is *only* ever set `false` inside the overlap-check loop at `:358` — none of the nine individual per-replacement rejection branches in the validation loop (`:287-345`) touch it. So a plan containing e.g. one out-of-range `replace` (a `problems` entry, but no touch of `replacementsValid`) still passes Gate C in full, as long as no remove/fold/overlap problem exists — Gate C's Python/retained-structure checks still run and can still contribute additional, independent error messages to the same aggregated result. Gate B is the only gate that also requires `len(problems)==0`, so move-replacement symmetry is the most conservatively gated check in the file — it never runs unless *everything* checked so far, of any kind, was clean.

**Cost/completeness consequence of Gate A** (this is the important one — see Uncovered mechanism below): an invalid `remove` range or an invalid `fold` suppresses move symmetry, all four Python structural validators, move-replacement symmetry, triple-quote parity, delimiter balance, backslash-continuation checking, mandatory-import-framing completion, *and* `validateRetainedStructure` — i.e. essentially the entire rest of the file's validation surface. Only the per-item remove/fold checks themselves, the per-item replace checks, and the replace-overlap check are unconditional.

### 1. Elision-projection mechanism — `compileElisionProjection`/`isElisionProjection`/`matchesElisionProjection` (`meat/editplan.go:555-632`) — **H3a, central hazard**

**What the pattern means**, stated without regex vocabulary: `new` is tokenized into an alternating sequence of **literal** spans and **wildcard** tokens (see tokenization below). `old` is accepted iff `old` can be decomposed, left to right, into: the first literal span as an exact prefix, the last literal span as an exact suffix, and every other literal span occurring **in order**, with **at least one character** of `old` between each pair of adjacent literal spans (the wildcard gap). This is exactly the "leftmost greedy two-pointer scan" HAZARDS.md's H3a prescribes for the port: walk `old` and the literal-span list together, matching each literal span's exact bytes at the current cursor (after skipping ≥1 byte for every wildcard gap since the previous literal), and fail if any literal can't be found positioned correctly or a trailing required gap has zero width.

**Tokenizing `new`** (`meat/editplan.go:571-624`): `new` is decoded to `newRunes := []rune(new)` (`:572`, genuinely rune-aware — see Hazards H2) and walked left to right:
- A `…` (U+2026) rune is one wildcard token, consuming exactly one rune (`:589-591`).
- A maximal run of ASCII `.` runes of length `run` is inspected (`:592-597`): if `run < 3`, it is **not** a wildcard at all — those dots are ordinary literal characters, folded into the current literal span. If `run >= 3`: under `strict=true`, the run must be **exactly** 3, or the whole call fails outright — `return nil, false` (`:598-601`) — a run of 4+ dots under `strict=true` is a hard rejection of the entire `new` string, not "literal text" and not "one wildcard plus literal dots." Under `strict=false`, any run of 3 or more dots is accepted as one wildcard token regardless of its exact length (a run of 4, 5, … dots is still just one wildcard) — verified: the `strict && run != 3` guard is the *only* place run-length is checked, and it only fires in strict mode.
- Anything else is appended to the current literal-span buffer (`:621-623`).

**Adjacent-wildcard handling** (`:606-619`) — this is the strict/non-strict behavioral fork:
- If the *previous* token was also a wildcard (`lastWasWildcard`) and `strict` is true: `return nil, false` — two adjacent placeholder tokens are a hard rejection in strict mode (this is what `isElisionProjection`/`matchesElisionProjection(..., true)` — the single-replacement validator — always uses).
- If the previous token was a wildcard and `strict` is false: `continue` with **no** new wildcard emitted — the second (and any further) adjacent wildcard token is silently *merged* into the one already open. Concretely: `i` has already been advanced past the current token by the tokenizer *before* this check runs, so `continue` costs nothing structurally; it just skips `flushLiteral()`, skips writing a second `.+`, skips `wildcards++`, and leaves `lastWasWildcard` at `true`. Net effect: N consecutive wildcard tokens (any mix of `…` and valid dot-runs) collapse to exactly one `.+` gap and count as `wildcards += 1`, not `N`. This is the mechanism `isComposedElisionProjection`/`matchesElisionProjection(..., false)` was written for (see Uncovered mechanism — it has zero call sites).
- Otherwise (not adjacent to a prior wildcard): `flushLiteral()` (emits the pending literal span, quoted), append the "at least one character" gap, `wildcards++`, set `lastWasWildcard = true`.

**"At least one character" gap** — the code comment at `:614-615` states it directly: "Every visible ellipsis must stand for at least one omitted character. This prevents silent changes such as `!allowed → allowed`." Mechanically this is why the gap between literals is a `.+` (require ≥1 character) rather than a `.*` (allow zero): a zero-width gap would let `new`'s ellipsis silently stand for *nothing omitted*, meaning `New` could differ from `Old` by a genuine content change (e.g. deleting a leading `!`) while still superficially "matching" via an empty ellipsis span. For the literal-scan port: at every wildcard gap, the two-pointer scan must require the next literal's start position to be **strictly past** (not equal to) the position right after the previous literal's end.

**Zero-wildcard rejection** (`:627-629`): if the tokenizer found no wildcard token at all, `compileElisionProjection` returns `(nil, false)` unconditionally — no elision is ever valid without at least one placeholder. This is deliberately a *second*, independent line of defense beyond the `New == Old` no-op rejection already applied upstream (`:317-320`). The two checks catch disjoint failure shapes: `New == Old` catches only the literal-identity case (and, subtly, that check runs on raw Go strings *before* `new` is ever tokenized, so it doesn't matter that a `new` containing an incidental, pre-existing 3-dot run in `old`'s own text would otherwise tokenize as a wildcard and could spuriously "match" — the identical-string case never reaches elision-projection matching at all). `wildcards == 0` catches every *other* string where `New != Old` but the model simply rewrote, substituted, reordered, or silently truncated text without marking the omission with `...`/`…` at all — e.g. `old="select * from x"`, `new="select * FROM x"` (a case change, zero wildcards, `New != Old`) or `old="hello"`, `new="hell"` (a bare truncation with no placeholder, zero wildcards, `New != Old`). Both pass the no-op check but are correctly rejected by the zero-wildcard check — this is the check doing the real "you may only omit text, never rewrite it" enforcement; the no-op check is a narrow special case of what this one already covers.

**Anchoring**: `pattern.WriteByte('^')` is the very first byte written (`:574`, before any token is processed) and `pattern.WriteByte('$')` is the very last byte written (`:626`, after all tokens and the final `flushLiteral()`), and every literal span is escaped via `regexp.QuoteMeta` (`:582`) — an exact-byte match, never a sub-pattern. So the whole construction is always a full-string match: `^<literal1><gap><literal2><gap>...<literalN>$`. `matchesElisionProjection` (`:566-569`) calls `re.MatchString(old)` — this operates on `old`'s raw UTF-8 bytes; Go's `regexp` engine does not rune-decode a `string` argument before matching (no `[]rune(old)` conversion anywhere in this file — verified by grep), so the matching side is a pure byte-wise question, and because the pattern is fully anchored, "does `old` match this pattern" is exactly and only "does the two-pointer literal-scan succeed," never a partial/substring match.

**Equivalence argument for the port** (`isElisionProjection(old: string, new: string): boolean`, zero regex):
1. Tokenize `new` into `(literals[], wildcardCount)` exactly as above (codepoint-aware — see Hazards H2), applying the strict-mode bail-outs as **immediate `false` returns** rather than "pattern failed to compile": a dot-run of length ≥3 that isn't exactly 3 → `false`; two adjacent wildcard tokens → `false`; zero wildcards after tokenizing all of `new` → `false`.
2. If tokenization succeeded, walk `old` and `literals[]` together: require `old` to start with `literals[0]` (byte-exact); advance the cursor past it; for each subsequent literal, require it to occur starting at some position **strictly greater than** the cursor (i.e. skip at least one byte first), take the **leftmost** such occurrence (greedy-leftmost, matching RE2's own leftmost-match semantics for this unambiguous pattern shape — since the gaps are unconstrained `.+`, any position where the next literal occurs is equally valid for the *existence* question, so leftmost vs. any-valid-position make no difference here); advance the cursor past it. Require the *last* literal's occurrence to end exactly at `old`'s end (suffix match).
3. If every literal is found in order with the required non-empty gaps and the last one ends exactly at `old`'s end, return `true`; any failure at any step returns `false`.

This reproduces `compileElisionProjection`'s rejection cases as scan-time bail-outs, and reproduces the anchored-match semantics as an explicit prefix/suffix/ordered-occurrence walk — with zero regex construction and therefore zero catastrophic-backtracking exposure regardless of how the model-authored `new` (bounded only at `maxReplacementBytes = 4 << 10`, `meat/editplan.go:21`) is shaped.

### 2. `planState`'s parallel arrays and `represented()` (`meat/editplan.go:84-106`)

- **`hidden []bool`** — true iff this physical line contributes no rendered text of its own: set by mandatory import hiding, by a model `remove`, or by being any line (first or not) of a committed fold.
- **`folded []int`** — `-1` by default (`newPlanState`, `:97-100`); for a line belonging to fold index `k`, set to `k` for **every** line in that fold's range, not only the first (`:256-259`).
- **`foldAt []int`** — `-1` by default; set to the fold's index **only on the fold's first source line** (`:255`). This is the render loop's own gate for "emit the `...` row here."
- **`folds []plannedFold`** — append-only, indexed by fold index; also absorbed by `addMandatoryPythonSuitePlaceholders` for compiler-synthesized placeholders (see `imports.md` Algorithm 8).

Every line index therefore falls into exactly one of: visible (`hidden[i]==false`); hidden by plain removal (`hidden[i]==true, folded[i]==-1`); a fold's non-first line (`hidden[i]==true, folded[i]>=0, foldAt[i]==-1`); a fold's first line (`hidden[i]==true, folded[i]>=0, foldAt[i]>=0`).

**`represented(line)` — precise semantics, verified byte-for-byte** (`:104-106`): `return !s.hidden[line] || s.folded[line] >= 0`. Because `folded[]` is set for **every** line of a fold (not only the first), `represented()` returns `true` for **every line belonging to any fold**, not merely the fold's first/rendering line — this is a coarser, "does this line's content still show up in the output *in some form*" predicate, distinct from `foldAt[i] >= 0`, which is the narrower "does this exact physical line emit its own row" predicate the render loop uses. In practice this distinction is never observable at any of `represented()`'s current call sites: every call is either against a line kind that can never be part of a fold (`diffLineHeader`, `diffLineOldFile`, rename/copy markers — none of these pass `isHunkSource`, which `prepareFold` requires for every line in range), or is an "any represented in `[start,end)`" range query (`anyRetainedMeaningful`/`anyRetained`, `:684-742,745-752`) where the fold's first line alone already makes the range answer `true` regardless of whether later fold lines also count. A porter relying on `represented()` for a *new*, per-line (not range) query on a non-first fold line should not assume it reads `false` there — it reads `true`.

### 3. Remove-range validation (`meat/editplan.go:186-213`)

Per range, in order: `StartLine<1 || EndLine<1 || StartLine>EndLine` → `"remove[%d]: invalid inclusive range %d-%d"`, `removalsValid=false`, `continue` (skip the overlap scan for this range). `EndLine > len(lines)` → `"remove[%d]: line %d is past end of diff (%d lines)"`, same. Otherwise, walk `n` from `StartLine` to `EndLine`: the overlap test at `:200` is against **`modelRemoved[n-1]`**, a separate boolean array seeded to all-`false` at `:185` — **not** `state.hidden[n-1]` (which starts pre-seeded with `mandatoryHidden` at `:184`). So a `remove` range is entirely free to cover lines already hidden by the mandatory-import pass without triggering the overlap error — only overlap against an *earlier model remove range* is checked. When `modelRemoved[n-1]` is already `true` (line already claimed by an earlier remove range in this same plan), the code records `firstOverlap` only the first time (`:201-203`, never overwritten on subsequent overlapping lines), sets `removalsValid=false`, and `continue`s — this `continue` skips **both** `modelRemoved[n-1]=true` (harmless, already true) and `state.hidden[n-1]=true` (also harmless — `state.hidden[n-1]` is already `true` from whichever earlier assignment first set `modelRemoved[n-1]` true, since that assignment always paired the two at `:207-208`). So no line is ever left un-hidden as a side effect of the overlap path, and exactly one diagnostic is produced per offending range no matter how many lines the overlap spans (matches G24's 701-line-overlap-→-one-message fixture).

### 4. Fold preparation and validation

**`prepareFold`** (`meat/editplan.go:421-470`): structural gate first — `StartLine<1 || EndLine<1 || StartLine>=EndLine` → "want at least two lines" (`:422-424`, note `>=` not `>`, so a fold's `StartLine==EndLine` is the same rejection as an inverted range); `EndLine > len(lines)` → past-end (`:425-427`). Then per line `n` in range:
- `isHunkSource(layout.kinds[index])` and non-empty text required, else `"fold[%d]: line %d is not source inside one diff hunk"` (`:433-436`).
- First line's diff-marker byte becomes `marker`; any later line whose marker differs → `"mixed diff markers"` (`:437-442`).
- **Python anchor protection** (`:444-448`): only when `pythonCodeLine` (Python-classified **and** `pythonTripleStateBeforeLine(...) == pythonTripleNone`, i.e. not inside an open triple-quoted string — cite `python.md` for both predicates) **and** `lineMarker != '-'`. A `-`-marked line is exempt: a fold that entirely *deletes* old-side code isn't hiding an anchor behind an ellipsis — the anchor is simply gone from the new text, which is a legitimate outcome the retained-structure/Python-owner checks handle on their own terms, not an "orphaned anchor behind a fold" risk (that risk is specifically "the header/decorator text still exists in the rendered diff but its interior is now an opaque `...`", which only applies to context/`+` lines).
- Blank lines (`strings.TrimSpace(body) == ""`) are skipped for indent purposes via `continue` (`:449-451`) — note this `continue` is *after* the marker-uniformity and anchor checks, so a blank line still participates in those, it's only exempted from indent computation.
- **Indent computation** (`:452-458`): `leadingWhitespace(body)` per non-blank line; first one sets `indent`; every subsequent one narrows it via `commonPrefix(indent, lineIndent)`. `commonPrefix` (`:489-499`) is a pure byte-position comparison with no interpretation of tab-vs-space width (H16). **Worked example**: fold lines indented `"  "` (2 spaces), `"  "` (2 spaces), `"\t "` (tab+space): after line 1, `indent="  "`; line 2 leaves it unchanged; line 3's `commonPrefix("  ", "\t ")` compares byte 0 (`' '` vs `'\t'`) and diverges immediately, collapsing the result to `""` — the fold's rendered `...` then carries **no** indentation at all, even though two of the three lines agreed on a 2-space indent. This is a real, silent truncation-to-empty on any single mismatched leading byte, not merely a width-interpretation difference; it never raises an error. `leadingWhitespace(body)` running-reduction via `commonPrefix` is order-independent (longest-common-prefix of a set is well-defined regardless of pairwise combination order), so which physical line is visited first doesn't change the final answer — only the *set* of leading-whitespace strings matters.
- If no non-blank line was ever found: `"fold[%d]: range %d-%d contains only blank source lines"` (`:460-462`).

**Caller-side checks** (`meat/editplan.go:214-260`), after `prepareFold` succeeds:
1. **Mandatory-import crossing** (`:222-236`): count `mandatoryHidden[n-1]` over the range. If `mandatoryLines > 0` and it doesn't equal the whole range width → `"fold[%d]: crosses automatically removed import rows and behavioral rows..."`, `foldsValid=false`. If it equals the whole range width (the fold is *entirely* mandatory-hidden lines) → **silently accepted as a no-op**: `continue`, no `plannedFold` is ever built or recorded, no state mutation happens — the fold is redundant since the mandatory pass already hides those lines unconditionally. (See `imports.md` G17-G18 for the fixture-level pinning of both branches; `editplan.md`'s own Open questions already flag this pairing as untested by `editplan_test.go` itself.)
2. **Conflict-with-already-hidden** (`:237-252`), reached only when `mandatoryLines == 0` for this range: scans `state.hidden[n-1]` for the first `true`. Since mandatory-hidden lines were already excluded above, a hit here can only be an earlier model `remove` or an earlier fold in the same plan. `kind := "remove"; if state.folded[conflictLine-1] >= 0 { kind = "fold" }` distinguishes which, producing `"fold[%d]: overlaps remove at line %d"` or `"...overlaps fold at line %d"`.
3. **State mutation** (`:253-259`): `foldIndex := len(state.folds)`; append; `state.foldAt[StartLine-1] = foldIndex`; for every line in range, `state.hidden[n-1]=true; state.folded[n-1]=foldIndex`.

### 5. Replace validation, ordered sequence (`meat/editplan.go:284-352`)

Per `in.Replace[i]`, checked in this exact order, each a `continue` on failure (none but the overlap loop touch `replacementsValid`):

1. `r.Line` bounds (`1..len(lines)`) — `:287-290`.
2. `mandatoryHidden[r.Line-1]` — **silently skipped, not rejected** (`:291-296`). This is deliberately asymmetric with folds (which reject a *mixed* mandatory/non-mandatory range outright): the code comment states the reason directly — "older cached/model plans that explicitly abridged an import still merge cleanly with the mandatory plan." A single-line `replace` targeting one mandatory row has no "mixed range" concept to police (it's one line, wholly mandatory or not), so there is nothing to reject; ignoring it lets a plan authored before/independent of the mandatory pass's exact scope still compile without needing to be re-authored.
3. Already hidden by remove/fold (`state.hidden[r.Line-1]`, checked *after* the mandatory-skip so this only fires for model-caused hiding) — `"replace[%d]: line %d is also %s"` (`removed`/`folded`) — `:297-304`.
4. `r.Old == ""` — `:305-308`.
5. `validateSingleLineText("old", r.Old, maxReplacementBytes)` then `("new", ...)` — each error wrapped `fmt.Errorf("replace[%d]: %w", i, err)` — `:309-316` (see §10, Hazards H5).
6. `r.New == r.Old` (no-op) — `:317-320`.
7. `!isElisionProjection(r.Old, r.New)` — `:321-324` (see §1). Note this runs against the model's *claimed* `Old`/`New` pair, independent of whether `Old` actually occurs in the source line at all — that's checked separately at step 10.
8. `!isHunkSource(layout.kinds[r.Line-1])` — `"...is not a source line inside a diff hunk"`, fires even when `Old`'s text literally occurs in a metadata line — `:325-328`.
9. Python anchor protection, only when `layout.python[...] && pythonTripleStateBeforeLine(...) == pythonTripleNone`: `code := trimPythonCode(body)`; reject if it starts with `@` or `isPythonSuiteHeaderStart(code)` — `:329-336` (cite `python.md`).
10. Python boundary-token preservation: `layout.python[...] && changesPythonBoundaryTokens(r.Old, r.New)` — `:337-340` (cite `python.md`).
11. `uniqueSubstringIndex(body, r.Old)` — `:341-345` (see next paragraph). On success, appended to `replacements[r.Line]`.

**`uniqueSubstringIndex`** (`meat/editplan.go:542-553`): `first := strings.Index(text, sub)`; if not found, `(0, false)`. Then `strings.Index(text[first+1:], sub) >= 0` → `(0, false)` ("ambiguous"). Searching from `first+1` (one byte past the match's *start*) rather than `first+len(sub)` (past the match's *end*) is strictly a **superset** search window whenever `len(sub) >= 1` (always true, since `Old` is non-empty by step 4): every position a "search past the end" approach would find is also within `text[first+1:]`, plus the window additionally covers positions strictly between the first match's start and its end. The `"aa"` in `"aaa"` example: `first=0`; searching from `text[1:]="aa"` finds a *second*, overlapping occurrence of `"aa"` starting at absolute position 1 (spanning `[1,3)`, overlapping the first match's `[0,2)` at byte 1) — a search starting at `first+len(sub)=2` (`text[2:]="a"`) would have missed this entirely and wrongly reported uniqueness. Generalizing: because the search window only ever grows relative to a "past-the-end" search, `uniqueSubstringIndex` catches **any** second occurrence of `sub` anywhere in `text` after the first — both occurrences overlapping the first match and occurrences fully disjoint from it, arbitrarily far later in the text. The precise guarantee: `unique == true` iff `sub` occurs at **exactly one** starting byte offset in `text` (overlapping occurrences counted, existence only — no enumeration).

### 6. Replacement-overlap sort/check pass (`meat/editplan.go:353-362`) — G21/G22, **H7 site**

Per source line with 2+ planned replacements: `sort.Slice(edits, func(i,j) bool { return edits[i].start < edits[j].start })` (`:354`), then only **adjacent** pairs are compared: `edits[i].start < edits[i-1].end` (`:356`).

**Does adjacent-only comparison catch all pairwise overlaps for 3+ spans?** Yes — proof: all spans are non-empty (`end > start`, since `Old` is non-empty) half-open ranges `[start, end)`. Suppose spans `i < j` (by sorted order, not necessarily adjacent) overlap: `s_j < e_i`. By sortedness, every span `k` with `i < k ≤ j` has `s_i ≤ s_k ≤ s_j`, so in particular `s_{i+1} ≤ s_j < e_i` — meaning the **immediately adjacent** pair `(i, i+1)` already satisfies the overlap test. So whenever *any* two spans overlap, the adjacent-pair scan is guaranteed to flag at least one adjacent pair, and `replacementsValid` correctly becomes `false`. **What is not guaranteed**: every genuinely-overlapping pair gets its own named error. If span `A=[0,100)` contains a tiny `B=[1,2)` which sorts immediately after it, and a third span `C=[50,60)` (also inside `A`, not overlapping `B`) sorts after `B`, then `(A,B)` is flagged but `(B,C)` is not (they don't overlap each other), and the real `A`-`C` overlap is never itself named — the compile still correctly fails (via the `A`-`B` report), but the aggregated message doesn't enumerate `A`-`C` as its own problem. No fixture in `editplan_test.go` constructs 3+ overlapping replacements on one line (only 2-way overlap cases are pinned, `:845-854,871-880`), so this specific under-reporting is real but untested in either direction.

### 7. Render loop and `applyPlannedReplacements` (`meat/editplan.go:387-419`)

Per physical line `i` (`lineNo = i+1`): if `state.foldAt[i] >= 0` (fold's own first line), emit `marker + indent + "..." + eol`, `continue` — this check runs **before** the `state.hidden[i]` check (`:391-401`), and must, because every fold line — including the first — also has `hidden[i]==true` by construction (§4 step 3). If the order were reversed, the fold's first line would hit the plain-hidden branch and vanish silently instead of rendering its `...`, breaking every fold guarantee. Otherwise, if `state.hidden[i]`, `continue` (contributes nothing). Otherwise emit the line, applying `applyPlannedReplacements(text[1:], edits)` if `replacements[lineNo]` is non-empty.

`applyPlannedReplacements` (`:413-419`) splices **right-to-left**, iterating `edits` from last to first: `body = body[:e.start] + e.New + body[e.end:]`. Every edit's `start`/`end` are byte offsets recorded against the **original, unmodified** line body. Splicing left-to-right would, the moment any edit's `len(New) != len(Old)`, shift the string's length and invalidate every later (higher-offset) edit's recorded coordinates. Splicing right-to-left never has this problem: at each step, all bytes strictly left of the current edit's `start` are untouched and still match their original offsets, because the edits are pre-sorted ascending and non-overlapping (§6), so a later (higher-start) edit's region never intersects the region any earlier edit will later touch.

### 8. `computePlanStats` (`meat/editplan.go:501-529`)

Single pass over `layout.kinds`: `diffLineHeader` increments `rawFiles`, and `visibleFiles` if `state.represented(i)` (reduces to `!hidden[i]` for header lines, per §2). `diffLineHunkChange` increments `rawChanged` and exactly one of `foldedChanged` (`state.folded[i]>=0`), `removedChanged` (`state.hidden[i]`, checked second — i.e. any hidden-but-not-folded line), or `visibleChanged` (default) — mutually exclusive by the `switch` structure. `foldCount = len(state.folds)` (includes compiler-synthesized Python-suite placeholder folds — see `imports.md`). Then a **separate** bonus pass (`:523-527`): `+1` to `visibleChanged` per fold whose `marker` is `'+'` or `'-'`, but **not** for a context-marked (`' '`) fold. Reason: a context-only fold's constituent lines were never `diffLineHunkChange` kind in the first place (context lines are `diffLineHunkContext`), so they were never counted anywhere in the main loop; a context fold's `...` therefore doesn't represent a *change* being compressed, only unchanged surrounding text, and inflating `visibleChanged` for it would misrepresent the change-density the stat exists to measure. A `+`/`-` fold, by contrast, stands in for real change lines that would otherwise have counted individually, so it earns the +1 as "this fold itself is the one visible unit representing that changed content."

### 9. `validateRetainedStructure` (`meat/editplan.go:666-734`) and its predicates (`:736-770`)

Loop over every line `i`. **Before** the `switch` (`:671-677`, applies to every line unconditionally): if `kind == diffLineNoNewline && state.represented(i)`, its `owner := layout.markerOwner[i]` must itself be represented, else `"remove: no-newline marker on line %d requires its source line"`.

`switch kind`:
- **`diffLineHeader`** (`:680-691`): `end := nextLayoutLine(layout, i+1, stop-at-Header-or-MailSignature)`. `bodyRetained := anyRetainedMeaningful(layout, state, i+1, end)`; `headerRetained := state.represented(i)`. If nothing meaningful retained but *something* (even non-meaningful) is retained → "retains only metadata; remove the complete file section." If `headerRetained != bodyRetained` → "must be retained exactly when its file body is retained."
- **`diffLineOldFile`** (`:692-703`): boundary search starts at **`i+2`** (skipping both the `---` line at `i` and the `+++` line at `i+1`), stopping at Header/OldFile/MailSignature. First requires `state.represented(i) == state.represented(i+1)` (the pair itself must move together), then compares `anyRetainedMeaningful(..., i+2, end)` against `state.represented(i)`.
- **`diffLineRenameFrom`** / **`diffLineCopyFrom`** (`:704-715`): requires the immediately next line to be the matching `To` kind, else "has no matching ... line"; else requires `state.represented(i) == state.represented(i+1)`.
- **`diffLineHunkHeader`** (`:716-727`): `end` search starts at `i+1`, stopping at Header/OldFile/HunkHeader/MailSignature. `anyRetainedHunkSource(..., i+1, end) && !headerRetained` → "retained context/change lines require hunk header." Then `headerRetained != anyRetainedHunkChange(..., i+1, end)` → "must be retained exactly when its hunk has a retained change" (context alone never justifies a header; a header with zero retained *changes* is likewise rejected even if context survives).

Predicates (`:736-770`): `anyRetainedMeaningful` — `represented(i)` **and** `kind != diffLineNoNewline && kind != diffLineIndex`; this is the only predicate that excludes those two kinds, so a section retaining only an index line and/or a no-newline marker doesn't count as "retaining real content." `anyRetained` — plain `represented(i)`, no kind filter. `anyRetainedHunkSource` — `represented(i) && isHunkSource(kind)`. `anyRetainedHunkChange` — `represented(i) && kind == diffLineHunkChange`.

### 10. `validateSummary`/`validateSingleLineText` (`meat/editplan.go:634-664`)

`validateSummary` (`:634-645`, summary-only): empty-after-`strings.TrimSpace` → `"summary must not be empty"` (`:635-636`); `len(summary) > maxSummaryBytes` → its **own** explicit length check (`:638-640`) — note this check always fires *before* `validateSingleLineText` is even called at `:641`, so `validateSingleLineText`'s own identical-bound length check (`:648-649`) is provably unreachable via this call path specifically (see Uncovered mechanism).

`validateSingleLineText(name, text, maxBytes)` (`:647-664`, shared by summary and by replace `old`/`new`): byte-length ceiling (`:648-649`); `utf8.ValidString` (`:651-652`); forbidden-character switch over `for _, r := range text` (`:654-658`) — exact list `'\n', '\r', 0, '\x1b', ' ', ' '`; general catch-all `unicode.IsControl(r) && r != '\t'` (`:659-661`).

### 11. Small primitives

- **`isIdentifierStart`/`isIdentifierContinue`** (`:472-478`) — ASCII-only byte tests (`_`/`A-Z`/`a-z`; digits added for continue). Reused unmodified by `python.go`'s `simpleAssignedReference` (`:817-826`) and `imports.go`'s `isImportOnlyFramingRow` (`:290,294`) — verified single definition site (`meat/editplan.go:472,476`; no shadow definitions elsewhere).
- **`leadingWhitespace`** (`:480-487`) — `for i, r := range s` testing only `r != ' ' && r != '\t'`; both single-byte ASCII, so the returned byte index is identical to what a plain byte-wise loop would give — same H2-non-issue argument `python.md` already makes for its own reuse of this function. Verified single definition (`meat/editplan.go:480`; `python.go`/`moves.go`/`imports.go` all call it, none redefine it).
- **`commonPrefix`** (`:489-499`) — pure byte-position comparison, zero rune-awareness. General behavior: it *can* truncate mid-UTF-8-codepoint if given two strings that diverge inside a multi-byte sequence (not itself byte-corrupting, just not a "safe" answer for arbitrary text). At its one call site (`:457`, fold-indent computation over `leadingWhitespace`'s output, which only ever contains `' '`/`'\t'` bytes), the risk is moot — the inputs are always pure ASCII space/tab runs, so byte comparison and codepoint comparison agree exactly; the only real-world effect is the tab-vs-spaces truncation-to-empty documented in §4, which is a width-interpretation issue (H16), not a codepoint-splitting one.
- **`joinEditPlanErrors`** (`:531-540`) — single problem returns as-is (preserving its own wrap chain, e.g. a `%w`-wrapped replace error); 2+ problems produce `"edit plan has %d errors:\n- ...\n- ..."`. Verified sole definition in `meat/editplan.go`; called from `moves.go`, `python.go`, `diff.go`, `chunk.go`, and four sites within `editplan.go` itself (`:148,174,384,731`) — this is its authoritative home, as `imports.md`/`moves.md`/`python.md` already cite.

### Data shapes

**Model-facing** (JSON wire shapes, by meaning — no Go struct-tag mechanics):
- **`lineRange`** — an inclusive, 1-based physical-line range in the original diff (`StartLine`, `EndLine`).
- **`lineReplacement`** — one line number plus an `Old`/`New` string pair: `Old` is matched against the source text *after* the diff's leading marker byte; `New` must be an elision projection of `Old`.
- **`lineFold`** — a `lineRange` naming the source lines a single machine-rendered `...` row replaces.
- **`editPlan`** — `Remove`/`Replace`/`Fold` slices, no prose; the structure-only plan shape previewable before a summary exists.
- **`submission`** — `editPlan` plus a `Summary` string; `submission.plan()` (`:65-67`) strips the summary back out.

**Internal, resolved/validated shapes**, populated at the pipeline stage named:
- **`plannedReplacement`** (embeds `lineReplacement` + `planIndex`, `start`, `end`) — populated only for replacements that passed *every* per-item check (§5); `start`/`end` are byte offsets into the line's body (post-marker-strip), computed by `uniqueSubstringIndex`, valid against the **original**, unedited body.
- **`plannedFold`** (embeds `lineFold` + `planIndex`, `marker byte`, `indent string`, `eol string`) — built once by `prepareFold` (§4) before the caller decides whether to actually commit it to `state.folds`.
- **`planState`** — the whole compiler's running mutable ledger; see §2. Seeded from `mandatoryHidden`, then mutated by remove application, fold commitment, and (inside Gate A) placeholder synthesis.
- **`planStats`** — populated once, at the very end (`:409`), from the **final** `state` and `layout`; never touched mid-pipeline.
- **`compiledPlan`** — the terminal output (`smartDiff`, `stats`, `moves`); only ever constructed once, after `len(problems)==0` at `:383-385` is confirmed, at the function's return (`:410`).

## Invariants

- **Physical-line-coordinate stability** (mechanism behind G34): `lines := splitSourceLines(raw)` (`:168`) is computed exactly once per compile call and every subsequent operation — remove, fold, replace, every validator, the render loop — indexes into this same fixed slice by physical line number minus one. No operation re-slices, re-splits, or re-derives `lines`; a `remove` on an earlier line never shifts a later operation's coordinates because nothing about `lines`'s indexing ever changes.
- **Fold-vs-hidden render ordering**: the render loop must test `state.foldAt[i] >= 0` before `state.hidden[i]` (verified at `:391-401`, in that order), because every line of a committed fold — including its first — has `hidden[i]==true` by construction. Reversing the checks would make a fold's first line fall into the plain-hidden branch and vanish instead of rendering its `...`.
- **Elision-projection anchoring**: the constructed pattern is always `^...$` (`:574,626`), and `old` is always matched via a single, whole-string `MatchString` call (`:568`) — there is no code path anywhere in this file that matches `new`/`old` unanchored or as a substring search; a partial match is never treated as a valid elision.
- **`represented()`'s fold-wide truth** (§2): true for every line of a fold, not only its first — a mechanism detail with no current observable consequence, but a genuine trap for a per-line (non-range) use added later.

## Hazards

- **H1** (byte offsets): saturates this file — `plannedReplacement.start`/`.end` (`:73-74`, populated `:349-350`), every `len()`/slice op in `applyPlannedReplacements` (`:416`), `uniqueSubstringIndex`'s `strings.Index` calls (`:543,549`), `validateSingleLineText`'s `len(text)` (`:648`), the two byte-count constants `maxReplacementBytes`/`maxSummaryBytes` (`:21-22`). Confirmed by grep: the **only** rune-iterating constructs anywhere in `editplan.go` are `leadingWhitespace`'s loop (`:481`, ASCII-safe per §11), `compileElisionProjection`'s `newRunes := []rune(new)` (`:572`), and `validateSingleLineText`'s `for _, r := range text` (`:654`) — everything else, including all offset arithmetic, is byte-indexed.
- **H2** (runes): `newRunes := []rune(new)` (`:572`) is genuinely rune-aware — it must recognize the multi-byte `…` codepoint and count codepoints (not bytes) to correctly delimit dot-runs and literal spans while walking `new`. By contrast, `old` is **never** rune-decoded anywhere in this mechanism — it is matched as raw UTF-8 bytes via `regexp.MatchString` (confirmed: no `[]rune(old)`/`range old` construct exists). For the literal-scan port: the *pattern-construction* side (`new`) needs codepoint-aware tokenization; the *matching* side (`old`) does not — a byte-wise scan against `old` is correct and sufficient. Separately, `unicode.IsControl(r)` in `validateSingleLineText`'s `for _, r := range text` (`:654,659`) is a real, full-Unicode-property rune loop over arbitrary model-authored text (summary or replacement text) and needs genuine `\p{Cc}`-class handling in the port, unlike `leadingWhitespace`'s ASCII-only loop.
- **H3a** — see Mechanism §1 above (central treatment).
- **H5** (error wrapping): `fmt.Errorf("replace[%d]: %w", i, err)` (`:310,314`) wraps `validateSingleLineText`'s error. Verified by repo-wide grep for `errors.Is`/`errors.As`: the only matches in the whole `meat`/`cmd/meat` tree are in `chunk.go`'s unrelated `chunkError` wrapping (context cancellation/deadlines) and its own test — **no caller anywhere unwraps or inspects an `editplan.go` validation error via `errors.Is`/`errors.As`**. The `%w` verb is technically live (the chain would `errors.Unwrap` correctly if asked, and survives intact through `joinEditPlanErrors`'s single-problem passthrough at `:532-533`), but empirically it is consumed purely as message text — every actual consumer either stringifies the error directly or feeds it through `fmt.Sprintf("invalid edit plan: %v", err)` (`meat/tools.go:219,239`).
- **H7** (sort stability) — `sort.Slice(edits, ...)` (`:354`). **Ties are reachable**: two different replacements on the same line can independently pass their own `uniqueSubstringIndex` check against the *unmodified* body and still share the exact same `start` (different `Old` texts that both begin at the same byte offset, e.g. `"ab"` and `"abc"` both starting at offset 5). **Ties are always caught regardless of sort order**: for any tie `edits[i].start == edits[i-1].start`, since `Old` is always non-empty (`end > start` for every span), `edits[i].start (== edits[i-1].start) < edits[i-1].end` holds unconditionally — the adjacent-pair overlap check fires and reports the overlap no matter which of the two tied elements the (unstable) sort happened to place first. **Conclusion**: H7 is live on this comparator (genuine ties occur) but provably inconsequential to correctness — a stable or unstable sort produce the same pass/fail outcome, though which `planIndex` is named as "overlaps replace[j]" in the message *can* differ between sort implementations for a tied pair, which a port's tests should not assume matches a specific Go run.
- **H8** (integer arithmetic): not applicable — grep confirms zero division operators anywhere in `editplan.go` (all `/` occurrences are inside comments).
- **H9** (nil vs. empty slice): not meaningfully applicable within this file — Go's `range` over a nil vs. empty `Remove`/`Replace`/`Fold` slice is behaviorally identical (zero iterations either way), so `compileEditPlanMoves` itself never distinguishes them. The nil-rejection behavior referenced by stage-1 G3 is enforced elsewhere, by `requirePlanArrays` in `meat/tools.go:203-207` (out of this file's scope — see findings, below).
- **H13** (map iteration order) — a second application site beyond `openai.go` (HAZARDS.md's H13 entry currently only names that file): `replacements := make(map[int][]plannedReplacement)` (`:284`) is ranged over at `:353` (`for lineNo, edits := range replacements`) to run the per-line overlap check. If two or more *different* physical lines each independently have their own overlapping-replacement problem, the **order** in which those lines' `"span overlaps"` errors are appended to `problems` — and therefore their order in the final aggregated message — depends on Go's randomized map iteration order, which is unspecified per-run. No fixture in `editplan_test.go` constructs 2+ simultaneously-overlapping *different* lines (`TestApplyEditPlan_RejectsOverlappingReplacements` and `TestApplyEditPlan_RejectsOverlappingOldOccurrences` each use only one line), so this is untested in Go and therefore imposes no reproducible order for a port to match. A deterministic port will necessarily produce a *fixed* order where Go had none — strictly more deterministic, in the same spirit as H7, and not itself a correctness risk.
- **H15** (nil/zero as meaningful state) — `plannedFold.marker byte` starts at the Go zero value `0` inside `prepareFold`'s loop (`:429`) as an explicit "unset" sentinel, tested via `if marker == 0` (`:438`) and distinguished from the three real marker values `' '`/`'+'`/`'-'`. A TypeScript port typing `marker` as a one-character string cannot reuse `0`/falsy for "unset" the same way (an empty string is falsy but visually different from a marker byte, and `' '` — a real, valid marker — is not itself falsy but is easy to mishandle); the port needs an explicit "not yet set" representation, e.g. `marker: '+' | '-' | ' ' | null`.
- **H16** (indentation-width convention) — `editplan.go:452` (fold-range indent via `leadingWhitespace`, feeding `commonPrefix`) is the site HAZARDS.md's own H16 entry already names as using the raw-byte-count convention, consistent with `imports.go`/`python.go` and distinct from `moves.go`'s tab-expanded columns. See §4's worked tab/space example for the concrete failure shape this produces (silent truncation to empty indent, not a wrong-but-plausible width).

## Errors

Exhaustive table of every error-producing site in `meat/editplan.go` (39 `fmt.Errorf` call sites; zero `errors.New`, zero `panic`, verified by grep):

| Message template | Producer | Line |
|---|---|---|
| `"remove[%d]: invalid inclusive range %d-%d"` | remove validation | `:189` |
| `"remove[%d]: line %d is past end of diff (%d lines)"` | remove validation | `:194` |
| `"remove[%d]: overlaps an earlier range at line %d"` | remove validation | `:211` |
| `"fold[%d]: crosses automatically removed import rows and behavioral rows in range %d-%d; fold only the behavioral rows"` | fold/mandatory-import interaction | `:230` |
| `"fold[%d]: overlaps %s at line %d"` (`%s` ∈ `remove`/`fold`) | fold conflict check | `:249` |
| `"replace[%d]: line %d is outside the diff (1-%d)"` | replace validation | `:288` |
| `"replace[%d]: line %d is also %s"` (`%s` ∈ `removed`/`folded`) | replace validation | `:302` |
| `"replace[%d]: old must not be empty"` | replace validation | `:306` |
| `"replace[%d]: %w"` (wraps `validateSingleLineText`'s `"old ..."` error) | replace validation | `:310` |
| `"replace[%d]: %w"` (wraps `validateSingleLineText`'s `"new ..."` error) | replace validation | `:314` |
| `"replace[%d]: new must elide some part of old"` | replace validation (no-op) | `:318` |
| `"replace[%d]: new must match all of old, with every omitted span represented by ... or …"` | replace validation (elision) | `:322` |
| `"replace[%d]: line %d is not a source line inside a diff hunk"` | replace validation | `:326` |
| `"replace[%d]: line %d is a Python decorator or suite header; keep structural anchors intact"` | replace validation (Python anchor) | `:333` |
| `"replace[%d]: must preserve Python string and expression boundary tokens"` | replace validation (Python boundary) | `:338` |
| `"replace[%d]: old must occur exactly once after the diff marker on line %d"` | replace validation (uniqueness) | `:343` |
| `"replace[%d]: span overlaps replace[%d] on line %d"` | replace-overlap check | `:357` |
| `"fold[%d]: want at least two lines in an inclusive range, got %d-%d"` | `prepareFold` | `:423` |
| `"fold[%d]: line %d is past end of diff (%d lines)"` | `prepareFold` | `:426` |
| `"fold[%d]: line %d is not source inside one diff hunk"` | `prepareFold` | `:435` |
| `"fold[%d]: mixed diff markers %q and %q in range %d-%d"` | `prepareFold` | `:441` |
| `"fold[%d]: line %d is a Python decorator or suite owner; keep the anchor and fold only its indented interior"` | `prepareFold` (Python anchor) | `:447` |
| `"fold[%d]: range %d-%d contains only blank source lines"` | `prepareFold` | `:461` |
| `"edit plan has %d errors:%s"` | `joinEditPlanErrors` (aggregation) | `:539` |
| `"summary must not be empty"` | `validateSummary` | `:636` |
| `"summary is %d bytes, over the %d-byte limit"` | `validateSummary` | `:639` |
| `"%s is %d bytes, over the %d-byte limit"` | `validateSingleLineText` | `:649` |
| `"%s is not valid UTF-8"` | `validateSingleLineText` | `:652` |
| `"%s must be a single printable line"` | `validateSingleLineText` (forbidden char) | `:657` |
| `"%s contains a control character"` | `validateSingleLineText` (control char) | `:660` |
| `"remove: no-newline marker on line %d requires its source line"` | `validateRetainedStructure` | `:675` |
| `"remove: file beginning on line %d retains only metadata; remove the complete file section"` | `validateRetainedStructure` (Header) | `:687` |
| `"remove: diff header on line %d must be retained exactly when its file body is retained"` | `validateRetainedStructure` (Header) | `:690` |
| `"remove: ---/+++ headers on lines %d-%d must be removed or retained together"` | `validateRetainedStructure` (OldFile) | `:697` |
| `"remove: ---/+++ headers on lines %d-%d must be retained exactly when their file body is retained"` | `validateRetainedStructure` (OldFile) | `:702` |
| `"rename from metadata on line %d has no matching rename to line"` | `validateRetainedStructure` (RenameFrom) | `:706` |
| `"remove: rename metadata on lines %d-%d must be removed or retained together"` | `validateRetainedStructure` (RenameFrom) | `:708` |
| `"copy from metadata on line %d has no matching copy to line"` | `validateRetainedStructure` (CopyFrom) | `:712` |
| `"remove: copy metadata on lines %d-%d must be removed or retained together"` | `validateRetainedStructure` (CopyFrom) | `:714` |
| `"remove: retained context/change lines require hunk header on line %d"` | `validateRetainedStructure` (HunkHeader) | `:722` |
| `"remove: hunk header on line %d must be retained exactly when its hunk has a retained change"` | `validateRetainedStructure` (HunkHeader) | `:726` |

All are accumulated into a `problems []error` slice at their call site and returned through `joinEditPlanErrors` (`:531-540`) — never short-circuited within a single validator's own loop (see G25), though see Mechanism §0/Open questions for cross-validator short-circuiting via the gates.

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

### Stage 2 findings

Resolution of the items above, now that the mechanism is fully traced:

- **`isComposedElisionProjection`** — confirmed dead code more strongly than
  before: repo-wide grep (both `.go` and `_test.go`) finds exactly one
  match, its own definition. Its mechanism is now fully specified (Mechanism
  §1, adjacent-wildcard-merging paragraph) even though it is unreachable —
  a port may drop it, or keep it only as a documented non-strict variant
  with no wiring.
- **Move detection/symmetry and mandatory-Python-import interactions** —
  mechanism fully traced (§0 Gate A, §4 caller-side checks); both remain
  genuine fixture gaps in `editplan_test.go` itself, resolved by
  `moves.md`/`imports.md`/`chunk.md` as already noted. Nothing new to add
  beyond the mechanism now being explicit.
- **`maxSummaryBytes`'s length-check branch** — sharpened, not just
  confirmed absent: `validateSummary`'s own check (`:638-640`) always fires
  before `validateSingleLineText` is even called (`:641`), so
  `validateSingleLineText`'s identical-bound length branch (`:648-649`) is
  provably **unreachable via the summary path specifically** — this isn't
  "no test happens to hit it," it's "no test *can* hit it this way." The
  branch is only live via the replace `old`/`new` path
  (`maxReplacementBytes`), which G23 does exercise.

New items found while tracing mechanism, not covered by any guarantee above:

- **Gate A suppresses far more than move symmetry.** Any invalid `remove`
  range or invalid `fold` (`removalsValid=false` or `foldsValid=false`)
  unconditionally skips move symmetry, all four Python structural
  validators, move-replacement symmetry (Gate B), and all of Gate C
  (triple-quote parity, delimiter balance, backslash continuations,
  import-framing completion, `validateRetainedStructure`) for that entire
  compile call — see Mechanism §0's gate table. This means the aggregated
  error message G25/G40 describe as "all problems reported together" is
  only complete **within** whichever gates are actually open; a plan with
  one bad `remove` range *and* an independent, genuine Python
  delimiter-balance break elsewhere reports only the `remove` problem on
  the first submission — the model fixes it, resubmits, and only then
  discovers the delimiter problem was there all along. No fixture in
  `editplan_test.go` constructs this cross-gate scenario, so it is untested
  in either direction, but it is real, verified mechanism, and it directly
  qualifies the "all problems reported together" framing G25/G40 currently
  state without qualification.
- **`replacementsValid` is a misnomer relative to its name.** It tracks
  only "no replace-overlap conflict was found," not "every individual
  replacement validated." Gate C therefore still runs (and can still
  contribute new problems) even when earlier, unrelated per-replacement
  failures already guarantee the compile will fail — harmless (the
  `replacements` map only ever contains successfully-validated entries, so
  Gate C's inputs are never polluted by an invalid replacement) but a
  subtlety a port should preserve exactly, not "fix" into a stricter gate,
  since doing so would silently suppress genuine Gate-C problems Go
  currently still surfaces.
- **`represented()`'s fold-wide (not fold-first-line-only) truth**
  (Mechanism §2) — true for every line of a fold, not only its first; a
  real, verified mechanism detail with no current observable consequence at
  any existing call site, but a trap for a per-line (non-range) use added
  later.
- **H13-shaped map-iteration nondeterminism in the replace-overlap pass**
  (Hazards) — a genuinely new application site for an existing hazard
  class: `replacements` (`meat/editplan.go:284`) is a `map[int][]...`
  ranged over at `:353`, so the relative order of "span overlaps" errors
  from two different offending lines is unspecified in Go. HAZARDS.md's H13
  entry currently names only `openai.go`; recommend widening its "Affects"
  line to include this site.
- **The replacement-overlap check only guarantees detecting that *some*
  overlap exists among 3+ spans on one line, not naming every overlapping
  pair** (Mechanism §6) — proved via a sortedness argument (adjacent-pair
  comparison after sorting by start always catches at least one pair of any
  overlapping set, but a "container + two disjoint nested spans" shape can
  leave one real overlapping pair unnamed even though the compile still
  correctly fails via the pair that *was* caught). Worth flagging since a
  port tempted to "improve" the check into an all-pairs report would
  produce a different (arguably better, but divergent) error surface than
  Go's.

Dead or unreachable code: `isComposedElisionProjection` (above) is the only
instance found in this file; every other function has at least one
production or test call site.
