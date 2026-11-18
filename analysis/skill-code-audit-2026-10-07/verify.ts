// Reproduce this audit without live models or personal configuration writes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionEnv } from "../../src/cli/agent.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const artifact = fileURLToPath(new URL("results.json", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = readFileSync(join(root, ".claude/skills/meat/SKILL.md"));
const env = { ...subscriptionEnv(process.env), MEAT_MODEL: "" };

function command(program: string, args: string[], shell = false) {
  const run = spawnSync(program, args, { cwd: root, env, shell, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const output = (run.stdout ?? "") + (run.stderr ?? "");
  const counts: Record<string, number> = {};
  for (const [, name, value] of output.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) counts[name!] = Number(value);
  return { command: [program, ...args], exit: run.status, error: run.error?.message ?? null, counts,
    summary: output.split(/\r?\n/).filter(line => /^not ok |^# (tests|pass|fail|skipped)|error TS/.test(line)) };
}

const identities = [
  ".claude/skills/meat/SKILL.md", ".agents/skills/meat/SKILL.md", ".grok/skills/meat/SKILL.md",
  ".claude/skills/show-me/SKILL.md", ".agents/skills/show-me/SKILL.md", ".grok/skills/show-me/SKILL.md",
  "scripts/install-meat-skill.ts", "src/cli/main.ts", "src/cli/agent.ts", "src/cli/prompt.ts",
  "src/cli/snapshot.ts", "src/cli/observe.ts", "src/cli/cache.ts", "src/meat/provider.ts",
  "src/meat/meat.ts", "src/meat/rubric.ts", "test/skill.test.ts", "test/skill-install.test.ts",
  "test/cli/skill-contract.test.ts", "test/cli/agent.test.ts", "test/cli/observe.test.ts", "test/cli/snapshot.test.ts",
  ".gitattributes", "package.json", "test/fixture-checkout.test.ts", "test/cli/main.test.ts",
  "test/cli/prompt.test.ts", "test/cli/stdin.test.ts", "test/cli/render.test.ts",
].map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; });

for (const host of [".agents", ".grok"]) {
  assert.deepEqual(readFileSync(join(root, host, "skills/meat/SKILL.md")), canonical);
  assert.deepEqual(readFileSync(join(root, host, "skills/show-me/SKILL.md")), readFileSync(join(root, ".claude/skills/show-me/SKILL.md")));
}
const personal = [".agents", ".claude"].map(host => {
  const path = join(homedir(), host, "skills/meat/SKILL.md");
  try {
    const text = readFileSync(path, "utf8");
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(canonical.toString("utf8"))![0];
    assert.ok(text.startsWith(frontmatter), `${host} personal meat discovery metadata is stale`);
    const skill = /^Canonical skill \(JSON path\): (.+)$/m.exec(text);
    assert.ok(skill, `${host} personal meat launcher lacks its canonical binding`);
    assert.equal(JSON.parse(skill[1]!), join(root, ".claude/skills/meat/SKILL.md").replaceAll("\\", "/"));
    assert.deepEqual(readFileSync(JSON.parse(skill[1]!)), canonical);
    assert.match(text, /Before selecting commands, read the canonical skill/);
    const match = /^Absolute CLI entry \(JSON path\): (.+)$/m.exec(text);
    assert.ok(match, `${host} personal meat skill lacks its CLI binding`);
    assert.equal(JSON.parse(match[1]!), join(root, "src/cli/main.ts").replaceAll("\\", "/"));
    return { host, present: true, sha256: hash(Buffer.from(text)), canonical_binding_matches: true, metadata_matches: true, entry_matches: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { host, present: false };
    throw error;
  }
});
const focused = command(process.execPath, ["--test", "test/skill.test.ts", "test/skill-install.test.ts", "test/cli/skill-contract.test.ts", "test/cli/observe.test.ts", "test/cli/snapshot.test.ts", "test/fixture-checkout.test.ts"]);
const auth = command(process.execPath, ["--test", "test/cli/agent.test.ts"]);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const build = command(npm, ["run", "build"], process.platform === "win32");
const full = command(npm, ["run", "check"], process.platform === "win32");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const fileTypes = spawnSync("git", ["ls-files", "--stage", "--", ".agents/skills/show-me/SKILL.md", ".grok/skills/show-me/SKILL.md"], { cwd: root, encoding: "utf8" }).stdout.trim();
assert.equal(fileTypes.split(/\r?\n/).length, 2);
assert.ok(fileTypes.split(/\r?\n/).every(line => line.startsWith("100644 ")), "Discovery files must be recorded as regular Markdown");
const fixturePaths = spawnSync("git", ["ls-files", "-z", "--", "conformance/vectors", "testdata/python", "analysis"], { cwd: root, encoding: "utf8" }).stdout.split("\0")
  .filter(path => path && (path.startsWith("conformance/vectors/") || /^testdata\/python\/[^/]+\.diff$/.test(path) || /\.(original|live)\.diff$/.test(path)));
const fixtureIdentity = fixturePaths.map(path => {
  const committed = spawnSync("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(committed.status, 0, `Cannot read committed fixture ${path}`);
  const current = readFileSync(join(root, path));
  assert.deepEqual(current, committed.stdout, `Frozen fixture ${path} changed from committed bytes`);
  return { path, bytes: current.length, sha256: hash(current), unchanged_from_head: true };
});
const result = { schema: "meat.skill-code-audit", version: 2, checked_at: new Date().toISOString(), git_head: head,
  source_identity: identities, project_discovery_matches: true, personal, checks: { focused, auth, build, full },
  focused_checks_passed: focused.exit === 0 && auth.exit === 0,
  build_passed: build.exit === 0, full_suite_passed: full.exit === 0,
  recorded_file_types: fileTypes, frozen_fixture_identity: fixtureIdentity, live_model_calls: 0, live_subscription_reviews: 0,
  limits: ["Skill selection and explanations remain model decisions, not deterministic compiler execution.",
    "Subscription process tests use local fake CLI shims; no live account authentication is performed.",
    "The installed launcher requires this checkout; discovery metadata or checkout moves require reinstallation."] };
writeFileSync(artifact, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ artifact, focused: focused.counts, auth: auth.counts, build: build.exit, full: full.counts, full_exit: full.exit, live_model_calls: 0 }, null, 2));
if (!result.focused_checks_passed || !result.build_passed || !result.full_suite_passed) process.exitCode = 1;
