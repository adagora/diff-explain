import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { splitSourceLines, analyzeDiff, type DiffLayout } from "../../src/meat/diff.ts";
import { newPlanState, type PlanState, type PlannedReplacement } from "../../src/meat/plan.ts";
import {
  scanPythonTripleLine,
  newTripleStateRef,
  pythonTripleNone,
  pythonDelimiterBalance,
  pythonDelimiterDepth,
  pythonDelimiterBalanceWithState,
  trimPythonCode,
  pythonCodeWithoutStrings,
  isPythonDefinition,
  isPythonSuiteHeaderStart,
  pythonTripleStateBeforeLine,
  pythonSuiteHeaderEnd,
  hasPythonBodyAfter,
  hasPythonDefinitionAfter,
  hunkHasVisibleChange,
  pythonLineOnSide,
  hiddenPythonRegionBalanced,
  pythonNewSideStates,
  simpleAssignedReference,
  containsIdentifier,
  changesPythonBoundaryTokens,
  endsPythonBackslash,
  validateHiddenPythonOwners,
  validateHiddenPythonBoundaries,
  validateHiddenReferences,
  validatePythonSuiteSkeleton,
  validatePythonDelimiterBalance,
  validatePythonBackslashContinuations,
  validateTripleQuoteParity,
} from "../../src/meat/python.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);
const MINUS = 0x2d;
const PLUS = 0x2b;

function layoutFor(diff: string): { lines: ReturnType<typeof splitSourceLines>; layout: DiffLayout } {
  const lines = splitSourceLines(s(diff));
  const layout = analyzeDiff(lines);
  return { lines, layout };
}

describe("scanPythonTripleLine (meat/python.go:590-641)", () => {
  test("no triple quotes: zero transitions, state stays none", () => {
    const state = newTripleStateRef();
    const got = scanPythonTripleLine(s("x = 1"), state);
    assert.equal(got, 0);
    assert.equal(state.value, pythonTripleNone);
  });
  test("opening a triple-double string sets state and counts one transition", () => {
    const state = newTripleStateRef();
    const got = scanPythonTripleLine(s('x = """abc'), state);
    assert.equal(got, 1);
    assert.equal(state.value, "double");
  });
  test("a self-contained triple string on one line returns to none with 2 transitions", () => {
    const state = newTripleStateRef();
    const got = scanPythonTripleLine(s('x = """abc""" + 1'), state);
    assert.equal(got, 2);
    assert.equal(state.value, pythonTripleNone);
  });
  test("closing an already-open triple-single string", () => {
    const state = newTripleStateRef("single");
    const got = scanPythonTripleLine(s("more text '''"), state);
    assert.equal(got, 1);
    assert.equal(state.value, pythonTripleNone);
  });
  test("# short-circuits the scan when not inside a string", () => {
    const state = newTripleStateRef();
    const got = scanPythonTripleLine(s('x = 1 # """ not a string'), state);
    assert.equal(got, 0);
    assert.equal(state.value, pythonTripleNone);
  });
  test("G15: a triple-quote-looking run inside an ordinary quoted string is not triple-quote-aware", () => {
    // 'x"""y' — the ordinary single-quote consumes everything up to its own
    // closing quote byte-by-byte, so the embedded \"\"\" is never inspected.
    const state = newTripleStateRef();
    const got = scanPythonTripleLine(s(`'x"""y'`), state);
    assert.equal(got, 0);
    assert.equal(state.value, pythonTripleNone);
  });
  test("backslash-escape inside an ordinary string skips the escaped byte", () => {
    const state = newTripleStateRef();
    // 'a\'b' — the backslash-quote pair must not close the string early.
    const got = scanPythonTripleLine(s(String.raw`'a\'b'`), state);
    assert.equal(got, 0);
    assert.equal(state.value, pythonTripleNone);
  });
  test("unterminated triple search consumes the rest of the line, no transition", () => {
    const state = newTripleStateRef("double");
    const got = scanPythonTripleLine(s("still inside, no closer here"), state);
    assert.equal(got, 0);
    assert.equal(state.value, "double");
  });
});

