import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../../src/cli/setup.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "src/cli/main.ts");
const run = (args: string[], cwd: string) => spawnSync(process.execPath, [cli, "setup", ...args], {
  cwd, encoding: "utf8", timeout: 10_000,
  env: { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1" },
});

function temporary(t: { after: (fn: () => void) => void }): string {
  const path = mkdtempSync(join(tmpdir(), "columbo-setup-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("setup defaults to a read-only preview of both hosts in the current project", (t) => {
  const project = temporary(t);
  const result = run([], project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.command, "setup");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.mode, "preview");
  assert.equal(parsed.data.ready, true);
  assert.equal(parsed.data.files.length, 6);
  assert.ok(parsed.data.files.every((file: { action: string }) => file.action === "create"));
  assert.match(parsed.data.next_action, /--yes$/);
  assert.deepEqual(readdirSync(project), []);
});

test("apply installs usable Codex skills and repeated setup preserves bytes and mtimes", (t) => {
  const project = temporary(t);
  writeFileSync(join(project, "AGENTS.md"), "Keep my project rules.\n");
  const first = run(["--agent", "codex", "--yes"], project);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const data = JSON.parse(first.stdout).data;
  assert.equal(data.created.length, 3);
  assert.equal(existsSync(join(project, ".claude")), false);
  const path = join(project, ".agents/skills/columbo/SKILL.md");
  const before = readFileSync(path, "utf8");
  const mtime = statSync(path).mtimeMs;
  assert.match(before, /^---\nname: columbo\n/);
  assert.ok(before.includes(data.launcher));
  assert.ok(existsSync(join(project, ".agents/skills/meat/SKILL.md")));
  assert.ok(existsSync(join(project, ".agents/skills/show-me/SKILL.md")));
  assert.equal(readFileSync(join(project, ".agents/skills/show-me/SKILL.md"), "utf8"), readFileSync(join(root, ".claude/skills/show-me/SKILL.md"), "utf8"));
  const loaded = spawnSync("/bin/sh", ["-c", data.launcher + " prime audit --json"], { cwd: project, encoding: "utf8", timeout: 5000 });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).data.scope, "repository");
  const again = run(["codex", "--yes", "--json"], project);
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(again.stdout).data.created, []);
  assert.ok(JSON.parse(again.stdout).data.files.every((file: { action: string }) => file.action === "unchanged"));
  assert.equal(statSync(path).mtimeMs, mtime);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "Keep my project rules.\n");
});

test("setup accepts explicit projects with spaces, quotes and shell metacharacters", (t) => {
  const base = temporary(t);
  const project = join(base, "project ' $(not-a-command)");
  mkdirSync(project);
  const preview = run(["--project", project, "--agent=claude", "--dry-run"], base);
  assert.equal(preview.status, 0, preview.stderr);
  const data = JSON.parse(preview.stdout).data;
  assert.equal(data.project, realpathSync(project));
  const command = data.next_action.replace(/^columbo /, `${shellQuote(process.execPath)} ${shellQuote(cli)} `);
  const applied = spawnSync("/bin/sh", ["-c", command], { cwd: base, encoding: "utf8", timeout: 10_000 });
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.equal(JSON.parse(applied.stdout).data.created.length, 3);
  assert.ok(existsSync(join(project, ".claude/skills/columbo/SKILL.md")));
  assert.equal(existsSync(join(project, ".agents")), false);
});

test("conflicts block all writes and preserve existing skills", (t) => {
  const project = temporary(t);
  const path = join(project, ".agents/skills/columbo/SKILL.md");
  mkdirSync(join(project, ".agents/skills/columbo"), { recursive: true });
  writeFileSync(path, "My own columbo skill.\n");
  const preview = run(["--dry-run"], project);
  assert.equal(preview.status, 0);
  assert.equal(JSON.parse(preview.stdout).data.ready, false);
  assert.equal(JSON.parse(preview.stdout).data.files[0].action, "conflict");
  const applied = run(["--yes"], project);
  assert.equal(applied.status, 1);
  const error = JSON.parse(applied.stdout).error;
  assert.equal(error.kind, "setup_conflict");
  assert.match(error.message, /Nothing was written/);
  assert.equal(readFileSync(path, "utf8"), "My own columbo skill.\n");
  assert.equal(existsSync(join(project, ".claude")), false);
  assert.equal(existsSync(join(project, ".agents/skills/meat")), false);
});

test("setup applies both host layouts with matching sibling skills", (t) => {
  const project = temporary(t);
  const result = run(["--yes"], project);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).data.created.length, 6);
  for (const skill of ["columbo", "meat", "show-me"]) {
    const codex = readFileSync(join(project, ".agents/skills", skill, "SKILL.md"));
    const claude = readFileSync(join(project, ".claude/skills", skill, "SKILL.md"));
    assert.deepEqual(codex, claude);
  }
});

test("setup refuses symlinked parent directories and custom or dangling leaf symlinks", (t) => {
  for (const mode of ["parent", "leaf", "dangling"]) {
    const project = temporary(t);
    const outside = temporary(t);
    writeFileSync(join(outside, "custom.md"), "Outside file.\n");
    if (mode === "parent") symlinkSync(outside, join(project, ".agents"), "dir");
    else {
      mkdirSync(join(project, ".agents/skills/columbo"), { recursive: true });
      symlinkSync(join(outside, mode === "leaf" ? "custom.md" : "missing.md"), join(project, ".agents/skills/columbo/SKILL.md"));
    }
    const result = run(["codex", "--yes"], project);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.kind, "setup_conflict");
    assert.deepEqual(readdirSync(outside), ["custom.md"]);
    assert.equal(readFileSync(join(outside, "custom.md"), "utf8"), "Outside file.\n");
  }
});

test("the source checkout's own bundled skills are recognized without rewriting symlinks", () => {
  const result = run(["--dry-run"], root);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.ready, true);
  assert.ok(data.files.every((file: { action: string }) => file.action === "bundled"));
  assert.deepEqual(data.created, []);
});

test("setup usage and inaccessible projects return actionable JSON", (t) => {
  const project = temporary(t);
  for (const args of [
    ["--agent", "unknown"], ["--agent"], ["--project"],
    ["--agent", "codex", "claude"], ["--yes", "--dry-run"],
    ["--agent=codex", "--agent=claude"], ["--force"], ["--json=false"],
  ]) {
    const result = run(args, project);
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).error.kind, "usage");
    assert.match(JSON.parse(result.stdout).error.next_action, /columbo setup/);
  }
  const missing = run(["--project", join(project, "missing")], project);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).error.kind, "setup_path");
  assert.deepEqual(readdirSync(project), []);
  const help = run(["--help"], project);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /columbo setup/);
});
