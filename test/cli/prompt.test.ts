import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../../src/cli/main.ts";
import { formatReviewPrompt } from "../../src/cli/prompt.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const fixture = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+żółć `````";

test("packet retains Unicode, nested fences, and input identity without truncation", () => {
  const bytes = Buffer.from(fixture);
  const packet = formatReviewPrompt(bytes, "stdin");
  assert.ok(packet.includes(`Input bytes: ${bytes.length}\n`));
  assert.ok(packet.includes(createHash("sha256").update(bytes).digest("hex")));
  assert.ok(packet.endsWith("``````diff\n" + fixture + "\n``````\n"));
  assert.equal(formatReviewPrompt(bytes, "stdin"), packet);
});

test("prompt accepts boolean spellings and rejects conflicting output modes", () => {
  for (const flag of ["-prompt", "--prompt", "-prompt=true"]) {
    const parsed = parseFlags([flag, "HEAD"]);
    assert.ok(parsed.kind === "ok" && parsed.flags.prompt);
    assert.deepEqual(parsed.flags.positional, ["HEAD"]);
  }
  const off = parseFlags(["-prompt=false", "-json"]);
  assert.ok(off.kind === "ok" && !off.flags.prompt && off.flags.jsonOut);
  for (const flag of ["-look", "-json"]) {
    const result = spawnSync(process.execPath, [cli, "-prompt", flag], {
      input: fixture, encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot be combined/);
  }
});

test("real CLI exports stdin without credentials, network, cache writes, or diagnostics", (t) => {
  const cache = mkdtempSync(join(tmpdir(), "meat-prompt-cache-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, "-prompt"], {
    input: fixture,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env, MEAT_CACHE: cache, MEAT_MODEL: "unused",
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", XAI_API_KEY: "",
      OPENAI_BASE_URL: "http://127.0.0.1:1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1", XAI_BASE_URL: "http://127.0.0.1:1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, formatReviewPrompt(Buffer.from(fixture), "stdin"));
  assert.equal(result.stderr, "");
  assert.deepEqual(readdirSync(cache), []);
});

test("prompt with empty stdin fails without claiming a review", () => {
  const result = spawnSync(process.execPath, [cli, "-prompt"], { input: "", encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no diff to read/);
});

test("prompt reviews another repo's explicit commit, range, index and worktree", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "meat-prompt-repo-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
    // This LF fixture must not inherit the user's line-ending conversion policy.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  git("init", "-q");
  const file = join(cwd, "file.txt");
  writeFileSync(file, "base\n");
  git("add", "file.txt");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  writeFileSync(file, "committed\n");
  git("add", "file.txt");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "change");
  writeFileSync(file, "staged\n");
  git("add", "file.txt");
  writeFileSync(file, "unstaged\n");
  for (const [args, expected] of [
    [["HEAD"], git("show", "--format=fuller", "-m", "--first-parent", "HEAD")],
    [["HEAD~1...HEAD"], git("diff", "HEAD~1...HEAD")],
    [["-staged"], git("diff", "--staged")],
    [["-w"], git("diff")],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, "-prompt", ...args], {
      cwd, env, input: "ignored pipe", encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(expected));
    assert.equal(result.stderr, "");
  }
});
