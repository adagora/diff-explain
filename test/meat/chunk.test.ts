// Port of meat/chunk_test.go's TestSplitDiff_* tests (16), TestFitsSingleRun,
// and every TestAbridge_Chunked* test (18) — the latter needing
// `Abridge`/`scriptedModel`, unavailable until item 4n (meat.ts). Three
// `TestSplitDiff_*` tests were two-part; their `Abridge`-based second halves
// are completed below too, now that meat.ts exists:
//  - TestSplitDiff_ImportBlockNeverSeveredOrLeaked's G11 half (the merged
//    reading diff has zero import scaffolding, end to end).
//  - TestSplitDiff_InterleavedSideStringInteriorAtomic's changed-row-match
//    half (chunked changed rows equal a real agent-loop run's).
//  - TestSplitDiff_PythonContinuationsAtomic's G40 half (orphaning a
//    continuation is rejected inside the chunk).
// TestRequestStaysPositionalCompatible is ported in meat.test.ts instead
// (as a Request-shape test), since it's fundamentally about `Request`/
// `RunOptions`, not chunk splitting.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { splitSourceLines, analyzeDiff, isHunkSource, numberedDiff, validateSupportedDiff } from "../../src/meat/diff.ts";
import { splitDiffForAbridging, fitsSingleRun, type DiffChunk } from "../../src/meat/chunk.ts";
import { Abridge, meatConfig, type Request } from "../../src/meat/meat.ts";
import { surfaceFixtureDiff } from "../../src/meat/rubric.ts";
import { type Model, type Message, type Block, type Response, type Tool, type ToolUseBlock } from "../../src/meat/model.ts";
import { compileEditPlan } from "../../src/meat/editplan.ts";
import { detectedMovesInDiff, detectExactMoves } from "../../src/meat/moves.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);
const d = (b: Uint8Array): string => decodeUTF8(b);

// ---------------------------------------------------------------------------
// Test infrastructure shared with meat.test.ts (meat/meat_test.go:16-33) —
// duplicated per this codebase's established per-file convention (see
// meat.test.ts/tools.test.ts's own git-repo helper duplication).
// ---------------------------------------------------------------------------

function toolUse(id: string, name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id, toolName: name, toolInput: s(JSON.stringify(input)) };
}

function assistant(...content: Block[]): Response {
  return { content, inputTokens: 100, outputTokens: 20 };
}

interface ScriptedModel extends Model {
  seen: number;
  lastTools: readonly Tool[];
  seenMessages: Message[][];
}

function newScriptedModel(turns: readonly Response[]): ScriptedModel {
  const m: ScriptedModel = {
    seen: 0,
    lastTools: [],
    seenMessages: [],
    async generate(_signal: AbortSignal, _system: string, messages: readonly Message[], tools: readonly Tool[]): Promise<Response> {
      m.lastTools = tools;
      m.seenMessages.push([...messages]);
      m.seen++;
      if (m.seen > turns.length) return turns[turns.length - 1]!;
      return turns[m.seen - 1]!;
    },
  };
  return m;
}

/** Go's `setSingleRunBudget` (`meat/chunk_test.go:13-18`). */
function setSingleRunBudget(budget: number): () => void {
  const old = meatConfig.singleRunDiffBytes;
  meatConfig.singleRunDiffBytes = budget;
  return () => {
    meatConfig.singleRunDiffBytes = old;
  };
}

