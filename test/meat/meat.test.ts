// Port of meat/meat_test.go's core Abridge/agent-loop tests (18 tests: the
// 17 that exercise `Abridge` directly, `TestRetentionPressure` already
// ported in tools.test.ts) plus `TestRequestStaysPositionalCompatible`
// (meat/chunk_test.go) and `TestAbridge_AcceptsGitFormatPatch`
// (meat/editplan_test.go, deferred there — see editplan.test.ts's own
// header comment — since it needs Abridge/scriptedModel). Every
// `TestAbridge_Chunked*` test (chunk merging) is ported in chunk.test.ts
// instead, alongside the `TestSplitDiff_*` tests it completes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { RoleUser, type Model, type Message, type Block, type ToolUseBlock, type Response, type Tool } from "../../src/meat/model.ts";
import { Abridge, meatConfig, userPromptIntro, userPromptImports, userPromptNoTools, userPromptProtocol, type Request } from "../../src/meat/meat.ts";
import { fitsSingleRun } from "../../src/meat/chunk.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);
const d = (b: Uint8Array): string => decodeUTF8(b);

// ---------------------------------------------------------------------------
// Test infrastructure (meat/meat_test.go:16-102, specs/agent-loop.md "Test
// infrastructure").
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

/** Go's `scriptedModel` (`meat/meat_test.go:18-33`). Once scripted turns are exhausted, replays the last turn forever. */
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

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const draftSubmit = (): ToolUseBlock =>
  toolUse("draft", "submit", { remove: [], replace: [], fold: [], summary: "Changes calls." });

/** Go's `deadlineFallbackModel` (`meat/meat_test.go:35-48`): call 1 returns a draft submit; call 2+ blocks on the (derived) signal aborting, simulating a hung model call past the per-run budget. */
function newDeadlineFallbackModel(): Model & { seen: number } {
  const m = {
    seen: 0,
    async generate(signal: AbortSignal): Promise<Response> {
      m.seen++;
      if (m.seen === 1) return assistant(draftSubmit());
      await waitForAbort(signal);
      throw new Error("unreachable");
    },
  };
  return m;
}

/** Go's `callerCancelFallbackModel` (`meat/meat_test.go:50-65`): identical shape, but cancels the CALLER's own controller on call 2, before blocking. */
function newCallerCancelFallbackModel(controller: AbortController): Model & { seen: number } {
  const m = {
    seen: 0,
    async generate(signal: AbortSignal): Promise<Response> {
      m.seen++;
      if (m.seen === 1) return assistant(draftSubmit());
      controller.abort();
      await waitForAbort(signal);
      throw new Error("unreachable");
    },
  };
  return m;
}

/** Go's `gitRepo` (`meat/meat_test.go:76-102`). */
async function gitRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "meat-agent-"));
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

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** Go's `retentionFixtureDiff` (`meat/meat_test.go:207-217`). */
function retentionFixtureDiff(): string {
  let out = "diff --git a/a.py b/a.py\n@@ -1,25 +1,25 @@\n";
  for (let i = 0; i < 25; i++) out += "-old_call()\n";
  for (let i = 0; i < 25; i++) out += "+new_call()\n";
  return out;
}

function setSingleRunBudget(budget: number): () => void {
  const old = meatConfig.singleRunDiffBytes;
  meatConfig.singleRunDiffBytes = budget;
  return () => {
    meatConfig.singleRunDiffBytes = old;
  };
}

function setAbridgeBudgetMs(ms: number): () => void {
  const old = meatConfig.abridgeBudgetMs;
  meatConfig.abridgeBudgetMs = ms;
  return () => {
    meatConfig.abridgeBudgetMs = old;
  };
}

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

