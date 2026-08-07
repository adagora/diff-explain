# imports

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `meat/imports.go`
> Go tests: `meat/python_golden_test.go` (one non-targeting guarantee),
> `meat/chunk_test.go` (import-mask interactions with splitting),
> `meat/imports_test.go` (language shapes, both sides, embedded, guards,
> merge, framing, agent surfaces)

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
    `meat/chunk.go:164-174`. Monolithic pin: G12 below
    (`TestCompileEditPlan_MandatoryImportsPreservePackageRenames`,
    `meat/imports_test.go:212`). See `chunk.md` G25.

G4. Import-like text embedded inside a source string literal (e.g. `import
    pytest` inside a template literal) is recognized from the string's
    opener and hidden by the mandatory pass; a cut separating the opener
    from the embedded rows does not defeat this, since the mask is
    precomputed globally before any splitting.
    — `meat/chunk_test.go:766-812`, mechanism `meat/chunk.go:257-291`
    (`stringInteriorMask`), `meat/imports.go:625` (`embeddedSourceLines`).
    See `chunk.md` G26. Monolithic shapes: G9.

G5. When the mandatory import pass would empty a visible Python suite
    owner's body, whole-diff rendering emits a fixed `"..."` placeholder
    row in its place; this placeholder decision is precomputed globally and
    carried into chunk segment emission even when a cut lands at the owner
    line or at the dropped import line itself.
    — `meat/chunk_test.go:1067-1109`, mechanism `meat/chunk.go:175-182`
    (`addMandatoryPythonSuitePlaceholders`, `meat/imports.go:12-55`),
    `meat/chunk.go:766-775` (`placeholderRow`). See `chunk.md` G33,
    `python.md`. Mixed-guard skeleton: G15.

G6. A section containing rows hidden only by move-precedence extension (see
    `moves.md`) — not by the plain import mask — is never packed verbatim
    into a chunk even if it would otherwise fit whole; it is forced through
    row-dropping segmentation so those rows are actually dropped from the
    emitted text.
    — `meat/chunk_test.go:1140-1145`, mechanism `meat/chunk.go:171-174,213-224`.
    See `chunk.md` G34, `moves.md`.

### Language shapes, both sides, false positives (`imports_test.go`)

G7. With an empty authored plan, recognized import declarations are stripped
    from the reading diff for every supported language family while
    non-import behavior is retained. Languages and shapes pinned:

    | Language (path) | Scaffolding removed (examples) | Behavior retained |
    |---|---|---|
    | Go (`.go`) | `import (`, `"fmt"`, `"example.com/a"`, `+)` | `+package a`, `+func run()` |
    | Python (`.py`) | multiline `from package.tools import (…)`, `import os, sys` | `+value = first` |
    | JS/TS (`.ts`) | multiline `import {…} from "…"`, multiline `const {…} = require("…")` | `+export const value` |
    | Rust (`.rs`) | multiline `use crate::{…};`, `pub(crate) use other::Third` | `+fn run()` |
    | C/C++ (`.cpp`) | `#include <vector>`, `# include "local.h"` (space after `#`) | `+int run()` |
    | Java (`.java`) | `import java.util…`, `import static …` | `+package example`, `+class A` |
    | Kotlin (`.kt`) | `import tools.first`, `import tools.second…` | `+package example`, `+fun run()` |

    For each of these fixtures the mandatory plan is **non-empty** and
    **byte-stable across two successive computations**.
    — `meat/imports_test.go:11-87`
    (`TestCompileEditPlan_MandatoryImportsByLanguage`); mechanism
    `mandatoryImportRemovalPlan` `meat/imports.go:156-250`, per-language
    ends `meat/imports.go:765-966`, path→language including `.kt`/`.kts` as
    Java family `meat/diff.go:446-447`, merge via `compileEditPlan`
    `meat/editplan.go:180-184`.

G8. Import classification is per-side, then recombined so context rows of an
    import group hide only when both sides agree, while unilateral `+`/`-`
    import members hide on their own side. Fixture: stable
    `package`/`import (`/`"fmt"`/`)` context around `- "math/rand"` and
    `+ "crypto/rand"` / `+ "encoding/hex"`, plus behavioral `-old`/`+new`.
    Reading diff drops all of `import (`, `"fmt"`, `"math/rand"`,
    `"crypto/rand"`, `"encoding/hex"`, ` )` and keeps
    `-old := fmt.Sprintf` and `+new := hex.EncodeToString`.
    — `meat/imports_test.go:89-105` (`TestCompileEditPlan_MandatoryImportsCoverBothDiffSides`); mechanism per-side masks and context
    rule `meat/imports.go:168-193` (`importLinesForSide`
    `meat/imports.go:356-368`).

G9. Import-like text inside embedded source fixtures is hidden; surrounding
    fixture/host behavior is kept. Three fixtures:

    1. **Python triple-quoted fixture** inside
       `pytester.makeconftest("""…""")`: drops `from plugin import`,
       `+            hook,`, `+            option,`, `import warnings`,
       `import pytest`; keeps `@pytest.hookimpl`, `def pytest_configure`,
       `warnings.warn`, `pytester.runpytest`.
    2. **Go raw-string fixture** with mixed languages: drops
       `import pytest` and `require("./helper")`; **does not** treat weak
       candidates `use analytics;` / `#include examples` as imports; keeps
       those lines, `run(helper)`, and host `func TestFixture`.
    3. **Truncated Go raw-string import block** (`import (` + `"fmt"`
       without closer before string ends): still drops that scaffolding;
       keeps closing ``+` `` and host `func TestGenerated`.

    — `meat/imports_test.go:107-155` (`TestCompileEditPlan_MandatoryEmbeddedSourceImports`); mechanism `embeddedSourceLines`
    `meat/imports.go:625-641`, embedded scan
    `importStatementEnd` `meat/imports.go:683-727`,
    `strongEmbeddedImportCandidate` `meat/imports.go:729-739`.

G10. Conservative false-positive resistance: lookalikes and prose are not
     stripped.

     - JS: `require.NoError`, `useFeature`, `using(resource)`,
       `wrap(require("morgan"))`, `app.use`, `} = source` (destructure
       **not** assigned from `require`), string prose
       `we import data from upstream`.
     - Rust: `useFeature()`, `using(value)`, prose
       `use the imported value`.
     - Unknown language / prose file (`README.md`): literal `import data`,
       `use feature`, `#include examples` all retained.

     — `meat/imports_test.go:157-192` (`TestCompileEditPlan_MandatoryImportRemovalAvoidsFalsePositives`); mechanism language-specific starters
     (`javascriptRequireEnd` `meat/imports.go:891-920`, `rustUseEnd`
     `meat/imports.go:922-946`, `cIncludeEnd` `meat/imports.go:948-959`);
     unknown path language `meat/diff.go:448-449`.