describe("pythonDelimiterBalance / pythonDelimiterDepth (meat/python.go:379-466)", () => {
  test("counts each bracket kind independently", () => {
    const d = pythonDelimiterBalance(s("foo(a, [b, c], {d: e})"));
    assert.deepEqual(d, { round: 0, square: 0, curly: 0 });
  });
  test("an unmatched opener leaves a positive count", () => {
    const d = pythonDelimiterBalance(s("foo(bar("));
    assert.equal(d.round, 2);
  });
  test("pythonDelimiterDepth sums all three kinds", () => {
    assert.equal(pythonDelimiterDepth(s("([{")), 3);
    assert.equal(pythonDelimiterDepth(s(")]}")), -3);
  });
  test("brackets inside a triple-quoted string are not counted", () => {
    const d = pythonDelimiterBalance(s('"""has (unbalanced [brackets"""'));
    assert.deepEqual(d, { round: 0, square: 0, curly: 0 });
  });
  test("brackets inside an ordinary string are not counted", () => {
    const d = pythonDelimiterBalance(s(`x = "(not a paren)"`));
    assert.deepEqual(d, { round: 0, square: 0, curly: 0 });
  });
  test("a bracket after a comment is not counted", () => {
    const d = pythonDelimiterBalance(s("foo() # trailing (comment"));
    assert.deepEqual(d, { round: 0, square: 0, curly: 0 });
  });
  test("pythonDelimiterBalanceWithState threads triple-quote context in from a previous line", () => {
    const state = newTripleStateRef("double");
    // Still inside the triple string, so this "(" must not count.
    const d = pythonDelimiterBalanceWithState(s("has (unbalanced looking text"), state);
    assert.deepEqual(d, { round: 0, square: 0, curly: 0 });
  });
});

describe("trimPythonCode (meat/python.go:726-754)", () => {
  test("strips a trailing comment and trims whitespace", () => {
    assert.equal(decodeUTF8(trimPythonCode(s("  x = 1  # comment  "))), "x = 1");
  });
  test("a # inside an ordinary string is not a comment", () => {
    assert.equal(decodeUTF8(trimPythonCode(s('x = "a # b"'))), 'x = "a # b"');
  });
  test("no comment present: only whitespace is trimmed", () => {
    assert.equal(decodeUTF8(trimPythonCode(s("  y = 2  "))), "y = 2");
  });
  test("documented approximation: a same-line-closed triple string with an embedded lone quote can flip the comment boundary", () => {
    // From specs/python.md §3's worked example: a real tokenizer stays
    // inside the triple string across the whole line, but trimPythonCode's
    // byte-toggle machine has no triple-quote concept at all.
    const got = decodeUTF8(trimPythonCode(s('"""Say "hi" # not a comment"""')));
    // Documented behavior: the embedded lone " closes trimPythonCode's quote
    // state, " hi" reads as code, the next " reopens a bogus string that
    // swallows the rest — net effect here happens to still not treat # as a
    // comment (per the spec's own worked example), so the whole line survives.
    assert.equal(got, '"""Say "hi" # not a comment"""');
  });
});

describe("pythonCodeWithoutStrings (meat/python.go:695-724)", () => {
  test("removes ordinary string contents, keeps other code", () => {
    assert.equal(decodeUTF8(pythonCodeWithoutStrings(s('x = "secret" + y'))), "x =  + y");
  });
  test("breaks entirely at a # ", () => {
    assert.equal(decodeUTF8(pythonCodeWithoutStrings(s("x = y # z = w"))), "x = y ");
  });
  test("breaks entirely at a triple-quote-looking prefix, discarding what follows on the line", () => {
    assert.equal(decodeUTF8(pythonCodeWithoutStrings(s('x = """abc""" + identifier_name'))), "x = ");
  });
});