describe("Abridge (meat/meat_test.go)", () => {
  test("preview_plan then submit drives the loop to completion; the preview result reaches the next turn (G4, G14)", async () => {
    const diff = "diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def test_it():\n+    setup()\n+    exercise()\n+    assert result\n";
    const plan = { remove: [], replace: [], fold: [{ start_line: 4, end_line: 5 }] };
    const m = newScriptedModel([
      assistant(toolUse("preview", "preview_plan", plan)),
      assistant(toolUse("submit", "submit", { remove: plan.remove, replace: plan.replace, fold: plan.fold, summary: "Tests the result." })),
    ]);
    const progress: string[] = [];
    const req: Request = { unifiedDiff: s(diff), progress: (msg) => progress.push(msg) };
    const res = await Abridge(new AbortController().signal, m, req);
    assert.ok(d(res.smartDiff).includes("+    ...") && m.seen === 2, `preview/submit result turns=${m.seen}:\n${d(res.smartDiff)}`);
    let sawPreviewResult = false;
    for (const msg of m.seenMessages[1]!) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.toolResult.includes("Valid source-derived plan")) sawPreviewResult = true;
      }
    }
    assert.ok(sawPreviewResult && progress.includes("previewing"), `preview plumbing missing: result=${sawPreviewResult} progress=${JSON.stringify(progress)}`);
  });

  test("read_file then submit: tool result informs a corrected plan (G4)", async (t) => {
    if (!gitAvailable()) {
      t.skip("git not found");
      return;
    }
    const repo = await gitRepo({ "route.go": "package route\n\ntype routeData struct{ boxID int }\n" });
    const m = newScriptedModel([
      assistant(toolUse("t1", "read_file", { path: "route.go" })),
      assistant(
        toolUse("t2", "submit", {
          remove: [],
          replace: [{ line: 3, old: "resp.BoxID = int64(rd.boxID)", new: "resp.BoxID = ..." }],
          fold: [],
          summary: "Copies cache fields from rd to resp.",
        }),
      ),
    ]);
    const req: Request = { repoRoot: repo, unifiedDiff: s("diff --git a/route.go b/route.go\n@@\n+    resp.BoxID = int64(rd.boxID)\n") };
    const res = await Abridge(new AbortController().signal, m, req);
    assert.ok(d(res.smartDiff).includes("resp.BoxID = ..."), `smart diff = ${JSON.stringify(d(res.smartDiff))}, want collapsed form`);
    assert.ok(res.summary !== "", "want non-empty summary");
    assert.ok(res.inputTokens > 0 && res.outputTokens > 0, `want token usage accumulated, got in=${res.inputTokens} out=${res.outputTokens}`);
    assert.equal(m.seen, 2);
  });

  test("an empty or all-whitespace diff short-circuits before any model call (G2)", async () => {
    const m = newScriptedModel([assistant()]);
    const req: Request = { repoRoot: await mkdtemp(join(tmpdir(), "meat-empty-")), unifiedDiff: s("  ") };
    const res = await Abridge(new AbortController().signal, m, req);
    assert.equal(res.smartDiff.length, 0);
    assert.equal(m.seen, 0);
  });

  test("no RepoRoot: Abridge advertises exactly preview_plan and submit to the model (G2)", async () => {
    const m = newScriptedModel([
      assistant(toolUse("t1", "submit", { remove: [], replace: [], fold: [], summary: "noop" })),
    ]);
    const req: Request = { unifiedDiff: s("diff --git a/x b/x\n@@\n+x\n") };
    await Abridge(new AbortController().signal, m, req);
    assert.equal(m.lastTools.length, 2);
    assert.equal(m.lastTools[0]!.name, "preview_plan");
    assert.equal(m.lastTools[1]!.name, "submit");
  });

  test("high retention gets exactly one refinement turn, seeded with pressure feedback and an exact preview (G9)", async () => {
    const diff = retentionFixtureDiff();
    const m = newScriptedModel([
      assistant(toolUse("draft", "submit", { remove: [], replace: [], fold: [], summary: "Changes calls." })),
      assistant(
        toolUse("final", "submit", {
          remove: [],
          replace: [],
          fold: [
            { start_line: 3, end_line: 27 },
            { start_line: 28, end_line: 52 },
          ],
          summary: "Changes calls.",
        }),
      ),
    ]);
    const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
    assert.equal(m.seen, 2, "want one refinement turn");
    const smart = d(res.smartDiff);
    const dotsCount = (smart.match(/\.\.\./g) ?? []).length;
    assert.ok(dotsCount === 2 && !smart.includes("old_call") && !smart.includes("new_call"), `refined diff =\n${smart}`);
    let sawPressure = false;
    let sawPreview = false;
    for (const msg of m.seenMessages[1]!) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          sawPressure = sawPressure || block.toolResult.includes("Pressure: high retention");
          sawPreview = sawPreview || (block.toolResult.includes("Preview") && block.toolResult.includes("+new_call()"));
        }
      }
    }
    assert.ok(sawPressure && sawPreview, "refinement turn did not receive pressure and exact preview");
  });

  test("the one-time refinement offer still fires even when the draft's own preview is large enough to be truncated (G10)", async () => {
    let diff = "diff --git a/a.py b/a.py\n@@ -0,0 +1,100 @@\n";
    for (let i = 0; i < 100; i++) diff += "+call_" + "x".repeat(220) + "()\n";
    const m = newScriptedModel([
      assistant(toolUse("draft", "submit", { remove: [], replace: [], fold: [], summary: "Adds calls." })),
      assistant(toolUse("final", "submit", { remove: [], replace: [], fold: [{ start_line: 3, end_line: 102 }], summary: "Adds calls." })),
    ]);
    const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
    assert.ok(m.seen === 2 && d(res.smartDiff).includes("+..."), `oversized refinement turns=${m.seen} diff=\n${d(res.smartDiff)}`);
    let truncated = false;
    for (const msg of m.seenMessages[1]!) {
      for (const block of msg.content) {
        if (block.type === "tool_result") truncated = truncated || block.toolResult.includes("truncated");
      }
    }
    assert.ok(truncated, "oversized refinement feedback was neither complete nor explicitly truncated");
  });

  test("an internal per-run deadline with an existing fallback returns the fallback rather than an error (G11)", async () => {
    const restore = setAbridgeBudgetMs(20);
    try {
      const diff = retentionFixtureDiff();
      const m = newDeadlineFallbackModel();
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.ok(m.seen === 2 && d(res.smartDiff) === diff, `deadline fallback turns=${m.seen} diff changed=${d(res.smartDiff) !== diff}`);
    } finally {
      restore();
    }
  });

  test("caller cancellation wins over an existing fallback — Abridge returns an error, not the fallback (G11)", async () => {
    const controller = new AbortController();
    const m = newCallerCancelFallbackModel(controller);
    await assert.rejects(() => Abridge(controller.signal, m, { unifiedDiff: s(retentionFixtureDiff()) }));
  });

  test("turn budget exhausted after a refinement was requested, model never resubmits: the held-back draft is returned as a fallback (G12)", async () => {
    const diff = retentionFixtureDiff();
    const m = newScriptedModel([
      assistant(toolUse("draft", "submit", { remove: [], replace: [], fold: [], summary: "Changes calls." })),
      assistant({ type: "text", text: "I cannot safely compress it further." }),
    ]);
    const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff), maxTurns: 2 });
    assert.equal(d(res.smartDiff), diff, `fallback diff changed:\n${d(res.smartDiff)}`);
  });

  test("an oversize diff is refused before any model call (G3)", async () => {
    const m = newScriptedModel([assistant()]);
    const big = "diff --git a/x b/x\n+" + "x".repeat(4 << 20);
    await assert.rejects(
      () => Abridge(new AbortController().signal, m, { unifiedDiff: s(big) }),
      (err: unknown) => err instanceof Error && err.message.includes("narrower"),
    );
    assert.equal(m.seen, 0, "oversize diff must not reach the model");
  });

  test("an unsplittable oversize diff (no hunks to split at) is refused before any model call (G3)", async () => {
    const m = newScriptedModel([assistant()]);
    const big = "diff --git a/x b/x\n+" + "x".repeat(400 << 10);
    await assert.rejects(
      () => Abridge(new AbortController().signal, m, { unifiedDiff: s(big) }),
      (err: unknown) => err instanceof Error && err.message.includes("narrower"),
    );
    assert.equal(m.seen, 0, "unsplittable diff must not reach the model");
  });

  test("inconsistent hunk counts are rejected before any model call (G3)", async () => {
    const m = newScriptedModel([assistant()]);
    const diff = "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n+extra\n";
    await assert.rejects(
      () => Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) }),
      (err: unknown) => err instanceof Error && err.message.includes("counts inconsistent"),
    );
    assert.equal(m.seen, 0);
  });

  test("a combined diff is rejected before any model call (G3)", async () => {
    const m = newScriptedModel([assistant()]);
    const diff = "diff --cc a.go\n@@@ -1,1 -1,1 +1,1 @@@\n++resolved\n";
    await assert.rejects(
      () => Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) }),
      (err: unknown) => err instanceof Error && err.message.includes("combined diff"),
    );
    assert.equal(m.seen, 0);
  });

  test("numbered-form expansion alone (not raw size) can force chunking; per-chunk prompts stay bounded (chunk.md G42)", async () => {
    const restore = setSingleRunBudget(400);
    try {
      let diff = "";
      for (const name of ["a", "b"]) {
        diff += `diff --git a/${name} b/${name}\n@@ -0,0 +1,40 @@\n`;
        for (let i = 0; i < 40; i++) diff += "+x\n";
      }
      assert.ok(diff.length <= 400, `fixture raw size = ${diff.length}, want under the raw budget`);
      assert.ok(!fitsSingleRun(s(diff), 400), "fixture numbered form should exceed the budget");
      const m = newScriptedModel([assistant(toolUse("s", "submit", { remove: [], replace: [], fold: [], summary: "Adds rows." }))]);
      const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
      assert.ok(m.seen >= 2, `model calls = ${m.seen}, want one per chunk (>= 2)`);
      const overhead = userPromptIntro.length + userPromptImports.length + userPromptNoTools.length + userPromptProtocol.length + 8;
      for (const msgs of m.seenMessages) {
        const firstBlock = msgs[0]!.content[0]!;
        assert.ok(firstBlock.type === "text");
        const promptLen = (firstBlock as { text: string }).text.length;
        assert.ok(promptLen <= 400 + overhead, `per-chunk prompt is ${promptLen} bytes; numbered chunk must stay within budget`);
      }
      assert.ok(res !== null && d(res.smartDiff).includes("+x"), "merged result missing retained rows");
    } finally {
      restore();
    }
  });

  test("Progress receives a turn update and one message per tool call (G14)", async (t) => {
    if (!gitAvailable()) {
      t.skip("git not found");
      return;
    }
    const repo = await gitRepo({ "a.go": "package a\n" });
    const m = newScriptedModel([
      assistant(toolUse("t1", "read_file", { path: "a.go" })),
      assistant(toolUse("t2", "grep", { pattern: "package" })),
      assistant(toolUse("t3", "submit", { remove: [], replace: [], fold: [], summary: "s" })),
    ]);
    const msgs: string[] = [];
    await Abridge(new AbortController().signal, m, {
      repoRoot: repo,
      unifiedDiff: s("diff --git a/a.go b/a.go\n@@\n+x\n"),
      progress: (msg) => msgs.push(msg),
    });
    const joined = msgs.join("\n");
    for (const want of ["turn 1", "read_file a.go", 'grep "package"', "submitting"]) {
      assert.ok(joined.includes(want), `progress messages missing ${JSON.stringify(want)}:\n${joined}`);
    }
  });

  test("a rejected submit (tool error) does not abort the run; the model gets another turn to correct its plan (G8)", async () => {
    const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n";
    const m = newScriptedModel([
      assistant(
        toolUse("bad", "submit", {
          remove: [{ start_line: 99, end_line: 99 }],
          replace: [{ line: 98, old: "new", new: "..." }],
          fold: [],
          summary: "Changes the value.",
        }),
      ),
      assistant(
        toolUse("good", "submit", {
          remove: [{ start_line: 3, end_line: 3 }],
          replace: [{ line: 4, old: "new", new: "n..." }],
          fold: [],
          summary: "Changes the value.",
        }),
      ),
    ]);
    const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
    assert.equal(m.seen, 2);
    const smart = d(res.smartDiff);
    assert.ok(!smart.includes("-old") && smart.includes("+n..."), `derived smart diff did not apply corrected plan:\n${smart}`);
    let sawAggregatedToolError = false;
    for (const msg of m.seenMessages[1]!) {
      for (const b of msg.content) {
        if (b.type === "tool_result" && b.toolError && b.toolResult.includes("remove[0]") && b.toolResult.includes("replace[0]")) {
          sawAggregatedToolError = true;
        }
      }
    }
    assert.ok(sawAggregatedToolError, "corrective turn did not receive all independently detectable plan errors");
  });

  test("only tool_use blocks are ever acted on; assistant-authored prose cannot influence SmartDiff (G7)", async () => {
    const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n";
    const m = newScriptedModel([
      assistant(
        { type: "text", text: "diff --git a/invented.go b/invented.go\n+dangerousCall()" },
        toolUse("submit", "submit", { remove: [{ start_line: 3, end_line: 3 }], replace: [], fold: [], summary: "Changes the value." }),
      ),
    ]);
    const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(diff) });
    const smart = d(res.smartDiff);
    assert.ok(!smart.includes("invented") && !smart.includes("dangerousCall"), `assistant prose leaked into smart diff:\n${smart}`);
    assert.ok(smart.includes("+new"), `original retained line missing:\n${smart}`);
  });

  test("a real Git format-patch — mail signature, prose that looks like diff metadata — round-trips identically under an identity plan (meat/editplan_test.go:636-677, deferred here)", async (t) => {
    if (!gitAvailable()) {
      t.skip("git not found");
      return;
    }
    const repo = await gitRepo({ "a.go": "package a\n\nconst Value = 1\n" });
    await writeFile(join(repo, "a.go"), "package a\n\nconst Value = 2\n");
    execFileSync("git", ["add", "a.go"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
    execFileSync(
      "git",
      ["commit", "-q", "-m", "change value", "-m", "@@@ this is commit prose", "-m", "rename from old behavior", "-m", "diff behavior notes"],
      { cwd: repo, stdio: ["ignore", "ignore", "ignore"] },
    );
    const raw = execFileSync("git", ["format-patch", "-1", "--stdout"], { cwd: repo }).toString("utf8");
    assert.ok(
      raw.includes("@@@ this is commit prose") && raw.includes("rename from old behavior") && raw.includes("diff behavior notes"),
      `format-patch fixture lost metadata-looking commit prose:\n${raw}`,
    );
    assert.ok(raw.includes("\n-- \n"), `format-patch fixture has no mail signature:\n${raw}`);

    const m = newScriptedModel([assistant(toolUse("submit", "submit", { remove: [], replace: [], fold: [], summary: "Changes Value from 1 to 2." }))]);
    const res = await Abridge(new AbortController().signal, m, { unifiedDiff: s(raw) });
    assert.equal(d(res.smartDiff), raw, "identity plan changed format-patch input");
  });
});

describe("Request shape (meat/chunk_test.go:1541-1546, G15)", () => {
  test("Request has exactly repoRoot/unifiedDiff/maxTurns/progress — chunk bookkeeping lives in a separate internal type", () => {
    const req: Request = { repoRoot: "", unifiedDiff: s("diff --git a/a b/a\n@@ -1 +1 @@\n+x\n"), maxTurns: 0 };
    assert.equal(d(req.unifiedDiff), "diff --git a/a b/a\n@@ -1 +1 @@\n+x\n");
    assert.deepEqual(new Set(Object.keys(req)), new Set(["repoRoot", "unifiedDiff", "maxTurns"]));
  });
});