G11. A JavaScript/TS multiline `const {…} = require("…")` does not consume a
     preceding unrelated multiline destructure. Fixture:
     `const { timeout } = options;` then
     `const { readFile } = require("fs");` then `consume(…)`. Reading
     diff keeps the full options destructure and `consume`; drops
     `readFile,` and `require("fs")`.
     — `meat/imports_test.go:194-210` (`TestCompileEditPlan_JavaScriptRequireDoesNotConsumePreviousStatement`); mechanism `javascriptRequireEnd`
     requires a completed `require` match on the joined candidate
     `meat/imports.go:891-920` (`javascriptRequireRE`
     `meat/imports.go:754`).

G12. **Two-sided package renames** (paired `-package` / `+package` plus
     paired import swaps) keep both package rows visible while adjacent
     import rows are hidden. Fixtures are Go (`-package oldname` /
     `+package newname` with `-import "old"` / `+import "new"`) and Java
     (`-package old.name;` / `+package new.name;` with matching import
     swaps). Reading diff contains `-package old` and `+package new`
     (prefix match) and contains **no** `import ` substring.
     Package stays because the classifier never marks package-declaration
     lines as imports — only the import rows enter the mandatory mask —
     and because both sides of the package line change, the hunk is
     **not** treated as import-only (so the whole hunk is not collapsed).
     Contrast G16 case 3, where a **one-sided** new Go file that is only
     `package` + import block collapses entirely via
     `isImportOnlyFramingRow` (`meat/imports.go:274-299`, which requires
     `oneSidedChange` and treats package as framing so the import-only
     hunk/file shell can be removed).
     — `meat/imports_test.go:212-230` (`TestCompileEditPlan_MandatoryImportsPreservePackageRenames`); mechanism per-side import
     classification (package never classified as import)
     `meat/imports.go:168-193`, import-only hunk collapse only when every
     changed row is import scaffolding or one-sided package framing
     `meat/imports.go:196-218`.

G13. Hunk header section text is not authority for hiding hunk body rows.
     Bodies that are ordinary behavior remain even when the section looks
     like an incomplete Go `import (` or a complete JS
     `import {…} from` / Rust `use crate::{…};`. Fixtures keep
     `+work()`/`+done()`, ` const root`/`+render(root)`,
     ` let value`/`+consume(value)`.
     — `meat/imports_test.go:232-267` (`TestCompileEditPlan_HunkSectionImportHintIsNotAuthority`); mechanism
     `hunkStartsImportContinuation` + `importContinuationEnd`
     `meat/imports.go:370-393,405-474` (continuation end returns 0 when
     body members do not match).

G14. Python import-only guarded suites are removed wholesale (owner +
     clauses + imports); the consumer of the import stays. Fixture drops
     `try:`, `except ImportError`, `TYPE_CHECKING`, `import ujson`,
     `import json`, `from models import` and keeps
     `+value: Payload = json.loads(data)`.
     — `meat/imports_test.go:269-282` (`TestCompileEditPlan_MandatoryGuardedPythonImports`); mechanism
     `expandPythonImportOnlySuites` `meat/imports.go:508-556`, guards
     `isPythonImportGuard` / `isPythonImportGuardClause`
     `meat/imports.go:558-573`.

G15. A mixed Python guard (import body on one clause, non-import body on
     another) hides only the import rows and preserves the suite skeleton,
     inserting the fixed fold ellipsis `...` for the dropped import under
     the still-visible owner. Fixture drops `import fast_json` but keeps:

     ```
     +try:
     +    ...
     +except ImportError:
     ```

     plus `+    fast_json = None` and `+value = fast_json`.
     — `meat/imports_test.go:284-296` (`TestCompileEditPlan_MandatoryGuardedPythonImports` mixed case); mechanism partial expand
     `meat/imports.go:508-556` + suite placeholder
     `addMandatoryPythonSuitePlaceholders` `meat/imports.go:12-55`
     (invoked from `meat/editplan.go:262`).

G16. Import-only hunks and import-only files leave no shell in the reading
     diff.

     1. File with import-only hunk `@@ imports @@` plus behavior hunk
        `@@ behavior @@`: drops the imports hunk entirely (header,
        `package import` / `new_package` text) and keeps
        `diff --git a/a.py`, `@@ behavior @@`, `-old = run_old()`,
        `+new = run_new()`.
     2. File whose only hunk is import swap: **`smartDiff` is exactly
        empty**.
     3. New Go file that is only `package` + import block: **`smartDiff`
        is exactly empty** (package treated as import-only framing on
        one-sided Go).

     — `meat/imports_test.go:299-331` (`TestCompileEditPlan_MandatoryImportsRemoveCompleteHunksAndFiles`); mechanism import-only hunk hide
     `meat/imports.go:196-218`, file-shell hide `meat/imports.go:228-247`,
     framing row `meat/imports.go:274-299`.

### Merge with model plans and agent surfaces

G17. Model edits that only restate mandatory import hiding merge cleanly;
     they do not leak scaffolding or emit import ellipses. On a 4-line
     multiline `from package import (…)` plus `+value = first(second)`:

     - `Remove` of one import member line, `Replace` on another import
       member, and an import-only `Fold` over the whole import block all
       succeed together.
     - Reading diff has no `from package` / `package import` /
       `+    ...` (no fold placeholder for imports) and keeps
       `+value = first(second)`.

     Mechanism: import-only folds are skipped after mandatory win
     `meat/editplan.go:228-235`; replaces on mandatory rows are ignored
     without further validation `meat/editplan.go:291-296`.
     — `meat/imports_test.go:333-351` (`TestCompileEditPlan_MergesMandatoryImportsWithModelEdits`).

G18. A fold that spans both automatically removed import rows and
     behavioral rows is rejected. Same Python fixture; fold
     `StartLine: 8, EndLine: 9` (import closer `+)` through
     `+value = first(second)`). Error text **contains** exact substring:

     `crosses automatically removed import rows`

     Full production message:

     `fold[%d]: crosses automatically removed import rows and behavioral rows in range %d-%d; fold only the behavioral rows`

     — `meat/imports_test.go:353-356` (`TestCompileEditPlan_MergesMandatoryImportsWithModelEdits` crossing fold); mechanism `meat/editplan.go:222-231`.

G19. After mandatory import hiding is merged with model removals, empty
     hunk/file shells that still contained compiler-classified imports are
     closed; leftover context-only rows and redundant context replacements
     do not preserve framing. Fixture: import swap + behavior pair + long
     context line; model `Remove`s the behavior pair and `Replace`s the
     context line. Compile succeeds; **`smartDiff` is exactly empty**.
     — `meat/imports_test.go:359-375` (`TestCompileEditPlan_CompletesImportFramingAfterModelRemoval`); mechanism
     `completeMandatoryImportFraming` `meat/imports.go:98-149` (called
     `meat/editplan.go:378`), retained-change check
     `anyRetainedHunkChange` `meat/editplan.go:763-769`.

