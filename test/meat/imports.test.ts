// Ported from meat/imports_test.go. The Go tests assert against
// `compiled.smartDiff` (compileEditPlan's rendered output), but `editplan.ts`
// (item 4i) is not built yet — mandatoryImportRemovalPlan's output alone
// fully determines that rendering for every fixture below, since each Go
// test compiles against `editPlan{}` (no model edits at all). With an empty
// plan, `planState.hidden` is seeded from exactly this mask and nothing else
// touches it (`completeMandatoryImportFraming` only ever hides *more* lines
// when a model edit removed something the mask alone did not already
// collapse — see this file's own direct tests of that function below for the
// case where it does). So "line contains substring X is/isn't hidden" is a
// faithful, line-granular restatement of "smartDiff does/doesn't contain X".
//
// G17-G21 (merge with model plans, agent-loop/tool surfaces) need
// editplan.ts/tools.ts/meat.ts and are deferred to those items' own test
// files, per TODO.md item 4h.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { splitSourceLines, analyzeDiff, type SourceLine, type DiffLayout } from "../../src/meat/diff.ts";
import { newPlanState, type PlanState, type LineRange } from "../../src/meat/plan.ts";
import {
  mandatoryImportRemovalPlan,
  mandatoryRemovalMask,
  hiddenLineRanges,
  importFileSections,
  addMandatoryPythonSuitePlaceholders,
  stateWithMandatoryImportsRepresented,
  completeMandatoryImportFraming,
} from "../../src/meat/imports.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);

interface Classified {
  readonly lines: SourceLine[];
  readonly layout: DiffLayout;
  readonly ranges: LineRange[];
  readonly hidden: boolean[];
}

function classify(diff: Uint8Array): Classified {
  const lines = splitSourceLines(diff);
  const layout = analyzeDiff(lines);
  const ranges = mandatoryImportRemovalPlan(lines, layout);
  const hidden = mandatoryRemovalMask(lines.length, ranges);
  return { lines, layout, ranges, hidden };
}

function lineIndex(lines: readonly SourceLine[], substring: string): number {
  return lines.findIndex((l) => decodeUTF8(l.text).includes(substring));
}

function assertHidden(c: Classified, substrings: readonly string[]): void {
  for (const substring of substrings) {
    const idx = lineIndex(c.lines, substring);
    assert.notEqual(idx, -1, `no physical line contains ${JSON.stringify(substring)}`);
    assert.equal(c.hidden[idx], true, `expected ${JSON.stringify(substring)} (line ${idx}: ${JSON.stringify(decodeUTF8(c.lines[idx]!.text))}) to be mandatory-hidden`);
  }
}

function assertVisible(c: Classified, substrings: readonly string[]): void {
  for (const substring of substrings) {
    const idx = lineIndex(c.lines, substring);
    assert.notEqual(idx, -1, `no physical line contains ${JSON.stringify(substring)}`);
    assert.equal(c.hidden[idx], false, `expected ${JSON.stringify(substring)} (line ${idx}: ${JSON.stringify(decodeUTF8(c.lines[idx]!.text))}) to stay visible`);
  }
}

function assertDeterministic(diff: Uint8Array): void {
  const lines = splitSourceLines(diff);
  const layout = analyzeDiff(lines);
  const first = mandatoryImportRemovalPlan(lines, layout);
  const second = mandatoryImportRemovalPlan(lines, layout);
  assert.ok(first.length > 0, "mandatory plan is unexpectedly empty");
  assert.deepEqual(first, second, "mandatory plan is nondeterministic");
}

// ===========================================================================
// hiddenLineRanges / mandatoryRemovalMask — low-level run-length codec
// ===========================================================================

describe("hiddenLineRanges / mandatoryRemovalMask (meat/imports.go:324-349)", () => {
  test("no hidden lines -> no ranges", () => {
    assert.deepEqual(hiddenLineRanges([false, false, false]), []);
  });

  test("single contiguous run", () => {
    assert.deepEqual(hiddenLineRanges([false, true, true, true, false]), [{ startLine: 2, endLine: 4 }]);
  });

  test("multiple runs, including a run touching the end", () => {
    assert.deepEqual(hiddenLineRanges([true, false, true, true, false, true]), [
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 4 },
      { startLine: 6, endLine: 6 },
    ]);
  });

  test("mandatoryRemovalMask round-trips hiddenLineRanges", () => {
    const hidden = [true, false, true, true, false, true];
    const ranges = hiddenLineRanges(hidden);
    assert.deepEqual(mandatoryRemovalMask(hidden.length, ranges), hidden);
  });
});