describe("isPythonDefinition / isPythonSuiteHeaderStart (meat/python.go:374-377,756-777)", () => {
  test("def / async def / class are definitions", () => {
    assert.ok(isPythonDefinition(s("def foo():")));
    assert.ok(isPythonDefinition(s("async def foo():")));
    assert.ok(isPythonDefinition(s("class Foo:")));
  });
  test("deffoo does not match def (literal space required)", () => {
    assert.ok(!isPythonDefinition(s("deffoo():")));
  });
  test("suite keywords require a boundary byte after the keyword", () => {
    assert.ok(isPythonSuiteHeaderStart(s("if x:")));
    assert.ok(isPythonSuiteHeaderStart(s("if(x):")));
    assert.ok(!isPythonSuiteHeaderStart(s("ifx = 1")));
  });
  test("except* (PEP 654) is recognized (G6)", () => {
    assert.ok(isPythonSuiteHeaderStart(s("except* ValueError:")));
  });
  test("async for / async with require the literal keyword with boundary", () => {
    assert.ok(isPythonSuiteHeaderStart(s("async for x in y:")));
    assert.ok(isPythonSuiteHeaderStart(s("async with x:")));
    assert.ok(!isPythonSuiteHeaderStart(s("async_for_helper()")));
  });
  test("bare else:/try:/except:/finally: are recognized exactly", () => {
    assert.ok(isPythonSuiteHeaderStart(s("else:")));
    assert.ok(isPythonSuiteHeaderStart(s("try:")));
    assert.ok(!isPythonSuiteHeaderStart(s("elsewhere:")));
  });
  test("no trailing-colon requirement — a multi-line header's opening line still starts a header", () => {
    assert.ok(isPythonSuiteHeaderStart(s("if (")));
  });
  test("a plain assignment is not a suite header", () => {
    assert.ok(!isPythonSuiteHeaderStart(s("value = 5")));
  });
  test("G8: fold-target validation strips a trailing comment before checking suite-header-ness", () => {
    assert.ok(isPythonSuiteHeaderStart(s("def helper():  # setup helper")));
  });
});

describe("pythonTripleStateBeforeLine (meat/python.go:792-802)", () => {
  test("reconstructs triple-quote state from the containing hunk's raw text, skipping removed lines", () => {
    const diff =
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n" +
      ' x = """opens here\n' +
      "-removed_should_be_skipped\n" +
      " still inside\n";
    const { lines, layout } = layoutFor(diff);
    // Line index 6 is "still inside" (0-based) — state before it should be "double".
    const state = pythonTripleStateBeforeLine(lines, layout, 6);
    assert.equal(state, "double");
  });
});

describe("hunkHasVisibleChange / pythonLineOnSide (meat/python.go:54-61,150-155)", () => {
  test("a hunk with a visible (kept) change line reports true", () => {
    const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n";
    const { layout } = layoutFor(diff);
    const state = newPlanState(layout.kinds.length);
    assert.ok(hunkHasVisibleChange(layout, state, 0, layout.kinds.length));
  });
  test("a hunk whose every change is hidden reports false", () => {
    const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n";
    const { layout } = layoutFor(diff);
    const state = newPlanState(layout.kinds.length);
    state.hidden[1] = true;
    state.hidden[2] = true;
    assert.ok(!hunkHasVisibleChange(layout, state, 0, layout.kinds.length));
  });
  test("context lines count toward both sides", () => {
    const diff = "@@ -1,1 +1,1 @@\n context\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(pythonLineOnSide(lines, layout, 1, MINUS));
    assert.ok(pythonLineOnSide(lines, layout, 1, PLUS));
  });
  test("a change line belongs only to its own side", () => {
    const diff = "@@ -1,1 +1,1 @@\n-old\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(pythonLineOnSide(lines, layout, 1, MINUS));
    assert.ok(!pythonLineOnSide(lines, layout, 1, PLUS));
  });
});

