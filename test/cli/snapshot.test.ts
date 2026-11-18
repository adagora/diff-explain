import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON, collectSnapshot, hashBytes, SnapshotError } from "../../src/cli/snapshot.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
function repo(t: { after: (fn: () => void) => void }): string {
  const cwd = mkdtempSync(join(tmpdir(), "meat-snapshot-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "core.autocrlf", "false");
  return cwd;
}
function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}
function commit(cwd: string, content: string, message = "change"): string {
  writeFileSync(join(cwd, "file.txt"), content);
  git(cwd, "add", "file.txt");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").toString().trim();
}

test("canonical encoding sorts nested keys and preserves Unicode and JSON primitives", () => {
  assert.equal(canonicalJSON({ z: [null, true, 3, "żółć\r\n"], a: { y: 2, x: 1 } }),
    '{"a":{"x":1,"y":2},"z":[null,true,3,"żółć\\r\\n"]}');
  assert.equal(hashBytes(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => canonicalJSON(undefined), SnapshotError);
  assert.throws(() => canonicalJSON(NaN), SnapshotError);
});

test("root and ordinary commit snapshots retain exact bytes and stable descriptor identity", async t => {
  const cwd = repo(t);
  const root = commit(cwd, "żółć\r\n");
  const first = await collectSnapshot(["HEAD"], false, false, { cwd });
  assert.equal(first.source.kind, "commit");
  assert.equal(first.source['parent'], null);
  assert.equal(first.context.before_tree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.equal(first.context.after_tree, git(cwd, "rev-parse", root + "^{tree}").toString().trim());
  assert.match(Buffer.from(first.diff).toString(), /\+żółć\r\n/);
  const explicit = await collectSnapshot([root], false, false, { cwd });
  assert.equal(first.id, explicit.id);
  assert.equal(first.input_digest, hashBytes(first.diff));
  const descriptor = { version: 1, input_digest: first.input_digest, source: first.source, context: first.context };
  assert.equal(first.id, hashBytes(Buffer.from(canonicalJSON(descriptor))));
  commit(cwd, "next\n");
  const second = await collectSnapshot(["HEAD"], false, false, { cwd });
  assert.equal(second.source['parent'], root);
  assert.equal(second.context.consistency, "immutable");
  assert.notEqual(first.id, second.id);
});

test("checkout locations and equivalent selectors do not affect snapshot identity", async t => {
  const cwd = repo(t);
  const oid = commit(cwd, "root\n");
  const other = repo(t);
  git(other, "fetch", "-q", cwd, "main");
  git(other, "checkout", "-q", "FETCH_HEAD");
  const a = await collectSnapshot(["HEAD"], false, false, { cwd });
  const b = await collectSnapshot([oid], false, false, { cwd: other });
  assert.equal(a.id, b.id);
  assert.notEqual(a.observations.repository, b.observations.repository);
});

test("two-dot and three-dot ranges bind actual endpoints and unique merge base", async t => {
  const cwd = repo(t);
  const root = commit(cwd, "root\n");
  git(cwd, "checkout", "-q", "-b", "topic");
  const right = commit(cwd, "topic\n");
  git(cwd, "checkout", "-q", "main");
  const left = commit(cwd, "main\n");
  const two = await collectSnapshot(["main..topic"], false, false, { cwd });
  assert.equal(two.source['form'], "two_dot");
  assert.equal(two.source['left_commit'], left);
  assert.equal(two.source['right_commit'], right);
  assert.match(Buffer.from(two.diff).toString(), /-main\n\+topic/);
  const three = await collectSnapshot(["main...topic"], false, false, { cwd });
  assert.equal(three.source['form'], "three_dot");
  assert.equal(three.source['merge_base'], root);
  assert.match(Buffer.from(three.diff).toString(), /-root\n\+topic/);
  const same = await collectSnapshot([left + "..." + right], false, false, { cwd });
  assert.equal(three.id, same.id);
});

test("merge commit compares its first parent rather than combined diff", async t => {
  const cwd = repo(t);
  commit(cwd, "root\n");
  git(cwd, "checkout", "-q", "-b", "topic");
  writeFileSync(join(cwd, "topic.txt"), "topic\n");
  git(cwd, "add", "topic.txt");
  git(cwd, "commit", "-q", "-m", "topic");
  git(cwd, "checkout", "-q", "main");
  const parent = commit(cwd, "main\n");
  git(cwd, "merge", "-q", "--no-ff", "topic", "-m", "merge");
  const result = await collectSnapshot(["HEAD"], false, false, { cwd });
  assert.equal(result.source['parent'], parent);
  assert.match(Buffer.from(result.diff).toString(), /diff --git a\/topic.txt b\/topic.txt/);
  assert.doesNotMatch(Buffer.from(result.diff).toString(), /diff --cc/);
});

test("a ref changing after resolution cannot change committed evidence", async t => {
  const cwd = repo(t);
  const old = commit(cwd, "old\n");
  const newer = commit(cwd, "new\n");
  git(cwd, "update-ref", "refs/heads/main", old);
  let changed = false;
  const result = await collectSnapshot(["main"], false, false, { cwd, git: args => {
    const bytes = git(cwd, ...args);
    if (args[0] === "rev-parse" && args.includes("main^{commit}")) {
      git(cwd, "update-ref", "refs/heads/main", newer);
      changed = true;
    }
    return bytes;
  } });
  assert.ok(changed);
  assert.equal(result.source['commit'], old);
  assert.match(Buffer.from(result.diff).toString(), /\+old/);
  assert.doesNotMatch(Buffer.from(result.diff).toString(), /\+new/);
});

test("mutable diffs retain evidence but mark context unavailable and leave index/worktree untouched", async t => {
  const cwd = repo(t);
  commit(cwd, "old\n");
  writeFileSync(join(cwd, "file.txt"), "staged\n");
  git(cwd, "add", "file.txt");
  writeFileSync(join(cwd, "file.txt"), "working\n");
  writeFileSync(join(cwd, "untracked.txt"), "excluded\n");
  const index = readFileSync(join(cwd, ".git", "index"));
  const working = readFileSync(join(cwd, "file.txt"));
  const staged = await collectSnapshot([], true, false, { cwd });
  const worktree = await collectSnapshot([], false, true, { cwd });
  assert.match(Buffer.from(staged.diff).toString(), /-old\n\+staged/);
  assert.match(Buffer.from(worktree.diff).toString(), /-staged\n\+working/);
  for (const result of [staged, worktree]) {
    assert.equal(result.context.availability, "unavailable");
    assert.equal(result.context.consistency, "unverified");
    assert.equal(result.context.after_tree, null);
    assert.doesNotMatch(Buffer.from(result.diff).toString(), /untracked.txt/);
    assert.match(String(result.source['index_digest']), /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  assert.deepEqual(readFileSync(join(cwd, "file.txt")), working);
});

test("unborn staged input uses the explicit empty tree", async t => {
  const cwd = repo(t);
  writeFileSync(join(cwd, "file.txt"), "new\n");
  git(cwd, "add", "file.txt");
  const result = await collectSnapshot([], true, false, { cwd });
  assert.equal(result.source['base_commit'], null);
  assert.equal(result.source['base_tree'], "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.match(Buffer.from(result.diff).toString(), /\+new/);
});

test("persistent mutable races fail after bounded comparisons", async t => {
  const cwd = repo(t);
  commit(cwd, "old\n");
  let diffs = 0;
  await assert.rejects(collectSnapshot([], false, true, { cwd, git: args => {
    if (args[0] === "diff") {
      writeFileSync(join(cwd, "file.txt"), String(++diffs) + "\n");
    }
    return git(cwd, ...args);
  } }), (error: unknown) => error instanceof SnapshotError && error.code === "source_changed");
  assert.equal(diffs, 4);
});

test("one transient mutable race is recollected with an unverified consistency label", async t => {
  const cwd = repo(t);
  commit(cwd, "old\n");
  let diffs = 0;
  const result = await collectSnapshot([], false, true, { cwd, git: args => {
    if (args[0] === "diff" && ++diffs <= 2) writeFileSync(join(cwd, "file.txt"), String(diffs) + "\n");
    return git(cwd, ...args);
  } });
  assert.equal(diffs, 4);
  assert.equal(result.context.consistency, "unverified");
  assert.match(Buffer.from(result.diff).toString(), /\+2\n/);
  assert.equal(Object.hasOwn(result.source, "index_entries"), false);
});

test("configured diff presentation and external helpers cannot alter committed evidence", async t => {
  const cwd = repo(t);
  commit(cwd, "old\n");
  commit(cwd, "new\n");
  const expected = await collectSnapshot(["HEAD"], false, false, { cwd });
  const configs = { "diff.external": "missing-external-command", "diff.algorithm": "histogram",
    "diff.noprefix": "true", "diff.mnemonicPrefix": "true", "diff.interHunkContext": "30",
    "diff.outputIndicatorNew": "X", "diff.outputIndicatorOld": "Y", "diff.outputIndicatorContext": "Z",
    "diff.orderFile": "missing-order-file", "color.diff": "always", "core.quotePath": "false" };
  for (const [key, value] of Object.entries(configs)) git(cwd, "config", key, value);
  const actual = await collectSnapshot(["HEAD"], false, false, { cwd });
  assert.deepEqual(actual.diff, expected.diff);
  assert.equal(actual.id, expected.id);
});

test("stdin bytes have unknown provenance and never probe or inherit cwd", async () => {
  const raw = Buffer.from([0, 255, 13, 10, 195, 169]);
  const result = await collectSnapshot([], false, false, { cwd: "missing", stdinIsPiped: () => true,
    readAllStdin: async () => raw, git: () => { throw new Error("must not run Git"); } });
  assert.deepEqual(result.diff, new Uint8Array(raw));
  assert.equal(result.observations.repository, null);
  assert.equal(result.context.reason, "stdin_provenance_unknown");
  assert.equal(result.source.kind, "stdin");
  const digest = result.input_digest;
  raw[0] = 1;
  assert.equal(hashBytes(result.diff), digest);
});

test("invalid selections fail before collecting input", async () => {
  for (const [args, staged, worktree] of [[[], true, true], [["HEAD"], true, false], [["a", "b"], false, false]] as const) {
    await assert.rejects(collectSnapshot(args, staged, worktree),
      (error: unknown) => error instanceof SnapshotError && error.code === "invalid_request");
  }
});
