// First-run usability: -o exact output files, -doctor, recovery hints, and
// help that leads with the workflows needing no API key. Offline: fake agent
// CLIs, temporary repositories and homes; no model, provider or gateway call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flagHint, noKeyHint, parseFlags, sourceHint, usage } from "../../src/cli/main.ts";
import { findExecutable } from "../../src/cli/agent.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const checkout = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new ✓\n";
const apiVars = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "XAI_API_KEY", "XAI_BASE_URL", "MEAT_MODEL"];

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MEAT_CACHE: "", MEAT_AGENT_ACTIVE: "" };
  for (const key of Object.keys(env)) if (apiVars.includes(key.toUpperCase())) delete env[key];
  return { ...env, ...extra };
}

function meat(args: readonly string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? checkout, input: options.input ?? "", env: options.env ?? cleanEnv(), encoding: "utf8", timeout: 20_000,
  });
}

function tempRepo(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "meat-usability-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "a.txt"), "two\n");
  git("commit", "-q", "-am", "second");
  return dir;
}

test("new flags parse, and invalid combinations are flag errors", () => {
  const out = parseFlags(["-prompt", "-o", "review.md", "HEAD"]);
  assert.ok(out.kind === "ok" && out.flags.output === "review.md" && out.flags.prompt);
  assert.deepEqual(out.kind === "ok" ? out.flags.positional : null, ["HEAD"]);
  const eq = parseFlags(["-o=x.json", "-json"]);
  assert.ok(eq.kind === "ok" && eq.flags.output === "x.json" && eq.flags.jsonOut);
  const doctor = parseFlags(["-doctor"]);
  assert.ok(doctor.kind === "ok" && doctor.flags.doctor);
  const verbose = parseFlags(["-agent", "claude", "-verbose", "-o", "r.md", "-staged"]);
  assert.ok(verbose.kind === "ok" && verbose.flags.verbose && verbose.flags.output === "r.md");
  for (const args of [["-o="], ["-o"], ["-doctor", "HEAD"], ["-doctor", "-staged"], ["-doctor", "-o", "x"], ["-verbose", "HEAD"], ["-verbose", "-prompt"]]) {
    assert.equal(parseFlags(args).kind, "error", args.join(" "));
  }
});

test("help leads with the no-key workflows and documents every new flag", () => {
  const start = usage.indexOf("Start here");
  assert.ok(start >= 0 && start < usage.indexOf("-model string"));
  for (const text of ["meat -doctor", "meat -prompt HEAD", "meat -agent codex HEAD", "/meat HEAD", "-o file", "-verbose", "Flags always go before"]) {
    assert.ok(usage.includes(text), `usage missing ${text}`);
  }
});

test("hints name the intended command without changing the original error", () => {
  assert.equal(sourceHint(["HEAD", "-look"]), "hint: flags go before the change: meat -look HEAD\n");
  assert.equal(sourceHint(["main...HEAD", "-prompt", "-staged"]), "hint: flags go before the change: meat -prompt -staged main...HEAD\n");
  assert.equal(sourceHint(["look", "HEAD~2"]), "hint: did you mean meat -look HEAD~2?\n");
  assert.equal(sourceHint(["Explain"]), "hint: did you mean meat -prompt HEAD?\n");
  assert.equal(sourceHint(["doctor"]), "hint: did you mean meat -doctor?\n");
  assert.equal(sourceHint(["v1.2.3"]), "");
  assert.equal(flagHint("flag provided but not defined: -explain"), "hint: did you mean -prompt?\n");
  assert.equal(flagHint("flag provided but not defined: -bogus"), "");
  const hint = noKeyHint("main...HEAD", false, true, "/opt/my meat/dist/cli/main.js");
  assert.match(hint, /meat -prompt main\.\.\.HEAD +review packet/);
  assert.match(hint, /meat -agent codex main\.\.\.HEAD +fresh review/);
  assert.match(hint, /--env-file=\.env "\/opt\/my meat\/dist\/cli\/main\.js" main\.\.\.HEAD/);
  assert.match(noKeyHint("", true, false, "meat"), /pipe the same diff/);
});

test("flag errors stay exit 2 but point to help instead of printing it all", () => {
  const result = meat(["-explain", "HEAD"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, 'meat: flag provided but not defined: -explain\nhint: did you mean -prompt?\nRun "meat -h" for usage and examples.\n');
});

test("misplaced flags and workflow words keep the Go error and exit code, plus a hint", (t) => {
  const dir = tempRepo(t);
  const misplaced = meat(["HEAD", "-look"], { cwd: dir });
  assert.equal(misplaced.status, 1);
  assert.equal(misplaced.stderr, "meat: too many arguments: want at most one revision, got 2\nhint: flags go before the change: meat -look HEAD\n");
  const word = meat(["doctor"], { cwd: dir });
  assert.equal(word.status, 1);
  assert.match(word.stderr, /^meat: reading "doctor": git show/);
  assert.match(word.stderr, /hint: did you mean meat -doctor\?\n$/);
  // git's own stderr is captured into meat's message, not echoed separately.
  assert.equal(word.stderr.split("unknown revision").length - 1, 1, word.stderr);
});

test("a missing API key lists the workflows that need none, for the same selection", (t) => {
  if (existsSync("/exe.dev")) { t.skip("exe.dev gateway marker present"); return; }
  const dir = tempRepo(t);
  writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=not-read\n");
  const result = meat(["HEAD~1"], { cwd: dir });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^meat: no OpenAI credentials: set OPENAI_API_KEY/);
  assert.match(result.stderr, /\n {2}meat -prompt HEAD~1 +review packet/);
  assert.match(result.stderr, /\n {2}meat -agent codex HEAD~1 +fresh review/);
  assert.match(result.stderr, /a \.env file is here, but meat does not load it/);
  assert.doesNotMatch(result.stderr, /not-read/);
  const stdin = meat([], { cwd: dir, input: fixture });
  assert.match(stdin.stderr, /\n {2}meat -prompt +review packet/);
  assert.match(stdin.stderr, /pipe the same diff into each command/);
});