describe("simpleAssignedReference (meat/python.go:804-828, G20/G21)", () => {
  test("a bare identifier assignment is simple", () => {
    const got = simpleAssignedReference(s("value = compute()"));
    assert.equal(got === null ? null : decodeUTF8(got), "value");
  });
  test("a dotted attribute path is simple (G21)", () => {
    const got = simpleAssignedReference(s("self.tests = []"));
    assert.equal(got === null ? null : decodeUTF8(got), "self.tests");
  });
  test("a type annotation is stripped before the target", () => {
    const got = simpleAssignedReference(s("count: int = 5"));
    assert.equal(got === null ? null : decodeUTF8(got), "count");
  });
  test("== is not an assignment", () => {
    assert.equal(simpleAssignedReference(s("a == b")), null);
  });
  test("augmented assignment is not simple (no explicit exclusion — the residual LHS just isn't a bare identifier)", () => {
    assert.equal(simpleAssignedReference(s("count += 1")), null);
  });
  test("tuple unpacking is not simple", () => {
    assert.equal(simpleAssignedReference(s("a, b = compute()")), null);
  });
  test("subscript targets are not simple", () => {
    assert.equal(simpleAssignedReference(s("d[k] = v")), null);
  });
});

describe("containsIdentifier (meat/python.go:830-846)", () => {
  test("finds a whole-word match", () => {
    assert.ok(containsIdentifier(s("return value + 1"), s("value")));
  });
  test("does not match a substring of a longer identifier", () => {
    assert.ok(!containsIdentifier(s("return value2 + 1"), s("value")));
  });
  test("does not match when preceded by an identifier-continue byte", () => {
    assert.ok(!containsIdentifier(s("my_value = 1"), s("value")));
  });
});

describe("changesPythonBoundaryTokens (meat/python.go:16-23, G11)", () => {
  test("no change when every token count matches", () => {
    assert.ok(!changesPythonBoundaryTokens(s("foo(bar)"), s("baz(qux)")));
  });
  test("detects a changed paren count", () => {
    assert.ok(changesPythonBoundaryTokens(s("foo(bar)"), s("foo bar")));
  });
  test("detects a changed triple-quote token count", () => {
    assert.ok(changesPythonBoundaryTokens(s('"""scenario'), s("...")));
  });
});

describe("endsPythonBackslash (meat/python.go:573-580)", () => {
  test("an odd trailing-backslash count is a continuation", () => {
    assert.ok(endsPythonBackslash(s("x = 1 + \\")));
  });
  test("an even trailing-backslash count is not (self-escaping)", () => {
    assert.ok(!endsPythonBackslash(s("x = 1 + \\\\")));
  });
  test("a trailing backslash inside a comment does not count (trimPythonCode strips it first)", () => {
    assert.ok(!endsPythonBackslash(s("x = 1 # trailing \\")));
  });
});