G20. Mandatory import removal applies on the live agent path for both
     `preview_plan` and `submit`, including identity (empty) plans, and
     preview retention statistics reflect the merged plan. Fixture:
     `+package a`, `+import "fmt"`, `+func run()…`. Identity preview then
     identity submit:

     - Final `SmartDiff` has no `import "fmt"` and contains `+func run()`.
     - Preview tool result likewise import-free and contains `+func run()`.
     - Preview contains exact `Retention: 2/3` (3 raw changed rows; import
       hidden → 2 visible) — proof stats use the merged plan.

     — `meat/imports_test.go:377-405` (`TestAbridge_MandatoryImportsApplyToIdentityPreviewAndSubmit`); mechanism
     `previewPlan`/`submit` → `compileEditPlanMoves`
     `meat/tools.go:210-246`, feedback `planFeedback` /
     `feedbackRetention` `meat/tools.go:257-288`, stats
     `computePlanStats` `meat/editplan.go:501-528`, loop
     `Abridge`/`abridgeOne` `meat/meat.go:115-213`.

G21. On high-retention identity submit → refinement → turn budget
     exhausted, the fallback result remains import-free, and refinement
     feedback must not re-expose stripped imports. Fixture: one JS import
     + 50× `+call();`, `MaxTurns: 2`, first turn identity `submit`, second
     turn text-only. Asserts two model turns; final `SmartDiff` has no
     `import { call }` and has `+call();`; no tool_result on the
     refinement turn contains `import { call }`.
     — `meat/imports_test.go:407-435` (`TestAbridge_MandatoryImportsApplyToRefinementFallback`); mechanism retention-pressure
     refinement + fallback `meat/meat.go:196-233`, pressure formula
     `meat/tools.go:248-253`, feedback built from compiled
     (mandatory-merged) plan `meat/tools.go:264-288`.

G22. The mandatory plan’s wire form is source-derived inclusive 1-based
     ranges with JSON keys `start_line` / `end_line`. Fixture:

     ```
     diff --git a/a.py b/a.py
     @@
     +import os
     +value = os.name
     ```

     Exact JSON of the plan: `[{"start_line":3,"end_line":3}]` (only the
     import physical line).
     — `meat/imports_test.go:437-447` (`TestMandatoryImportPlanJSONCoordinatesRemainSourceDerived`); mechanism `hiddenLineRanges`
     `meat/imports.go:324-338`, field tags `meat/editplan.go:27-30`.

## Mechanism

### Responsibility and dependents

`imports.go` computes the compiler-owned mandatory import mask: a pure
function of the immutable parsed diff (`[]sourceLine`, `diffLayout`) that
decides which physical lines are import declarations (or their scaffolding)
and must be hidden from every rendering, independent of what any model or
hand-authored plan says. It has no dependency on plan state for its *initial*
computation — `mandatoryImportRemovalPlan` `meat/imports.go:156-250` takes
only `lines`/`layout`. Three later functions in the same file *do* take a
`*planState` because they run after a plan has been merged:
`addMandatoryPythonSuitePlaceholders` `meat/imports.go:12-55`,
`stateWithMandatoryImportsRepresented` `meat/imports.go:61-93`,
`completeMandatoryImportFraming` `meat/imports.go:98-149`.

Call sites, in the order they actually run (`meat/editplan.go:180-182,262,269,378`;
`meat/chunk.go:168,180`):

1. `mandatoryImportRemovalPlan` → `mandatoryRemovalMask` — computed once,
   whole-diff, before anything else touches the plan.
2. Move-precedence extension (owned by `moves.go`, see `moves.md`; extends
   this mask across move counterparts — not re-explained here).
3. The extended mask seeds `planState.hidden` before any model `Remove`/
   `Fold`/`Replace` op is applied.
4. Model ops are merged (mandatory rows are immune to them — see Invariants).
5. `addMandatoryPythonSuitePlaceholders` runs, using the *final* merged
   state, to backfill `...` placeholders under suite owners the merge
   emptied.
6. Move-symmetry validation runs.
7. `stateWithMandatoryImportsRepresented` builds a throwaway validation-only
   clone for the four Python structural validators.
8. Only at the very end, after replacement/triple-quote/backslash
   validation, does `completeMandatoryImportFraming` run — closing hunk/file
   shells that the model's own edits emptied of everything but mandatory
   import rows.

`chunk.go` recomputes the identical whole-diff mask before any cutting
(`meat/chunk.go:168-170`) so a chunk boundary can never land inside import
scaffolding — see `chunk.md`.

### Data shapes, by meaning

- **Mandatory mask** — one boolean per physical line, true iff that line is
  compiler-hidden import scaffolding. Produced as `[]lineRange` (1-based
  inclusive spans, source-derived, `hiddenLineRanges` `meat/imports.go:324-339`)
  and re-expanded to a flat boolean-per-line array by `mandatoryRemovalMask`
  `meat/imports.go:341-349` wherever a mask, not a range list, is needed.
- **Side line** (`importSideLine`, `meat/imports.go:351-354`) — one
  hunk-source line's absolute index plus its text with the leading
  `+`/`-`/` ` diff marker already stripped. A "side" (`importLinesForSide`
  `meat/imports.go:356-368`) is the ordered subsequence of a hunk's lines
  belonging to one diff side (`-` or `+`): every context line (marker ` `)
  plus every change line matching that side's marker. Context lines
  therefore appear, redundantly, in *both* sides' sequences — this is what
  makes context hide only when both sides agree (see decision boundaries
  below).
- **Import file section** (`importFileSection`, `meat/imports.go:252-255`) —
  one file's structural span in the flat layout: from its `diff --git`/`---`
  opener to (excluding) the next mail signature or the next differing
  `fileID`. Built by `importFileSections` `meat/imports.go:302-322`.
- **Embedded flag** — one boolean per side-line, true iff that line's text
  sits strictly after a source-string opener and at or before its closer
  (Algorithm 3 below). A same-side, same-call scratch array; never stored
  past one `classifySideImports`/`fillImportGroupGaps` call.

### Algorithm 1 — top-level orchestration (`mandatoryImportRemovalPlan`, `meat/imports.go:156-250`)

For every hunk (identified by its header line), where `end` is the first
later line that is a file header, old-file marker, another hunk header, or
mail signature (`nextLayoutLine`, `meat/diff.go:473-480`):

1. Read the hunk's language from `layout.language[hunk]`.
2. Decide whether the hunk's *first* body line is itself already inside an
   import statement left open by an earlier, unseen hunk, via
   `hunkStartsImportContinuation(lines[hunk].text, language)` (Algorithm 4).
3. For each side (`-` then `+`, `meat/imports.go:169`):
   a. Build that side's line sequence (`importLinesForSide`).
   b. Classify it (`classifySideImports`, Algorithm 2) — produces a
      per-side-line hidden flag, seeded by the continuation decision from
      step 2.
   c. Expand whole import-only Python guard suites within that
      classification (`expandPythonImportOnlySuites`, Algorithm 5) — must
      run after (b), since it decides "import-only" by reading (b)'s output.
   d. Fill blank gaps between hidden runs (`fillImportGroupGaps`, Algorithm
      6) — must run after (c), since a guard suite's newly-hidden span can
      itself become one endpoint of a gap.
   e. Convert the side's hidden flags into an index-keyed map
      (`meat/imports.go:174-179`).
