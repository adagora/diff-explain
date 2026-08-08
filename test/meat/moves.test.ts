import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import {
  detectExactMoves,
  detectedMovesInDiff,
  applyMandatoryMovePrecedence,
  validateMoveSymmetry,
  validateMoveReplacementSymmetry,
  compressionAt,
  formatMovePairs,
  formatLineRange,
  lineRangeVerb,
  normalizeMoveLine,
  indentationColumns,
  moveRowsMatch,
  substantialMove,
  rangesOverlap,
  minMoveSubstantiveRows,
  minMoveNonspaceBytes,
  maxMoveHints,
  type DetectedMove,
  type MoveLineInfo,
} from "../../src/meat/moves.ts";
import { splitSourceLines, analyzeDiff } from "../../src/meat/diff.ts";
import { newPlanState, type PlanState, type PlannedReplacement } from "../../src/meat/plan.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);

// Ported from meat/moves_test.go and meat/rubric.go's surfaceFixtureDiff.
// exactMoveDiff: an exact cross-file move of 4 lines (indent 4 -> 8 spaces),
// removed physical lines 6-9, added lines 16-19.
const exactMoveDiff = s(
  "diff --git a/old.txt b/old.txt\n" +
    "--- a/old.txt\n" +
    "+++ b/old.txt\n" +
    "@@ -1,5 +1,2 @@\n" +
    " context\n" +
    "-    alpha := prepare(source)\n" +
    "-    beta := transform(alpha)\n" +
    "-    publish(beta)\n" +
    "-    recordSuccess(beta)\n" +
    "+old_location_gone = true\n" +
    "diff --git a/new.txt b/new.txt\n" +
    "--- a/new.txt\n" +
    "+++ b/new.txt\n" +
    "@@ -1 +1,6 @@\n" +
    " context\n" +
    "+        alpha := prepare(source)\n" +
    "+        beta := transform(alpha)\n" +
    "+        publish(beta)\n" +
    "+        recordSuccess(beta)\n" +
    "+new_location_ready = true\n",
);
const exactMove: DetectedMove = { removed: { startLine: 6, endLine: 9 }, added: { startLine: 16, endLine: 19 } };

function deletedOnlyHunk(start: number, rows: readonly string[]): string {
  let b = `@@ -${start},${rows.length} +${start},0 @@\n`;
  for (const row of rows) b += `-${row}\n`;
  return b;
}
function addedOnlyHunk(start: number, rows: readonly string[]): string {
  let b = `@@ -${start},0 +${start},${rows.length} @@\n`;
  for (const row of rows) b += `+    ${row}\n`;
  return b;
}

