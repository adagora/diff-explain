// Behavioral checks of the same entry point the installed skill invokes.
// No live provider, personal cache, auth storage, or agent process is used.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Abridge } from "../../src/meat/meat.ts";
import { cacheKey, cacheStore } from "../../src/cli/cache.ts";
import { RubricHash } from "../../src/meat/rubric.ts";
import { decodeUTF8, encodeUTF8 } from "../../src/meat/bytes.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

function fixture(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "meat-skill-contract-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repo = join(folder, "reviewed repo");
  const cache = join(folder, "cache");
  mkdirSync(repo); mkdirSync(cache);
  const env = { ...process.env, MEAT_CACHE: cache, MEAT_MODEL: "",
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", XAI_API_KEY: "",
    OPENAI_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", XAI_BASE_URL: "http://127.0.0.1:1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, maxBuffer: 8 * 1024 * 1024, stdio: "pipe" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  const commit = () => {
    git("add", ".");
    git("-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "commit", "-qm", "behavior");
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, env, input: "ignored stdin", encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  return { repo, cache, git, commit, run };
}

test("Git-backed full packets capture more than Node's default 1 MiB without truncation", t => {
  const { repo, git, commit, run } = fixture(t);
  const body = Array.from({ length: 14000 }, (_, i) => `behavior_${i} = "${"z".repeat(80)}";\n`).join("");
  writeFileSync(join(repo, "large.js"), body);
  commit();
  const original = git("show", "--format=fuller", "-m", "--first-parent", "HEAD");
  assert.ok(original.length > 1024 * 1024);
  const result = run("-prompt", "HEAD");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.includes(decodeUTF8(original)));
  assert.ok(result.stdout.includes(`Input bytes: ${original.length}`));
  assert.ok(result.stdout.includes(`Input SHA-256: ${createHash("sha256").update(original).digest("hex")}`));
  assert.ok(result.stdout.includes("+behavior_13999"));
});

test("the skill's compiled CLI path returns the actual compiler result from cache without provider access", async t => {
  const { repo, cache, git, commit, run } = fixture(t);
  writeFileSync(join(repo, "behavior.js"), "import { helper } from './helper.js';\nexport const behavior = 2;\n");
  commit();
  const diff = new Uint8Array(git("show", "--format=fuller", "-m", "--first-parent", "HEAD"));
  let modelCalls = 0;
  const compiled = await Abridge(new AbortController().signal, {
    async generate() {
      modelCalls++;
      return { content: [{ type: "tool_use", id: "submit", toolName: "submit",
        toolInput: encodeUTF8(JSON.stringify({ remove: [], replace: [], fold: [], summary: "Adds behavior." })) }],
      inputTokens: 1, outputTokens: 1 };
    },
  }, { unifiedDiff: diff });
  assert.equal(modelCalls, 1);
  assert.doesNotMatch(decodeUTF8(compiled.smartDiff), /\+import \{ helper \}/);
  assert.match(decodeUTF8(compiled.smartDiff), /\+export const behavior = 2/);
  const model = "offline-contract-model";
  await cacheStore(cache, cacheKey(decodeUTF8(diff), model, RubricHash()), compiled);
  const result = run("-json", "-model", model, "HEAD");
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.smart_diff, decodeUTF8(compiled.smartDiff));
  assert.equal(json.summary, compiled.summary);
  assert.equal(json.input_tokens, compiled.inputTokens);
  assert.equal(json.output_tokens, compiled.outputTokens);
  assert.match(result.stderr, /meat: cached/);
});
