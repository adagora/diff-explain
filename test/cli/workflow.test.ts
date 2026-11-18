import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyColumboEnvironment } from "../../src/cli/brand.ts";
import { loadWorkflow } from "../../src/cli/workflow.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "src/cli/main.ts");
const run = (args: string[], cwd = root) => spawnSync(process.execPath, [cli, ...args], {
  cwd, encoding: "utf8", input: "", timeout: 5000,
  env: { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1", COLUMBO_MODEL: "unused", COLUMBO_CACHE: "" },
});

test("Prime loads only the local bootstrap and selected activity", async () => {
  const orientation = await loadWorkflow();
  assert.equal(orientation.activity, "orient");
  assert.deepEqual(orientation.resources, ["prime/README.md"]);
  for (const activity of ["understand", "work", "review", "audit", "converge"]) {
    const result = await loadWorkflow(activity);
    const shared = ["review", "audit", "converge"].includes(activity) ? ["prime/review-policy.md"] : [];
    assert.deepEqual(result.resources, ["prime/README.md", ...shared, ...(activity === "converge" ? ["prime/activities/work.md"] : []), `prime/activities/${activity}.md`]);
    assert.equal(result.execution, "current_session");
    assert.equal(result.model_called, false);
    assert.ok(result.instructions.endsWith(readFileSync(join(root, `prime/activities/${activity}.md`), "utf8")));
    assert.doesNotMatch(result.instructions, /raw\.githubusercontent\.com/);
    assert.deepEqual(await loadWorkflow(activity), result);
  }
});

test("Prime CLI works without Git or provider access and does not create files", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "columbo-prime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const args of [["prime", "--json"], ["prime", "work", "--json"], ["prime", "--json", "review"], ["prime", "audit", "--json"], ["prime", "converge", "--json"]]) {
    const result = run(args, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.command, "prime");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.kind, "columbo.workflow");
    assert.match(parsed.data.instructions, /columbo/);
    if (parsed.data.activity === "audit") assert.equal(parsed.data.scope, "repository");
    if (parsed.data.activity === "review") assert.equal(parsed.data.scope, "diff");
  }
  assert.deepEqual(readdirSync(cwd), []);
  const text = run(["prime", "understand"], cwd);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /# Understand/);
  assert.doesNotMatch(text.stdout, /^# Work$/m);
});

test("Prime rejects invalid, prototype, traversal and extra activity names", () => {
  for (const args of [
    ["prime", "unknown"], ["prime", "toString"], ["prime", "__proto__"],
    ["prime", "../README.md"], ["prime", "work", "review"], ["prime", "--bad"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.error.kind, "usage");
    assert.match(parsed.error.next_action, /columbo prime/);
    assert.equal(parsed.data, null);
  }
  for (const args of [["help", "prime"], ["prime", "--help"]]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /columbo prime/);
  }
});

test("columbo aliases override legacy config including empty values, preserving unrelated env", () => {
  const env = { COLUMBO_MODEL: "preferred", THREAD_MODEL: "thread", MEAT_MODEL: "legacy", COLUMBO_CACHE: "", THREAD_CACHE: "/thread", MEAT_CACHE: "/old", OPENAI_API_KEY: "fake", PATH: "/bin" };
  applyColumboEnvironment(env);
  assert.equal(env.MEAT_MODEL, "preferred");
  assert.equal(env.MEAT_CACHE, "");
  assert.equal(env.OPENAI_API_KEY, "fake");
  assert.equal(env.PATH, "/bin");
  const threadOnly = { THREAD_MODEL: "thread", MEAT_MODEL: "legacy", THREAD_CACHE: "/thread", MEAT_CACHE: "/old" };
  applyColumboEnvironment(threadOnly);
  assert.deepEqual(threadOnly, { THREAD_MODEL: "thread", MEAT_MODEL: "thread", THREAD_CACHE: "/thread", MEAT_CACHE: "/thread" });
  const legacyOnly = { MEAT_MODEL: "legacy", MEAT_CACHE: "/old" };
  applyColumboEnvironment(legacyOnly);
  assert.deepEqual(legacyOnly, { MEAT_MODEL: "legacy", MEAT_CACHE: "/old" });
});