4. **Recombine sides into one `hidden` array** (`meat/imports.go:182-194`):
   for each hunk-source line, if its marker is `-`, use the `-` side's
   verdict; if `+`, use the `+` side's; if ` ` (context), hide it only if
   both sides independently hid it. This asymmetric-vs-symmetric split is
   what lets a unilateral import addition/removal hide on its own side while
   shared context around a stable import block needs both sides to agree.
5. **Full-hunk collapse** (`meat/imports.go:196-218`): walk every
   `diffLineHunkChange` row in the hunk (context rows are never inspected
   here). A row already hidden by step 4 sets `haveImportChange`; a row not
   hidden is checked against `isImportOnlyFramingRow` (Algorithm 7) — if it
   counts as framing, the hunk is still eligible; if it is genuine unhidden
   behavioral content, the hunk is disqualified. If the hunk had at least
   one import change **and** every other change row was framing, the entire
   hunk — header through `end`, including every context row, whether or not
   that context row was ever examined — is hidden. Context rows are swept up
   unconditionally; nothing about their own content is consulted (see
   Invariants, and Open questions).
6. **No-newline propagation** (`meat/imports.go:221-226`): a
   `diffLineNoNewline` marker line inherits its owner's hidden state via
   `layout.markerOwner` (set only when the marker directly follows hunk
   source, per `diff.md`) — a marker can never survive its owner's hiding.
7. **Full-file collapse** (`meat/imports.go:228-247`): for every
   `importFileSection`, if the section contains at least one hunk header and
   every hunk header in it is already hidden by step 5, the whole section
   (its `diff --git`/`index`/`---`/`+++` metadata included) is hidden too.
8. Return the mask as `[]lineRange` (`hiddenLineRanges`, a single
   left-to-right run-length encoding of the boolean array,
   `meat/imports.go:324-339`).

### Algorithm 2 — per-side classification (`classifySideImports`, `meat/imports.go:476-506`)

1. If this side starts inside a continuation left open by a prior (unseen)
   hunk, hide lines `[0, importContinuationEnd(...))` unconditionally first
   (Algorithm 4).
2. Compute the side's embedded-source flags once (`embeddedSourceLines`,
   Algorithm 3).
3. Scan left to right with a cursor `i`, starting after any continuation
   prefix already hidden:
   a. If the line is embedded, cap the scan window to end just *before* the
      embedding's closer line (`embeddedSourceEnd`, Algorithm 3) — an import
      statement can never be judged to extend into or past the closing
      delimiter.
   b. Otherwise the scan window is the whole (uncapped) side.
   c. Ask `importStatementEnd(scanLines, i, language, embedded[i])` (per-
      language table below) for the exclusive end of an import statement
      starting at `i`.
   d. If there is no match, advance `i` by one and retry from the next line.
   e. Otherwise hide `[i, end)` and jump the cursor to `end`.

### Algorithm 3 — embedded source detection (`meat/imports.go:616-681`)

`embeddedSourceLines(lines, language)` walks the side once, tracking two
independent pieces of state that persist across lines within this side's own
sequence (not across sides, not across hunks):

1. **Python/Java triple-quote state** (`pythonTripleState`, shared machinery
   from `python.go`): advanced one side-line at a time via
   `scanPythonTripleLine`. Reused for Java because Java text blocks use the
   identical `"""`/`'''` triple-quote delimiter syntax — a deliberate
   cross-language reuse, not a Python-specific case leaking into Java.
2. **Go/JS backtick state**: advanced by `countCodeBackticks(line.text) % 2`,
   toggled once per line with an odd backtick count.
   `countCodeBackticks` (`meat/imports.go:643-681`) is a single-line,
   stateless-across-calls scanner: it tracks single/double-quoted regions
   (with backslash-escape awareness) to avoid counting a backtick that sits
   inside an ordinary same-line string, stops counting entirely once it sees
   an un-quoted `//` (treating the rest of that physical line as a comment),
   and counts a backtick only if the number of immediately preceding
   backslashes is even (not escaped). It does not understand `/* */` block
   comments or regex literals — a bare backtick inside either could
   mis-toggle the tracked state (see Open questions).
