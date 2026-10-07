import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installMeatSkill, syncProjectSkills } from "../scripts/install-meat-skill.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const canonical = join(root, ".claude", "skills", "meat", "SKILL.md");

test("installed Codex/Claude skills locate this CLI from an unrelated repository without credentials", t => {
  const temporary = mkdtempSync(join(tmpdir(), "meat-skill-install-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const userRoot = join(temporary, "user with spaces 雪");
  const repo = join(temporary, "reviewed repo");
  const cache = join(temporary, "cache");
  mkdirSync(repo); mkdirSync(cache);
  const env = { ...process.env, MEAT_CACHE: cache,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", XAI_API_KEY: "",
    OPENAI_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", XAI_BASE_URL: "http://127.0.0.1:1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "change.txt"), "new behavior\n");
  git("add", "change.txt"); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "change");
  for (const host of ["codex", "claude"] as const) {
    const installed = installMeatSkill(host, userRoot);
    assert.equal(installed, join(userRoot, host === "codex" ? ".agents" : ".claude", "skills", "meat", "SKILL.md"));
    const text = readFileSync(installed, "utf8");
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(readFileSync(canonical, "utf8"))![0];
    assert.ok(text.startsWith(frontmatter));
    const skillMatch = /^Canonical skill \(JSON path\): (.+)$/m.exec(text);
    assert.ok(skillMatch);
    assert.deepEqual(readFileSync(JSON.parse(skillMatch[1]!)), readFileSync(canonical));
    assert.match(text, /Before selecting commands, read the canonical skill/);
    const pathMatch = /^Absolute CLI entry \(JSON path\): (.+)$/m.exec(text);
    assert.ok(pathMatch);
    const entry = JSON.parse(pathMatch[1]!);
    const result = spawnSync(process.execPath, [entry, "-prompt", "HEAD"], { cwd: repo, env, input: "ignored stdin", encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+new behavior/);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(readdirSync(cache), []);
});

test("installed launcher reads updated canonical instructions without reinstalling", t => {
  const temporary = mkdtempSync(join(tmpdir(), "meat-skill-live-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const meatRoot = join(temporary, "checkout with spaces");
  const canonicalPath = join(meatRoot, ".claude", "skills", "meat", "SKILL.md");
  mkdirSync(join(meatRoot, ".claude", "skills", "meat"), { recursive: true });
  const frontmatter = "---\nname: meat\ndescription: Explain changes\n---\n";
  writeFileSync(canonicalPath, frontmatter + "\nOld instructions\n");
  const installed = installMeatSkill("codex", join(temporary, "user"), meatRoot);
  const launcher = readFileSync(installed);
  const match = /^Canonical skill \(JSON path\): (.+)$/m.exec(launcher.toString("utf8"));
  assert.ok(match);
  writeFileSync(canonicalPath, frontmatter + "\nCurrent instructions\n");
  assert.equal(readFileSync(JSON.parse(match[1]!), "utf8"), frontmatter + "\nCurrent instructions\n");
  assert.deepEqual(readFileSync(installed), launcher);
  assert.doesNotMatch(launcher.toString("utf8"), /Old instructions/);
});

test("project synchronization replaces stale meat copies while preserving adjacent skills", t => {
  const temporary = mkdtempSync(join(tmpdir(), "meat-skill-sync-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  for (const host of [".claude", ".agents", ".grok"]) {
    mkdirSync(join(temporary, host, "skills", "meat"), { recursive: true });
    writeFileSync(join(temporary, host, "skills", "meat", "SKILL.md"), host === ".claude" ? readFileSync(canonical) : "outdated");
    mkdirSync(join(temporary, host, "skills", "other"));
    writeFileSync(join(temporary, host, "skills", "other", "SKILL.md"), "untouched");
  }
  syncProjectSkills(temporary);
  for (const host of [".agents", ".grok"]) {
    assert.deepEqual(readFileSync(join(temporary, host, "skills", "meat", "SKILL.md")), readFileSync(canonical));
    assert.equal(readFileSync(join(temporary, host, "skills", "other", "SKILL.md"), "utf8"), "untouched");
  }
});

test("installation refuses a personal skill junction without corrupting the canonical skill", t => {
  const temporary = mkdtempSync(join(tmpdir(), "meat-skill-junction-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const canonicalFolder = join(temporary, "checkout", ".claude", "skills", "meat");
  const userRoot = join(temporary, "user");
  const folder = join(userRoot, ".agents", "skills", "meat");
  mkdirSync(canonicalFolder, { recursive: true });
  mkdirSync(join(userRoot, ".agents", "skills"), { recursive: true });
  writeFileSync(join(canonicalFolder, "SKILL.md"), readFileSync(canonical));
  symlinkSync(canonicalFolder, folder, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => installMeatSkill("codex", userRoot, join(temporary, "checkout")), /linked skill directory/);
  assert.deepEqual(readFileSync(join(canonicalFolder, "SKILL.md")), readFileSync(canonical));
});

test("project synchronization replaces a discovery file link without writing through it", t => {
  const temporary = mkdtempSync(join(tmpdir(), "meat-skill-file-link-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const folder = join(temporary, ".claude", "skills", "meat");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), readFileSync(canonical));
  const destination = join(temporary, ".agents", "skills", "meat", "SKILL.md");
  mkdirSync(join(temporary, ".agents", "skills", "meat"), { recursive: true });
  const outside = join(temporary, "other-file.md");
  writeFileSync(outside, "untouched target");
  try { symlinkSync(outside, destination, "file"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks require host permission"); return; }
    throw error;
  }
  assert.throws(() => installMeatSkill("codex", temporary, temporary), /linked skill file/);
  syncProjectSkills(temporary);
  assert.equal(lstatSync(destination).isSymbolicLink(), false);
  assert.equal(readFileSync(outside, "utf8"), "untouched target");
});

test("invalid installer arguments fail before installing a user skill", () => {
  const script = join(root, "scripts", "install-meat-skill.ts");
  const result = spawnSync(process.execPath, [script, "not-a-host"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /codex\|claude\|all/);
});