describe("detectedMovesInDiff / detectExactMoves — Go's TestDetectExactMoves_*", () => {
  test("G8: canonical cross-file uniform reindent, exactly one move", () => {
    const moves = detectedMovesInDiff(exactMoveDiff);
    assert.deepEqual(moves, [exactMove]);
  });

  test("G9: same-file cross-hunk relocation with +4-space reindent", () => {
    const raw = s(
      "diff --git a/a.txt b/a.txt\n" +
        "--- a/a.txt\n" +
        "+++ b/a.txt\n" +
        "@@ -1,4 +1,0 @@\n" +
        "-first_unique_operation(source)\n" +
        "-second_unique_operation(result)\n" +
        "-third_unique_operation(result)\n" +
        "-fourth_unique_operation(result)\n" +
        "@@ -20,0 +17,4 @@\n" +
        "+    first_unique_operation(source)\n" +
        "+    second_unique_operation(result)\n" +
        "+    third_unique_operation(result)\n" +
        "+    fourth_unique_operation(result)\n",
    );
    const moves = detectedMovesInDiff(raw);
    assert.deepEqual(moves, [{ removed: { startLine: 5, endLine: 8 }, added: { startLine: 10, endLine: 13 } }]);
  });

  test("G10/G11: reports only the matching interior, tolerating trailing spaces/tabs", () => {
    const raw = s(
      "diff --git a/a.txt b/a.txt\n" +
        "--- a/a.txt\n" +
        "+++ b/a.txt\n" +
        "@@ -1,6 +1,0 @@\n" +
        "-old_wrapper_begin()\n" +
        "-    alpha := prepare(source)\n" +
        "-    beta := transform(alpha)\n" +
        "-    publish(beta)\n" +
        "-    recordSuccess(beta)\n" +
        "-old_wrapper_end()\n" +
        "@@ -20,0 +14,6 @@\n" +
        "+new_wrapper_begin()\n" +
        "+        alpha := prepare(source)   \n" +
        "+        beta := transform(alpha)\t\n" +
        "+        publish(beta)\n" +
        "+        recordSuccess(beta)\n" +
        "+new_wrapper_end()\n",
    );
    const moves = detectedMovesInDiff(raw);
    assert.deepEqual(moves, [{ removed: { startLine: 6, endLine: 9 }, added: { startLine: 13, endLine: 16 } }]);
  });

  test("G12.1: ambiguous repeated block (3 global occurrences) yields no move", () => {
    const block = ["first_unique_operation(source)", "second_unique_operation(result)", "third_unique_operation(result)"];
    const raw = s(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
        deletedOnlyHunk(1, block) +
        deletedOnlyHunk(20, block) +
        addedOnlyHunk(40, block),
    );
    assert.deepEqual(detectedMovesInDiff(raw), []);
  });

  test("G12.2: tiny coincidence (only 2 substantive rows) yields no move", () => {
    const raw = s(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
        deletedOnlyHunk(1, ["return first", "return second"]) +
        addedOnlyHunk(20, ["return first", "return second"]),
    );
    assert.deepEqual(detectedMovesInDiff(raw), []);
  });

  test("G12.3: same-hunk replacement yields no move", () => {
    const raw = s(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n" +
        "-first_unique_operation(source)\n-second_unique_operation(result)\n-third_unique_operation(result)\n" +
        "+first_unique_operation(source)\n+second_unique_operation(result)\n+third_unique_operation(result)\n",
    );
    assert.deepEqual(detectedMovesInDiff(raw), []);
  });

  test("G12.4: nonconstant indentation shift (4/8/4, not one constant offset) yields no move", () => {
    const raw = s(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
        "@@ -1,3 +1,0 @@\n" +
        "-first_unique_operation(source)\n-second_unique_operation(result)\n-third_unique_operation(result)\n" +
        "@@ -20,0 +17,3 @@\n" +
        "+    first_unique_operation(source)\n+        second_unique_operation(result)\n+    third_unique_operation(result)\n",
    );
    assert.deepEqual(detectedMovesInDiff(raw), []);
  });

  test("detectExactMoves guard: empty lines returns no moves", () => {
    assert.deepEqual(detectExactMoves([], { kinds: [], markerOwner: [], python: [], languages: [], fileId: [], hunkId: [], problems: [] }), []);
  });

  test("detectedMovesInDiff returns no moves when the diff itself has structural problems", () => {
    // An @@ header claiming counts the body doesn't have.
    const raw = s("@@ -1,5 +1,5 @@\n only one line\n");
    assert.deepEqual(detectedMovesInDiff(raw), []);
  });
});

describe("normalizeMoveLine (meat/moves.go:200-216)", () => {
  test("strips ASCII trailing space/tab, not a Unicode trim", () => {
    const info = normalizeMoveLine(s("  hello  \t"));
    assert.equal(decodeUTF8(info.normalized), "hello");
    assert.equal(info.indent, 2);
    assert.ok(info.substantive);
  });
  test("indent-only body normalizes to empty and is not substantive", () => {
    const info = normalizeMoveLine(s("    "));
    assert.equal(info.normalized.length, 0);
    assert.ok(!info.substantive);
  });
  test("punctuation-only body is not substantive", () => {
    const info = normalizeMoveLine(s(");"));
    assert.ok(!info.substantive);
  });
  test("a Unicode letter counts as substantive", () => {
    const info = normalizeMoveLine(s("café"));
    assert.ok(info.substantive);
  });
});

