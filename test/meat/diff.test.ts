import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import {
  splitSourceLines,
  validateSupportedDiffLines,
  validateSupportedDiff,
  analyzeDiff,
  numberedDiff,
  containingHunk,
  isHunkSource,
  nextLayoutLine,
  joinEditPlanErrors,
  hunkSourceKind,
  parseHunkCounts,
  diffHeaderLanguage,
  fileMarkerLanguage,
  pathLanguage,
  isRawOldFileHeader,
  isFormatPatchSignature,
  isNoNewlineMarker,
  isGitDiffHeader,
  type DiffLayout,
} from "../../src/meat/diff.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);

// A minimal, well-formed one-file, one-hunk git diff fixture, reused across
// several describe blocks below.
const SIMPLE_GIT_DIFF = [
  "diff --git a/foo.go b/foo.go",
  "index 1111111..2222222 100644",
  "--- a/foo.go",
  "+++ b/foo.go",
  "@@ -1,2 +1,2 @@",
  " unchanged",
  "-removed",
  "+added",
].join("\n") + "\n";

describe("hunkSourceKind (meat/diff.go:354-366)", () => {
  test("space prefix is hunk context", () => {
    assert.equal(hunkSourceKind(s(" ctx")), "hunk_context");
  });
  test("plus prefix is hunk change", () => {
    assert.equal(hunkSourceKind(s("+added")), "hunk_change");
  });
  test("minus prefix is hunk change", () => {
    assert.equal(hunkSourceKind(s("-removed")), "hunk_change");
  });
  test("empty line is other", () => {
    assert.equal(hunkSourceKind(s("")), "other");
  });
  test("any other first byte is other", () => {
    assert.equal(hunkSourceKind(s("prose")), "other");
  });
});

describe("isGitDiffHeader / isFormatPatchSignature / isNoNewlineMarker", () => {
  test("recognizes a diff --git header", () => {
    assert.ok(isGitDiffHeader(s("diff --git a/x b/x")));
  });
  test("rejects a non-header line", () => {
    assert.ok(!isGitDiffHeader(s("diff --gitx")));
  });
  test("mail signature is exactly '-- '", () => {
    assert.ok(isFormatPatchSignature(s("-- ")));
    assert.ok(!isFormatPatchSignature(s("--")));
    assert.ok(!isFormatPatchSignature(s("-- x")));
  });
  test("no-newline marker is the exact Go string", () => {
    assert.ok(isNoNewlineMarker(s("\\ No newline at end of file")));
    assert.ok(!isNoNewlineMarker(s("\\ No newline")));
  });
});

describe("isRawOldFileHeader", () => {
  test("recognizes a --- / +++ pair with spaces", () => {
    const lines = splitSourceLines(s("--- a/foo\n+++ b/foo\n"));
    assert.ok(isRawOldFileHeader(lines, 0));
  });
  test("recognizes a --- / +++ pair with tabs (git appends \\t<timestamp>)", () => {
    const lines = splitSourceLines(s("---\ta/foo\n+++\tb/foo\n"));
    assert.ok(isRawOldFileHeader(lines, 0));
  });
  test("rejects when the second line isn't +++", () => {
    const lines = splitSourceLines(s("--- a/foo\n other\n"));
    assert.ok(!isRawOldFileHeader(lines, 0));
  });
  test("rejects at the last line (no room for a pair)", () => {
    const lines = splitSourceLines(s("--- a/foo\n"));
    assert.ok(!isRawOldFileHeader(lines, 0));
  });
  test("a hunk body line reading '--- foo' followed by '+++ bar' is still just text here — this function is purely textual", () => {
    // isRawOldFileHeader itself has no hunk-awareness; analyzeDiff's counts
    // tracking is what distinguishes G3's case. See the analyzeDiff describe
    // block below for the real disambiguation test.
    const lines = splitSourceLines(s("--- x\n+++ y\n"));
    assert.ok(isRawOldFileHeader(lines, 0));
  });
});

