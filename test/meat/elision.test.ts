// Port of meat/elision_test.go (11 tests). TestElisionLine_FileHeadersNotCounted
// tests the unexported `diffStats` directly in Go; `diffStats` stays
// unexported here too (matching this codebase's convention — see
// editplan.test.ts's `validateSummary` for the same pattern), so it is
// ported indirectly: an identity diff (raw fed back as its own abridged
// form) exercises exactly the same counts (G1's own mechanism) and asserts
// the (5, 2) shape through `ElisionLine`'s "in %d/%d files" clause instead.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8 } from "../../src/meat/bytes.ts";
import { applyEditPlan, type Submission } from "../../src/meat/editplan.ts";
import { ElisionLine } from "../../src/meat/elision.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);

const rawTwoFiles = s(
  "diff --git a/a.go b/a.go\n" +
    "--- a/a.go\n" +
    "+++ b/a.go\n" +
    "@@ -1,3 +1,4 @@\n" +
    " package a\n" +
    "-old1\n" +
    "+new1\n" +
    "+new2\n" +
    "diff --git a/b.pb.go b/b.pb.go\n" +
    "--- a/b.pb.go\n" +
    "+++ b/b.pb.go\n" +
    "@@ -1,2 +1,3 @@\n" +
    "+gen1\n" +
    "+gen2\n",
);

describe("ElisionLine (meat/elision_test.go)", () => {
  test("partial retention on both axes at once (G3)", () => {
    const abridged = s(
      "diff --git a/a.go b/a.go\n" + "@@ -1,3 +1,4 @@\n" + "+new1\n",
    );
    // raw: 5 changed lines (old1,new1,new2,gen1,gen2) in 2 files; kept 1 line in 1 file.
    assert.equal(ElisionLine(rawTwoFiles, abridged), "kept 1/5 changed lines in 1/2 files");
  });

  test("empty abridged diff reports 'elided all' rather than 0/N (G4)", () => {
    const got = ElisionLine(rawTwoFiles, s(""));
    assert.ok(got.includes("elided all 5 changed lines"), got);
  });

  test("kept hunks but no per-file headers fall back to a lines-only phrasing (G5)", () => {
    const got = ElisionLine(rawTwoFiles, s("@@ -1 +1 @@\n+new1\n"));
    assert.equal(got, "kept 1/5 changed lines");
  });

  test("literal --- /+++ lines inside a hunk body are not mistaken for file headers; alignment is forward-only (G6)", () => {
    const raw = s(
      "--- a/one.go\n" +
        "+++ b/one.go\n" +
        "@@ -1 +1 @@\n" +
        "--- a/two.go\n" +
        "+++ b/two.go\n" +
        "--- a/two.go\n" +
        "+++ b/two.go\n" +
        "@@ -1 +1 @@\n" +
        "-old\n" +
        "+new\n",
    );
    const abridged = s("--- a/two.go\n" + "+++ b/two.go\n" + "@@ -1 +1 @@\n" + "-old\n" + "+new\n");
    assert.equal(ElisionLine(raw, abridged), "kept 2/4 changed lines");
  });

  test("two adjacent Replace placeholders that compose into one longer ellipsis run count as one kept row (G7)", () => {
    const raw = s("diff --git a/a b/a\n@@ -0,0 +1 @@\n+abcdef\n");
    const submission: Submission = {
      summary: "Elides adjacent details.",
      remove: [],
      fold: [],
      replace: [
        { line: 3, old: "ab", new: "..." },
        { line: 3, old: "cd", new: "..." },
      ],
    };
    const abridged = applyEditPlan(raw, submission);
    assert.ok(new TextDecoder().decode(abridged).includes("+......ef"), new TextDecoder().decode(abridged));
    assert.equal(ElisionLine(raw, abridged), "kept 1/1 changed lines in 1/1 files");
  });

  test("an earlier projection candidate wins over a later exact duplicate — greedy left-to-right order (G8)", () => {
    const raw = s("diff --git a/a b/a\n@@ -0,0 +1,4 @@\n+aSECRETz\n+after-first\n+a...z\n+after-exact\n");
    const abridged = s("diff --git a/a b/a\n@@ -0,0 +1,4 @@\n+a...z\n+after-first\n");
    assert.equal(ElisionLine(raw, abridged), "kept 2/4 changed lines in 1/1 files");
  });

  test("1000 never-matching projection lines finish within a generous wall-clock ceiling and credit zero (G9)", () => {
    let raw = "diff --git a/a b/a\n@@ -0,0 +1,1000 @@\n";
    let abridged = "diff --git a/a b/a\n@@ -0,0 +1,1000 @@\n";
    for (let i = 0; i < 1000; i++) {
      raw += "+raw\n";
      abridged += "+missing...zzz\n";
    }
    const start = Date.now();
    const got = ElisionLine(s(raw), s(abridged));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `ElisionLine took ${elapsed}ms for 1000 divergent projection lines`);
    assert.equal(got, "kept 0/1000 changed lines in 1/1 files");
  });

  test("a synthetic fold row collapsing several changed rows counts as exactly one kept row (G10)", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+first()\n+second()\n+third()\n");
    const submission: Submission = {
      summary: "Folds repeated calls.",
      remove: [],
      replace: [],
      fold: [{ startLine: 3, endLine: 5 }],
    };
    const abridged = applyEditPlan(raw, submission);
    assert.equal(ElisionLine(raw, abridged), "kept 1/3 changed lines in 1/1 files");
  });

  test("a fold's synthetic ellipsis row does not consume a later, unrelated literal '...' row (G11)", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+first()\n+second()\n+middle()\n+...\n+last()\n");
    const submission: Submission = {
      summary: "Folds calls.",
      remove: [],
      replace: [],
      fold: [{ startLine: 3, endLine: 4 }],
    };
    const abridged = applyEditPlan(raw, submission);
    assert.equal(ElisionLine(raw, abridged), "kept 4/5 changed lines in 1/1 files");
  });

  test("a stale @@ hunk header does not perturb the count — counting reads classified body rows only (G12)", () => {
    const raw = s(
      "--- a/one.go\n" +
        "+++ b/one.go\n" +
        "@@ -1,2 +1,2 @@\n" +
        " one\n" +
        "-a\n" +
        "+b\n" +
        "--- a/two.go\n" +
        "+++ b/two.go\n" +
        "@@ -1,2 +1,2 @@\n" +
        " two\n" +
        "-c\n" +
        "+d\n",
    );
    const abridged = s(
      "--- a/one.go\n" +
        "+++ b/one.go\n" +
        "@@ -1,2 +1,2 @@\n" +
        " one\n" +
        "+b\n" +
        "--- a/two.go\n" +
        "+++ b/two.go\n" +
        "@@ -1,2 +1,2 @@\n" +
        " two\n" +
        "-c\n" +
        "+d\n",
    );
    assert.equal(ElisionLine(raw, abridged), "kept 3/4 changed lines");
  });

  // TestElisionLine_FileHeadersNotCounted ported indirectly (see file header
  // comment): an identity diff exercises diffStats' (changed, files) = (5, 2)
  // shape through ElisionLine's own file-header/hunk-change classification,
  // without needing `diffStats` exported.
  test("+++/--- old/new-file header lines are not counted as changed lines or files (indirect port of G13's diffStats check)", () => {
    assert.equal(ElisionLine(rawTwoFiles, rawTwoFiles), "kept 5/5 changed lines in 2/2 files");
  });
});