describe("indentationColumns (meat/moves.go:218-228)", () => {
  test("spaces count one column each", () => {
    assert.equal(indentationColumns(s("    ")), 4);
  });
  test("a tab advances to the next multiple of 8", () => {
    assert.equal(indentationColumns(s("\t")), 8);
    assert.equal(indentationColumns(s("  \t")), 8);
    assert.equal(indentationColumns(s("\t\t")), 16);
  });
  test("empty indent is zero columns", () => {
    assert.equal(indentationColumns(s("")), 0);
  });
});

describe("moveRowsMatch (meat/moves.go:230-238)", () => {
  const info = (normalized: string, indent: number): MoveLineInfo => ({ normalized: s(normalized), indent, substantive: normalized.length > 0 });
  test("different normalized bodies never match", () => {
    assert.ok(!moveRowsMatch(info("a", 0), info("b", 0), 0));
  });
  test("two blank/whitespace-only rows match unconditionally, ignoring indent offset", () => {
    assert.ok(moveRowsMatch(info("", 0), info("", 99), 0));
  });
  test("matching bodies require the exact fixed indent offset", () => {
    assert.ok(moveRowsMatch(info("x", 4), info("x", 8), 4));
    assert.ok(!moveRowsMatch(info("x", 4), info("x", 9), 4));
  });
});

describe("substantialMove (meat/moves.go:240-254)", () => {
  test("passes when both gates clear", () => {
    const infos: MoveLineInfo[] = [
      { normalized: s("first_unique_operation(source)"), indent: 0, substantive: true },
      { normalized: s("second_unique_operation(result)"), indent: 0, substantive: true },
      { normalized: s("third_unique_operation(result)"), indent: 0, substantive: true },
    ];
    assert.ok(substantialMove(infos, 0, 2));
  });
  test("fails the row gate below minMoveSubstantiveRows even with enough bytes", () => {
    const longBody = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const infos: MoveLineInfo[] = [{ normalized: s(longBody), indent: 0, substantive: true }];
    assert.ok(longBody.length >= minMoveNonspaceBytes);
    assert.ok(!substantialMove(infos, 0, 0));
  });
  test("fails the byte gate below minMoveNonspaceBytes even with enough rows", () => {
    const infos: MoveLineInfo[] = [
      { normalized: s("a"), indent: 0, substantive: true },
      { normalized: s("b"), indent: 0, substantive: true },
      { normalized: s("c"), indent: 0, substantive: true },
    ];
    assert.equal(minMoveSubstantiveRows, 3);
    assert.ok(!substantialMove(infos, 0, 2));
  });
  test("a non-ASCII rune's true UTF-8 byte length is counted, not its UTF-16 .length (H1)", () => {
    // "€" is 1 UTF-16 code unit but 3 UTF-8 bytes. Build a window that only
    // clears the 48-nonspace-byte gate if measured in true UTF-8 bytes.
    const euroRun = "€".repeat(16); // 16 code units, but 48 UTF-8 bytes exactly
    const infos: MoveLineInfo[] = [
      { normalized: s(euroRun), indent: 0, substantive: true },
      { normalized: s("x"), indent: 0, substantive: true },
      { normalized: s("y"), indent: 0, substantive: true },
    ];
    assert.equal(euroRun.length, 16);
    assert.ok(substantialMove(infos, 0, 2));
  });
  test("punctuation-only rows contribute bytes but never rows", () => {
    const infos: MoveLineInfo[] = [
      { normalized: s("aaa"), indent: 0, substantive: true },
      { normalized: s("bbb"), indent: 0, substantive: true },
      { normalized: s(");".repeat(30)), indent: 0, substantive: false },
    ];
    assert.ok(!substantialMove(infos, 0, 2)); // only 2 substantive rows, row gate still fails
  });
});