/** Go's `fileSection` (`meat/chunk_test.go:27-35`): one file section with a single hunk of n added rows. */
function fileSection(name: string, n: number): string {
  let out = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${n} @@\n`;
  for (let i = 0; i < n; i++) out += `+${name} row ${i}\n`;
  return out;
}

/** Go's `requireValidChunks` (`meat/chunk_test.go:37-52`): every chunk fits the budget as raw and numbered text and is independently a well-formed diff. */
function requireValidChunks(chunks: readonly DiffChunk[], budget: number): void {
  chunks.forEach((c, i) => {
    assert.ok(c.text.length <= budget, `chunk ${i} raw size ${c.text.length} exceeds budget ${budget}`);
    const numbered = numberedDiff(c.text);
    assert.ok(numbered.length <= budget, `chunk ${i} numbered size ${numbered.length} exceeds budget ${budget}`);
    validateSupportedDiff(c.text); // throws (with the chunk's own text) if not independently valid
  });
}

/** Go's `chunkBodyRows` (`meat/chunk_test.go:57-67`). */
function chunkBodyRows(text: Uint8Array): string[] {
  const lines = splitSourceLines(text);
  const layout = analyzeDiff(lines);
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHunkSource(layout.kinds[i]!) || layout.kinds[i] === "no_newline") rows.push(d(lines[i]!.text));
  }
  return rows;
}

describe("splitDiffForAbridging (meat/chunk_test.go)", () => {
  test("packs consecutive whole file sections into one chunk; reassembles byte-for-byte (G1)", () => {
    const diff = fileSection("a", 5) + fileSection("b", 5) + fileSection("c", 5);
    const one = fileSection("a", 5);
    const budget = numberedDiff(s(one + one)).length;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.equal(chunks.length, 2, "two sections packed, then one");
    assert.ok(d(chunks[0]!.text).includes("diff --git a/a") && d(chunks[0]!.text).includes("diff --git a/b"));
    assert.ok(d(chunks[1]!.text).includes("diff --git a/c") && !chunks[1]!.continuation);
    assert.equal(d(chunks[0]!.text) + d(chunks[1]!.text), diff, "whole-section chunks should reassemble the original diff exactly");
  });

  test("a file section too large to fit whole splits at hunk boundaries, replicating metadata verbatim (G2)", () => {
    let diff = "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 6; h++) {
      diff += `@@ -${h * 10 + 1},2 +${h * 10 + 1},3 @@ func f${h}()\n context ${h}\n+added ${h}\n context tail ${h}\n`;
    }
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 40;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split");
    let rows: string[] = [];
    chunks.forEach((c, i) => {
      assert.ok(d(c.text).startsWith("diff --git a/big.go"), `chunk ${i} lost its replicated file metadata`);
      assert.equal(c.continuation, i > 0, `chunk ${i} continuation`);
      assert.ok(c.sectionId >= 0, `chunk ${i} of a split section should carry its section ID`);
      assert.ok(d(c.text).includes(" @@ func f"), `chunk ${i} lost hunk headings`);
      rows = rows.concat(chunkBodyRows(c.text));
    });
    assert.deepEqual(rows, chunkBodyRows(s(diff)), "split lost or reordered hunk rows");
  });

  test("an oversized hunk is cut into synthesized sub-hunks; every changed row survives in order; only the first segment keeps the heading (G3, G4)", () => {
    let diff = "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n@@ -100,30 +200,45 @@ func big()\n";
    for (let i = 0; i < 30; i++) {
      diff += ` context row ${String(i).padStart(2, "0")}\n`;
      if (i % 2 === 0) diff += `+added row ${String(i).padStart(2, "0")}\n`;
    }
    const budget = Math.floor(numberedDiff(s(diff)).length / 3) + 60;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split");

    const changedOnly = (rows: string[]): string[] => rows.filter((r) => r.startsWith("+") || r.startsWith("-"));
    let rows: string[] = [];
    for (const c of chunks) rows = rows.concat(changedOnly(chunkBodyRows(c.text)));
    assert.deepEqual(rows, changedOnly(chunkBodyRows(s(diff))), "hunk split lost or reordered changed rows");

    assert.ok(d(chunks[0]!.text).includes("@@ -100,") && d(chunks[0]!.text).includes("+200,"), "first segment header should keep original starts");
    assert.ok(d(chunks[0]!.text).includes(" @@ func big()"), "first segment lost the hunk heading");
    chunks.slice(1).forEach((c, i) => {
      assert.ok(!d(c.text).includes("func big()"), `chunk ${i + 1} replicated the hunk heading it does not start inside`);
    });
  });

  test("a no-newline marker is never separated from its owning source line by a cut (G5)", () => {
    let diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,6 +1,6 @@\n";
    for (let i = 0; i < 5; i++) diff += ` ctx ${i}\n`;
    diff += "-old tail\n+new tail\n\\ No newline at end of file\n";
    const meta = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,6 +1,6 @@\n";
    const budget = numberedDiff(s(meta)).length + 80;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split around the marker");
    for (const c of chunks) {
      const text = d(c.text);
      if (text.includes("No newline")) {
        assert.ok(text.includes("+new tail\n\\ No newline"), `chunk separated the no-newline marker from its source line:\n${text}`);
      }
    }
  });

  test("a file section with no hunks to divide fails with narrower-range advice, not a crash (G6)", () => {
    const diff = "diff --git a/x b/x\nBinary files a/x and b/x differ\n" + "junk\n".repeat(100);
    assert.throws(() => splitDiffForAbridging(s(diff), 80), /narrower/);
  });

  test("synthesized segment headers follow unified-diff's gap convention exactly (G7)", () => {
    const meta = "diff --git a/a b/a\n--- a/a\n+++ b/a\n";
    const diff = meta + "@@ -10,2 +20,2 @@\n-old10\n-old11\n+new20\n+new21\n";
    const budget = numberedDiff(s(meta + "@@ -10,1 +19,0 @@\n-old10\n")).length;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    const want = [
      "@@ -10,1 +19,0 @@\n-old10\n",
      "@@ -11,1 +19,0 @@\n-old11\n",
      "@@ -11,0 +20,1 @@\n+new20\n",
      "@@ -11,0 +21,1 @@\n+new21\n",
    ];
    assert.equal(chunks.length, want.length, "want single-row segments");
    chunks.forEach((c, i) => assert.equal(d(c.text), meta + want[i]));
  });

  test("a side whose original count was already zero is not re-decremented on later segments (G8)", () => {
    const meta = "diff --git a/a b/a\n--- a/a\n+++ b/a\n";
    const diff = meta + "@@ -10,0 +11,4 @@\n+r0\n+r1\n+r2\n+r3\n";
    const budget = numberedDiff(s(meta + "@@ -10,0 +11,2 @@\n+r0\n+r1\n")).length;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split");
    let wantNew = 11;
    for (const c of chunks) {
      const text = d(c.text);
      assert.ok(text.includes("@@ -10,0 "), `shifted the originally empty old side, want -10,0:\n${text}`);
      assert.ok(text.includes(`+${wantNew},`), `new start: want +${wantNew}:\n${text}`);
      wantNew += (text.match(/\n\+r/g) ?? []).length;
    }
  });

  test("splitting a new-file hunk never synthesizes a negative old-side start (G9)", () => {
    const meta = "diff --git a/a b/a\n--- /dev/null\n+++ b/a\n";
    const diff = meta + "@@ -0,0 +1,4 @@\n+r0\n+r1\n+r2\n+r3\n";
    const budget = numberedDiff(s(meta + "@@ -0,0 +1,2 @@\n+r0\n+r1\n")).length;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    for (const c of chunks) assert.ok(d(c.text).includes("@@ -0,0 "), `chunk old side should stay -0,0:\n${d(c.text)}`);
  });

  test("the whole-diff mandatory import mask is pre-applied — import scaffolding appears in no chunk (G10; end-to-end merge half deferred to meat.ts, G11)", () => {
    const meta = "diff --git a/a.go b/a.go\n--- /dev/null\n+++ b/a.go\n";
    const before = 10;
    const members = 8;
    const after = 10;
    let body = `@@ -0,0 +1,${5 + before + members + after} @@\n+package a\n+\n`;
    for (let i = 0; i < before; i++) body += `+var a${i} = ${i}\n`;
    body += "+import (\n";
    for (let i = 0; i < members; i++) body += `+\t"pkg${i}"\n`;
    body += "+)\n+func F() {}\n";
    for (let i = 0; i < after; i++) body += `+var b${i} = ${i}\n`;
    const diff = meta + body;
    // Budget sized so a naive per-line greedy cut would land mid-block.
    const marker = '"pkg3"\n';
    const prefixEnd = diff.indexOf(marker) + marker.length;
    const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split");
    for (const c of chunks) {
      const text = d(c.text);
      assert.ok(!text.includes('"pkg') && !text.includes("import ("), `chunk contains import scaffolding a chunk-local compiler cannot own:\n${text}`);
    }
  });

  test("synthesized segment headers adopt the original hunk header's CRLF line ending throughout (G12)", () => {
    const crlf = (text: string): string => text.replace(/\n/g, "\r\n");
    const meta = crlf("diff --git a/a b/a\n--- a/a\n+++ b/a\n");
    let body = "";
    for (let i = 0; i < 12; i++) body += `+row ${i}\r\n`;
    const diff = meta + crlf("@@ -0,0 +1,12 @@\n") + body;
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 60;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split");
    for (const c of chunks) {
      const text = d(c.text);
      assert.ok(!text.replace(/\r\n/g, "").includes("\n"), `chunk contains a bare LF line (synthesized header?):\n${JSON.stringify(text)}`);
    }
  });

  test("a single physical line longer than the whole budget cannot be split (G13)", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+" + "x".repeat(500) + "\n";
    assert.throws(() => splitDiffForAbridging(s(diff), 200), /narrower/);
  });

  test("non-file preamble text rides only the first piece verbatim, never replicated as metadata (G20)", () => {
    const preamble = "commit 0123456789abcdef\nAuthor: A U Thor <a@example.com>\n\n    Big change.\n\n";
    let diff = preamble + "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 4; h++) {
      diff += `@@ -${h * 10 + 1},1 +${h * 10 + 1},2 @@ func f${h}()\n context ${h}\n+added ${h}\n`;
    }
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 90;
    const chunks = splitDiffForAbridging(s(diff), budget);
    requireValidChunks(chunks, budget);
    assert.ok(chunks.length >= 2, "want a real split");
    assert.ok(d(chunks[0]!.text).startsWith(preamble), "first piece lost the preamble");
    chunks.forEach((c, i) => {
      assert.ok(!d(c.metaPrefix).includes("commit "), `chunk ${i} metaPrefix includes preamble`);
      if (i > 0) assert.ok(!d(c.text).includes("commit "), `chunk ${i} replicated the preamble`);
      assert.ok(d(c.text).includes("diff --git a/big.go"), `chunk ${i} lost file metadata`);
    });
  });

  test("pathological amplification is refused outright rather than exploding into hundreds of chunks (G27)", () => {
    const meta = "diff --git a/a b/a\n--- a/a\n+++ b/a\n";
    const rows = 2000;
    let diff = meta + `@@ -0,0 +1,${rows} @@\n`;
    for (let i = 0; i < rows; i++) diff += `+row ${i}\n`;
    // A budget barely above the per-piece overhead forces one tiny segment per piece.
    const budget = numberedDiff(s(meta + "@@ -1998,0 +1998,1 @@\n+row 1999\n")).length + 30;
    assert.throws(() => splitDiffForAbridging(s(diff), budget), /narrower/);
  });

  test("cuts never start inside a multiline string's interior — every forced cut position still yields independently valid chunks (G29, G31; end-to-end changed-row comparison deferred to meat.ts)", () => {
    const meta = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n";
    const pad = 8;
    let diff = meta + `@@ -1,${pad + 5} +1,${pad + 3} @@\n`;
    for (let i = 0; i < pad; i++) diff += ` shared row ${i}\n`;
    // The old side's backtick string spans rows interleaved with new-side
    // rows; behavioral old-side rows follow the closer.
    diff += '-var s = `text\n+var t = 1\n-import "embedded"\n+var u = 2\n-end`\n-var outside = require("out")\n-var last = 9\n+var v = 3\n';

    for (const mark of ["+var t = 1\n", '-import "embedded"\n', "+var u = 2\n", "-end`\n"]) {
      const prefixEnd = diff.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
      const chunks = splitDiffForAbridging(s(diff), budget);
      requireValidChunks(chunks, budget);
    }
  });

  test("a cut never lands directly after a Python suite-owner row, leaving its body in a different chunk (G35, G36)", () => {
    const meta = "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n";
    const pad = 8;

    // Case 1: an added owner immediately followed by its own added body.
    let diff = meta + `@@ -0,0 +1,${pad + 4} @@\n`;
    for (let i = 0; i < pad; i++) diff += `+x${i} = ${i}\n`;
    diff += "+if enabled:\n+    activate()\n+    finish()\n+done = True\n";
    for (const mark of ["+if enabled:\n"]) {
      const prefixEnd = diff.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
      const chunks = splitDiffForAbridging(s(diff), budget);
      requireValidChunks(chunks, budget);
      for (const c of chunks) {
        const text = d(c.text);
        if (text.includes("+if enabled:")) {
          assert.ok(text.includes("+    activate()"), `budget at ${JSON.stringify(mark)}: chunk severed the suite owner from its body:\n${text}`);
        }
      }
    }

    // Case 2: a context owner whose new body follows removed old rows.
    let diff2 = meta + `@@ -1,${pad + 3} +1,${pad + 3} @@\n`;
    for (let i = 0; i < pad; i++) diff2 += ` y${i} = ${i}\n`;
    diff2 += " if enabled:\n-    old_activate()\n+    new_activate()\n context_tail = 1\n";
    for (const mark of [" if enabled:\n", "-    old_activate()\n"]) {
      const prefixEnd = diff2.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff2.slice(0, prefixEnd))).length;
      const chunks = splitDiffForAbridging(s(diff2), budget);
      requireValidChunks(chunks, budget);
      for (const c of chunks) {
        const text = d(c.text);
        if (text.includes(" if enabled:")) {
          assert.ok(
            text.includes("+    new_activate()"),
            `budget at ${JSON.stringify(mark)}: chunk severed the context owner from its kept body:\n${text}`,
          );
        }
      }
    }

    // Case 3: the owner's first following rows are a dropped import and a comment — neither is semantic body.
    let diff3 = meta + `@@ -0,0 +1,${pad + 5} @@\n`;
    for (let i = 0; i < pad; i++) diff3 += `+z${i} = ${i}\n`;
    diff3 += "+if enabled:\n+    import optional_dep\n+    # explanatory comment\n+    activate()\n+done = True\n";
    for (const mark of ["+if enabled:\n", "+    import optional_dep\n", "+    # explanatory comment\n"]) {
      const prefixEnd = diff3.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff3.slice(0, prefixEnd))).length;
      const chunks = splitDiffForAbridging(s(diff3), budget);
      requireValidChunks(chunks, budget);
      for (const c of chunks) {
        const text = d(c.text);
        if (text.includes("+if enabled:")) {
          assert.ok(
            text.includes("+    activate()"),
            `budget at ${JSON.stringify(mark)}: chunk severed the owner from its first emitted body row:\n${text}`,
          );
        }
      }
    }
  });

  test("Python backslash continuations and open bracket expressions are never severed by a cut (G39; rejection-inside-chunk half deferred to meat.ts, G40)", () => {
    const meta = "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n";
    const pad = 8;
    let diff = meta + `@@ -0,0 +1,${pad + 8} @@\n`;
    for (let i = 0; i < pad; i++) diff += `+x${i} = ${i}\n`;
    diff += "+value = first + \\\n+    second\n+values = [\n+    1,\n+    2,\n+]\n+tail = 3\n+tail2 = 4\n";

    for (const mark of ["+value = first + \\\n", "+values = [\n", "+    1,\n", "+    2,\n"]) {
      const prefixEnd = diff.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
      const chunks = splitDiffForAbridging(s(diff), budget);
      requireValidChunks(chunks, budget);
      for (const c of chunks) {
        const text = d(c.text);
        assert.equal(
          text.includes("+value = first"),
          text.includes("+    second"),
          `budget at ${JSON.stringify(mark)}: chunk severed a backslash continuation:\n${text}`,
        );
        assert.equal(
          text.includes("+values = ["),
          text.includes("+]"),
          `budget at ${JSON.stringify(mark)}: chunk severed a bracketed literal:\n${text}`,
        );
      }
    }
  });
});