// ===========================================================================
// importFileSections (meat/imports.go:252-322)
// ===========================================================================

describe("importFileSections (meat/imports.go:302-322)", () => {
  test("single file: one section spanning the whole diff", () => {
    const diff = s("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n");
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const sections = importFileSections(layout);
    assert.deepEqual(sections, [{ start: 0, end: lines.length }]);
  });

  test("two files: two disjoint sections split at the second diff --git", () => {
    const diff = s(
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n" +
        "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@\n+import sys\n",
    );
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const sections = importFileSections(layout);
    assert.equal(sections.length, 2);
    const secondHeader = lineIndex(lines, "diff --git a/b.py");
    assert.equal(sections[0]!.start, 0);
    assert.equal(sections[0]!.end, secondHeader);
    assert.equal(sections[1]!.start, secondHeader);
    assert.equal(sections[1]!.end, lines.length);
  });
});

// ===========================================================================
// G7: recognized import declarations stripped per language, non-import
// behavior retained (meat/imports_test.go:11-87)
// ===========================================================================

describe("mandatoryImportRemovalPlan — G7 by language (meat/imports_test.go:11-87)", () => {
  test("Go import block", () => {
    const diff = s(
      "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@\n+package a\n+\n+import (\n+\t\"fmt\"\n+\talias \"example.com/a\"\n+)\n+\n+func run() { fmt.Println(alias.Value) }\n",
    );
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+package a", "+func run()"]);
    assertHidden(c, ["import (", `"fmt"`, `"example.com/a"`, "+)"]);
  });

  test("Python import and multiline from import", () => {
    const diff = s(
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+from package.tools import (\n+    first,\n+    second as renamed,\n+)\n+import os, sys\n+\n+value = first(renamed, os.name, sys.version)\n",
    );
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+value = first"]);
    assertHidden(c, ["from package.tools import", "second as renamed", "import os, sys"]);
  });

  test("JavaScript static import and multiline require", () => {
    const diff = s(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+import {\n+  first,\n+  second,\n+} from \"./tools\";\n+const {\n+  third,\n+} = require(\"./more\");\n+\n+export const value = first(second, third);\n",
    );
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+export const value"]);
    assertHidden(c, ["import {", `from "./tools"`, "const {", `require("./more")`]);
  });

  test("Rust use declarations", () => {
    const diff = s(
      "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@\n+use crate::{\n+    first,\n+    second,\n+};\n+pub(crate) use other::Third;\n+\n+fn run() { first(second(), Third); }\n",
    );
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+fn run()"]);
    assertHidden(c, ["use crate", "pub(crate) use", "+};"]);
  });

  test("C and C++ includes", () => {
    const diff = s("diff --git a/a.cpp b/a.cpp\n--- a/a.cpp\n+++ b/a.cpp\n@@\n+#include <vector>\n+# include \"local.h\"\n+\n+int run() { return local_value(); }\n");
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+int run()"]);
    assertHidden(c, ["#include", `# include "local.h"`]);
  });

  test("Java imports", () => {
    const diff = s(
      "diff --git a/A.java b/A.java\n--- a/A.java\n+++ b/A.java\n@@\n+package example;\n+import java.util.List;\n+import static java.util.Collections.emptyList;\n+class A { List<String> run() { return emptyList(); } }\n",
    );
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+package example", "+class A"]);
    assertHidden(c, ["import java.util", "import static"]);
  });

  test("Kotlin imports", () => {
    const diff = s("diff --git a/A.kt b/A.kt\n--- a/A.kt\n+++ b/A.kt\n@@\n+package example\n+import tools.first\n+import tools.second as renamed\n+fun run() = first(renamed)\n");
    assertDeterministic(diff);
    const c = classify(diff);
    assertVisible(c, ["+package example", "+fun run()"]);
    assertHidden(c, ["import tools.first", "import tools.second"]);
  });
});

// ===========================================================================
// G8: per-side classification, context hides only when both sides agree
// (meat/imports_test.go:89-105)
// ===========================================================================