describe("rangesOverlap (meat/moves.go:256-258)", () => {
  test("disjoint ranges do not overlap", () => {
    assert.ok(!rangesOverlap({ startLine: 1, endLine: 3 }, { startLine: 4, endLine: 6 }));
  });
  test("touching-at-a-point ranges overlap (inclusive)", () => {
    assert.ok(rangesOverlap({ startLine: 1, endLine: 3 }, { startLine: 3, endLine: 6 }));
  });
  test("nested ranges overlap", () => {
    assert.ok(rangesOverlap({ startLine: 1, endLine: 10 }, { startLine: 3, endLine: 4 }));
  });
});

describe("applyMandatoryMovePrecedence (meat/moves.go:260-280)", () => {
  test("propagates mandatory status to the aligned counterpart", () => {
    // 0-based indices 5-8 (removed, 1-based 6-9) and 15-18 (added, 1-based 16-19).
    const mandatory = new Array(20).fill(false);
    mandatory[5] = true; // removed line 6 is mandatory
    applyMandatoryMovePrecedence([exactMove], mandatory);
    assert.equal(mandatory[15], true); // added line 16 becomes mandatory too
    assert.equal(mandatory[6], false); // unaffected rows stay untouched
  });
  test("out-of-bounds offsets are skipped defensively, not thrown", () => {
    const shortMandatory = [false, false];
    assert.doesNotThrow(() => applyMandatoryMovePrecedence([exactMove], shortMandatory));
  });
  test("neither side mandatory leaves both untouched", () => {
    const mandatory = new Array(20).fill(false);
    applyMandatoryMovePrecedence([exactMove], mandatory);
    assert.ok(mandatory.every((v) => v === false));
  });
});

describe("compressionAt (meat/moves.go:292-316)", () => {
  test("mandatory canonicalizes as removed, taking precedence over plan state", () => {
    const state = newPlanState(5);
    state.hidden[0] = true;
    state.folded[0] = 0; // would otherwise look folded
    const mandatory = [true, false, false, false, false];
    assert.equal(compressionAt(state, mandatory, 1), "removed");
  });
  test("not hidden is kept", () => {
    const state = newPlanState(5);
    const mandatory = [false, false, false, false, false];
    assert.equal(compressionAt(state, mandatory, 1), "kept");
  });
  test("hidden but not folded is removed", () => {
    const state = newPlanState(5);
    state.hidden[0] = true;
    const mandatory = [false, false, false, false, false];
    assert.equal(compressionAt(state, mandatory, 1), "removed");
  });
  test("hidden and folded reports fold_start / fold_middle / fold_end by boundary", () => {
    const state = newPlanState(5);
    const mandatory = [false, false, false, false, false];
    for (let i = 0; i < 3; i++) {
      state.hidden[i] = true;
      state.folded[i] = 0;
    }
    state.folds.push({ startLine: 1, endLine: 3, planIndex: 0, marker: "-", indent: s(""), eol: s("\n") });
    assert.equal(compressionAt(state, mandatory, 1), "fold_start");
    assert.equal(compressionAt(state, mandatory, 2), "fold_middle");
    assert.equal(compressionAt(state, mandatory, 3), "fold_end");
  });
});

describe("formatLineRange / lineRangeVerb (meat/moves.go:450-462)", () => {
  test("single-line range uses singular phrasing", () => {
    assert.equal(formatLineRange({ startLine: 5, endLine: 5 }), "line 5");
    assert.equal(lineRangeVerb({ startLine: 5, endLine: 5 }), "is");
  });
  test("multi-line range uses plural phrasing", () => {
    assert.equal(formatLineRange({ startLine: 5, endLine: 8 }), "lines 5-8");
    assert.equal(lineRangeVerb({ startLine: 5, endLine: 8 }), "are");
  });
});

