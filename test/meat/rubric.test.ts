// Full port of meat/meat_test.go's rubric/prompt-surface tests, completed
// now that `promptSurface()`/`RubricHash()` landed in this file as part of
// item 4n (meat.ts): TestPromptSurfaceStaysFrozen (G1/G2, full — supersedes
// this file's earlier systemPrompt-only slice), TestBuildUserPromptNumbersOriginalDiff,
// TestRubricHash, TestSurfaceFixturesCoverBothMoveBranches, and
// TestRubricHashPinned (G4-G6). The conformance harness's own
// `rubric-hash.txt`/`prompt-surface.txt` vectors (test/conformance.test.ts)
// already prove promptSurface()/RubricHash() byte-exact against the frozen
// Go oracle; these are the direct unit-test port for parity with
// meat_test.go, not a duplicate of that proof.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { numberedDiff } from "../../src/meat/diff.ts";
import {
  abridgeProtocolVersion,
  systemPrompt,
  surfaceFixtureDiff,
  surfaceFixtureNoMoveDiff,
  surfaceOverflowDiff,
  RubricHash,
} from "../../src/meat/rubric.ts";
import { buildUserPrompt, noToolCallNudge, type RunOptions } from "../../src/meat/meat.ts";
import { newToolbox, tools as toolboxTools, planFeedback } from "../../src/meat/tools.ts";
import { compileEditPlan, type CompiledPlan, type EditPlan } from "../../src/meat/editplan.ts";
import { detectedMovesInDiff, maxMoveHints } from "../../src/meat/moves.ts";

const emptyOpts: RunOptions = {};

describe("promptSurface (meat/meat_test.go:646-714, TestPromptSurfaceStaysFrozen)", () => {
  test("no surface leaks compiler-internal arbitration vocabulary (G1) and every required guidance string survives (G2)", () => {
    const banned = [
      "mandatory",
      "compiler",
      "precedence over",
      "import precedence",
      "hiding wins",
      "wins before",
      "counterpart",
      "compiler-owned",
      "arbitrat",
    ];

    const moveDiff = encodeUTF8(surfaceFixtureDiff);
    const noMoveDiff = encodeUTF8(surfaceFixtureNoMoveDiff);
    const numberedMove = numberedDiff(moveDiff);
    const numberedNoMove = numberedDiff(noMoveDiff);

    const surfaces = new Map<string, string>([
      ["systemPrompt", systemPrompt],
      ["userPrompt", decodeUTF8(buildUserPrompt({ unifiedDiff: moveDiff, repoRoot: "/repo" }, emptyOpts, numberedMove))],
      ["userPrompt (no root)", decodeUTF8(buildUserPrompt({ unifiedDiff: moveDiff }, emptyOpts, numberedMove))],
      ["userPrompt (no move)", decodeUTF8(buildUserPrompt({ unifiedDiff: noMoveDiff, repoRoot: "/repo" }, emptyOpts, numberedNoMove))],
    ]);

    const tb = newToolbox({ root: "/repo", rawDiff: moveDiff });
    for (const tool of toolboxTools(tb)) {
      surfaces.set(`tool ${tool.name}`, tool.description + decodeUTF8(tool.inputSchema));
    }
    surfaces.set("nudge", noToolCallNudge);

    const plan: EditPlan = {
      remove: [],
      replace: [],
      fold: [
        { startLine: 6, endLine: 9 },
        { startLine: 16, endLine: 19 },
      ],
    };
    const compiled = compileEditPlan(moveDiff, plan);
    surfaces.set("planFeedback moves", planFeedback(compiled));
    // Cover the other feedback branches: no moves, and high retention
    // pressure (stats synthesized to trip retentionPressure).
    const plainPlan: CompiledPlan = {
      smartDiff: new Uint8Array(0),
      moves: [],
      stats: { rawChanged: 10, visibleChanged: 4, removedChanged: 0, foldedChanged: 0, foldCount: 0, rawFiles: 1, visibleFiles: 1 },
    };
    surfaces.set("planFeedback plain", planFeedback(plainPlan));
    const pressurePlan: CompiledPlan = {
      smartDiff: new Uint8Array(0),
      moves: [],
      stats: { rawChanged: 100, visibleChanged: 90, removedChanged: 0, foldedChanged: 0, foldCount: 0, rawFiles: 2, visibleFiles: 2 },
    };
    surfaces.set("planFeedback pressure", planFeedback(pressurePlan));

    for (const [name, text] of surfaces) {
      const lower = text.toLowerCase();
      for (const word of banned) {
        assert.ok(!lower.includes(word), `${name} leaks compiler-internal vocabulary ${JSON.stringify(word)}`);
      }
    }

    // The freeze is not just an absence: the surfaces must still tell the
    // model everything it acts on. Guard the load-bearing guidance so a
    // rewording cannot silently drop it.
    const required = new Map<string, string[]>([
      ["systemPrompt", ["IMPORTS ARE REMOVED AUTOMATICALLY", "TREAT BEHAVIORAL MOVES SYMMETRICALLY", "NEVER invent or alter program logic"]],
      ["userPrompt", ["removed automatically", "-6..9 ↔ +16..19", "identical keep/remove/fold/replace treatment"]],
    ]);
    for (const [name, wants] of required) {
      const text = surfaces.get(name);
      assert.ok(text !== undefined, `missing surface ${name}`);
      for (const want of wants) {
        assert.ok(text.includes(want), `${name} lost required guidance ${JSON.stringify(want)}`);
      }
    }
  });
});

