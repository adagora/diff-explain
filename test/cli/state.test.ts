import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "columbo-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
  const invoke = (args: string[], cwd = root) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 10000 });
    assert.equal(r.stderr, "");
    return { exit: r.status, ...JSON.parse(r.stdout) };
  };
  const record = (data: unknown) => {
    writeFileSync(join(root, "input.json"), JSON.stringify(data));
    return invoke(["record", "--file", "input.json"]);
  };
  const intent = { kind: "intent", id: "retry", actor: "agent", goal: "Fix retry behavior", criteria: ["Validation failures are not retried"] };
  return { root, invoke, record, intent };
}

test("status observes an unborn repository without creating state, and works in subdirectories", t => {
  const { root, invoke } = fixture(t);
  const result = invoke(["status", "--json"]);
  assert.equal(result.exit, 0);
  assert.equal(result.data.head, null);
  assert.deepEqual(result.data.tasks, []);
  assert.match(result.data.git_status_porcelain_v1, /source.ts/);
  assert.equal(existsSync(join(root, ".git", "columbo-state-v1")), false);
  mkdirSync(join(root, "nested"));
  assert.equal(invoke(["status"], join(root, "nested")).data.repository, result.data.repository);
  execFileSync("git", ["-C", root, "add", "source.ts"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", root, "checkout", "--detach", "-q"]);
  const detached = invoke(["status"]);
  assert.equal(detached.exit, 0);
  assert.equal(detached.data.branch, null);
  assert.match(detached.data.head, /^[a-f0-9]{40,64}$/);
});

test("evidence is attributed, immutable, and detects changed and unavailable supporting files", t => {
  const { root, invoke, record, intent } = fixture(t);
  assert.equal(record(intent).data.created, true);
  assert.equal(record(intent).data.created, false);
  assert.equal(record({ ...intent, goal: "different" }).error.kind, "record_conflict");
  const sources = invoke(["snapshot", "--file", "source.ts"]).data.sources;
  const evidence = { kind: "evidence", id: "inspection", actor: "agent", task: "retry", claim: "The implementation exports value", basis: "source", sources, limits: ["Callers were not inspected"] };
  assert.equal(record(evidence).exit, 0);
  let status = invoke(["status", "--task", "retry"]).data;
  assert.equal(status.evidence[0].freshness, "supporting_inputs_unchanged");
  assert.equal(status.evidence[0].verified_by_columbo, false);
  assert.equal(status.evidence[0].claim, undefined);
  assert.equal(invoke(["status", "--details"]).data.evidence[0].claim, evidence.claim);
  writeFileSync(join(root, "unrelated.txt"), "unrelated");
  assert.equal(invoke(["status"]).data.evidence[0].freshness, "supporting_inputs_unchanged");
  writeFileSync(join(root, "source.ts"), "export const value = 2;\n");
  status = invoke(["status"]).data;
  assert.equal(status.evidence[0].freshness, "needs_recheck");
  assert.equal(status.next_actions[0].action, "reinspect");
  assert.equal(record({ ...evidence, id: "stale" }).error.kind, "source_mismatch");
  rmSync(join(root, "source.ts"));
  assert.equal(invoke(["status"]).data.evidence[0].source_status[0].status, "unavailable");
  assert.equal(readFileSync(join(root, ".git", "columbo-state-v1", "inspection.json"), "utf8").includes('"verified_by_columbo":true'), false);
});

test("decisions preserve history, resolve questions, and expose competing answers", t => {
  const { invoke, record, intent } = fixture(t);
  record(intent);
  const question = { kind: "decision", id: "deadline", actor: "agent", task: "retry", question: "Preserve response deadline?", answer: null };
  assert.equal(record(question).exit, 0);
  assert.deepEqual(invoke(["status"]).data.unresolved_decisions, ["deadline"]);
  assert.equal(record({ ...question, id: "answer", actor: "human-reported-by-agent", answer: "Preserve deadline", supersedes: "deadline" }).exit, 0);
  assert.deepEqual(invoke(["status"]).data.unresolved_decisions, []);
  record({ ...question, id: "other-answer", answer: "Extend deadline", supersedes: "deadline" });
  const status = invoke(["status"]).data;
  assert.equal(status.decisions.length, 2);
  assert.equal(status.omitted.superseded_decisions, 1);
  assert.equal(invoke(["status", "--details"]).data.decisions.length, 3);
  assert.deepEqual(status.decision_conflicts, ["deadline"]);
  assert.equal(record({ ...question, id: "bad", supersedes: "retry" }).error.kind, "record_reference");
});

test("malformed records, unknown tasks, path escapes, and symlinks fail without replacing state", t => {
  const { root, invoke, record, intent } = fixture(t);
  assert.equal(record({ ...intent, surprise: true }).error.kind, "invalid_record");
  assert.equal(record({ ...intent, id: "../escape" }).error.kind, "invalid_record");
  assert.equal(record({ ...intent, goal: "界".repeat(6000) }).error.kind, "invalid_record");
  assert.equal(invoke(["status", "--task", "missing"]).error.kind, "record_reference");
  assert.equal(invoke(["snapshot", "--file", "../outside"]).error.kind, "source_path");
  symlinkSync(join(root, "source.ts"), join(root, "alias.ts"));
  assert.equal(invoke(["snapshot", "--file", "alias.ts"]).error.kind, "source_path");
  assert.equal(invoke(["record"]).exit, 2);
  assert.equal(invoke(["status", "--typo"]).exit, 2);
  assert.equal(existsSync(join(root, ".git", "columbo-state-v1")), false);
  symlinkSync(root, join(root, ".git", "columbo-state-v1"));
  assert.equal(record(intent).error.kind, "state_invalid");
});

test("reported checks remain assertions and corrupt records fail visibly", t => {
  const { root, invoke, record, intent } = fixture(t);
  record(intent);
  const sources = invoke(["snapshot", "--file", "source.ts"]).data.sources;
  record({ kind: "evidence", id: "test-result", actor: "agent", task: "retry", claim: "Tests passed", basis: "reported_check", sources, limits: ["Execution was not captured by columbo"] });
  assert.equal(invoke(["status"]).data.evidence[0].verified_by_columbo, false);
  writeFileSync(join(root, ".git", "columbo-state-v1", "test-result.json"), "{");
  const result = invoke(["status"]);
  assert.equal(result.exit, 1);
  assert.equal(result.error.kind, "invalid_record");
});


test("concurrent writers publish one complete immutable record", async t => {
  const { root, invoke, intent } = fixture(t);
  const paths = ["first.json", "second.json"];
  paths.forEach((path, index) => writeFileSync(join(root, path), JSON.stringify({ ...intent, goal: `Goal ${index}` })));
  const results = await Promise.all(paths.map(path => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "record", "--file", path], { cwd: root });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout }));
  })));
  assert.deepEqual(results.map(item => item.code).sort(), [0, 1]);
  const failed = results.find(item => item.code === 1)!;
  assert.equal(JSON.parse(failed.stdout).error.kind, "record_conflict");
  assert.equal(invoke(["status"]).data.tasks.length, 1);
});

test("linked worktrees have independent records", t => {
  const { root, invoke, record, intent } = fixture(t);
  execFileSync("git", ["-C", root, "add", "source.ts"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"]);
  record(intent);
  const linked = join(root, "linked");
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", "-q", linked]);
  assert.deepEqual(invoke(["status"], linked).data.tasks, []);
  writeFileSync(join(linked, "input.json"), JSON.stringify({ ...intent, id: "linked-task" }));
  assert.equal(invoke(["record", "--file", "input.json"], linked).exit, 0);
  assert.equal(invoke(["status"], linked).data.tasks[0].id, "linked-task");
  assert.equal(invoke(["status"]).data.tasks[0].id, "retry");
});


test("record schema is discoverable and available outside Git without writes", t => {
  const root = mkdtempSync(join(tmpdir(), "columbo-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, "record-schema", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.schema.oneOf.length, 3);
  assert.equal(data.schema.oneOf[0].properties.kind.const, "intent");
  assert.equal(data.schema.oneOf[0].additionalProperties, false);
  assert.equal(existsSync(join(root, ".git")), false);
});