describe("parseHunkCounts (meat/diff.go:368-379)", () => {
  test("parses a well-formed header with explicit counts", () => {
    const got = parseHunkCounts(s("@@ -1,2 +3,4 @@"));
    assert.deepEqual(got, { oldCount: 2, newCount: 4, countsKnown: true });
  });
  test("defaults count to 1 when no comma is present", () => {
    const got = parseHunkCounts(s("@@ -1 +1 @@"));
    assert.deepEqual(got, { oldCount: 1, newCount: 1, countsKnown: true });
  });
  test("ignores trailing hunk section text", () => {
    const got = parseHunkCounts(s("@@ -1,2 +3,4 @@ func main() {"));
    assert.deepEqual(got, { oldCount: 2, newCount: 4, countsKnown: true });
  });
  test("rejects fewer than 4 fields", () => {
    assert.equal(parseHunkCounts(s("@@ -1,2 @@")).countsKnown, false);
  });
  test("rejects when first field isn't '@@'", () => {
    assert.equal(parseHunkCounts(s("xx -1,2 +3,4 @@")).countsKnown, false);
  });
  test("rejects when fourth field isn't '@@'", () => {
    assert.equal(parseHunkCounts(s("@@ -1,2 +3,4 xx")).countsKnown, false);
  });
  test("rejects a non-numeric start-line even though the count is fine — value discarded, well-formedness required", () => {
    assert.equal(parseHunkCounts(s("@@ -x,3 +1,3 @@")).countsKnown, false);
  });
  test("rejects a negative count", () => {
    assert.equal(parseHunkCounts(s("@@ -1,-2 +1,3 @@")).countsKnown, false);
  });
  test("rejects wrong sign on old/new fields", () => {
    assert.equal(parseHunkCounts(s("@@ +1,2 -3,4 @@")).countsKnown, false);
  });
});

describe("pathLanguage (meat/diff.go:427-451)", () => {
  test("recognizes every table entry", () => {
    const cases: [string, string][] = [
      ["a.go", "go"],
      ["a.py", "python"],
      ["a.pyi", "python"],
      ["a.js", "javascript"],
      ["a.jsx", "javascript"],
      ["a.mjs", "javascript"],
      ["a.cjs", "javascript"],
      ["a.ts", "javascript"],
      ["a.tsx", "javascript"],
      ["a.mts", "javascript"],
      ["a.cts", "javascript"],
      ["a.rs", "rust"],
      ["a.c", "c"],
      ["a.h", "c"],
      ["a.cc", "c"],
      ["a.hh", "c"],
      ["a.cpp", "c"],
      ["a.hpp", "c"],
      ["a.cxx", "c"],
      ["a.hxx", "c"],
      ["a.java", "java"],
      ["a.kt", "java"],
      ["a.kts", "java"],
      ["a.txt", "unknown"],
      ["a", "unknown"],
    ];
    for (const [path, want] of cases) {
      assert.equal(pathLanguage(s(path)), want, path);
    }
  });
  test("is case-insensitive", () => {
    assert.equal(pathLanguage(s("A.GO")), "go");
    assert.equal(pathLanguage(s("Foo.PY")), "python");
  });
  test("strips surrounding quote bytes", () => {
    assert.equal(pathLanguage(s('"a/foo.go"')), "go");
  });
  test(".cc does not falsely match .c, .tsx does not falsely match .ts", () => {
    assert.equal(pathLanguage(s("a.cc")), "c");
    assert.equal(pathLanguage(s("a.tsx")), "javascript");
  });
});

describe("fileMarkerLanguage (meat/diff.go:416-425)", () => {
  test("extracts language from a --- path line", () => {
    assert.equal(fileMarkerLanguage(s("--- a/foo.py")), "python");
  });
  test("cuts at the first tab (git timestamp suffix)", () => {
    assert.equal(fileMarkerLanguage(s("--- a/foo.py\t2024-01-01")), "python");
  });
  test("too-short line is unknown", () => {
    assert.equal(fileMarkerLanguage(s("-- ")), "unknown");
  });
  test("/dev/null has no recognized extension", () => {
    assert.equal(fileMarkerLanguage(s("+++ /dev/null")), "unknown");
  });
});

describe("diffHeaderLanguage (meat/diff.go:401-414)", () => {
  test("destination path wins when recognized", () => {
    assert.equal(diffHeaderLanguage(s("diff --git a/old.py b/new.go")), "go");
  });
  test("falls back to source path when destination is unrecognized", () => {
    assert.equal(diffHeaderLanguage(s("diff --git a/old.py b/new")), "python");
  });
  test("fewer than 4 fields is unknown", () => {
    assert.equal(diffHeaderLanguage(s("diff --git a/old.py")), "unknown");
  });
});