test("G8: mandatory imports cover both diff sides (meat/imports_test.go:89-105)", () => {
  const diff = s(
    "diff --git a/token.go b/token.go\n--- a/token.go\n+++ b/token.go\n@@\n package token\n import (\n \t\"fmt\"\n-\t\"math/rand\"\n+\t\"crypto/rand\"\n+\t\"encoding/hex\"\n )\n-old := fmt.Sprintf(\"%x\", value)\n+new := hex.EncodeToString(value)\n",
  );
  const c = classify(diff);
  assertHidden(c, ["import (", `"fmt"`, `"math/rand"`, `"crypto/rand"`, `"encoding/hex"`, " )"]);
  assertVisible(c, ["-old := fmt.Sprintf", "+new := hex.EncodeToString"]);
});

// ===========================================================================
// G9: embedded source detection (meat/imports_test.go:107-155)
// ===========================================================================

describe("G9: embedded source imports (meat/imports_test.go:107-155)", () => {
  test("Python triple-quoted fixture inside pytester.makeconftest", () => {
    const diff = s(
      "diff --git a/test_plugin.py b/test_plugin.py\n--- a/test_plugin.py\n+++ b/test_plugin.py\n@@\n" +
        "+def test_plugin(pytester):\n" +
        "+    pytester.makeconftest(\n" +
        '+        """\n' +
        "+        from plugin import (\n" +
        "+            hook,\n" +
        "+            option,\n" +
        "+        )\n" +
        "+        import warnings\n" +
        "+        import pytest\n" +
        "+\n" +
        "+        @pytest.hookimpl(tryfirst=True)\n" +
        "+        def pytest_configure():\n" +
        "+            warnings.warn(option, UserWarning)\n" +
        '+        """\n' +
        "+    )\n" +
        "+    result = pytester.runpytest()\n" +
        "+    assert result.ret == 0\n",
    );
    const c = classify(diff);
    assertHidden(c, ["from plugin import", "+            hook,", "+            option,", "import warnings", "import pytest"]);
    assertVisible(c, ["+        @pytest.hookimpl", "+        def pytest_configure", "+            warnings.warn", "+    result = pytester.runpytest"]);
  });

  test("Go raw-string fixture with mixed-language weak candidates rejected", () => {
    const diff = s(
      "diff --git a/plugin_test.go b/plugin_test.go\n--- a/plugin_test.go\n+++ b/plugin_test.go\n@@\n" +
        "+const fixture = `\n" +
        "+import pytest\n" +
        '+const helper = require("./helper").default;\n' +
        "+use analytics;\n" +
        "+#include examples\n" +
        "+run(helper)\n" +
        "+`\n" +
        "+func TestFixture() { execute(fixture) }\n",
    );
    const c = classify(diff);
    assertHidden(c, ["import pytest", `require("./helper")`]);
    assertVisible(c, ["+use analytics;", "+#include examples", "+run(helper)", "+func TestFixture"]);
  });

  test("truncated Go raw-string import block still hides in full", () => {
    const diff = s(
      "diff --git a/generated_test.go b/generated_test.go\n--- a/generated_test.go\n+++ b/generated_test.go\n@@\n" +
        "+const source = `\n" +
        "+import (\n" +
        '+    "fmt"\n' +
        "+`\n" +
        "+func TestGenerated() { check(source, behavior()) }\n",
    );
    const c = classify(diff);
    assertHidden(c, ["import (", `"fmt"`]);
    assertVisible(c, ["+`", "+func TestGenerated()"]);
  });
});

// ===========================================================================
// G10: conservative false-positive resistance (meat/imports_test.go:157-192)
// ===========================================================================

describe("G10: false positives are not stripped (meat/imports_test.go:157-192)", () => {
  test("JavaScript lookalikes", () => {
    const diff = s(
      "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@\n" +
        "+require.NoError(t, err);\n" +
        "+useFeature();\n" +
        "+using(resource);\n" +
        '+const middleware = wrap(require("morgan"));\n' +
        "+app.use(middleware);\n" +
        "+const {\n" +
        "+  value,\n" +
        "+} = source;\n" +
        "+consume(value);\n" +
        '+const note = "we import data from upstream";\n',
    );
    const c = classify(diff);
    assertVisible(c, [
      "require.NoError",
      "useFeature",
      "using(resource)",
      "wrap(require",
      "app.use",
      "} = source",
      "consume(value)",
      "we import data from upstream",
    ]);
  });

  test("Rust lookalikes", () => {
    const diff = s('diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@\n+useFeature();\n+using(value);\n+let prose = "use the imported value";\n');
    const c = classify(diff);
    assertVisible(c, ["useFeature", "using(value)", "use the imported value"]);
  });

  test("unknown-language prose file", () => {
    const diff = s(
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@\n+import data from the upstream service before rendering.\n+use feature flags for rollout.\n+#include examples in the guide.\n",
    );
    const c = classify(diff);
    assertVisible(c, ["import data", "use feature", "#include examples"]);
  });
});

