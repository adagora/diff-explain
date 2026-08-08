// Port of the toolbox-touching tests in meat/meat_test.go (17 of 29 tests
// touch the toolbox, per specs/tools.md's own count) that construct a
// `toolbox` directly rather than going through `Abridge`/`scriptedModel`:
// TestAbridge_NoRepoOffersPlanTools (G2's core claim, ported via `tools()`
// directly), TestToolboxGrepAndPathConfinement (G3/G4), TestRetentionPressure
// (G1), TestPreviewPlanShowsExactFoldAndDoesNotSubmit (G5),
// TestSubmitToolUsesEditPlanSchema (G6), TestSubmitRejectsLegacySmartDiff
// (G7), TestSubmitRequiresEditArrays (G8), TestSubmitTruncatesValidationErrors
// (G9). Every other toolbox-touching test in meat_test.go needs
// `Abridge`/`scriptedModel` (item 4n, meat.ts) and is deferred there.
//
// Also adds direct tests — this codebase's convention for private helpers
// with no dedicated Go test (specs/tools.md: "Vectors: none dedicated") —
// for `truncateForTool` (exported), `readFile`'s success path (an Open
// Question in specs/tools.md: untested even in Go), and `clearSubmission`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { compileEditPlanMoves } from "../../src/meat/editplan.ts";
import {
  newToolbox,
  tools,
  run,
  readFile,
  grep,
  previewPlan,
  submit,
  submitTool,
  retentionPressure,
  planFeedback,
  truncateForTool,
  clearSubmission,
  maxToolOutput,
} from "../../src/meat/tools.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);
const d = (b: Uint8Array): string => decodeUTF8(b);
const noSignal = new AbortController().signal;

async function gitRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "meat-tools-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "t@t.test"]);
  run(["config", "user.name", "t"]);
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  return dir;
}

describe("tools() (meat/meat_test.go:332-344, G2)", () => {
  test("no root: exactly preview_plan then submit", () => {
    const tb = newToolbox({ rawDiff: s("") });
    const list = tools(tb);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.name, "preview_plan");
    assert.equal(list[1]!.name, "submit");
  });

  test("with root: exactly read_file, grep, preview_plan, submit in order", () => {
    const tb = newToolbox({ root: "/repo", rawDiff: s("") });
    const list = tools(tb);
    assert.equal(list.length, 4);
    assert.deepEqual(
      list.map((t) => t.name),
      ["read_file", "grep", "preview_plan", "submit"],
    );
  });
});

describe("grep and path confinement (meat/meat_test.go:346-363, G3, G4)", () => {
  test("grep runs git grep scoped to the repo root; read_file rejects path traversal", async (t) => {
    let gitOk = true;
    try {
      execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      gitOk = false;
    }
    if (!gitOk) {
      t.skip("git not found");
      return;
    }
    const repo = await gitRepo({ "a.go": "package a\nfunc Foo() {}\n" });
    const tb = newToolbox({ root: repo, rawDiff: s("") });

    const [grepOut, grepIsErr] = await grep(tb, noSignal, s(JSON.stringify({ pattern: "func Foo" })));
    assert.ok(!grepIsErr, `grep error: ${grepOut}`);
    assert.ok(grepOut.includes("a.go"), `grep result = ${JSON.stringify(grepOut)}, want a.go match`);

    const [, readIsErr] = await readFile(tb, s(JSON.stringify({ path: "../../../etc/passwd" })));
    assert.ok(readIsErr, "want path traversal rejected");
  });
});

describe("retentionPressure (meat/meat_test.go:189-205, G1)", () => {
  test("exact boundary cases", () => {
    const cases: Array<{ rawChanged: number; visibleChanged: number; want: boolean }> = [
      { rawChanged: 39, visibleChanged: 39, want: false },
      { rawChanged: 100, visibleChanged: 19, want: false },
      { rawChanged: 100, visibleChanged: 44, want: false },
      { rawChanged: 100, visibleChanged: 45, want: true },
      { rawChanged: 200, visibleChanged: 80, want: true },
    ];
    for (const c of cases) {
      const got = retentionPressure({
        rawChanged: c.rawChanged,
        visibleChanged: c.visibleChanged,
        removedChanged: 0,
        foldedChanged: 0,
        foldCount: 0,
        rawFiles: 0,
        visibleFiles: 0,
      });
      assert.equal(got, c.want, `retentionPressure(${c.rawChanged}, ${c.visibleChanged})`);
    }
  });
});

describe("previewPlan (meat/meat_test.go:566-580, G5)", () => {
  test("exact fold feedback text; never mutates submission state", () => {
    const tb = newToolbox({
      rawDiff: s("diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def test_it():\n+    setup()\n+    exercise()\n+    assert result\n"),
    });
    const [out, isErr] = previewPlan(tb, s('{"remove":[],"replace":[],"fold":[{"start_line":4,"end_line":5}]}'));
    assert.ok(!isErr, `preview_plan = ${JSON.stringify(out)}`);
    for (const want of ["Retention: 3/4", "hidden by 1 folds", "+    ...", "+    assert result"]) {
      assert.ok(out.includes(want), `preview missing ${JSON.stringify(want)}:\n${out}`);
    }
    assert.ok(!tb.submitSeen && tb.submitted === null && tb.smartDiff.length === 0, "preview_plan mutated final submission state");
  });
});