describe("splitSourceLines re-export (meat/diff.go:66-86)", () => {
  test("empty input yields zero lines, not a phantom one", () => {
    assert.deepEqual(splitSourceLines(s("")), []);
  });
  test("no trailing newline: exactly as many lines as bodies", () => {
    const lines = splitSourceLines(s("a\nb"));
    assert.equal(lines.length, 2);
    assert.equal(decodeUTF8(lines[1]!.eol), "");
  });
});

describe("numberedDiff (meat/diff.go:126-137)", () => {
  test("empty input returns empty output", () => {
    assert.equal(numberedDiff(s("")).length, 0);
  });
  test("gutters right-justify to the digit width of the line count and always end in LF", () => {
    // 10 lines forces a width-2 gutter ("01|".. "10|" as " 1|".."10|" — Go
    // right-justifies with spaces, not zero-padding).
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n";
    const got = decodeUTF8(numberedDiff(s(text)));
    const outLines = got.split("\n").filter((l) => l.length > 0);
    assert.equal(outLines.length, 10);
    assert.equal(outLines[0], " 1|l0");
    assert.equal(outLines[9], "10|l9");
  });
  test("no trailing newline in source still gets no phantom gutter entry (G5)", () => {
    const got = decodeUTF8(numberedDiff(s("α\n\n+β")));
    assert.equal(got, "1|α\n2|\n3|+β\n");
    assert.ok(!got.includes("4|"));
  });
  test("gutter newline is always LF even for a CRLF source line", () => {
    const got = decodeUTF8(numberedDiff(s("a\r\nb")));
    assert.equal(got, "1|a\n2|b\n");
  });
});

describe("validateSupportedDiffLines (meat/diff.go:104-122, G1)", () => {
  test("accepts an ordinary diff", () => {
    assert.doesNotThrow(() => validateSupportedDiffLines(splitSourceLines(s(SIMPLE_GIT_DIFF))));
  });
  test("rejects 'diff --cc ' with the exact header-form message", () => {
    const lines = splitSourceLines(s("diff --cc foo.go\n@@@ -1,1 -1,1 +1,1 @@@\n"));
    assert.throws(() => validateSupportedDiffLines(lines), {
      message: "combined diff on line 1 is unsupported; use a normal first-parent or two-tree diff",
    });
  });
  test("rejects 'diff --combined ' too", () => {
    const lines = splitSourceLines(s("diff --combined foo.go\n"));
    assert.throws(() => validateSupportedDiffLines(lines), /combined diff on line 1/);
  });
  test("rejects a bare @@@ hunk header while inPatch, with the hunk-form message", () => {
    const lines = splitSourceLines(s("diff --git a/x b/x\n@@@ -1,1 -1,1 +1,1 @@@\n"));
    assert.throws(() => validateSupportedDiffLines(lines), {
      message: "combined diff hunk on line 2 is unsupported; use a normal first-parent or two-tree diff",
    });
  });
  test("a mail signature resets inPatch, so a later @@@ is not flagged", () => {
    const lines = splitSourceLines(s("diff --git a/x b/x\n-- \n@@@ commit prose\n"));
    assert.doesNotThrow(() => validateSupportedDiffLines(lines));
  });
  test("@@@ before any patch marker (not inPatch) is not flagged by this pass", () => {
    const lines = splitSourceLines(s("@@@ this is commit prose\ndiff --git a/x b/x\n"));
    assert.doesNotThrow(() => validateSupportedDiffLines(lines));
  });
});

