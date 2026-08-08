// Port of cmd/meat/render_test.go's 9 tests: TestFormatBodyPlain,
// TestFormatBodyEmptyDiff, TestColorizeDiffLineSlots,
// TestPaletteDisabledIsAllPlain, TestIsTerminalNonFile,
// TestIsTerminalRegularFileAndDevNull, TestRenderResultToFileIsPlain,
// TestGitWantsColorHonorsConfig, TestRenderJSON.
//
// `TestRenderJSON`'s ground here is also covered byte-exact by
// `test/conformance.test.ts`'s `json-wire/` block against the frozen
// vectors — both are kept, matching this codebase's convention (e.g.
// `cache.test.ts`'s `cacheKey` describe block alongside `cache-key/`'s
// vectors) of a direct unit test plus vector coverage, not one instead of
// the other.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync, closeSync, writeSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeUTF8 } from "../../src/meat/bytes.ts";
import { type Result } from "../../src/meat/meat.ts";
import {
  ansiReset,
  type DiffPalette,
  type Writer,
  isTerminal,
  gitWantsColor,
  palette,
  colorizeDiffLine,
  formatBody,
  renderJSON,
  renderResult,
} from "../../src/cli/render.ts";

function result(fields: Partial<Result>): Result {
  return { smartDiff: new Uint8Array(0), summary: "", inputTokens: 0, outputTokens: 0, ...fields };
}

// coloredP fakes git-resolved colors without shelling out, so colorization
// logic is tested deterministically (render_test.go:17).
const coloredP: DiffPalette = { meta: "\x1b[1m", frag: "\x1b[36m", old: "\x1b[31m", new: "\x1b[32m" };
const plainP: DiffPalette = { meta: "", frag: "", old: "", new: "" };

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// Ported from render_test.go's TestFormatBodyPlain.
test("formatBody: plain output, no ANSI escapes (render_test.go:19-29)", () => {
  const res = result({ summary: "did a thing", smartDiff: encodeUTF8("@@ -1 +1 @@\n-old\n+new\n") });
  const got = formatBody(res, "", plainP);
  assert.equal(got, "# did a thing\n\n@@ -1 +1 @@\n-old\n+new\n");
  assert.ok(!got.includes("\x1b["), "plain output must contain no ANSI escapes");
});

// Ported from render_test.go's TestFormatBodyEmptyDiff.
describe("formatBody: empty/whitespace-only diff (render_test.go:31-38)", () => {
  for (const [name, p] of [
    ["plain", plainP],
    ["colored", coloredP],
  ] as const) {
    test(`says so under the ${name} palette`, () => {
      const got = formatBody(result({ summary: "s" }), "", p);
      assert.ok(got.includes("no meaningful change"), `palette ${name}: got ${JSON.stringify(got)}`);
    });
  }
});

// Ported from render_test.go's TestColorizeDiffLineSlots (18-row table):
// checks each line kind maps to the CORRECT palette slot, not merely "some
// color", so a wrong-slot regression is caught.
describe("colorizeDiffLine: exact slot per line kind (render_test.go:42-84)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [" context", ""],
    ["+added", coloredP.new],
    ["-removed", coloredP.old],
    ["@@ -1 +1 @@", coloredP.frag],
    ["diff --git a/x b/x", coloredP.meta],
    ["index abc..def 100644", coloredP.meta],
    ["--- a/x", coloredP.meta], // file header is meta, not "old"
    ["+++ b/x", coloredP.meta], // file header is meta, not "new"
    ["new file mode 100644", coloredP.meta],
    ["deleted file mode 100644", coloredP.meta],
    ["old mode 100644", coloredP.meta],
    ["new mode 100755", coloredP.meta],
    ["rename from a", coloredP.meta],
    ["rename to b", coloredP.meta],
    ["copy from a", coloredP.meta],
    ["copy to b", coloredP.meta],
    ["similarity index 90%", coloredP.meta],
    ["dissimilarity index 40%", coloredP.meta],
  ];
  for (const [line, want] of cases) {
    test(`colorizeDiffLine(${JSON.stringify(line)})`, () => {
      const got = colorizeDiffLine(line, coloredP);
      assert.ok(got.includes(line), `dropped text: ${JSON.stringify(got)}`);
      if (want === "") {
        assert.equal(got, line, "should be unchanged");
        return;
      }
      assert.ok(got.startsWith(want), `wrong slot: ${JSON.stringify(got)}, want prefix ${JSON.stringify(want)}`);
      assert.ok(got.endsWith(ansiReset), `colored line must end with a reset: ${JSON.stringify(got)}`);
    });
  }
});

// Ported from render_test.go's TestPaletteDisabledIsAllPlain.
test("palette(false) is the empty palette; colors nothing (render_test.go:87-96)", () => {
  assert.deepEqual(palette(false), plainP);
  for (const line of ["+a", "-b", "@@ x @@", "diff --git a b"]) {
    assert.equal(colorizeDiffLine(line, plainP), line);
  }
});