describe("validateMoveSymmetry (meat/moves.go:352-394, G13/G14 without editplan.ts)", () => {
  // Builds PlanState directly (editplan.ts's compileEditPlan doesn't exist
  // yet) to exercise the same guarantees moves_test.go's
  // TestCompileEditPlan_MoveSymmetry pins end to end.
  const linesLen = 20;
  const mandatory = () => new Array(linesLen).fill(false);

  test("symmetric: both kept (empty plan) passes", () => {
    const state = newPlanState(linesLen);
    assert.doesNotThrow(() => validateMoveSymmetry([exactMove], state, mandatory()));
  });

  test("symmetric: both fully removed passes", () => {
    const state = newPlanState(linesLen);
    for (const [start, end] of [
      [6, 9],
      [16, 19],
    ] as const) {
      for (let line = start; line <= end; line++) state.hidden[line - 1] = true;
    }
    assert.doesNotThrow(() => validateMoveSymmetry([exactMove], state, mandatory()));
  });

  test("symmetric: both folded identically passes", () => {
    const state = newPlanState(linesLen);
    for (const [start, end] of [
      [6, 9],
      [16, 19],
    ] as const) {
      const foldIndex = state.folds.length;
      state.folds.push({ startLine: start, endLine: end, planIndex: 0, marker: "-", indent: s(""), eol: s("\n") });
      for (let line = start; line <= end; line++) {
        state.hidden[line - 1] = true;
        state.folded[line - 1] = foldIndex;
      }
    }
    assert.doesNotThrow(() => validateMoveSymmetry([exactMove], state, mandatory()));
  });

  test("asymmetric: removed side removed, added side kept — precise error text", () => {
    const state = newPlanState(linesLen);
    for (let line = 6; line <= 9; line++) state.hidden[line - 1] = true;
    assert.throws(() => validateMoveSymmetry([exactMove], state, mandatory()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /removed lines 6-9 match added lines 16-19/);
      assert.match(err.message, /removed lines 6-9 are removed while added lines 16-19 are kept/);
      return true;
    });
  });

  test("asymmetric: both folded but with different boundaries", () => {
    const state = newPlanState(linesLen);
    // removed side: two separate folds (6-7, 8-9); added side: one fold (16-19).
    const f1 = state.folds.length;
    state.folds.push({ startLine: 6, endLine: 7, planIndex: 0, marker: "-", indent: s(""), eol: s("\n") });
    for (let line = 6; line <= 7; line++) {
      state.hidden[line - 1] = true;
      state.folded[line - 1] = f1;
    }
    const f2 = state.folds.length;
    state.folds.push({ startLine: 8, endLine: 9, planIndex: 1, marker: "-", indent: s(""), eol: s("\n") });
    for (let line = 8; line <= 9; line++) {
      state.hidden[line - 1] = true;
      state.folded[line - 1] = f2;
    }
    const f3 = state.folds.length;
    state.folds.push({ startLine: 16, endLine: 19, planIndex: 2, marker: "+", indent: s(""), eol: s("\n") });
    for (let line = 16; line <= 19; line++) {
      state.hidden[line - 1] = true;
      state.folded[line - 1] = f3;
    }
    assert.throws(() => validateMoveSymmetry([exactMove], state, mandatory()), /folded with different boundaries/);
  });
});