describe("pythonSuiteHeaderEnd / hasPythonBodyAfter / hasPythonDefinitionAfter (meat/python.go:277-372)", () => {
  test("resolves a single-line header's end at zero depth with trailing colon", () => {
    const diff = "@@ -1,2 +1,2 @@\n if x:\n     body\n";
    const { lines, layout } = layoutFor(diff);
    const end = pythonSuiteHeaderEnd(lines, layout, null, 1);
    assert.equal(end, 1);
  });
  test("resolves a multi-line parenthesized header only once depth returns to zero (G7)", () => {
    const diff = "@@ -1,3 +1,3 @@\n if (\n     condition\n ):\n";
    const { lines, layout } = layoutFor(diff);
    const end = pythonSuiteHeaderEnd(lines, layout, null, 1);
    assert.equal(end, 3);
  });
  test("returns null when the header never resolves (unterminated)", () => {
    const diff = "@@ -1,1 +1,1 @@\n if (\n";
    const { lines, layout } = layoutFor(diff);
    assert.equal(pythonSuiteHeaderEnd(lines, layout, null, 1), null);
  });
  test("hasPythonBodyAfter finds the first real content line, skipping comment-only lines (G2)", () => {
    const diff = "@@ -1,3 +1,3 @@\n def f():\n     # just a comment\n     return 1\n";
    const { lines, layout } = layoutFor(diff);
    // Owner "def f():" has indent 0; body lines are indented 4.
    assert.ok(hasPythonBodyAfter(lines, layout, null, 1, 0));
  });
  test("hasPythonBodyAfter is false when nothing deeper-indented follows", () => {
    const diff = "@@ -1,2 +1,2 @@\n def f():\n next_stmt()\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(!hasPythonBodyAfter(lines, layout, null, 1, 0));
  });
  test("G12: a fold whose marker is '-' does not count as a body", () => {
    const diff = "@@ -1,2 +1,1 @@\n def f():\n-    old_body()\n";
    const { lines, layout } = layoutFor(diff);
    const state: PlanState = newPlanState(lines.length);
    state.hidden[2] = true;
    state.folded[2] = 0;
    state.foldAt[2] = 0;
    state.folds.push({ startLine: 2, endLine: 2, planIndex: -1, marker: "-", indent: s("    "), eol: s("\n") });
    assert.ok(!hasPythonBodyAfter(lines, layout, state, 1, 0));
  });
  test("G12: a fold whose marker is '+' counts as a body iff its indent exceeds the owner's", () => {
    const diff = "@@ -1,1 +1,2 @@\n def f():\n+    new_body()\n";
    const { lines, layout } = layoutFor(diff);
    const state: PlanState = newPlanState(lines.length);
    state.hidden[2] = true;
    state.folded[2] = 0;
    state.foldAt[2] = 0;
    state.folds.push({ startLine: 2, endLine: 2, planIndex: -1, marker: "+", indent: s("    "), eol: s("\n") });
    assert.ok(hasPythonBodyAfter(lines, layout, state, 1, 0));
  });
  test("hasPythonDefinitionAfter finds an attached def, skipping the decorator's own multi-line depth", () => {
    const diff = "@@ -1,2 +1,2 @@\n @decorator(\n     arg,\n )\n def f():\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(hasPythonDefinitionAfter(lines, layout, null, 1, 0));
  });
  test("hasPythonDefinitionAfter recurses through a stacked decorator", () => {
    const diff = "@@ -1,3 +1,3 @@\n @first\n @second\n def f():\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(hasPythonDefinitionAfter(lines, layout, null, 1, 0));
  });
  test("hasPythonDefinitionAfter is false when the next same-indent line is not a definition", () => {
    const diff = "@@ -1,2 +1,2 @@\n @decorator\n not_a_def()\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(!hasPythonDefinitionAfter(lines, layout, null, 1, 0));
  });
});

describe("hiddenPythonRegionBalanced (meat/python.go:101-148, G13/G14)", () => {
  test("an empty region is trivially balanced", () => {
    const diff = "@@ -1,1 +1,1 @@\n context\n";
    const { lines, layout } = layoutFor(diff);
    assert.ok(hiddenPythonRegionBalanced(lines, layout, 0, 1, 1, MINUS));
  });
  test("G13: hiding a closer while the opener stays visible is unbalanced", () => {
    const diff = "@@ -1,2 +1,1 @@\n x = (1,\n-    2)\n";
    const { lines, layout } = layoutFor(diff);
    // Region [2,3) covers only the hidden "2)" line — a lone closer with no
    // matching opener inside the region itself.
    assert.ok(!hiddenPythonRegionBalanced(lines, layout, 0, 2, 3, MINUS));
  });
  test("G14: brackets inside a hidden triple-quoted docstring do not break balance", () => {
    const diff = '@@ -1,3 +1,0 @@\n-"""\n-docstring with foo( and [value]\n-"""\n';
    const { lines, layout } = layoutFor(diff);
    assert.ok(hiddenPythonRegionBalanced(lines, layout, 0, 1, 4, MINUS));
  });
  test("a region that starts a triple-quoted string but never closes it within the region is unbalanced", () => {
    const diff = '@@ -1,2 +1,0 @@\n-x = """opens\n-still open\n';
    const { lines, layout } = layoutFor(diff);
    assert.ok(!hiddenPythonRegionBalanced(lines, layout, 0, 1, 3, MINUS));
  });
});