// ===========================================================================
// G11: JS require doesn't consume a preceding unrelated destructure
// (meat/imports_test.go:194-210)
// ===========================================================================

test("G11: JavaScript require does not consume the previous statement (meat/imports_test.go:194-210)", () => {
  const diff = s(
    "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@\n" +
      "+const {\n" +
      "+  timeout,\n" +
      "+} = options;\n" +
      "+const {\n" +
      "+  readFile,\n" +
      '+} = require("fs");\n' +
      "+consume(timeout, readFile);\n",
  );
  const c = classify(diff);
  assertVisible(c, ["+const {", "+  timeout,", "+} = options;", "+consume(timeout, readFile);"]);
  assertHidden(c, ["readFile,", `require("fs")`]);
});

// ===========================================================================
// G12: two-sided package renames keep package rows visible
// (meat/imports_test.go:212-230)
// ===========================================================================

describe("G12: mandatory imports preserve package renames (meat/imports_test.go:212-230)", () => {
  test("Go", () => {
    const diff = s("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@\n-package oldname\n+package newname\n-import \"old\"\n+import \"new\"\n");
    const c = classify(diff);
    assertVisible(c, ["-package old", "+package new"]);
    assertHidden(c, [`-import "old"`, `+import "new"`]);
  });

  test("Java", () => {
    const diff = s(
      "diff --git a/A.java b/A.java\n--- a/A.java\n+++ b/A.java\n@@\n-package old.name;\n+package new.name;\n-import old.Value;\n+import new.Value;\n",
    );
    const c = classify(diff);
    assertVisible(c, ["-package old", "+package new"]);
    assertHidden(c, ["-import old.Value", "+import new.Value"]);
  });
});

// ===========================================================================
// G13: hunk header section text is not authority over hunk body rows
// (meat/imports_test.go:232-267)
// ===========================================================================

describe("G13: hunk section import hint is not authority (meat/imports_test.go:232-267)", () => {
  test("Go incomplete-looking section", () => {
    const diff = s("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -10,0 +11,2 @@ import (\n+work()\n+done()\n");
    const c = classify(diff);
    assertVisible(c, ["+work()", "+done()"]);
  });

  test("JavaScript complete import section", () => {
    const diff = s('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,1 +10,2 @@ import { render } from "./render";\n const root = document.body;\n+render(root);\n');
    const c = classify(diff);
    assertVisible(c, [" const root", "+render(root)"]);
  });

  test("Rust complete use section", () => {
    const diff = s("diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -10,1 +10,2 @@ use crate::{Bar, Baz};\n let value = compute();\n+consume(value);\n");
    const c = classify(diff);
    assertVisible(c, [" let value", "+consume(value)"]);
  });
});

// ===========================================================================
// G14/G15: Python import-only guard suites (meat/imports_test.go:269-297)
// ===========================================================================

describe("G14/G15: guarded Python imports (meat/imports_test.go:269-297)", () => {
  test("G14: whole import-only guard suite removed", () => {
    const diff = s(
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n" +
        "+try:\n" +
        "+    import ujson as json\n" +
        "+except ImportError:\n" +
        "+    import json\n" +
        "+if TYPE_CHECKING:\n" +
        "+    from models import Payload\n" +
        "+value: Payload = json.loads(data)\n",
    );
    const c = classify(diff);
    assertHidden(c, ["+try:", "except ImportError", "TYPE_CHECKING", "import ujson", "+    import json", "from models import"]);
    assertVisible(c, ["+value: Payload = json.loads(data)"]);
  });

  test("G15: mixed guard hides only the import, preserves the suite skeleton", () => {
    const diff = s(
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n" + "+try:\n" + "+    import fast_json\n" + "+except ImportError:\n" + "+    fast_json = None\n" + "+value = fast_json\n",
    );
    const c = classify(diff);
    assertHidden(c, ["import fast_json"]);
    assertVisible(c, ["+try:", "+except ImportError:", "+    fast_json = None", "+value = fast_json"]);
  });
});

