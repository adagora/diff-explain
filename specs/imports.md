# imports

> Status: stage 1 ✅ | stage 2 ⬜
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