describe("pythonNewSideStates (meat/python.go:157-193, G18)", () => {
  test("clamps a negative delimiter count from a leading unmatched closer", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n )\n value = compute()\n";
    const { lines, layout } = layoutFor(diff);
    const { depthBefore } = pythonNewSideStates(lines, layout);
    // The leading ")" context line closes a delimiter opened above the hunk;
    // depthBefore at the following assignment line must be clamped to 0, not
    // left negative (which would suppress reference-guard protection).
    assert.equal(depthBefore[5], 0);
  });
});

describe("validateHiddenPythonOwners (meat/python.go:25-52, G5)", () => {
  // Every one of the four validators skips raw '-'-marked lines outright
  // (they're already removed by the diff itself, not "hidden by the plan").
  // The owner here must be a context/added line that the *plan* hides.
  test("hiding a suite owner while its body remains visible is rejected", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def f():\n     return 1\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true; // plan hides the context "def f():" line
    assert.throws(() => validateHiddenPythonOwners(lines, layout, state), /hides Python suite owner on line 5 while its body remains visible/);
  });
  test("hiding both owner and body together is accepted", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def f():\n     return 1\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true;
    state.hidden[5] = true;
    assert.doesNotThrow(() => validateHiddenPythonOwners(lines, layout, state));
  });
});

describe("validatePythonSuiteSkeleton (meat/python.go:238-275, G2)", () => {
  test("a retained suite owner with all body removed is rejected", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def f():\n     return 1\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[5] = true; // plan hides only the body line; owner stays retained
    assert.throws(() => validatePythonSuiteSkeleton(lines, layout, state), /retained Python suite owner on line 5 has no indented body/);
  });
  test("G4: a zero-context signature-only hunk with no raw body is a valid identity plan", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,1 @@\n-def f():\n+def f(x):\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    assert.doesNotThrow(() => validatePythonSuiteSkeleton(lines, layout, state));
  });
  test("a '-' marker fold does not count as a body, so hiding it this way is still rejected", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def f():\n     return 1\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[5] = true;
    state.folded[5] = 0;
    state.foldAt[5] = 0;
    state.folds.push({ startLine: 6, endLine: 6, planIndex: 0, marker: "-", indent: s("    "), eol: s("\n") });
    assert.throws(() => validatePythonSuiteSkeleton(lines, layout, state), /retained Python suite owner on line 5 has no indented body/);
  });
  test("a '+' marker fold does count as a body, so hiding it this way is accepted", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def f():\n     return 1\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[5] = true;
    state.folded[5] = 0;
    state.foldAt[5] = 0;
    state.folds.push({ startLine: 6, endLine: 6, planIndex: 0, marker: "+", indent: s("      "), eol: s("\n") });
    assert.doesNotThrow(() => validatePythonSuiteSkeleton(lines, layout, state));
  });
});

describe("validateHiddenReferences (meat/python.go:195-236, G20)", () => {
  test("hiding a definition still referenced elsewhere in the file is rejected", () => {
    const diff =
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,0 +1,1 @@\n+value = compute()\n@@ -5,1 +6,1 @@\n use(value)\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true; // plan hides the added "value = compute()" line
    assert.throws(() => validateHiddenReferences(lines, layout, state), /hides definition "value" on line 5 while retained line \d+ still references it/);
  });
  test("hiding a definition with no remaining reference is accepted", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,0 @@\n-value = compute()\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true;
    assert.doesNotThrow(() => validateHiddenReferences(lines, layout, state));
  });
});