// ===========================================================================
// G16: import-only hunks and files collapse with no shell left
// (meat/imports_test.go:299-331)
// ===========================================================================

describe("G16: mandatory imports remove complete hunks and files (meat/imports_test.go:299-331)", () => {
  test("case 1: import-only hunk drops entirely, behavior hunk survives", () => {
    const diff = s(
      "diff --git a/a.py b/a.py\nindex 111..222 100644\n--- a/a.py\n+++ b/a.py\n@@ imports @@\n-import old_package\n+from new_package import value\n@@ behavior @@\n-old = run_old()\n+new = run_new()\n",
    );
    const c = classify(diff);
    assertHidden(c, ["@@ imports @@", "import old_package", "from new_package import value"]);
    assertVisible(c, ["diff --git a/a.py", "@@ behavior @@", "-old = run_old()", "+new = run_new()"]);
  });

  test("case 2: file whose only hunk is an import swap collapses entirely", () => {
    const diff = s("diff --git a/a.py b/a.py\nindex 111..222 100644\n--- a/a.py\n+++ b/a.py\n@@\n-import old_package\n+import new_package\n");
    const c = classify(diff);
    assert.ok(
      c.hidden.every((h) => h),
      `expected every line hidden, got ${JSON.stringify(c.hidden)}`,
    );
  });

  test("case 3: new Go file that is only package + import block collapses entirely", () => {
    const diff = s("diff --git a/a.go b/a.go\nnew file mode 100644\n--- /dev/null\n+++ b/a.go\n@@\n+package a\n+\n+import (\n+    \"fmt\"\n+)\n");
    const c = classify(diff);
    assert.ok(
      c.hidden.every((h) => h),
      `expected every line hidden, got ${JSON.stringify(c.hidden)}`,
    );
  });
});

// ===========================================================================
// G22: the mandatory plan's wire form is source-derived, 1-based, inclusive
// (meat/imports_test.go:437-447)
// ===========================================================================

test("G22: mandatory plan coordinates remain source-derived (meat/imports_test.go:437-447)", () => {
  const diff = s("diff --git a/a.py b/a.py\n@@\n+import os\n+value = os.name\n");
  const lines = splitSourceLines(diff);
  const layout = analyzeDiff(lines);
  const plan = mandatoryImportRemovalPlan(lines, layout);
  assert.deepEqual(plan, [{ startLine: 3, endLine: 3 }]);
});

// ===========================================================================
// The three plan-state-aware functions (meat/imports.go:8-149). Not proven
// by any Go test directly (specs/imports.md's Open questions list both
// stateWithMandatoryImportsRepresented and addMandatoryPythonSuitePlaceholders
// as "untested directly" even in the Go suite) — these are hand-built from
// the Mechanism section's Algorithms 8-10 rather than ported from a fixture.
// editplan.ts (item 4i) is this trio's real caller; these are direct unit
// tests of the functions in isolation, seeding `PlanState` the way the
// pipeline's own Responsibility-and-dependents section says it does (mask
// seeds `planState.hidden` before any model op runs).
// ===========================================================================

function seededState(lines: readonly SourceLine[], hidden: readonly boolean[]): PlanState {
  const state = newPlanState(lines.length);
  state.hidden = [...hidden];
  return state;
}

