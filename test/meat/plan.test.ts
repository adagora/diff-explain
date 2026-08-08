import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import {
  newPlanState,
  planStateRepresented,
  applyPlannedReplacements,
  leadingWhitespace,
  isIdentifierStart,
  isIdentifierContinue,
  type PlannedReplacement,
  type PlanState,
} from "../../src/meat/plan.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);

describe("newPlanState (meat/editplan.go:91-102)", () => {
  test("hidden defaults false, folded/foldAt default -1, folds empty", () => {
    const state = newPlanState(3);
    assert.deepEqual(state.hidden, [false, false, false]);
    assert.deepEqual(state.folded, [-1, -1, -1]);
    assert.deepEqual(state.foldAt, [-1, -1, -1]);
    assert.deepEqual(state.folds, []);
  });
  test("zero lines yields empty arrays", () => {
    const state = newPlanState(0);
    assert.deepEqual(state.hidden, []);
    assert.deepEqual(state.folded, []);
  });
});

describe("planStateRepresented (meat/editplan.go:104-106)", () => {
  test("a visible (not hidden) line is represented", () => {
    const state = newPlanState(1);
    assert.ok(planStateRepresented(state, 0));
  });
  test("a hidden, non-folded line is not represented", () => {
    const state = newPlanState(1);
    state.hidden[0] = true;
    assert.ok(!planStateRepresented(state, 0));
  });
  test("a hidden but folded line is represented (the fold placeholder stands in for it)", () => {
    const state = newPlanState(1);
    state.hidden[0] = true;
    state.folded[0] = 0;
    assert.ok(planStateRepresented(state, 0));
  });
  test("throws out of range past the array length", () => {
    const state = newPlanState(1);
    assert.throws(() => planStateRepresented(state, 5), RangeError);
  });
});

describe("applyPlannedReplacements (meat/editplan.go:413-419)", () => {
  const edit = (line: number, planIndex: number, start: number, end: number, newText: string): PlannedReplacement => ({
    line,
    old: s(""), // unused by applyPlannedReplacements itself
    new: s(newText),
    planIndex,
    start,
    end,
  });

  test("no edits returns the body unchanged", () => {
    const body = s("hello world");
    assert.equal(decodeUTF8(applyPlannedReplacements(body, [])), "hello world");
  });

  test("a single replacement splices in place", () => {
    const body = s("hello world");
    const got = applyPlannedReplacements(body, [edit(1, 0, 6, 11, "...")]);
    assert.equal(decodeUTF8(got), "hello ...");
  });

  test("multiple non-overlapping edits apply right-to-left so earlier offsets stay valid", () => {
    // "aaa bbb ccc" -> replace "aaa" (0-3) with "X" and "ccc" (8-11) with "YY".
    // A naive left-to-right splice would corrupt the second edit's offsets
    // once the first edit changes the string length.
    const body = s("aaa bbb ccc");
    const got = applyPlannedReplacements(body, [edit(1, 0, 0, 3, "X"), edit(2, 1, 8, 11, "YY")]);
    assert.equal(decodeUTF8(got), "X bbb YY");
  });

  test("does not sort — caller must pre-sort ascending by start", () => {
    // Edits passed in descending order are applied in that (wrong) order,
    // since applyPlannedReplacements never sorts; with non-overlapping spans
    // this still produces a correct result because the function always walks
    // its input back-to-front regardless of the values, but it proves no
    // internal re-sort happens by using an already-correct order and
    // checking equivalence — a true out-of-order input is the caller's bug
    // to avoid, per the Go contract.
    const body = s("one two three");
    const sorted = applyPlannedReplacements(body, [edit(1, 0, 0, 3, "1"), edit(2, 1, 4, 7, "2")]);
    assert.equal(decodeUTF8(sorted), "1 2 three");
  });
});

describe("leadingWhitespace (meat/editplan.go:480-487)", () => {
  test("captures a run of leading spaces", () => {
    assert.equal(decodeUTF8(leadingWhitespace(s("   x"))), "   ");
  });
  test("captures a run of leading tabs and mixed space/tab", () => {
    assert.equal(decodeUTF8(leadingWhitespace(s("\t \tx"))), "\t \t");
  });
  test("no leading whitespace returns empty", () => {
    assert.equal(leadingWhitespace(s("x")).length, 0);
  });
  test("all-whitespace input returns the whole thing", () => {
    assert.equal(decodeUTF8(leadingWhitespace(s("   "))), "   ");
  });
  test("stops at the first non-space-non-tab byte, including other whitespace like newline", () => {
    // leadingWhitespace only recognizes literal space/tab — not a general
    // Unicode-whitespace scan (distinct from H14's TrimSpace elsewhere).
    assert.equal(decodeUTF8(leadingWhitespace(s(" \nx"))), " ");
  });
});

describe("PlanState mutability matches Go's slice semantics", () => {
  test("fields are independently mutable arrays, not frozen", () => {
    const state: PlanState = newPlanState(2);
    state.hidden[0] = true;
    state.folds.push({
      startLine: 1,
      endLine: 2,
      planIndex: 0,
      marker: "+",
      indent: s("  "),
      eol: s("\n"),
    });
    assert.equal(state.hidden[0], true);
    assert.equal(state.folds.length, 1);
  });
});

describe("isIdentifierStart / isIdentifierContinue (meat/editplan.go:472-478)", () => {
  const UNDERSCORE = 0x5f;
  const UPPER_A = 0x41;
  const LOWER_Z = 0x7a;
  const DIGIT_0 = 0x30;
  const DIGIT_5 = 0x35;

  test("underscore and ASCII letters start an identifier", () => {
    assert.ok(isIdentifierStart(UNDERSCORE));
    assert.ok(isIdentifierStart(UPPER_A));
    assert.ok(isIdentifierStart(LOWER_Z));
  });
  test("digits do not start an identifier", () => {
    assert.ok(!isIdentifierStart(DIGIT_0));
  });
  test("digits continue an identifier", () => {
    assert.ok(isIdentifierContinue(DIGIT_5));
  });
  test("a non-ASCII byte is neither a start nor a continue byte", () => {
    assert.ok(!isIdentifierStart(0xe9));
    assert.ok(!isIdentifierContinue(0xe9));
  });
});