describe("validateMoveReplacementSymmetry (meat/moves.go:396-439, G15-G18 without editplan.ts)", () => {
  const rawLines = () => splitSourceLines(exactMoveDiff);
  const layoutOf = (lines: ReturnType<typeof rawLines>) => analyzeDiff(lines);

  const replacement = (line: number, planIndex: number, old: string, next: string, offsetInBody: number): PlannedReplacement => ({
    line,
    old: s(old),
    new: s(next),
    planIndex,
    start: offsetInBody,
    end: offsetInBody + old.length,
  });

  test("equivalent local elisions on both kept endpoints pass", () => {
    const lines = rawLines();
    layoutOf(lines);
    const state: PlanState = newPlanState(lines.length);
    // "    beta := transform(alpha)" -> byte offset of "beta" within body (after marker) is 4.
    const replacements = new Map<number, readonly PlannedReplacement[]>([
      [8, [replacement(8, 0, "beta", "...", 4)]],
      [18, [replacement(18, 1, "beta", "...", 8)]],
    ]);
    assert.doesNotThrow(() => validateMoveReplacementSymmetry([exactMove], lines, state, new Array(lines.length).fill(false), replacements));
  });

  test("one-sided local elision is rejected with the precise error text", () => {
    const lines = rawLines();
    const state: PlanState = newPlanState(lines.length);
    const replacements = new Map<number, readonly PlannedReplacement[]>([[8, [replacement(8, 0, "beta", "...", 4)]]]);
    assert.throws(
      () => validateMoveReplacementSymmetry([exactMove], lines, state, new Array(lines.length).fill(false), replacements),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /move symmetry/);
        assert.match(err.message, /removed lines 6-9 match added lines 16-19/);
        assert.match(err.message, /corresponding kept lines 8 and 18 have different model-authored local elisions/);
        return true;
      },
    );
  });

  test("different local elisions on the two endpoints are rejected", () => {
    const lines = rawLines();
    const state: PlanState = newPlanState(lines.length);
    const replacements = new Map<number, readonly PlannedReplacement[]>([
      [8, [replacement(8, 0, "beta", "...", 4)]],
      [18, [replacement(18, 1, "beta", "b...", 8)]],
    ]);
    assert.throws(
      () => validateMoveReplacementSymmetry([exactMove], lines, state, new Array(lines.length).fill(false), replacements),
      /different model-authored local elisions/,
    );
  });

  test("a replacement outside the detected move never triggers this check", () => {
    const lines = rawLines();
    const state: PlanState = newPlanState(lines.length);
    // Line 20 ("+new_location_ready = true") is outside the move (16-19).
    const replacements = new Map<number, readonly PlannedReplacement[]>([[20, [replacement(20, 0, "location_ready", "location_...", 4)]]]);
    assert.doesNotThrow(() => validateMoveReplacementSymmetry([exactMove], lines, state, new Array(lines.length).fill(false), replacements));
  });

  test("rows that aren't both kept (e.g. removed/folded) are exempt, even with a replacement recorded", () => {
    const lines = rawLines();
    const state: PlanState = newPlanState(lines.length);
    state.hidden[7] = true; // line 8 (removed side) is fully removed, not kept
    const replacements = new Map<number, readonly PlannedReplacement[]>([[8, [replacement(8, 0, "beta", "...", 4)]]]);
    assert.doesNotThrow(() => validateMoveReplacementSymmetry([exactMove], lines, state, new Array(lines.length).fill(false), replacements));
  });
});

describe("formatMovePairs (meat/moves.go:464-480)", () => {
  test("no moves yields empty string", () => {
    assert.equal(formatMovePairs([], maxMoveHints), "");
  });
  test("non-positive limit yields empty string even with moves", () => {
    assert.equal(formatMovePairs([exactMove], 0), "");
  });
  test("formats one pair with the arrow notation", () => {
    assert.equal(formatMovePairs([exactMove], maxMoveHints), "-6..9 ↔ +16..19");
  });
  test("joins multiple pairs with ', '", () => {
    const second: DetectedMove = { removed: { startLine: 30, endLine: 31 }, added: { startLine: 40, endLine: 41 } };
    assert.equal(formatMovePairs([exactMove, second], maxMoveHints), "-6..9 ↔ +16..19, -30..31 ↔ +40..41");
  });
  test("overflow appends 'and N more', showing only the numerically-first N", () => {
    const moves: DetectedMove[] = Array.from({ length: 14 }, (_, i) => ({
      removed: { startLine: i * 10 + 1, endLine: i * 10 + 2 },
      added: { startLine: i * 10 + 100, endLine: i * 10 + 101 },
    }));
    const got = formatMovePairs(moves, maxMoveHints);
    assert.ok(got.endsWith("and 2 more"));
    assert.equal(got.split(", ").length, maxMoveHints + 1);
  });
});
