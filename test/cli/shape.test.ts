// Drives the shipped shape/color/length transform (`formatDiffLook`) and the
// no-model CLI entry (`-look`) on representative unified diffs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeUTF8 } from "../../src/meat/bytes.ts";
import { ansiReset, type DiffPalette } from "../../src/cli/render.ts";
import { formatDiffLook, observeDiffShape, SHAPE_WRAP } from "../../src/cli/shape.ts";

const coloredP: DiffPalette = { meta: "\x1b[1m", frag: "\x1b[36m", old: "\x1b[31m", new: "\x1b[32m" };
const plainP: DiffPalette = { meta: "", frag: "", old: "", new: "" };

const mainModulePath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

interface HunkParts {
  readonly ctxBefore: readonly string[];
  readonly deletes: readonly string[];
  readonly adds: readonly string[];
  readonly ctxAfter: readonly string[];
}

function nLines(prefix: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${prefix}${i}`);
  return out;
}

/** Well-formed one-file git unified diff whose hunk body is exactly `parts`. */
function unifiedFrom(parts: HunkParts): string {
  const oldCount = parts.ctxBefore.length + parts.deletes.length + parts.ctxAfter.length;
  const newCount = parts.ctxBefore.length + parts.adds.length + parts.ctxAfter.length;
  const body: string[] = [];
  for (const line of parts.ctxBefore) body.push(` ${line}`);
  for (const line of parts.deletes) body.push(`-${line}`);
  for (const line of parts.adds) body.push(`+${line}`);
  for (const line of parts.ctxAfter) body.push(` ${line}`);
  return [
    "diff --git a/f.ts b/f.ts",
    "index 1111111..2222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...body,
    "",
  ].join("\n");
}

function expectedMarks(parts: HunkParts): string {
  return ".".repeat(parts.ctxBefore.length) + "-".repeat(parts.deletes.length) + "+".repeat(parts.adds.length) + ".".repeat(parts.ctxAfter.length);
}

function expectedLengthLine(parts: HunkParts): string {
  const context = parts.ctxBefore.length + parts.ctxAfter.length;
  return `length  +${parts.adds.length} -${parts.deletes.length} ~${context}`;
}

function shapeMarksFromView(view: string): string {
  const rows: string[] = [];
  for (const line of view.split("\n")) {
    if (line.startsWith("shape   ")) rows.push(line.slice("shape   ".length));
  }
  return rows.join("");
}

const oneLine: HunkParts = {
  ctxBefore: ["keep-a"],
  deletes: ["old"],
  adds: ["new"],
  ctxAfter: ["keep-b"],
};

const mostlyAdded: HunkParts = {
  ctxBefore: ["keep-a"],
  deletes: ["gone-a", "gone-b"],
  adds: nLines("added-", 80),
  ctxAfter: ["keep-b"],
};

const mixedRewrite: HunkParts = {
  ctxBefore: ["keep-a", "keep-b"],
  deletes: nLines("old-", 24),
  adds: nLines("new-", 24),
  ctxAfter: ["keep-c", "keep-d"],
};

describe("formatDiffLook: three representative shapes", () => {
  const cases: ReadonlyArray<readonly [string, HunkParts]> = [
    ["one-line edit", oneLine],
    ["large mostly-added", mostlyAdded],
    ["large mixed rewrite", mixedRewrite],
  ];

  for (const [name, parts] of cases) {
    test(`${name}: length, add/delete marks, and the input's own unified-diff text`, () => {
      const diffText = unifiedFrom(parts);
      const view = formatDiffLook(encodeUTF8(diffText), plainP);

      assert.ok(view.includes(expectedLengthLine(parts)), `missing length line for ${name}:\n${view}`);

      const marks = shapeMarksFromView(view);
      assert.equal(marks, expectedMarks(parts), `shape marks for ${name}`);
      if (parts.adds.length > 0) {
        assert.ok(marks.includes("+"), `${name}: fixture has additions, shape must show +`);
      }
      if (parts.deletes.length > 0) {
        assert.ok(marks.includes("-"), `${name}: fixture has deletions, shape must show -`);
      }

      // +++ / --- file headers must not inflate add/delete counts.
      const observed = observeDiffShape(encodeUTF8(diffText));
      assert.equal(observed.adds, parts.adds.length);
      assert.equal(observed.deletes, parts.deletes.length);

      // The same view still carries the actual unified-diff text.
      assert.ok(view.includes("diff --git a/f.ts b/f.ts"), `${name} dropped the unified-diff header`);
      for (const line of parts.deletes) {
        assert.ok(view.includes(`-${line}`), `${name} missing deleted line ${line}`);
      }
      for (const line of parts.adds.slice(0, 3)) {
        assert.ok(view.includes(`+${line}`), `${name} missing added line ${line}`);
      }
      assert.ok(!view.includes("\x1b["), `${name} color-off view must contain no ANSI`);
    });
  }

  test("the three views are observably different from the view alone", () => {
    const one = formatDiffLook(encodeUTF8(unifiedFrom(oneLine)), plainP);
    const added = formatDiffLook(encodeUTF8(unifiedFrom(mostlyAdded)), plainP);
    const mixed = formatDiffLook(encodeUTF8(unifiedFrom(mixedRewrite)), plainP);
    assert.notEqual(one, added);
    assert.notEqual(one, mixed);
    assert.notEqual(added, mixed);
  });

  test("a large mostly-added change wraps into a block of + marks", () => {
    const view = formatDiffLook(encodeUTF8(unifiedFrom(mostlyAdded)), plainP);
    const markRows = view.split("\n").filter((line) => line.startsWith("shape   "));
    assert.ok(markRows.length >= 2, `expected wrapped shape, got ${markRows.length} row(s)`);
    assert.ok(markRows.some((row) => row.slice("shape   ".length).length === SHAPE_WRAP));
    assert.ok(shapeMarksFromView(view).includes("+".repeat(80)));
  });
});