test("-o writes exactly the stdout bytes, only after success", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "meat-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packet = join(dir, "review.md");
  const expected = spawnSync(process.execPath, [cli, "-prompt"], { input: fixture, env: cleanEnv() }).stdout;
  const written = meat(["-prompt", "-o", packet], { input: fixture });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, "");
  assert.deepEqual(readFileSync(packet), expected);
  assert.equal(readFileSync(packet)[0], "#".charCodeAt(0), "no byte-order mark");
  assert.ok(!readFileSync(packet).includes("\r\n"), "no line-ending conversion");
  assert.match(written.stderr, new RegExp(`^meat: wrote .*review\\.md \\(${expected.length} bytes\\)\\n$`));

  const look = join(dir, "look.txt");
  assert.equal(meat(["-look", "-o", look], { input: fixture }).status, 0);
  assert.ok(readFileSync(look, "utf8").includes("+new ✓"));
  assert.doesNotMatch(readFileSync(look, "utf8"), /\x1b\[/);

  const capabilities = join(dir, "capabilities.json");
  assert.equal(meat(["-capabilities", "-o", capabilities]).status, 0);
  assert.equal(JSON.parse(readFileSync(capabilities, "utf8")).kind, "capabilities");

  const failed = meat(["-prompt", "-o", join(dir, "empty.md")], { input: " \n" });
  assert.equal(failed.status, 1);
  const missingDir = meat(["-prompt", "-o", join(dir, "no-such-dir", "x.md")], { input: fixture });
  assert.equal(missingDir.status, 1);
  assert.match(missingDir.stderr, /^meat: writing .*x\.md: /);
  assert.deepEqual(readdirSync(dir).sort(), ["capabilities.json", "look.txt", "review.md"]);
});

test("a reader that stops early ends meat quietly, as with meat -look HEAD | head", async () => {
  const big = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,200000 @@\n" + "+line\n".repeat(200_000);
  const child = spawn(process.execPath, [cli, "-look"], { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdin.end(big);
  await once(child.stdout, "data");
  child.stdout.destroy();
  const [code] = await once(child, "close") as [number | null];
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled/);
});

test("-doctor reports each workflow without printing credential values", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "meat doctor (test)-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(join(home, ".claude", "skills", "meat"), { recursive: true });
  const entry = resolve(checkout, "src", "cli", "main.ts").replaceAll("\\", "/");
  writeFileSync(join(home, ".claude", "skills", "meat", "SKILL.md"), `---\nname: meat\n---\nAbsolute CLI entry (JSON path): ${JSON.stringify(entry)}\n`);
  const fake = join(bin, process.platform === "win32" ? "codex.cjs" : "codex");
  writeFileSync(fake, `#!${process.execPath}\nif (process.argv.includes('status')) console.log(process.env.OPENAI_API_KEY ? 'leaked' : 'Logged in using ChatGPT');\nelse process.exit(3);\n`);
  chmodSync(fake, 0o755);
  if (process.platform === "win32") writeFileSync(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0codex.cjs" %*\r\n`);
  const gitPath = findExecutable("git", process.env);
  const searchPath = [bin, ...(gitPath === null ? [] : [dirname(gitPath)])].join(delimiter);
  const secret = "sk-test-doctor-secret-value";
  const result = meat(["-doctor"], { cwd: dir, env: cleanEnv({ PATH: searchPath, Path: searchPath, HOME: home, USERPROFILE: home, OPENAI_API_KEY: secret, MEAT_CACHE: "" }) });
  assert.equal(result.status, 0, result.stderr);
  const report = result.stdout;
  assert.doesNotMatch(report, new RegExp(secret));
  assert.match(report, /^meat doctor: .*No model call/);
  assert.match(report, /\n {2}ok {2}Node \d+\.\d+/);
  assert.match(report, /\n {2}no {2}Not inside a Git repository/);
  assert.match(report, /\n {2}ok {2}Claude Code skill: type \/meat HEAD/);
  assert.match(report, /\n {2}no {2}Codex skill not installed\n {6}Fix: npm run skill:install -- codex/);
  assert.match(report, /\n {2}ok {2}Codex subscription review: meat -agent codex HEAD/);
  if (findExecutable("claude", { PATH: searchPath }) === null) {
    assert.match(report, /\n {2}no {2}Claude subscription review: 'claude' CLI not found on PATH/);
  }
  assert.match(report, /\n {2}ok {2}API abridging \(meat HEAD\): model \S+ via OpenAI\n/);
  assert.match(report, /Result cache: disabled/);
});