describe("analyzeDiff (meat/diff.go:165-352)", () => {
  test("classifies a simple git diff end to end", () => {
    const lines = splitSourceLines(s(SIMPLE_GIT_DIFF));
    const layout = analyzeDiff(lines);
    assert.deepEqual(layout.kinds, [
      "header",
      "index",
      "old_file",
      "new_file",
      "hunk_header",
      "hunk_context",
      "hunk_change",
      "hunk_change",
    ]);
    assert.deepEqual(layout.problems, []);
    assert.deepEqual(layout.fileId, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(layout.hunkId, [-1, -1, -1, -1, 0, 0, 0, 0]);
    assert.deepEqual(layout.languages, Array(8).fill("go"));
    assert.deepEqual(layout.python, Array(8).fill(false));
  });

  test("counts inconsistent: body has more lines than declared (site 1, both sides exhausted)", () => {
    const diff = "@@ -1,1 +1,1 @@\n line one\n+extra\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.problems.length, 1);
    assert.match(layout.problems[0]!, /counts inconsistent/);
    // the extra line is still classified as hunk source, not dropped
    assert.equal(layout.kinds[2], "hunk_change");
  });

  test("counts inconsistent: one side over-claims mid-hunk (site 2)", () => {
    const diff = "@@ -1,1 +1,0 @@\n-removed\n+unexpected-add\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.ok(layout.problems.length >= 1);
    assert.match(layout.problems[0]!, /counts inconsistent/);
  });

  test("counts inconsistent: hunk ends early, undeclared remaining count (site 3)", () => {
    const diff = "@@ -1,3 +1,3 @@\n only one line\nnot hunk source at all\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.problems.length, 1);
    assert.match(layout.problems[0]!, /counts inconsistent/);
  });

  test("counts inconsistent: diff ends mid-hunk with remaining count (site 4, EOF)", () => {
    const diff = "@@ -1,5 +1,5 @@\n only one line\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.problems.length, 1);
    assert.match(layout.problems[0]!, /counts inconsistent/);
  });

  test("only one problem is reported per hunk even with multiple violations", () => {
    const diff = "@@ -1,1 +1,1 @@\n a\n+b\n+c\n+d\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.problems.length, 1);
  });

  test("G3: a hunk body line reading like a file header stays hunk source while counts remain", () => {
    // Body claims 2 old-side lines; the first is a removed line, the second
    // is text that looks exactly like a raw file-header pair but must be
    // read as ordinary hunk source because oldRemain is still > 0.
    const realDiff = "@@ -2 +0 @@\n--- a/foo\n+++ b/foo\n";
    const layout = analyzeDiff(splitSourceLines(s(realDiff)));
    // oldCount=1 (no comma => defaults to 1), newCount=1 similarly, so with
    // 2 body lines counts will actually be exceeded — instead verify the
    // lines are classified as hunk source, not as old_file/new_file, proving
    // they were NOT reclassified as a trailing header while inHunk.
    assert.equal(layout.kinds[1], "hunk_change");
    assert.equal(layout.kinds[2], "hunk_change");
  });

  test("once counts are exhausted, a following --- / +++ pair really does start a new file", () => {
    const diff =
      "--- a/foo\n+++ b/foo\n@@ -1,1 +1,1 @@\n-old\n+new\n--- a/bar\n+++ b/bar\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.deepEqual(layout.problems, []);
    assert.equal(layout.kinds[5], "old_file");
    assert.equal(layout.kinds[6], "new_file");
    // the raw pair starts a new file id since it's not inside a git section
    assert.equal(layout.fileId[0], 0);
    assert.equal(layout.fileId[5], 1);
  });

  test("unparseable @@ header recovers only at an explicit paired file header", () => {
    const diff = "@@ not parseable @@\nsome text\n--- a/foo\n+++ b/foo\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.kinds[0], "hunk_header");
    // "some text" is swallowed as unclassified hunk-ish content until the
    // paired header is reached (hunkSourceKind("some text") is "other", so
    // it falls out of the hunk immediately and is reprocessed structurally).
    assert.equal(layout.kinds[2], "old_file");
    assert.equal(layout.kinds[3], "new_file");
  });

  test("no-newline marker is owned by the immediately preceding hunk-source line", () => {
    const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.kinds[3], "no_newline");
    assert.equal(layout.markerOwner[3], 2);
  });

  test("no-newline marker not directly following hunk source gets markerOwner -1", () => {
    const diff = "@@ -0,0 +0,0 @@\n\\ No newline at end of file\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.kinds[1], "no_newline");
    assert.equal(layout.markerOwner[1], -1);
  });

  test("raw (non-git) multi-file diff: each --- / +++ pair gets its own file id", () => {
    const diff = "--- a/one\n+++ b/one\n@@ -1,1 +1,1 @@\n-x\n+y\n--- a/two\n+++ b/two\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.fileId[0], 0);
    assert.equal(layout.fileId[5], 1);
  });

  test("git-style file section's own --- / +++ pair shares the diff --git file id", () => {
    const diff = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.deepEqual(layout.fileId, [0, 0, 0, 0, 0, 0, 0]);
  });

  test("bare '@@ ' hunk header is recognized even before any file section (open question, diff.md)", () => {
    const diff = "@@ this looks like commit prose\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.kinds[0], "hunk_header");
  });

  test("rename from/to and copy from/to inside a file section", () => {
    const diff = "diff --git a/old b/new\nrename from old\nrename to new\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.deepEqual(layout.kinds, ["header", "rename_from", "rename_to"]);
  });

  test("index/similarity index/dissimilarity index lines", () => {
    const diff = "diff --git a/x b/x\nsimilarity index 100%\ndissimilarity index 50%\nindex abc..def\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.deepEqual(layout.kinds, ["header", "index", "index", "index"]);
  });

  test("mail signature ends a file section and resets git-section state", () => {
    const diff = "diff --git a/x b/x\n-- \n--- a/y\n+++ b/y\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.equal(layout.kinds[1], "mail_signature");
    // gitFileSection was reset, so this raw pair starts its own new file id (1)
    assert.equal(layout.fileId[2], 1);
  });

  test("unclassified lines default to 'other' (zero value)", () => {
    const diff = "just some prose\nmore prose\n";
    const layout = analyzeDiff(splitSourceLines(s(diff)));
    assert.deepEqual(layout.kinds, ["other", "other"]);
  });
});