describe("submit tool schema (meat/meat_test.go:582-593, G6)", () => {
  test("requires remove/replace/fold(/summary); never accepts smart_diff", () => {
    const tool = submitTool();
    const schema = d(tool.inputSchema);
    assert.ok(!schema.includes("smart_diff"), `submit schema still accepts a model-authored smart diff: ${schema}`);
    for (const want of ['"remove"', '"replace"', '"fold"', '"start_line"', '"old"', '"new"']) {
      assert.ok(schema.includes(want), `submit schema missing ${want}: ${schema}`);
    }
  });
});

describe("submit (meat/meat_test.go:595-638, G7, G8, G9)", () => {
  test("rejects a legacy smart_diff payload with an unknown-field error; no submission recorded (G7)", () => {
    const tb = newToolbox({ rawDiff: s("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n") });
    const [out, isErr] = submit(tb, s('{"smart_diff":"+invented\\n","summary":"Changes it.","remove":[],"replace":[]}'));
    assert.ok(isErr && out.includes("unknown field"), `legacy smart_diff = (${JSON.stringify(out)}, ${isErr}), want unknown-field error`);
    assert.ok(!tb.submitSeen, "invalid legacy submission was accepted");
  });

  test("requires remove/replace/fold to all be present as JSON arrays (G8)", () => {
    const cases = [
      '{"summary":"Changes it."}',
      '{"remove":null,"replace":[],"fold":[],"summary":"Changes it."}',
      '{"remove":[],"replace":null,"fold":[],"summary":"Changes it."}',
      '{"remove":[],"replace":[],"fold":null,"summary":"Changes it."}',
    ];
    for (const raw of cases) {
      const tb = newToolbox({ rawDiff: s("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n") });
      const [out, isErr] = submit(tb, s(raw));
      assert.ok(isErr && out.includes("must all be JSON arrays"), `submit(${raw}) = (${JSON.stringify(out)}, ${isErr}), want array error`);
    }
  });

  test("bounds validation-error text to maxToolOutput with a truncated marker (G9)", () => {
    const tb = newToolbox({ rawDiff: s("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n") });
    const replace = [];
    for (let i = 0; i < 2000; i++) {
      replace.push({ line: 100 + i, old: "x", new: "..." });
    }
    const raw = JSON.stringify({ remove: [], replace, fold: [], summary: "Changes the value." });
    const [out, isErr] = submit(tb, s(raw));
    assert.ok(isErr, "want invalid submission error");
    assert.ok(out.length <= maxToolOutput + 100 && out.includes("truncated"), `submit error was not bounded: ${out.length} bytes\n${out}`);
  });
});

describe("truncateForTool", () => {
  test("returns unchanged text under budget", () => {
    assert.equal(truncateForTool("short"), "short");
  });

  test("truncates at a UTF-8 rune boundary, never mid-codepoint, and reports the original byte length", () => {
    // Every character is a 3-byte UTF-8 codepoint so any naive byte cut lands mid-character unless walked back.
    const text = "€".repeat(10000);
    const originalBytes = encodeUTF8(text).length;
    const got = truncateForTool(text);
    assert.ok(got.length < text.length);
    assert.ok(got.includes(`(truncated, ${originalBytes} total bytes)`), got.slice(-60));
    const kept = got.slice(0, got.indexOf("\n... (truncated"));
    // Every kept character must be a complete "€" — no replacement/mangled characters.
    assert.ok([...kept].every((ch) => ch === "€"));
    assert.ok(encodeUTF8(kept).length <= maxToolOutput);
  });
});

describe("readFile success path (specs/tools.md Open questions: untested even in Go)", () => {
  test("reads a whole file, and a 1-based inclusive line range with a tab-numbered gutter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meat-tools-readfile-"));
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
    const tb = newToolbox({ root: dir, rawDiff: s("") });

    const [whole, wholeErr] = await readFile(tb, s(JSON.stringify({ path: "a.txt" })));
    assert.ok(!wholeErr);
    assert.equal(whole, "one\ntwo\nthree\n");

    const [ranged, rangedErr] = await readFile(tb, s(JSON.stringify({ path: "a.txt", start_line: 2, end_line: 3 })));
    assert.ok(!rangedErr);
    assert.equal(ranged, "2\ttwo\n3\tthree\n");
  });
});

describe("clearSubmission", () => {
  test("resets all five submission fields to zero value", () => {
    const tb = newToolbox({ rawDiff: s("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n") });
    const [, isErr] = submit(tb, s('{"remove":[],"replace":[],"fold":[],"summary":"Changes it."}'));
    assert.ok(!isErr);
    assert.ok(tb.submitSeen && tb.submitted !== null && tb.smartDiff.length > 0);
    clearSubmission(tb);
    assert.equal(tb.submitSeen, false);
    assert.equal(tb.submitted, null);
    assert.equal(tb.submittedPlan, null);
    assert.equal(tb.submitFeedback, "");
    assert.equal(tb.smartDiff.length, 0);
  });
});

describe("run() dispatch", () => {
  test("an unrecognized tool name returns an error result rather than throwing", async () => {
    const tb = newToolbox({ rawDiff: s("") });
    const [out, isErr] = await run(tb, noSignal, "nonexistent_tool", s("{}"));
    assert.ok(isErr);
    assert.equal(out, 'unknown tool "nonexistent_tool"');
  });
});

describe("planFeedback (meat/tools.go:264-290)", () => {
  test("appends a files clause only when rawFiles > 0, and a moves clause only when moves is non-empty", () => {
    const diff = s("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n");
    const compiled = compileEditPlanMoves(diff, { remove: [], replace: [], fold: [] }, undefined, true);
    const text = planFeedback(compiled);
    assert.ok(text.startsWith("Valid source-derived plan.\nRetention:"));
    assert.ok(!text.includes("Moves:"), "no moves were compiled, so no Moves: line should appear");
  });
});