test("columbo branding is discoverable while compatibility identifiers remain stable", () => {
  const result = run(["capabilities", "--json"]);
  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.product, "columbo");
  assert.equal(data.package_name, "columbo-review");
  assert.equal(data.compatibility_command, "meat");
  assert.equal(data.workflow.automatic_hooks, false);
  assert.equal(data.workflow.scopes.audit, "repository");
  assert.equal(data.workflow.scopes.review, "diff");
  assert.ok(data.offline_commands.includes("prime"));
  assert.ok(data.api_environment.includes("COLUMBO_MODEL"));
  assert.match(run(["--help"]).stderr, /columbo —/);
  assert.match(run(["guide"]).stdout, /columbo prime/);
});

test("columbo skill is shared across hosts and the distribution includes workflows", () => {
  const canonical = join(root, ".claude/skills/columbo/SKILL.md");
  const skill = readFileSync(canonical, "utf8");
  assert.match(skill, /^name: columbo$/m);
  assert.match(skill, /prime work --json/);
  assert.match(skill, /prime review --json/);
  for (const host of [".agents", ".grok"]) assert.equal(readFileSync(join(root, host, "skills/columbo/SKILL.md"), "utf8"), skill);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.name, "columbo-review");
  assert.equal(pkg.bin.columbo, pkg.bin.meat);
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["columbo", "meat"]);
  assert.ok(pkg.files.includes("prime/README.md"));
  assert.ok(pkg.files.includes("prime/activities"));
  assert.ok(pkg.files.includes("prime/review-policy.md"));
  assert.ok(pkg.files.includes("prime/provenance.json"));
  assert.ok(!pkg.files.includes("prime"));
  assert.ok(!pkg.files.includes("prime/references"));
  assert.ok(pkg.files.includes(".claude/skills/columbo"));
  assert.equal(lock.name, pkg.name);
  assert.deepEqual(Object.keys(lock.packages[""].bin).sort(), Object.keys(pkg.bin).sort());
});

test("Review policy has pinned provenance without loading upstream instructions", async () => {
  const provenance = JSON.parse(readFileSync(join(root, "prime/provenance.json"), "utf8"));
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.source, "https://github.com/fastxyz/pact");
  assert.ok(provenance.inspected_files.length >= 1);
  for (const source of provenance.inspected_files) assert.match(source.sha256, /^[a-f0-9]{64}$/);
  const audit = await loadWorkflow("audit");
  const review = await loadWorkflow("review");
  const converge = await loadWorkflow("converge");
  assert.equal(audit.scope, "repository");
  assert.equal(review.scope, "diff");
  assert.equal(converge.scope, "findings");
  for (const workflow of [audit, review, converge]) {
    assert.ok(workflow.resources.includes("prime/review-policy.md"));
    assert.ok(workflow.resources.every(path => !path.includes("references/") && !path.includes("provenance") && !path.includes("optional/")));
  }
});


test("Compatibility fixing uses the implementation procedure without an automatic loop", async () => {
  const work = await loadWorkflow("work");
  const converge = await loadWorkflow("converge");
  assert.ok(converge.instructions.includes(readFileSync(join(root, "prime/activities/work.md"), "utf8")));
  assert.match(work.instructions, /complete root AGENTS.md and README.md/);
  assert.match(work.instructions, /There is no default/);
  assert.doesNotMatch(converge.instructions, /default cap of three|default cap is three/);
  assert.match((await loadWorkflow()).next_action, /implementation or fixes/);
});


test("Statechart guidance is packaged and discoverable without a new activity or eager loading", async () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("prime/optional"));
  const guide = readFileSync(join(root, "prime/optional/statecharts.md"), "utf8");
  assert.ok(guide.length > 0);
  for (const activity of [undefined, "work", "review", "understand", "audit", "converge"]) {
    const result = await loadWorkflow(activity);
    assert.match(result.instructions, /optional\/statecharts\.md/);
    assert.ok(!result.resources.includes("prime/optional/statecharts.md"));
    assert.ok(!result.instructions.includes(guide));
  }
  await assert.rejects(loadWorkflow("statechart"), /Unknown columbo activity/);
});