function fileWriter(fd: number): Writer {
  return {
    fd,
    write: (text: string) => {
      writeSync(fd, text);
    },
  };
}

// Ported from render_test.go's TestIsTerminalNonFile: a non-fd writer is
// never a terminal.
test("isTerminal: an in-memory writer with no fd is never a terminal (render_test.go:99-103)", () => {
  const chunks: string[] = [];
  const w: Writer = { write: (text) => chunks.push(text) };
  assert.equal(isTerminal(w), false);
});

// Ported from render_test.go's TestIsTerminalRegularFileAndDevNull: guards
// against a naive char-device check misclassifying /dev/null as a tty.
describe("isTerminal: regular file and /dev/null are both non-terminals (render_test.go:108-126)", () => {
  test("a regular file must not be a terminal", () => {
    const dir = mkdtempSync(join(tmpdir(), "meat-render-"));
    const fd = openSync(join(dir, "out"), "w");
    try {
      assert.equal(isTerminal(fileWriter(fd)), false);
    } finally {
      closeSync(fd);
    }
  });

  test("/dev/null (a character device) must not be a terminal", (t) => {
    let fd: number;
    try {
      fd = openSync("/dev/null", "w");
    } catch {
      t.skip("cannot open /dev/null");
      return;
    }
    try {
      assert.equal(isTerminal(fileWriter(fd)), false);
    } finally {
      closeSync(fd);
    }
  });
});

// Ported from render_test.go's TestRenderResultToFileIsPlain: a near-
// end-to-end check of the public entry point.
test("renderResult to a regular file is plain, includes summary and elision, never pages (render_test.go:131-154)", () => {
  const dir = mkdtempSync(join(tmpdir(), "meat-render-"));
  const path = join(dir, "out");
  const fd = openSync(path, "w");
  const res = result({ summary: "s", smartDiff: encodeUTF8("@@ x @@\n+a\n-b\n") });
  renderResult(fileWriter(fd), res, "kept 2/9 changed lines");
  closeSync(fd);

  const got = readFileSync(path, "utf8");
  assert.ok(!got.includes("\x1b["), `redirected output must be plain, got escapes:\n${JSON.stringify(got)}`);
  assert.ok(got.includes("+a") && got.includes("# s"), `redirected output missing content:\n${got}`);
  assert.ok(got.includes("# kept 2/9 changed lines"), `redirected output missing elision manifest:\n${got}`);
});

// Ported from render_test.go's TestGitWantsColorHonorsConfig: color.diff
// policy wins over the raw tty flag in both directions. Uses GIT_CONFIG_*
// env so the real user/repo config is untouched.
test("gitWantsColor honors color.diff over the raw tty flag (render_test.go:160-176)", (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  const saved = {
    count: process.env["GIT_CONFIG_COUNT"],
    key0: process.env["GIT_CONFIG_KEY_0"],
    value0: process.env["GIT_CONFIG_VALUE_0"],
  };
  try {
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "color.diff";

    process.env["GIT_CONFIG_VALUE_0"] = "never";
    assert.equal(gitWantsColor(true), false, "color.diff=never should disable color even on a tty");

    process.env["GIT_CONFIG_VALUE_0"] = "always";
    assert.equal(gitWantsColor(false), true, "color.diff=always should enable color even when not a tty");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const envKey = k === "count" ? "GIT_CONFIG_COUNT" : k === "key0" ? "GIT_CONFIG_KEY_0" : "GIT_CONFIG_VALUE_0";
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  }
});

// Ported from render_test.go's TestRenderJSON: pins the -json wire form —
// one JSON object, snake_case keys, the machine-computed elision manifest,
// no ANSI, no HTML-escaping. See also test/conformance.test.ts's
// `json-wire/` block for the byte-exact vector coverage of the same
// function.
test("renderJSON: snake_case keys, no HTML-escaping, no ANSI (render_test.go:180-211)", () => {
  const res = result({
    smartDiff: encodeUTF8("@@ x @@\n+a\n"),
    summary: "did <a> thing",
    inputTokens: 10,
    outputTokens: 2,
  });
  const out = renderJSON(res, "kept 1/5 changed lines");

  const got: Record<string, unknown> = JSON.parse(out);
  assert.equal(got["smart_diff"], "@@ x @@\n+a\n");
  assert.equal(got["summary"], "did <a> thing"); // SetEscapeHTML(false): '<' not <
  assert.equal(got["input_tokens"], 10);
  assert.equal(got["output_tokens"], 2);
  assert.equal(got["elision"], "kept 1/5 changed lines");
  assert.ok(!out.includes("\x1b["), "json output must contain no ANSI escapes");
  assert.ok(!out.includes("\\u003c"), "json output should not HTML-escape (SetEscapeHTML(false))");
});