describe("validatePythonDelimiterBalance (meat/python.go:468-519, G13 at the hunk level)", () => {
  test("an identity plan (nothing hidden) always preserves balance", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,1 @@\n-value = (1, 2)\n+value = (1, 3)\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    const replacements = new Map<number, readonly PlannedReplacement[]>();
    assert.doesNotThrow(() => validatePythonDelimiterBalance(lines, layout, state, replacements));
  });
  test("hiding only the closer while the opener stays visible breaks the hunk's kept balance", () => {
    // hunkHasVisibleChange requires at least one actual +/- change line for
    // this validator to examine the hunk at all — the trailing +extra line
    // supplies that; the balance break itself is on the two context lines.
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n value = (1,\n     2)\n+extra = 1\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[5] = true; // hide only "    2)"; the opener on line 4 stays visible
    const replacements = new Map<number, readonly PlannedReplacement[]>();
    assert.throws(
      () => validatePythonDelimiterBalance(lines, layout, state, replacements),
      /must preserve Python \(\), \[\], and \{\} delimiter balance/,
    );
  });
});

describe("validateTripleQuoteParity (meat/python.go:643-693, G16)", () => {
  test("removing only one boundary of a triple-quoted string is rejected", () => {
    const diff =
      'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,1 @@\n-"""\n-docstring\n"""\n';
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true; // hide only the opening """
    const replacements = new Map<number, readonly PlannedReplacement[]>();
    assert.throws(() => validateTripleQuoteParity(lines, layout, state, replacements), /must preserve balanced Python triple-quote boundaries/);
  });
  test("removing both boundaries together preserves parity", () => {
    const diff = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,3 +1,0 @@\n-"""\n-docstring\n-"""\n';
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true;
    state.hidden[5] = true;
    state.hidden[6] = true;
    const replacements = new Map<number, readonly PlannedReplacement[]>();
    assert.doesNotThrow(() => validateTripleQuoteParity(lines, layout, state, replacements));
  });
});

describe("validatePythonBackslashContinuations (meat/python.go:521-571, G19)", () => {
  test("hiding only the continuation line while keeping the backslash-ending line is rejected", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,1 @@\n-x = 1 + \\\n-    2\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[5] = true; // hide only the continuation
    const replacements = new Map<number, readonly PlannedReplacement[]>();
    assert.throws(
      () => validatePythonBackslashContinuations(lines, layout, state, replacements),
      /Python backslash continuation on lines \d+-\d+ must be retained or hidden together/,
    );
  });
  test("hiding both lines together is accepted", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,0 @@\n-x = 1 + \\\n-    2\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true;
    state.hidden[5] = true;
    const replacements = new Map<number, readonly PlannedReplacement[]>();
    assert.doesNotThrow(() => validatePythonBackslashContinuations(lines, layout, state, replacements));
  });
});

describe("validateHiddenPythonBoundaries (meat/python.go:63-99, G17)", () => {
  test("a hidden region covering one call's closer plus the next statement's opener is rejected", () => {
    const diff =
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,0 +1,3 @@\n+first_call(arg1,\n+    arg2)\n+second_call()\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    // Hiding "    arg2)" (closes first_call) together with "second_call()"
    // as one contiguous run leaves a lone unmatched ")" at the region's
    // start — an expression boundary crossing, not a self-contained region.
    state.hidden[5] = true;
    state.hidden[6] = true;
    assert.throws(() => validateHiddenPythonBoundaries(lines, layout, state), /hidden Python region \d+-\d+ crosses new-side expression or string boundaries/);
  });
  test("hiding a single self-contained statement's region is accepted", () => {
    const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,0 +1,2 @@\n+first_call(arg1, arg2)\n+second_call()\n";
    const { lines, layout } = layoutFor(diff);
    const state = newPlanState(lines.length);
    state.hidden[4] = true;
    assert.doesNotThrow(() => validateHiddenPythonBoundaries(lines, layout, state));
  });
});