describe("formatDiffLook: color on vs color off", () => {
  const diff = encodeUTF8(unifiedFrom(oneLine));

  test("color-on uses distinct add vs delete colors and wraps with a reset", () => {
    assert.notEqual(coloredP.new, coloredP.old);
    const on = formatDiffLook(diff, coloredP);
    assert.ok(on.includes(coloredP.new), `add color missing:\n${JSON.stringify(on)}`);
    assert.ok(on.includes(coloredP.old), `delete color missing:\n${JSON.stringify(on)}`);
    assert.ok(on.includes(ansiReset), `colored output must wrap with a reset:\n${JSON.stringify(on)}`);

    const shapeRow = on.split("\n").find((line) => line.startsWith("shape   "));
    assert.ok(shapeRow !== undefined);
    const coloredShape = shapeRow.slice("shape   ".length);
    assert.ok(coloredShape.includes(coloredP.new + "+" + ansiReset), `add run not wrapped with add color + reset: ${JSON.stringify(coloredShape)}`);
    assert.ok(coloredShape.includes(coloredP.old + "-" + ansiReset), `delete run not wrapped with delete color + reset: ${JSON.stringify(coloredShape)}`);
  });

  test("color-off contains no ANSI but still distinguishes additions from deletions", () => {
    const off = formatDiffLook(diff, plainP);
    assert.ok(!off.includes("\x1b["), `color-off leaked ANSI:\n${JSON.stringify(off)}`);
    const marks = shapeMarksFromView(off);
    assert.ok(marks.includes("+") && marks.includes("-"), `color-off shape must keep +/- marks: ${marks}`);
  });
});

describe("meat -look: real CLI, no model, no API key", () => {
  const fixture = unifiedFrom(mostlyAdded);

  function runLook(input: string): { status: number | null; stdout: string; stderr: string } {
    const env = { ...process.env };
    delete env["OPENAI_API_KEY"];
    delete env["ANTHROPIC_API_KEY"];
    const result = spawnSync(process.execPath, [mainModulePath, "-look"], {
      input,
      encoding: "utf8",
      env,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test("piped unified diff exits 0 and prints that fixture's length and shape", () => {
    const first = runLook(fixture);
    assert.equal(first.status, 0, `stderr:\n${first.stderr}`);
    assert.ok(first.stdout.includes(expectedLengthLine(mostlyAdded)), `missing length:\n${first.stdout}`);
    assert.equal(shapeMarksFromView(first.stdout), expectedMarks(mostlyAdded));
    assert.ok(first.stdout.includes("+added-0") && first.stdout.includes("-gone-a"));

    const second = runLook(fixture);
    assert.equal(second.status, 0, `second run stderr:\n${second.stderr}`);
    assert.equal(second.stdout, first.stdout, "repeat -look run must be consistent");
  });

  test("-look -w uses the existing worktree git source, still without a model", (t) => {
    try {
      execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      t.skip("git not found");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "meat-look-w-"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv, stdio: ["ignore", "ignore", "ignore"] });
    writeFileSync(join(dir, "f.ts"), "keep-a\ncommitted\nkeep-b\n");
    execFileSync("git", ["add", "f.ts"], { cwd: dir, env: gitEnv, stdio: ["ignore", "ignore", "ignore"] });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: gitEnv, stdio: ["ignore", "ignore", "ignore"] });
    writeFileSync(join(dir, "f.ts"), "keep-a\nunstaged\nkeep-b\n");

    const env = { ...gitEnv };
    delete env["OPENAI_API_KEY"];
    delete env["ANTHROPIC_API_KEY"];
    const result = spawnSync(process.execPath, [mainModulePath, "-look", "-w"], {
      cwd: dir,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes("length  +1 -1 ~2"), `missing length:\n${result.stdout}`);
    assert.ok(result.stdout.includes("shape   .-+."), `missing shape:\n${result.stdout}`);
    assert.ok(result.stdout.includes("-committed") && result.stdout.includes("+unstaged"));
  });
});