describe("validateSupportedDiff (meat/diff.go:88-98)", () => {
  test("accepts a well-formed diff", () => {
    assert.doesNotThrow(() => validateSupportedDiff(s(SIMPLE_GIT_DIFF)));
  });
  test("throws the combined-diff message before ever reaching analyzeDiff", () => {
    assert.throws(() => validateSupportedDiff(s("diff --cc foo\n")), {
      message: "combined diff on line 1 is unsupported; use a normal first-parent or two-tree diff",
    });
  });
  test("throws the joined counts-inconsistent message", () => {
    assert.throws(() => validateSupportedDiff(s("@@ -1,5 +1,5 @@\n only one\n")), {
      message: "hunk header on line 1 has counts inconsistent with its body near line 2",
    });
  });
});

describe("containingHunk (meat/diff.go:139-156)", () => {
  test("finds the start/end bounds of the hunk containing a given line", () => {
    const layout = analyzeDiff(splitSourceLines(s(SIMPLE_GIT_DIFF)));
    const { start, end } = containingHunk(layout, 6);
    assert.equal(start, 5); // first line after the hunk header
    assert.equal(end, layout.kinds.length); // runs to the end of the diff
  });
});

describe("nextLayoutLine (meat/diff.go:471-480)", () => {
  test("returns the first index at or after start satisfying the predicate", () => {
    const layout = analyzeDiff(splitSourceLines(s(SIMPLE_GIT_DIFF)));
    const idx = nextLayoutLine(layout, 0, (k) => k === "hunk_header");
    assert.equal(idx, 4);
  });
  test("returns the array length when nothing matches", () => {
    const layout = analyzeDiff(splitSourceLines(s(SIMPLE_GIT_DIFF)));
    const idx = nextLayoutLine(layout, 0, (k) => k === "rename_from");
    assert.equal(idx, layout.kinds.length);
  });
});

describe("isHunkSource", () => {
  test("true only for hunk_context and hunk_change", () => {
    assert.ok(isHunkSource("hunk_context"));
    assert.ok(isHunkSource("hunk_change"));
    assert.ok(!isHunkSource("hunk_header"));
    assert.ok(!isHunkSource("other"));
  });
});

describe("joinEditPlanErrors (meat/editplan.go:531-539)", () => {
  test("a single problem passes through unwrapped", () => {
    const err = joinEditPlanErrors(["only problem"]);
    assert.equal(err.message, "only problem");
  });
  test("multiple problems join into the numbered/bulleted form", () => {
    const err = joinEditPlanErrors(["first", "second"]);
    assert.equal(err.message, "edit plan has 2 errors:\n- first\n- second");
  });
});

describe("DiffLayout shape sanity", () => {
  test("all parallel arrays share the line count", () => {
    const layout: DiffLayout = analyzeDiff(splitSourceLines(s(SIMPLE_GIT_DIFF)));
    const n = 8;
    for (const arr of [layout.kinds, layout.markerOwner, layout.python, layout.languages, layout.fileId, layout.hunkId]) {
      assert.equal(arr.length, n);
    }
  });
});