describe("addMandatoryPythonSuitePlaceholders (meat/imports.go:12-55, Algorithm 8)", () => {
  test("mixed guard: placeholder synthesized under the emptied try:, none under except: (real body survives)", () => {
    const diff = s(
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n" + "+try:\n" + "+    import fast_json\n" + "+except ImportError:\n" + "+    fast_json = None\n" + "+value = fast_json\n",
    );
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const ranges = mandatoryImportRemovalPlan(lines, layout);
    const mandatory = mandatoryRemovalMask(lines.length, ranges);
    const importLine = lineIndex(lines, "import fast_json");
    assert.equal(mandatory[importLine], true);

    const state = seededState(lines, mandatory);
    addMandatoryPythonSuitePlaceholders(lines, layout, state, mandatory);

    assert.equal(state.folds.length, 1, `expected exactly one placeholder, got ${JSON.stringify(state.folds)}`);
    const fold = state.folds[0]!;
    assert.equal(fold.startLine, importLine + 1);
    assert.equal(fold.endLine, importLine + 1);
    assert.equal(fold.planIndex, -1);
    assert.equal(fold.marker, "+");
    assert.equal(decodeUTF8(fold.indent), "    ");
    assert.equal(state.foldAt[importLine], 0);
    assert.equal(state.folded[importLine], 0);
  });

  test("owner whose body is untouched by hiding gets no placeholder", () => {
    // Every mandatory row here sits directly under `import os`'s own owner-less
    // top level (no suite header above it at all), so nothing should ever
    // qualify as an owner and no fold should be synthesized.
    const diff = s("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n+value = os.name\n");
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const ranges = mandatoryImportRemovalPlan(lines, layout);
    const mandatory = mandatoryRemovalMask(lines.length, ranges);
    const state = seededState(lines, mandatory);
    addMandatoryPythonSuitePlaceholders(lines, layout, state, mandatory);
    assert.deepEqual(state.folds, []);
  });
});

describe("stateWithMandatoryImportsRepresented (meat/imports.go:61-93, Algorithm 9)", () => {
  test("hunk with a visible non-import row: mandatory rows are faked present, for validation only", () => {
    const diff = s("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n+value = os.name\n");
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const ranges = mandatoryImportRemovalPlan(lines, layout);
    const mandatory = mandatoryRemovalMask(lines.length, ranges);
    const importLine = lineIndex(lines, "import os");
    assert.equal(mandatory[importLine], true);

    const state = seededState(lines, mandatory);
    const validation = stateWithMandatoryImportsRepresented(state, mandatory, layout);

    assert.equal(validation.hidden[importLine], false, "mandatory row should read as present in the validation clone");
    assert.equal(validation.folded[importLine], -1);
    assert.equal(validation.foldAt[importLine], -1);
    // The real state used for rendering is untouched.
    assert.equal(state.hidden[importLine], true);
    // Folds slice is shared, never cloned (only ever cleared here, never appended to).
    assert.equal(validation.folds, state.folds);
  });

  test("hunk with no visible non-import row: validation clone is left unchanged", () => {
    const diff = s("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n");
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const ranges = mandatoryImportRemovalPlan(lines, layout);
    const mandatory = mandatoryRemovalMask(lines.length, ranges);
    const state = seededState(lines, mandatory);
    const validation = stateWithMandatoryImportsRepresented(state, mandatory, layout);
    assert.deepEqual(validation.hidden, state.hidden);
    assert.deepEqual(validation.folded, state.folded);
    assert.deepEqual(validation.foldAt, state.foldAt);
  });
});

describe("completeMandatoryImportFraming (meat/imports.go:98-149, Algorithm 10)", () => {
  test("hunk emptied by a model removal collapses in full, then the whole file collapses with it", () => {
    const diff = s("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n+value = 1\n");
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const ranges = mandatoryImportRemovalPlan(lines, layout);
    const mandatory = mandatoryRemovalMask(lines.length, ranges);
    const behaviorLine = lineIndex(lines, "value = 1");
    assert.equal(mandatory[behaviorLine], false);

    const state = seededState(lines, mandatory);
    // Simulate the model having separately removed the one behavioral row too.
    state.hidden[behaviorLine] = true;

    completeMandatoryImportFraming(layout, state, mandatory);

    assert.ok(
      state.hidden.every((h) => h),
      `expected the whole file to collapse, got ${JSON.stringify(state.hidden)}`,
    );
  });

  test("hunk with a retained behavioral row is left alone, at both hunk and file level", () => {
    const diff = s("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+import os\n+value = 1\n");
    const lines = splitSourceLines(diff);
    const layout = analyzeDiff(lines);
    const ranges = mandatoryImportRemovalPlan(lines, layout);
    const mandatory = mandatoryRemovalMask(lines.length, ranges);
    const headerLine = lineIndex(lines, "@@");
    const behaviorLine = lineIndex(lines, "value = 1");

    const state = seededState(lines, mandatory);
    completeMandatoryImportFraming(layout, state, mandatory);

    assert.equal(state.hidden[headerLine], false, "hunk header must stay visible: its behavioral row is still retained");
    assert.equal(state.hidden[behaviorLine], false);
    assert.equal(state.hidden[0], false, "diff --git header must stay visible: the file was never fully collapsed");
  });
});