describe("fitsSingleRun (meat/chunk_test.go:1548-1559)", () => {
  test("boundary is exact: numbered-size-equal fits, one byte under does not, raw-over-budget never fits (G41)", () => {
    const diff = "diff --git a/a b/a\n@@ -1 +1 @@\n+x\n";
    assert.ok(fitsSingleRun(s(diff), numberedDiff(s(diff)).length), "diff should fit a budget equal to its numbered size");
    assert.ok(!fitsSingleRun(s(diff), numberedDiff(s(diff)).length - 1), "diff should not fit below its numbered size");
    assert.ok(!fitsSingleRun(s("x".repeat(100)), 50), "raw size over budget should not fit");
  });
});

function textOf(block: Block): string {
  assert.equal(block.type, "text");
  return (block as { text: string }).text;
}

describe("Abridge (chunked) — meat/chunk_test.go's TestAbridge_Chunked* (18 tests)", () => {
  test("end to end: each chunk gets its own agent run with its own 1-based numbering; results merge (G14-G17)", async () => {
    const restore = setSingleRunBudget(400);
    try {
      const secA = fileSection("alpha.go", 10);
      const secB = fileSection("beta.go", 10);
      const diff = secA + secB;
      assert.ok(!fitsSingleRun(s(diff), 400), "fixture should exceed the shrunken single-run budget");
      assert.ok(fitsSingleRun(s(secA), 400) && fitsSingleRun(s(secB), 400), "each section should fit alone");

      const plan = (summary: string): unknown => ({ remove: [{ start_line: 6, end_line: 13 }], replace: [], fold: [], summary });
      const m = newScriptedModel([assistant(toolUse("s1", "submit", plan("Adds alpha rows."))), assistant(toolUse("s2", "submit", plan("Adds beta rows.")))]);
      const progress: string[] = [];
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff), progress: (p) => progress.push(p) });
      assert.equal(m.seen, 2, "one per chunk");

      for (const msgs of m.seenMessages) {
        const prompt = textOf(msgs[0]!.content[0]!);
        assert.ok(prompt.includes(" 1|diff --git"), `chunk prompt does not restart numbering at 1:\n${prompt}`);
      }
      const firstPrompt = textOf(m.seenMessages[0]![0]!.content[0]!);
      assert.ok(firstPrompt.includes("alpha.go") && !firstPrompt.includes("beta.go"), "first chunk prompt should contain only alpha.go");
      const secondPrompt = textOf(m.seenMessages[1]![0]!.content[0]!);
      assert.ok(secondPrompt.includes("beta.go") && !secondPrompt.includes("alpha.go"), "second chunk prompt should contain only beta.go");

      const smart = d(res.smartDiff);
      for (const want of ["diff --git a/alpha.go", "diff --git a/beta.go", "+alpha.go row 0", "+beta.go row 0"]) {
        assert.ok(smart.includes(want), `merged smart diff missing ${JSON.stringify(want)}:\n${smart}`);
      }
      assert.equal(res.summary, "Adds alpha rows. Adds beta rows.");
      assert.equal(res.inputTokens, 200);
      assert.equal(res.outputTokens, 40);
      const joined = progress.join("\n");
      for (const want of ["abridging 2 chunks", "chunk 1/2: thinking", "chunk 2/2: thinking"]) {
        assert.ok(joined.includes(want), `progress missing ${JSON.stringify(want)}:\n${joined}`);
      }
    } finally {
      restore();
    }
  });

  test("merges a split file's replicated metadata exactly once (G18)", async () => {
    let diff = "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 4; h++) diff += `@@ -${h * 10 + 1},1 +${h * 10 + 1},2 @@ func f${h}()\n context ${h}\n+added ${h}\n`;
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 60;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget), "fixture should exceed the shrunken budget");
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      const smart = d(res.smartDiff);
      assert.equal((smart.match(/diff --git a\/big\.go/g) ?? []).length, 1, `merged diff repeats file metadata:\n${smart}`);
      assert.equal((smart.match(/\+\+\+ b\/big\.go/g) ?? []).length, 1, `merged diff repeats +++ header:\n${smart}`);
      for (let h = 0; h < 4; h++) assert.ok(smart.includes(`+added ${h}`), `merged diff lost hunk ${h} content:\n${smart}`);
      assert.equal(res.summary, "Adds rows.", "duplicate per-chunk summaries should merge to one");
    } finally {
      restore();
    }
  });

  test("keeps the continuation's replicated metadata when the first piece abridges to nothing (G19)", async () => {
    let diff = "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 4; h++) diff += `@@ -${h * 10 + 1},1 +${h * 10 + 1},2 @@ func f${h}()\n context ${h}\n+added ${h}\n`;
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 60;
    const restore = setSingleRunBudget(budget);
    try {
      const m = newScriptedModel([
        assistant(toolUse("s1", "submit", { remove: [{ start_line: 1, end_line: 9 }], replace: [], fold: [], summary: "Nothing meaningful." })),
        assistant(toolUse("s2", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." })),
      ]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(m.seen, 2);
      const smart = d(res.smartDiff);
      assert.equal((smart.match(/diff --git a\/big\.go/g) ?? []).length, 1, `merged diff header count wrong:\n${smart}`);
      assert.ok(smart.includes("+added 2") && !smart.includes("+added 0"), `merged diff should carry only the second piece's hunks:\n${smart}`);
    } finally {
      restore();
    }
  });

  test("non-file preamble is retained on a first piece that elides its whole file section; continuation headers are not stripped (G21)", async () => {
    const preamble = "commit 0123456789abcdef\nAuthor: A U Thor <a@example.com>\n\n    Big change.\n\n";
    let diff = preamble + "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 4; h++) diff += `@@ -${h * 10 + 1},1 +${h * 10 + 1},2 @@ func f${h}()\n context ${h}\n+added ${h}\n`;
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 90;
    const restore = setSingleRunBudget(budget);
    try {
      const chunks = splitDiffForAbridging(s(diff), budget);
      assert.equal(chunks.length, 2, `chunks = ${chunks.length}, want 2`);
      const fileStart = splitSourceLines(s(preamble)).length + 1;
      const firstLen = splitSourceLines(chunks[0]!.text).length;
      const m = newScriptedModel([
        assistant(toolUse("s1", "submit", { remove: [{ start_line: fileStart, end_line: firstLen }], replace: [], fold: [], summary: "Nothing meaningful." })),
        assistant(toolUse("s2", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." })),
      ]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      const smart = d(res.smartDiff);
      assert.ok(smart.includes("commit 0123456789abcdef"), `merged diff lost retained preamble:\n${smart}`);
      assert.equal((smart.match(/diff --git a\/big\.go/g) ?? []).length, 1, `merged diff header count wrong:\n${smart}`);
      const atIdx = smart.indexOf("@@");
      const hdrIdx = smart.indexOf("diff --git");
      assert.ok(!(atIdx >= 0 && (hdrIdx < 0 || hdrIdx > atIdx)), `merged diff has orphaned hunks before any file header:\n${smart}`);
    } finally {
      restore();
    }
  });

  test("identity chunked abridgement over a diff with no trailing final newline reproduces it byte-for-byte (G22)", async () => {
    const diff = (fileSection("alpha.go", 10) + fileSection("beta.go", 10)).replace(/\n$/, "");
    const restore = setSingleRunBudget(400);
    try {
      assert.ok(!fitsSingleRun(s(diff), 400));
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(d(res.smartDiff), diff, "identity chunked abridgement altered the diff");
    } finally {
      restore();
    }
  });

  test("a failing chunk aborts the whole abridgement, naming the failing chunk (G23)", async () => {
    const restore = setSingleRunBudget(400);
    try {
      const diff = fileSection("alpha.go", 10) + fileSection("beta.go", 10);
      const m = newScriptedModel([
        assistant(toolUse("s1", "submit", { remove: [], replace: [], fold: [], summary: "Adds alpha rows." })),
        assistant({ type: "text", text: "just text" }),
      ]);
      await assert.rejects(
        () => Abridge(new AbortController().signal, m, { unifiedDiff: s(diff), maxTurns: 2 }),
        (err: unknown) => err instanceof Error && err.message.includes("chunk 2/2"),
      );
    } finally {
      restore();
    }
  });

  test("chunk failure labeling preserves the wrapped error chain (G24)", async () => {
    const restore = setSingleRunBudget(400);
    try {
      const diff = fileSection("alpha.go", 10) + fileSection("beta.go", 10);
      const controller = new AbortController();
      controller.abort();
      const m: Model = {
        generate: (signal: AbortSignal) => Promise.reject(signal.reason),
      };
      await assert.rejects(
        () => Abridge(controller.signal, m, { unifiedDiff: s(diff) }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("chunk 1/2"), err.message);
          const inner = (err as Error & { cause?: unknown }).cause;
          assert.ok(inner instanceof Error);
          assert.equal((inner as Error & { cause?: unknown }).cause, controller.signal.reason, "chunk labeling broke the error chain");
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  test("a package rename split across chunks: both package rows survive, both import sides stay hidden (G25)", async () => {
    const meta = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ a/a.go\n".replace("+++ a/a.go", "+++ b/a.go");
    const pad = 6;
    let diff = meta + `@@ -1,${2 + pad} +1,${2 + pad} @@\n`;
    diff += '-package oldname\n-import "old"\n';
    for (let i = 0; i < pad; i++) diff += ` shared row ${i}\n`;
    diff += '+package newname\n+import "new"\n';

    const whole = compileEditPlan(s(diff), { remove: [], replace: [], fold: [] });
    for (const want of ["-package oldname", "+package newname"]) {
      assert.ok(d(whole.smartDiff).includes(want), `whole-diff reference lost ${JSON.stringify(want)}:\n${d(whole.smartDiff)}`);
    }

    const marker = "shared row 2\n";
    const prefixEnd = diff.indexOf(marker) + marker.length;
    const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Renames the package." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      const smart = d(res.smartDiff);
      for (const want of ["-package oldname", "+package newname"]) assert.ok(smart.includes(want), `chunked result lost ${JSON.stringify(want)}:\n${smart}`);
      assert.ok(!smart.includes("import "), `chunked result retained import churn:\n${smart}`);
    } finally {
      restore();
    }
  });

  test("embedded imports inside a cut-severed multiline string never leak (G26)", async () => {
    const meta = "diff --git a/plugin_test.go b/plugin_test.go\n--- a/plugin_test.go\n+++ b/plugin_test.go\n";
    const pad = 8;
    let diff = meta + `@@ -0,0 +1,${pad + 6} @@\n`;
    for (let i = 0; i < pad; i++) diff += `+var pre${i} = ${i}\n`;
    diff += '+const fixture = `\n+import pytest\n+const helper = require("./helper").default;\n+run(helper)\n+`\n+func TestFixture() { execute(fixture) }\n';

    const whole = compileEditPlan(s(diff), { remove: [], replace: [], fold: [] });
    for (const unwanted of ["import pytest", 'require("./helper")']) {
      assert.ok(!d(whole.smartDiff).includes(unwanted), `whole-diff reference kept embedded import ${JSON.stringify(unwanted)}`);
    }

    const marker = "const fixture = `\n";
    const prefixEnd = diff.indexOf(marker) + marker.length;
    const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds fixture." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      const smart = d(res.smartDiff);
      for (const unwanted of ["import pytest", 'require("./helper")']) assert.ok(!smart.includes(unwanted), `embedded import leaked:\n${smart}`);
      for (const want of ["+run(helper)", "+func TestFixture"]) assert.ok(smart.includes(want), `embedded behavior lost:\n${smart}`);
    } finally {
      restore();
    }
  });

  test("a format-patch mail signature and version trailer survive splitting identically (G28)", async () => {
    let diff = "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 4; h++) diff += `@@ -${h * 10 + 1},1 +${h * 10 + 1},2 @@\n context ${h}\n+added ${h}\n`;
    diff += "-- \n2.39.2\n\n";
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 60;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(d(res.smartDiff), diff, "identity chunked abridgement altered the diff (trailer lost?)");
    } finally {
      restore();
    }
  });

  test("cuts never start a segment inside a multiline string literal — the chunked result matches whole-diff compilation (G29)", async () => {
    const meta = "diff --git a/plugin_test.go b/plugin_test.go\n--- a/plugin_test.go\n+++ b/plugin_test.go\n";
    const pad = 8;
    let diff = meta + `@@ -0,0 +1,${pad + 7} @@\n`;
    for (let i = 0; i < pad; i++) diff += `+var pre${i} = ${i}\n`;
    diff += '+const fixture = `\n+import pytest\n+run_inside()\n+`\n+var outside = require("outside")\n+func F() {}\n+var post = 1\n';

    const whole = compileEditPlan(s(diff), { remove: [], replace: [], fold: [] });
    assert.ok(d(whole.smartDiff).includes('require("outside")'), "whole-diff reference lost the behavioral require");

    for (const mark of ["+import pytest\n", "+run_inside()\n", "+`\n"]) {
      const prefixEnd = diff.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
      const restore = setSingleRunBudget(budget);
      try {
        assert.ok(!fitsSingleRun(s(diff), budget), `budget ${budget} should force a split`);
        const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds fixture." }))]);
        const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
        const smart = d(res.smartDiff);
        assert.ok(smart.includes('require("outside")'), `budget at ${JSON.stringify(mark)}: behavioral require lost:\n${smart}`);
        assert.ok(!smart.includes("import pytest"), `budget at ${JSON.stringify(mark)}: embedded import leaked:\n${smart}`);
      } finally {
        restore();
      }
    }
  });

  test("an oversized diff whose every changed row is import scaffolding makes zero model calls (G30)", async () => {
    const meta = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ a/a.go\n".replace("+++ a/a.go", "+++ b/a.go");
    const rows = 40;
    let diff = meta + `@@ -0,0 +1,${rows + 2} @@\n+import (\n`;
    for (let i = 0; i < rows; i++) diff += `+\t"pkg/dep${String(i).padStart(2, "0")}"\n`;
    diff += "+)\n";
    const budget = Math.floor(numberedDiff(s(diff)).length / 2) + 60;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([assistant()]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(m.seen, 0, "import-only diff reached the model");
      assert.equal(res.smartDiff.length, 0);
      assert.ok(res.summary !== "");
    } finally {
      restore();
    }
  });

  test("greedy hunk-run packing filling the final piece still lets the trailer survive as its own piece (G32)", async () => {
    let body = "diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n";
    for (let h = 0; h < 4; h++) body += `@@ -${h * 10 + 1},1 +${h * 10 + 1},2 @@\n context ${h}\n+added ${h}\n`;
    const trailer = "-- \n2.39.2\n\n";
    const diff = body + trailer;
    const budget = Math.floor(numberedDiff(s(body)).length / 2) + 30;
    const restore = setSingleRunBudget(budget);
    try {
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(d(res.smartDiff), diff, "identity chunked abridgement altered the diff");
    } finally {
      restore();
    }
  });

  test("a mandatory Python suite placeholder survives when the owner and its dropped import land in a chunk with no reason to synthesize one (G33)", async () => {
    const meta = "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n";
    const pad = 8;
    let diff = meta + `@@ -0,0 +1,${pad + 4} @@\n`;
    for (let i = 0; i < pad; i++) diff += `+x${i} = ${i}\n`;
    diff += "+def optional_feature():\n+    import optional_dep\n+def useful():\n+    return 1\n";

    const whole = compileEditPlan(s(diff), { remove: [], replace: [], fold: [] });
    assert.ok(d(whole.smartDiff).includes("+    ..."), "whole-diff reference lost its suite placeholder");

    for (const mark of ["+def optional_feature():\n", "+    import optional_dep\n"]) {
      const prefixEnd = diff.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
      const restore = setSingleRunBudget(budget);
      try {
        const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds module." }))]);
        const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
        const smart = d(res.smartDiff);
        assert.ok(smart.includes("+    ..."), `budget at ${JSON.stringify(mark)}: chunked result lost the mandatory suite placeholder:\n${smart}`);
        assert.ok(!smart.includes("import optional_dep"), `budget at ${JSON.stringify(mark)}: import leaked:\n${smart}`);
      } finally {
        restore();
      }
    }
  });

  test("a cross-file import move (whole-diff move precedence) stays hidden on both sides even when the two files land in different chunks (G34)", async () => {
    const imports = 'import (\n\t"alpha/betapackage/deep"\n\t"gamma/deltapackage/deeper"\n\t"epsilon/zetapackage/deepest"\n\t"eta/thetapackage/bottom"\n)\n';
    const impLines = splitSourceLines(s(imports));
    let diff = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n";
    diff += `@@ -1,${1 + impLines.length} +1,1 @@\n context a\n`;
    for (const l of impLines) diff += "-" + d(l.text) + "\n";
    diff += "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n";
    diff += `@@ -1,1 +1,${1 + impLines.length + 1} @@\n context f\n`;
    for (const l of impLines) diff += "+" + d(l.text) + "\n";
    diff += "+fixture tail\n";

    const whole = compileEditPlan(s(diff), { remove: [], replace: [], fold: [] });
    assert.ok(detectExactMoves(splitSourceLines(s(diff)), analyzeDiff(splitSourceLines(s(diff)))).length > 0, "fixture no longer triggers move detection");
    assert.ok(!d(whole.smartDiff).includes("alpha/betapackage"), "whole-diff reference kept the moved import block");

    const second = diff.indexOf("diff --git a/fixture.txt");
    const budget = numberedDiff(s(diff.slice(0, second))).length;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Moves imports into fixture." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      const smart = d(res.smartDiff);
      for (const unwanted of ["alpha/betapackage", "gamma/deltapackage", "import ("]) {
        assert.ok(!smart.includes(unwanted), `moved import ${JSON.stringify(unwanted)} leaked into chunked result:\n${smart}`);
      }
      assert.ok(smart.includes("+fixture tail"), `behavioral fixture row lost:\n${smart}`);
    } finally {
      restore();
    }
  });

  test("move uniqueness is a whole-diff property — a globally ambiguous block is never invented as a move inside a chunk (G34, moves.md)", async () => {
    const block = "    alpha := prepare(source)\n    beta := transform(alpha)\n    publish(beta)\n    record(beta)\n";
    const blockLines = splitSourceLines(s(block));
    const section = (name: string, marker: "+" | "-", extra: number): string => {
      let out = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`;
      let oldC = 1 + blockLines.length + extra;
      let newC = 1;
      if (marker === "+") [oldC, newC] = [newC, oldC];
      out += `@@ -1,${oldC} +1,${newC} @@\n context ${name}\n`;
      for (const l of blockLines) out += marker + d(l.text) + "\n";
      for (let i = 0; i < extra; i++) out += `${marker}filler ${name} ${i}\n`;
      return out;
    };
    const diff = section("a.go", "-", 3) + section("b.go", "+", 3) + section("c.go", "+", 3);
    assert.equal(detectedMovesInDiff(s(diff)).length, 0, "fixture should be globally ambiguous");

    const secondStart = diff.indexOf("diff --git a/c.go");
    const budget = numberedDiff(s(diff.slice(0, secondStart))).length;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([
        assistant(toolUse("s1", "submit", { remove: [], replace: [], fold: [{ start_line: 6, end_line: 9 }], summary: "Removes pipeline." })),
        assistant(toolUse("s2", "submit", { remove: [], replace: [], fold: [], summary: "Adds pipeline." })),
      ]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(m.seen, 2, "asymmetric fold must not be rejected in a chunk");
      assert.ok(d(res.smartDiff).includes("-    ..."), "chunk-1 fold missing from merged result");
      for (const msgs of m.seenMessages) {
        assert.ok(!textOf(msgs[0]!.content[0]!).includes("exact source-evidenced moves"), "chunk prompt contains a move hint over a fragment");
      }
    } finally {
      restore();
    }
  });

  test("import-only sections/hunks are skipped by the splitter — no agent run per file shell (G37)", async () => {
    const importSection = (name: string): string =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n-import "old/dep"\n+import "new/dep"\n context\n`;
    const behavioral = fileSection("real.go", 10);
    let diff = "";
    for (let i = 0; i < 6; i++) diff += importSection(`dep${i}.go`);
    diff += behavioral;
    const budget = numberedDiff(s(behavioral)).length + 40;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds real rows." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(m.seen, 1, "import-only sections must not spend agent runs");
      const smart = d(res.smartDiff);
      assert.ok(!smart.includes("dep0.go") && !smart.includes("import"), `import-only sections leaked into the merged result:\n${smart}`);
      assert.ok(smart.includes("+real.go row 0"), `behavioral section lost:\n${smart}`);
    } finally {
      restore();
    }
  });

  test("a genuine whole-diff move whose sides land in the same chunk keeps full symmetry enforcement (G38)", async () => {
    const pad = fileSection("zzz.go", 12);
    const diff = surfaceFixtureDiff + pad;
    const budget = numberedDiff(s(surfaceFixtureDiff)).length + 20;
    const restore = setSingleRunBudget(budget);
    try {
      assert.ok(!fitsSingleRun(s(diff), budget));
      const chunks = splitDiffForAbridging(s(diff), budget);
      assert.ok(chunks.length >= 2 && d(chunks[0]!.text).includes("new_location_ready"), `fixture should put both move sides in chunk 1; got ${chunks.length} chunks`);

      const asym = { remove: [], replace: [], fold: [{ start_line: 6, end_line: 9 }], summary: "Relocates the pipeline." };
      const sym = {
        remove: [],
        replace: [],
        fold: [
          { start_line: 6, end_line: 9 },
          { start_line: 16, end_line: 19 },
        ],
        summary: "Relocates the pipeline.",
      };
      const identity = { remove: [], replace: [], fold: [], summary: "Adds rows." };
      const m = newScriptedModel([assistant(toolUse("bad", "submit", asym)), assistant(toolUse("good", "submit", sym)), assistant(toolUse("z", "submit", identity))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.equal(m.seen, 3, "asymmetric rejected, symmetric accepted, second chunk");

      const prompt = textOf(m.seenMessages[0]![0]!.content[0]!);
      assert.ok(prompt.includes("-6..9 ↔ +16..19"), `chunk prompt lost the whole-diff move hint:\n${prompt}`);

      let sawMoveError = false;
      for (const msg of m.seenMessages[1]!) {
        for (const blk of msg.content) {
          if (blk.type === "tool_result" && blk.toolError && blk.toolResult.includes("move")) sawMoveError = true;
        }
      }
      assert.ok(sawMoveError, "asymmetric move plan was not rejected with a move error");
      assert.ok((d(res.smartDiff).match(/\.\.\./g) ?? []).length >= 2, `symmetric folds missing from merged result:\n${d(res.smartDiff)}`);
    } finally {
      restore();
    }
  });
});

describe("deferred TestSplitDiff_* second halves (now that Abridge exists)", () => {
  test("import block never severed or leaked — end to end: the merged reading diff has zero import scaffolding, all behavioral rows survive (G11)", async () => {
    const meta = "diff --git a/a.go b/a.go\n--- /dev/null\n+++ b/a.go\n";
    const before = 10;
    const members = 8;
    const after = 10;
    let body = `@@ -0,0 +1,${5 + before + members + after} @@\n+package a\n+\n`;
    for (let i = 0; i < before; i++) body += `+var a${i} = ${i}\n`;
    body += "+import (\n";
    for (let i = 0; i < members; i++) body += `+\t"pkg${i}"\n`;
    body += "+)\n+func F() {}\n";
    for (let i = 0; i < after; i++) body += `+var b${i} = ${i}\n`;
    const diff = meta + body;
    const marker = '"pkg3"\n';
    const prefixEnd = diff.indexOf(marker) + marker.length;
    const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
    const restore = setSingleRunBudget(budget);
    try {
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds file." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      const smart = d(res.smartDiff);
      assert.ok(!smart.includes('"pkg') && !smart.includes("+)") && !smart.includes("import ("), `import scaffolding leaked into the merged reading diff:\n${smart}`);
      for (const want of ["+func F() {}", "+var a0 = 0", "+var b9 = 9"]) {
        assert.ok(smart.includes(want), `behavioral row ${JSON.stringify(want)} lost from merged reading diff:\n${smart}`);
      }
    } finally {
      restore();
    }
  });

  test("interleaved-side string interior: chunked changed rows match a real agent-loop run over the whole diff", async () => {
    const meta = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n";
    const pad = 8;
    let diff = meta + `@@ -1,${pad + 5} +1,${pad + 3} @@\n`;
    for (let i = 0; i < pad; i++) diff += ` shared row ${i}\n`;
    diff += '-var s = `text\n+var t = 1\n-import "embedded"\n+var u = 2\n-end`\n-var outside = require("out")\n-var last = 9\n+var v = 3\n';

    const whole = compileEditPlan(s(diff), { remove: [], replace: [], fold: [] });
    const changedRowsOf = (text: Uint8Array): string[] => {
      const lines = splitSourceLines(text);
      const layout = analyzeDiff(lines);
      const rows: string[] = [];
      for (let i = 0; i < lines.length; i++) if (layout.kinds[i] === "hunk_change") rows.push(d(lines[i]!.text));
      return rows;
    };
    const wantChanged = changedRowsOf(whole.smartDiff);

    for (const mark of ["+var t = 1\n", '-import "embedded"\n', "+var u = 2\n", "-end`\n"]) {
      const prefixEnd = diff.indexOf(mark) + mark.length;
      const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
      const restore = setSingleRunBudget(budget);
      try {
        const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Changes vars." }))]);
        const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
        assert.deepEqual(changedRowsOf(res.smartDiff), wantChanged, `budget at ${JSON.stringify(mark)}: chunked changed rows diverge from whole-diff compilation`);
      } finally {
        restore();
      }
    }
  });

  test("Python continuations atomic: orphaning a backslash continuation is rejected inside the chunk, exactly as whole-diff compilation rejects it (G40)", async () => {
    const meta = "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n";
    const pad = 8;
    let diff = meta + `@@ -0,0 +1,${pad + 8} @@\n`;
    for (let i = 0; i < pad; i++) diff += `+x${i} = ${i}\n`;
    diff += "+value = first + \\\n+    second\n+values = [\n+    1,\n+    2,\n+]\n+tail = 3\n+tail2 = 4\n";

    const marker = "+    1,\n";
    const prefixEnd = diff.indexOf(marker) + marker.length;
    const budget = numberedDiff(s(diff.slice(0, prefixEnd))).length;
    const chunks = splitDiffForAbridging(s(diff), budget);
    const chunk1 = chunks.find((c) => d(c.text).includes("+value = first"));
    assert.ok(chunk1, "no chunk contains the continuation opener");
    let openerLine = 0;
    splitSourceLines(chunk1!.text).forEach((l, i) => {
      if (d(l.text) === "+value = first + \\") openerLine = i + 1;
    });
    assert.ok(openerLine !== 0, "opener not found in chunk");

    const restore = setSingleRunBudget(budget);
    try {
      const bad = { remove: [{ start_line: openerLine, end_line: openerLine }], replace: [], fold: [], summary: "Removes the assignment." };
      const identity = { remove: [], replace: [], fold: [], summary: "Adds rows." };
      const m = newScriptedModel([assistant(toolUse("bad", "submit", bad)), assistant(toolUse("ok", "submit", identity)), assistant(toolUse("ok2", "submit", identity))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      let sawRejection = false;
      for (const msgs of m.seenMessages) {
        for (const msg of msgs) {
          for (const blk of msg.content) {
            if (blk.type === "tool_result" && blk.toolError && blk.toolResult.includes("continuation")) sawRejection = true;
          }
        }
      }
      assert.ok(sawRejection, "orphaning the backslash continuation was not rejected inside the chunk");
      const smart = d(res.smartDiff);
      assert.ok(smart.includes("+    second") && smart.includes("+value = first + \\"), `merged result lost the continuation pair:\n${smart}`);
    } finally {
      restore();
    }
  });
});