3. **The off-by-one that defines the embedded window**: `flags[i]` is
   computed from the state as it stood *before* line `i` is scanned, then
   line `i` is scanned to update the state for the *next* line. Consequence:
   the line containing the opening delimiter is not itself flagged embedded
   (it is the host's own call/expression syntax); every line strictly
   between opener and closer is; the closer line is flagged embedded too
   (state hasn't flipped back yet when its own flag was read), even though
   `embeddedSourceEnd`'s caller then excludes that same closer line from the
   scan window it hands to `importStatementEnd` (Go's `lines[:limit]` is
   exclusive of `limit`, and `limit` is the closer's own index). Net effect:
   an import statement can be recognized on any line strictly between the
   opener and the closer, never on the opener or the closer itself.
4. If the closer is never seen (a truncated fixture, e.g. G9 case 3),
   `embeddedSourceEnd` returns the length of the side — the cap is simply "to
   the end of this side" — so a truncated import block is still recognized
   in full.

`strongEmbeddedImportCandidate(text, language)` (`meat/imports.go:729-739`)
is a separate, additional filter consulted only when a line is embedded
*and* the host hunk's own declared language failed to recognize it as one of
its own imports — i.e. only for the cross-language embedded fallback in
`importStatementEnd` (Algorithm 2 step c / table below), never for a line
being judged against its file's own declared language. It returns true
unconditionally for Go/Python/JS/Java, but for Rust requires `::`, `{`, or a
`pub use ` prefix, and for C requires a literal `<` or `"` somewhere in the
trimmed text. This is precisely why an embedded `use analytics;` (G9 case 2)
is rejected even though `rustUseEnd` alone would accept it as a complete
`use` statement (it ends in `;`) — the pre-filter never lets `rustUseEnd` be
tried at all, because `analytics;` contains none of `::`/`{`/`pub use `. The
same is true for an embedded `#include examples` against C's guard (no `<`
or `"`).

### Algorithm 4 — hunk-boundary continuation (`meat/imports.go:370-474`)

`hunkStartsImportContinuation(header, language)` decides, from the hunk
header's own trailing "section" hint text (`hunkSectionText`, everything
after the second `@@`, `meat/imports.go:395-403`) — not from the hunk body —
whether the diff was cut in the middle of a still-open import statement
whose opener lies in an earlier, unshown hunk. Per language: Go requires the
hint to be exactly `import (` (optionally with a trailing `//` comment) —
the same regex used for a body-line block opener. Python requires the hint
to parse as `from ... import (` with `(` as the very first character of the
import list. JS requires the hint to start with `import `, not already be a
syntactically complete side-effect/`from`/TS-require import, and have
strictly more open than closed brackets/braces/parens somewhere in it. Rust
requires a `use`/`pub use` start, a `{`, and no trailing `;`. C and Java
never produce a continuation hint — Java imports are always single-line by
grammar, and C's continuation mechanism is a same-hunk backslash line-join,
not a cross-hunk one.

This hint is not authority by itself (G13): `classifySideImports` only hides
`[0, importContinuationEnd(...))`, and `importContinuationEnd`
(`meat/imports.go:405-474`) independently re-validates the body — for each
language it re-derives the balance/terminator from the actual member lines
and returns `0` the moment a line doesn't look like a member. A `0` end
hides nothing. So a hunk header that merely resembles an unclosed import
("`@@ ... @@ import (`" over a body that is ordinary code) has zero effect
on hiding.

### Per-language decision table

| Language | Statement-end function | Start condition | Continuation / multi-line handling | Deliberately does **not** match |
|---|---|---|---|---|
| Go | `goImportEnd` `meat/imports.go:765-784` | `goImportSingleRE` (one `import "x"`/backtick-path line, optional alias, optional `//` comment) **or** `goImportBlockStartRE` (line is exactly `import (`) | Block: scan forward (cap 200 lines) accepting blank/`//`-comment/`goImportMemberRE` lines until `goImportBlockEndRE` (`)`) | A path that isn't quoted/backtick-delimited — prose like `import data` never matches at the grammar level in any language context, because the grammar itself requires a trailing string literal |
| Python | `pythonImportEnd`/`pythonContinuedImportEnd` `meat/imports.go:786-852` | `import ` prefix (`pythonImportListRE` on the rest) or `pythonFromStartRE` (`from ... import ...`) | Parenthesized list: paren-balance scan (cap 200). Backslash-continued list: join lines while each ends in `\` (cap 50). Both re-validate the joined member text against the appropriate list regex before accepting | A from-clause whose member list, once assembled, doesn't fully match `pythonFromListRE`/`pythonImportListRE` (aliases, `*`, comma lists only) |
| JS/TS | `javascriptImportEnd` / `javascriptRequireEnd` `meat/imports.go:861-920` | Statement-initial `import ` (not `import (`) for ES imports; statement-initial `require(`/`require (`, or a `const`/`let`/`var` destructure whose RHS is `require(...)`, for require forms | ES import: join lines (cap 80) until one of `javascriptSideEffectImportRE`/`javascriptFromImportRE`/`javascriptTSRequireImportRE` matches the accumulated text, gated at the first line on having an unclosed `{`/`[`/trailing `,`. Require: only attempted if the trimmed line starts with a require call directly, or is a `const`/`let`/`var` with a currently unbalanced `{`/`[` — then joins (cap 80) until `javascriptRequireRE` matches | `require.NoError` (no call parens), `useFeature`/`using(...)`/`app.use` (JS has no dedicated "use" grammar at all), `wrap(require("morgan"))` (require must be the statement's own start, not nested inside another call), a bare `} = source;` closing an unrelated destructure never started with `require(`, and prose `we import data from upstream` (must start with literal `import `) |
| Rust | `rustUseEnd` `meat/imports.go:922-946` | `rustUseStartRE` (optional `pub(...)`, then `use\s+`) **and** (ends in `;` **or** contains `{` **or** ends in `::`) | Grouped `use crate::{...}`: scan forward (cap 200) while `rustUseContinuationMemberRE` holds, stopping at a `;`-terminated line | `useFeature()`/`using(value)` (no whitespace after `use`, so the start regex itself never matches) and `use the imported value` (matches the start regex, but has neither a trailing `;` nor a `{`/`::`, so the second gate rejects it) |
| C/C++ | `cIncludeEnd` `meat/imports.go:948-959` | `cIncludeStartRE` (`#`, optional whitespace, `include` or `include_next`, then whitespace **or** `<`/`"`) | Backslash line-continuation: from the `#include` line itself (cap 50), keep consuming lines as long as the *previous* line ended in `\`, with no content validation at all on the continued lines — any text following a `\`-terminated include line is swallowed | A bare `#include identifier` with no `<`/`"` is **not** excluded here (only the embedded-fallback path requires `<`/`"` via `strongEmbeddedImportCandidate`) — see Open questions |
| Java/Kotlin | `javaImportEnd` `meat/imports.go:961-966` | Whole trimmed line matches `javaImportRE` in one shot — no continuation, ever | — (Java/Kotlin imports are always exactly one physical line) | Regex requires `import`/`import static` then a dotted identifier path; a trailing optional `as Alias` clause is present in the grammar specifically to admit Kotlin's import-aliasing (`.kt`/`.kts` share this language bucket, `meat/diff.go:446-447`) even though plain Java has no such syntax |

### Decision boundary — the two scan-cap fallback conventions

Every multi-line continuation scanner in this file bounds how far it looks
ahead, but two different things happen when the bound is hit, and a port
must reproduce the specific one for each function:

**Family A — "give up ⇒ swallow the rest as import."** If the loop exits
because it ran out of side-lines *or* hit its cap while every line examined
so far still looked like a plausible continuation member (never found a
rejecting line, never found a valid closer), the function returns the full
length of the side — the entire remainder, not just up to the cap, is
treated as import. This is what lets a genuinely truncated fixture (G9 case
3) still hide completely. It also means: if a pathological input had 200+
lines that all merely resemble import members with no closer ever
appearing, real code starting past the cap is never inspected and gets
silently swallowed into the "import" too.
- Go import block: cap 200, `meat/imports.go:773`, fallback `meat/imports.go:783`.
- Python parenthesized `from`/`import (...)`: cap 200, `meat/imports.go:811`,
  fallback `meat/imports.go:828`.
- Python backslash-continued: cap 50, `meat/imports.go:833`, fallback
  `meat/imports.go:846` — but only when every line remained
  backslash-continued to the cap; if a non-continued terminator line is
  found whose joined text fails to validate, this same function instead
  returns the statement's start (Family B) at `meat/imports.go:843` — one
  function exhibits both fallback conventions depending on why the loop
  ended.
- JS import (`import {...} from`): cap 80, `meat/imports.go:867`, fallback
  `meat/imports.go:888`.
- Rust grouped `use {...}`: cap 200, `meat/imports.go:933`, fallback
  `meat/imports.go:945`.
- C `#include` backslash continuation: cap 50, `meat/imports.go:953`,
  fallback `meat/imports.go:958` — and unlike every other scanner in this
  family, the per-line body of this loop has no content-rejection check at
  all: once the opening `#include ...\` line is accepted, every subsequent
  line is swallowed purely by whether the *previous* line ended in `\`,
  regardless of what it contains.

**Family B — "give up ⇒ not an import at all."** `javascriptRequireEnd`'s
cap loop (cap 80, `meat/imports.go:910`) falls through to returning the
statement's start (`meat/imports.go:919`) if no line up to the cap ever
completes a full `javascriptRequireRE` match — a `const`/`let`/`var`
destructure that looks like it might resolve to a `require(...)` but never
does within 80 lines is left entirely alone, not partially hidden.

No fixture in `imports_test.go` exercises any of these caps; the mechanism
itself — including the asymmetry between the two fallback conventions and
the single function that uses both — is now fully determined from source
(see Open questions).

### Algorithm 5 — whole guard-suite removal (`expandPythonImportOnlySuites`, `meat/imports.go:508-556`)

Operates on one side's classification in place. For each not-yet-hidden line
whose trimmed body is a guard opener (`isPythonImportGuard`: `try:` exactly,
or `if `/`with `/`async with `/`except` as a prefix, always ending in `:`,
`meat/imports.go:558-565`):

1. Record the opener's indentation width (count of leading literal
   space/tab bytes, tabs counted as 1 — not the 8-column tab expansion
   `moves.go` uses for its own indent comparisons; see Hazards).
2. Scan forward, line by line:
   - A blank/comment-only line is skipped without affecting the boundary.
   - A dedent below the opener's indent ends the scan (left the suite).
   - A line at exactly the opener's indent ends the scan unless it is itself
     a valid continuation clause (`isPythonImportGuardClause`: `else:`/
     `finally:` exactly, or `elif `/`except` as a prefix,
     `meat/imports.go:567-573`), in which case it is absorbed and scanning
     continues into its own body.
   - A deeper-indented line that is already hidden (by Algorithm 2) is
     absorbed and counted.
   - A deeper-indented line that is not hidden aborts the whole expansion
     for this owner — real content anywhere in any clause's body vetoes
     removing the entire multi-clause guard.
3. If the scan absorbed at least one import and found no un-hidden body
   content anywhere in the guard, hide the owner, every continuation-clause
   header, and every clause body line — the whole guard, in one shot.

This delivers whole-guard removal (G14) only, and is deliberately
all-or-nothing across every clause: a `try`/`except` pair where the `try`
body is import-only but the `except` body has real code does not qualify
here — instead, the individual import statement inside `try` was already
hidden by Algorithm 2 (independently of this function), leaving the `try:`
owner visible with an empty body. That specific shape — a visible owner
whose body an import-only removal has emptied — is what Algorithm 8
(`addMandatoryPythonSuitePlaceholders`, run at a different pipeline stage)
exists to patch with a placeholder. The two mechanisms are complementary,
not overlapping: this one deletes framing wholesale (G14); that one inserts
a placeholder into framing it left standing (G15).

### Algorithm 6 — blank-gap fill (`fillImportGroupGaps`, `meat/imports.go:575-614`)

Two independent left-to-right sweeps over one side's hidden array, in this
order:

1. **Cross-group bridging** (`meat/imports.go:576-596`): track the most
   recently seen hidden line. When a new hidden line is found, check every
   line strictly between it and the previous hidden line — if every one of
   them is blank, hide them too, merging the two import "groups" into one
   contiguous hidden run. A single non-blank line in the gap — including a
   bare comment — blocks the bridge; the comment (and everything in that
   gap) stays visible.
2. **Embedded trailing-blank absorption** (`meat/imports.go:598-613`): for
   each hidden run (after step 1), consume any immediately-following lines
   that are both blank and flagged embedded — blank lines that sit inside a
   source-string fixture right after a dropped import group are removed so
   the fixture doesn't retain empty debris; an ordinary (non-embedded) blank
   line after an import group is left alone, available for the model's own
   folding.

This resolves stage 1's "blank gap fill" open question: the mechanism is
fully determined (comment-sensitive bridging between hidden runs, plus a
second, embedded-only pass for trailing blanks) — no fixture pins the exact
boundary, so coverage remains a gap, but the behavior itself is no longer
ambiguous.

### Algorithm 7 — decision boundary (`isImportOnlyFramingRow`, `meat/imports.go:274-300`)

A changed row (with its diff marker already stripped) counts as "framing" —
collapsible alongside genuine import rows without vetoing whole-hunk removal
— iff:
- its trimmed text is empty, for any language, unconditionally; or
- the hunk's changes are one-sided (`hunkChangesOnlyOneSide`,
  `meat/imports.go:257-272`: exactly one of `+`/`-` appears among the hunk's
  change rows, never both) **and** the language is Go or Java **and** the
  trimmed text is `package <dotted-ASCII-identifier>` (each dot-segment
  validated byte-by-byte against `isIdentifierStart`/`isIdentifierContinue`,
  `meat/editplan.go:472-478` — ASCII letters/digits/underscore only, no
  Unicode identifiers).

Any other language, any two-sided hunk, or any non-`package` text fails this
check and blocks the hunk-wide collapse (Algorithm 1 step 5) for that hunk.

### Algorithm 8 — `addMandatoryPythonSuitePlaceholders` (`meat/imports.go:12-55`)

Runs once over the whole diff, after a plan (model or identity) has been
merged into plan state. For each line acting as a candidate suite owner:

1. Require: Python-tagged, currently visible, hunk source, at least 2 bytes,
   not itself a removed (`-`) row, and not inside an already-open
   triple-quoted string.
2. Require its trimmed body to be a suite-header start (`def`/`async def`/
   `class`/`if`/`elif`/`for`/`while`/`with`/`except`/`except*`/`match`/
   `case`/`async for`/`async with`, or bare `else:`/`try:`/`except:`/
   `finally:`).
3. Locate the header's own terminator (tracking round/square/curly bracket
   depth so a multi-line `def` signature is skipped correctly) within the
   owner's containing hunk; skip if none is found.
4. Compare the body with all hiding ignored against the body with the real
   merged state applied: proceed only if the unhidden view had a
   deeper-indented line and the hidden view now has none — i.e. hiding is
   exactly what emptied this owner.
5. Search forward from just after the header terminator, within the same
   hunk, for the first line that is compiler-mandatory, currently hidden,
   hunk source, non-removed, non-blank, and indented strictly deeper than
   the owner. Synthesize a one-line fold at exactly that line, tagged
   `planIndex: -1` (compiler-authored, no model plan index), carrying that
   line's own marker and leading-indent text (not the owner's) and EOL, and
   stop after the first such line — at most one placeholder per owner, even
   if several mandatory lines sit in the body.

Called from `editplan.go:262` (whole-diff, after model removes/folds are
merged, before move-symmetry validation) and independently from
`chunk.go:180` (per-chunk, against the chunk's own precomputed whole-diff
mandatory mask) — the two call sites reproduce the identical algorithm
against differently-scoped state, not two different algorithms.

### Algorithm 9 — `stateWithMandatoryImportsRepresented` (`meat/imports.go:61-93`)

Builds a throwaway clone of plan state (deep-copies `hidden`/`folded`/
`foldAt`; shares the underlying folds slice, safe because this function only
*clears* fold references, never adds one) used only to feed the four Python
structural validators (`editplan.go:270-281`) — never used for rendering.
Per hunk: if the hunk has at least one non-mandatory hunk-source row that is
genuinely represented (visible or folded) in the real state, then every
mandatory row in that hunk is forced to look fully present (unhidden,
unfolded) for the validators' purposes only. A hunk with no such
non-mandatory visible content is left untouched. Ordering dependency: this
runs (`editplan.go:269`) before `completeMandatoryImportFraming`
(`editplan.go:378`) — at validation time an all-mandatory hunk has not yet
been collapsed to an explicit shell, so the "have visible non-import content"
gate is what correctly distinguishes "this hunk needs its imports faked
present so its other content validates correctly" from "this hunk is pure
import and needs nothing faked."

### Algorithm 10 — `completeMandatoryImportFraming` (`meat/imports.go:98-149`)

Runs last (`editplan.go:378`), after all model removes/folds/replacements
and all validation. Unlike Algorithm 1 step 5 (which decides collapse from
raw text via `isImportOnlyFramingRow`), this decides collapse from the
actual compiled state: a hunk containing at least one mandatory-import row
is hidden in full if no change row in it remains represented (visible or
folded) once the model's own edits are accounted for. This means a hunk that
mixed a mandatory import with behavioral rows the model chose to remove/fold
entirely will also collapse here, even though `isImportOnlyFramingRow` alone
would never have allowed it — a strictly later, state-driven second chance
at collapse, not the same rule reapplied. The matching file-level pass
repeats the same "every hunk header still un-represented" check.

## Invariants

- Mandatory rows are never model-addressable. An explicit `Remove`/`Fold`/
  `Replace` on a mandatory row is silently accepted-and-ignored
  (`meat/editplan.go:228-235,291-296`), never an error. Breaking this would
  desynchronize every guarantee in this file that depends on the mask being
  immune to plan content (G1, G7-G22), and would desynchronize `imports.go`'s
  output from `moves.go`'s symmetry canonicalization, which also treats
  mandatory rows as unconditionally removed (see `moves.md`).
- The per-side classification order is load-bearing: statement
  classification → guard-suite expansion → gap-fill, always in that order,
  per side, per hunk (Algorithm 1 step 3). Running gap-fill before
  guard-suite expansion would miss gaps that only exist once a whole guard
  becomes hidden; running guard-suite expansion before statement
  classification would have nothing to check "have an import" against.
- Embedded-region capping excludes the closer line from the import scan
  window, even though the closer line is itself flagged embedded (Algorithm
  3). An import-statement scanner allowed to run into a fixture's closing
  delimiter line could misclassify trailing host syntax on that same
  physical line as part of the import.
- `strongEmbeddedImportCandidate` gates only the cross-language embedded
  fallback, never a hunk's own declared language. Applying it universally
  would stop recognizing an ordinary single-item Rust `use foo;` in a real
  `.rs` file, since `use foo;` contains none of `::`/`{`/`pub use ` — a file's
  own language is governed by `rustUseEnd`'s own semicolon/brace/`::` gate,
  not by the embedded-strength test.
- A full-hunk import-only collapse hides every row in the hunk, including
  context rows that were never individually inspected. A port that "improves"
  this by only hiding the actual import rows plus blank framing would diverge
  from G16 case 1's exact behavior, retaining context the current
  implementation discards — a behavior change either way must be deliberate,
  not an accident of a more careful-looking reimplementation.
- Placeholder synthesis is one per owner and stops at the first qualifying
  line. Synthesizing one per hidden mandatory line instead would produce
  multiple `...` rows under one owner where the source emits exactly one,
  breaking G5/G15's exact-count assertions.

## Hazards

- **H1** (byte offsets): this file is one of `HAZARDS.md`'s named
  concentration points. Every classification decision indexes raw bytes: the
  leading diff-marker strip (`line.text[1:]`, e.g. `meat/imports.go:20,38,364`),
  the marker read (`lines[i].text[0]`, e.g. `meat/imports.go:186,264,362`),
  and the byte-wise scanner `countCodeBackticks`
  (`meat/imports.go:643-681`), which does its own byte-indexed quote/
  backslash-parity walk. All of it is ASCII-anchored (diff markers, Python
  `#`, Go/JS backtick/quote bytes), so it is position-safe under either a
  consistent byte or a consistent UTF-16 indexing scheme individually — the
  risk is the cross-file one `HAZARDS.md` already names: if `sourceLine.text`
  becomes a JS string measured by `.length` anywhere downstream, every
  offset this file's mask is built from silently drifts on non-ASCII
  content.
- **H3(a)** does not apply: no pattern here is assembled at runtime from
  untrusted (model-authored) text; every regex is a package-level `var`,
  compiled once.
- **H3(b)**: applies to all 18 patterns declared at `meat/imports.go:742-762`
  — every `\s` token means Go's `[\t\n\f\r ]`, and every pattern here is
  ASCII-anchored, so `\s` is the only token that needs rewriting when
  porting. This is the single largest concentration of `\s` usage named in
  `HAZARDS.md` for the whole codebase: `goImportBlockStartRE` (2),
  `goImportBlockEndRE` (1), `goImportMemberRE` (2), `goImportSingleRE` (3),
  `pythonImportListRE` (6), `pythonFromStartRE` (3), `pythonFromListRE` (6),
  `javascriptSideEffectImportRE` (3), `javascriptFromImportRE` (7),
  `javascriptTSRequireImportRE` (9), `javascriptRequireRE` (11),
  `javascriptRequireStartRE` (4), `javascriptImportContinuationMemberRE` (3),
  `javascriptImportContinuationEndRE` (3), `rustUseStartRE` (3),
  `rustUseContinuationMemberRE` (3), `cIncludeStartRE` (2), `javaImportRE`
  (6).
- **H3(c)** (offsets): inert here specifically — the one capturing regex
  call (`pythonFromStartRE.FindStringSubmatch`, `meat/imports.go:379,792`)
  never feeds its match into further offset arithmetic against the original
  bytes, only into further string comparisons on the captured text itself.
- **H2** (rune iteration / Unicode properties): does not apply to this file.
  No `[]rune` conversion, no `for _, r := range <string>`, and no
  `unicode.*` call anywhere in `imports.go` — every `range` here is over a
  slice or a fixed literal list, not a string. Contrast `moves.go`, which
  depends on H2 for its own indent/substantive-content logic.
- **H7 / H13** (sort stability / map iteration): do not apply. This file
  contains no `sort.*` call. Its two maps (`sideMasks`, `meat/imports.go:168`,
  and its inner per-side map, `meat/imports.go:174`) are only ever written
  and then read by direct key lookup — never ranged over — so there is no
  map-iteration-order dependency.
- **H16** (indentation-width conventions): `expandPythonImportOnlySuites`'s
  and `addMandatoryPythonSuitePlaceholders`'s own indent comparisons
  (`meat/imports.go:29,39,520,531`) use the raw-byte-count convention (one
  column per leading space or tab byte), the same convention `python.go`
  and `editplan.go` use and `moves.go` deliberately does not — see
  `migration/HAZARDS.md` H16 for the full cross-file picture.

## Errors

This file raises no errors of its own: no `fmt.Errorf`, `errors.New`, or
`panic` anywhere in `imports.go` — every function here either returns a
classification (bool/int/range list) or mutates plan state directly. The two
error strings that are consequences of this file's output are both raised in
`editplan.go`, gated on values this file produces:

- **Fold crosses mandatory and behavioral rows**: `"fold[%d]: crosses
  automatically removed import rows and behavioral rows in range %d-%d; fold
  only the behavioral rows"` — raised when a model `Fold` range overlaps the
  mandatory mask on some but not all of its lines (`meat/editplan.go:230`,
  gated on the mandatory mask this file produces). Already G18 above.
- **Move symmetry against a mandatory-extended mask**: the move-symmetry
  error family owned by `moves.go` (see `moves.md`) is triggered, in the
  mandatory-import case, entirely by this file's mask being what
  move-precedence extension extends before symmetry validation runs.

## Ordering Go leaves unspecified

None. Every algorithm in this file is a deterministic, single-pass,
left-to-right scan over slices or fixed-order literals; no map is ever
iterated (only key-indexed); no sort ever runs. This mirrors `diff.md`'s
finding — `imports.go` has nothing analogous to `moves.go`'s or `chunk.go`'s
sort-stability concerns (H7) or `openai.go`'s map-iteration concern (H13).

## Open questions

- **No-newline marker** forced hidden when its owner import is hidden
  `meat/imports.go:221-226` — present in source, not asserted by
  `imports_test.go`.
- **`stateWithMandatoryImportsRepresented`** (validation sees imports as
  present; render does not) `meat/imports.go:61-93` — untested directly.
- **Multi-file diffs** (one import-only file next to a behavioral file) —
  not constructed in `imports_test.go`.
- **Backslash-continued** Python imports / C `#include` line continuations;
  **`#include_next`**; JS **side-effect** `import "x"`; TS
  `import x = require(...)` — untested language corners.
- **Scan length caps** (e.g. Go block ≤200 members, JS join ≤80 lines) —
  present in source, untested.
- **Blank gap fill** between import groups in ordinary (non-embedded)
  source `meat/imports.go:575-596` — only indirectly exercised.
- Move-precedence extension of mandatory hiding across move counterparts is
  covered in `moves.md` G19–G21 / `chunk.md` G34, not re-proven here.

### Stage 2 findings

Resolution of the items above, now that the mechanism is fully traced:

- **No-newline marker** — mechanism confirmed exactly as simple as it looks
  (Algorithm 1 step 6, a direct consequence of `diff.go`'s `markerOwner`
  invariant). Remains untested; nothing more to add.
- **`stateWithMandatoryImportsRepresented`** — mechanism fully specified
  (Algorithm 9), including the precise per-hunk gate and its ordering
  dependency relative to `completeMandatoryImportFraming`. Remains untested
  directly, but is no longer opaque.
- **Multi-file diffs** — mechanism handles this uniformly:
  `importFileSections` partitions by `fileID`, and every collapse loop
  (hunk-level and file-level) iterates all sections/hunks independently,
  with no special-casing tied to file count. Answered at the mechanism
  level; the remaining gap is fixture coverage, not an unknown mechanism.
- **Backslash-continued Python imports; C `#include` continuations;
  `#include_next`; JS side-effect `import "x"`; TS
  `import x = require(...)`** — all five have real, traced mechanism in
  this file (`pythonContinuedImportEnd`'s backslash branch; `cIncludeEnd`'s
  backslash loop and `cIncludeStartRE`'s `(?:_next)?`;
  `javascriptSideEffectImportRE`; `javascriptTSRequireImportRE`). Code
  exists for all five; these remain coverage gaps, not missing mechanism.
- **Scan length caps** — substantially sharpened, not just confirmed
  present: see "the two scan-cap fallback conventions" under Mechanism. The
  caps are not uniform truncation — two distinct fallback conventions exist
  (swallow-the-rest vs. give-up-entirely), and `pythonContinuedImportEnd`'s
  backslash branch uses both depending on why its loop ended. This is a
  higher-value, more specific open question than before; recommend keeping
  it open with this refined framing.
- **Blank gap fill** — mechanism fully specified as two ordered sweeps
  (Algorithm 6): comment-sensitive bridging between hidden runs, then a
  second, embedded-only pass for trailing blanks. Answered at the mechanism
  level; fixture coverage remains a separate gap.

New items found while tracing mechanism, not covered by any guarantee above:

- **Full-hunk import-only collapse discards unexamined context rows**
  (Mechanism Algorithm 1 step 5; Invariants). G16 case 1 is delivered
  correctly, but the guarantee's own fixture has no incidental context
  lines around its import block, so the reach of the mechanism is broader
  than the guarantee states. Open question: does an import-only hunk that
  also carries genuinely unrelated context lines (orientation lines around
  the import block, unrelated to it) lose that context on collapse, and is
  that intended? No fixture in `imports_test.go` constructs this shape.
- **`cIncludeEnd`'s backslash continuation has no content validation at
  all** once triggered (`meat/imports.go:948-959`) — any text on a
  continued line, however unlike a header path, is swallowed as long as the
  previous line ended in `\`. Sharper than "untested": it is unconditional
  once started, not merely unvalidated.
- **A bare, undelimited `#include identifier` line in a real (non-embedded)
  `.c`/`.cpp` file is classified as import scaffolding**, because
  `cIncludeStartRE`'s alternation accepts plain whitespace after `include`
  — only the embedded fallback path additionally requires `<`/`"`
  (`strongEmbeddedImportCandidate`). G10's "`#include examples` retained"
  fixture is the unknown-language case, where the language switch never
  reaches `cIncludeEnd` at all, so this is untested for a real C file
  either way.
- **`javaImportRE` accepts a Kotlin-only `as Alias` clause**
  (`meat/imports.go:762`) that is not valid Java grammar — deliberate,
  since `.kt`/`.kts` share the Java language bucket, but no fixture
  exercises an aliased Kotlin import.
- **Package-identifier validation in `isImportOnlyFramingRow` is
  ASCII-only** (`meat/imports.go:289-298`) — a non-ASCII package/module
  segment would fail the framing check and block hunk collapse. G12's
  fixtures are ASCII throughout, so this is untested in either direction.
- **Per-side embedded tracking can disagree across sides** when a fixture
  literal's own opener/closer delimiters are themselves edited
  asymmetrically (e.g. the opener is removed-only, the closer is
  added-only) — each side's `embeddedSourceLines` call filters to that
  side's own lines first, so one side's scan may never see the other
  side's opener/closer, and the two sides' embedded windows could
  genuinely disagree. No fixture edits a fixture literal's own delimiters
  asymmetrically across sides.
- **`countCodeBackticks` understands neither `/* */` block comments nor
  regex literals** — a bare backtick inside either could mis-toggle the
  tracked backtick-string state for the rest of the side. No fixture
  constructs this.
- **`goImportMemberRE`/`goImportSingleRE` accept a bare `_` or `.` as the
  import alias** (blank and dot imports, both legal Go) — correct per Go
  grammar, but G7's Go fixture exercises neither alias form.
- **`stateWithMandatoryImportsRepresented`'s "have visible non-import"
  gate is per-hunk, not per-clause or per-line** — a hunk with one visible
  non-import row anywhere unmasks every mandatory row in that whole hunk
  for validation purposes, not just rows structurally near the visible
  row. Untested distinction; likely harmless given the validators' own
  scope, but not proven so from source alone.

Dead or unreachable code: none found. Every function and package-level
regex `var` in `imports.go` has at least one production call site reached
from the chain rooted at `mandatoryImportRemovalPlan`, confirmed by grep
across all non-test files in `meat/`.