describe("buildUserPrompt (meat/meat_test.go:716-727, TestBuildUserPromptNumbersOriginalDiff)", () => {
  test("numbers the original diff and emits no phantom trailing line", () => {
    const diff = encodeUTF8("diff --git a/a b/a\n@@ -1 +1 @@\n+x");
    const prompt = decodeUTF8(buildUserPrompt({ unifiedDiff: diff }, emptyOpts, numberedDiff(diff)));
    for (const want of ["1|diff --git a/a b/a", "2|@@ -1 +1 @@", "3|+x"]) {
      assert.ok(prompt.includes(want), `numbered prompt missing ${JSON.stringify(want)}:\n${prompt}`);
    }
    assert.ok(!prompt.includes("4|"), `numbered prompt contains phantom final line:\n${prompt}`);
  });
});

describe("RubricHash (meat/meat_test.go:729-738, TestRubricHash)", () => {
  test("is a 16-hex-char string, stable across calls within a build", () => {
    const h = RubricHash();
    assert.equal(h.length, 16, `RubricHash() = ${JSON.stringify(h)}, want 16 hex chars`);
    assert.equal(h, RubricHash(), "RubricHash is not deterministic");
  });
});

describe("surfaceFixtureDiff/surfaceFixtureNoMoveDiff/surfaceOverflowDiff (meat/meat_test.go:751-761, TestSurfaceFixturesCoverBothMoveBranches)", () => {
  test("the canonical hashing fixtures keep exercising both the move and no-move user-prompt branches", () => {
    assert.ok(detectedMovesInDiff(encodeUTF8(surfaceFixtureDiff)).length > 0, "surfaceFixtureDiff no longer triggers move detection");
    assert.equal(detectedMovesInDiff(encodeUTF8(surfaceFixtureNoMoveDiff)).length, 0, "surfaceFixtureNoMoveDiff detects moves, want 0");
    const n = detectedMovesInDiff(surfaceOverflowDiff()).length;
    assert.ok(n > maxMoveHints, `surfaceOverflowDiff detects ${n} moves, want more than maxMoveHints (${maxMoveHints}) so the overflow hint renders`);
  });
});

describe("RubricHash pin (meat/meat_test.go:763-768, TestRubricHashPinned)", () => {
  test("matches the frozen hash — a change here means the model-visible prompt surface changed", () => {
    const pinned = "441f5e6e28ad3add";
    assert.equal(RubricHash(), pinned, "RubricHash() changed; review it against the freeze policy on systemPrompt, then update the pin");
  });
});

describe("abridgeProtocolVersion", () => {
  test("is a non-empty version string, mixed into RubricHash", () => {
    assert.equal(typeof abridgeProtocolVersion, "string");
    assert.ok(abridgeProtocolVersion.length > 0);
  });
});
