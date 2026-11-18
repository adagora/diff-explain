import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createPacket, compilePacket, envelope, BridgeError } from "../../src/cli/bridge.ts";
import { compileSubmission } from "../../src/meat/editplan.ts";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const fixture = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+żółć";
const packet = () => envelope("packet", createPacket(encodeUTF8(fixture), "stdin"));
const plan = () => createPacket(encodeUTF8(fixture), "stdin").plan_template;
const offlineEnv = { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", XAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1", MEAT_CACHE: "" };
const invoke = (args: string[], input = "", cwd?: string) => spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", env: offlineEnv, timeout: 10_000, ...(cwd ? { cwd } : {}) });

test("packet is deterministic, byte-exact, numbered, and self-describing", () => {
  const p = packet();
  assert.deepEqual(p, packet());
  assert.equal(p.data.input.diff, fixture);
  assert.equal(p.data.input.bytes, Buffer.byteLength(fixture));
  assert.match(p.data.numbered_diff, /6\|\+żółć\n$/);
  assert.deepEqual(p.data.shape, { adds: 1, deletes: 1, context: 0, lines: 6 });
  assert.equal(p.data.file_sections[0]?.start_line, 1);
  assert.ok(p.data.plan_schema);
  assert.match(p.data.selection_rubric, /code-reading assistant/);
  assert.doesNotMatch(p.data.instructions, /Call preview_plan/);
});

test("bridge uses the production compiler and discloses its guarantees", () => {
  const result = compilePacket(packet(), plan());
  const expected = compileSubmission(encodeUTF8(fixture), { remove: [], replace: [], fold: [], summary: plan().summary });
  assert.equal(result.smart_diff, decodeUTF8(expected.smartDiff));
  assert.deepEqual(result.stats, expected.stats);
  assert.equal(result.guarantees.transformation_validated, true);
  assert.equal(result.guarantees.semantic_completeness_verified, false);
  assert.equal(result.guarantees.tests_run, false);
  assert.deepEqual(compilePacket(packet(), plan()), result);
});

test("snapshot text preserves BOM, CRLF, Unicode and missing final newlines", () => {
  for (const text of ["\ufeffcommit message\n" + fixture, fixture.replaceAll("\n", "\r\n"), fixture + "\n"]) {
    const p = createPacket(encodeUTF8(text), "stdin");
    assert.equal(p.input.diff, text);
    assert.equal(Buffer.byteLength(p.input.diff), p.input.bytes);
    const result = compilePacket(envelope("packet", p), p.plan_template);
    const expected = compileSubmission(encodeUTF8(text), { remove: [], replace: [], fold: [], summary: p.plan_template.summary });
    assert.deepEqual(Buffer.from(result.smart_diff), Buffer.from(expected.smartDiff));
  }
});

test("reject stale, tampered, incompatible, and unsupported snapshots before compilation", () => {
  const cases: [unknown, unknown, string][] = [];
  const changed = packet(); changed.data.input.diff += "\n";
  const wrongCount = packet(); wrongCount.data.input.bytes++;
  const wrongNumbering = packet(); wrongNumbering.data.numbered_diff = "1|fabricated";
  const oldCompiler = packet(); oldCompiler.data.compiler.rubric_hash = "old";
  const oldVersion = packet(); oldVersion.data.schema_version = 2;
  cases.push([changed, plan(), "packet_integrity"], [wrongCount, plan(), "packet_integrity"], [wrongNumbering, plan(), "packet_integrity"], [oldCompiler, plan(), "compiler_mismatch"], [oldVersion, plan(), "unsupported_packet"], [packet(), { ...plan(), input_sha256: "0".repeat(64) }, "snapshot_mismatch"]);
  for (const [p, s, kind] of cases) assert.throws(() => compilePacket(p, s), (e) => e instanceof BridgeError && e.kind === kind);
});

test("schema rejects missing, unknown, null, fractional and unsafe operations", () => {
  const { summary: _summary, ...missing } = plan();
  for (const p of [
    missing, { ...plan(), extra: true }, { ...plan(), remove: null },
    { ...plan(), remove: [{ start_line: 1.5, end_line: 2 }] },
    { ...plan(), remove: [{ start_line: 1, end_line: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...plan(), fold: [{ start_line: 1, end_line: 2, extra: true }] },
    { ...plan(), replace: [{ line: 6, old: "żółć", new: 123 }] },
    { ...plan(), schema_version: 2 }, { ...plan(), input_sha256: "bad" },
  ]) assert.throws(() => compilePacket(packet(), p), (e) => e instanceof BridgeError && e.kind === "invalid_plan");
});

test("compiler rejects invented code and invalid original coordinates with repair guidance", () => {
  for (const p of [
    { ...plan(), remove: [{ start_line: 100, end_line: 101 }] },
    { ...plan(), replace: [{ line: 6, old: "żółć", new: "invented" }] },
  ]) assert.throws(() => compilePacket(packet(), p), (e) => e instanceof BridgeError && e.kind === "invalid_plan" && /rerun columbo compile/.test(e.nextAction));
});

test("packet rejects empty, oversized, malformed, and non-UTF8 input", () => {
  for (const [bytes, kind] of [
    [Buffer.from(" \n"), "empty_diff"], [Buffer.alloc(409601, 120), "input_too_large"],
    [Buffer.from([255]), "invalid_encoding"],
    [Buffer.from("diff --cc a.txt\n"), "invalid_diff"],
    [Buffer.from("ordinary text, not a diff"), "invalid_diff"],
  ] as const) assert.throws(() => createPacket(bytes, "stdin"), (e) => e instanceof BridgeError && e.kind === kind);
});

test("real CLI packet → plan → compile works offline outside a Git repository", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "meat-bridge-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const p = invoke(["packet", "--stdin", "--json"], fixture, cwd);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stderr, "");
  const parsed = JSON.parse(p.stdout);
  writeFileSync(join(cwd, "packet.json"), p.stdout);
  const before = readFileSync(join(cwd, "packet.json"));
  const result = invoke(["compile", "--packet", "packet.json", "--plan", "-"], JSON.stringify(parsed.data.plan_template), cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const compiled = JSON.parse(result.stdout);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.data.smart_diff, fixture);
  assert.deepEqual(readFileSync(join(cwd, "packet.json")), before);
  const equals = invoke(["compile", "--packet=packet.json", "--plan=-", "--json"], JSON.stringify(parsed.data.plan_template), cwd);
  assert.equal(equals.status, 0, equals.stderr);
  assert.equal(equals.stdout, result.stdout);
  const bad = invoke(["compile", "--packet", "packet.json", "--plan", "-"], "```json\n{}\n```", cwd);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).error.kind, "invalid_json");
  assert.equal(bad.stderr, "");
});

test("usage failures always emit actionable JSON; help needs no repo or provider", () => {
  for (const args of [
    ["packet", "--staged", "HEAD"], ["packet", "--stdin", "--worktree"],
    ["packet", "HEAD", "--jsno"], ["compile"],
    ["compile", "--packet", "-", "--plan", "-"],
    ["compile", "--packet", "p", "--packet", "p", "--plan", "s"],
    ["compile", "--json=false"],
    ["guide", "unexpected"], ["capabilities", "--bad"], ["help", "unknown"],
    ["help", "toString"], ["help", "constructor"], ["help", "__proto__"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.data, null);
    assert.equal(parsed.error.kind, "usage");
    assert.match(parsed.error.next_action, /columbo/);
  }
  for (const args of [["help", "packet"], ["compile", "--help"], ["guide"], ["robot-docs", "guide"]]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /columbo/);
  }
  const caps = JSON.parse(invoke(["capabilities", "--json"]).stdout);
  assert.equal(caps.ok, true);
  assert.equal(caps.data.contract_version, 1);
  assert.ok(caps.data.error_kinds.includes("snapshot_mismatch"));
  assert.match(JSON.parse(invoke(["guide", "--json"]).stdout).data.guide, /API keys/);
  const typo = JSON.parse(invoke(["packet", "--jsno"]).stdout);
  assert.match(typo.error.message, /Did you mean --json/);
});

test("packet defaults to explicit HEAD and supports staged/worktree/range with options after revision", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "meat-bridge-git-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "old\n"); git("add", "."); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  writeFileSync(join(cwd, "a.txt"), "new\n"); git("add", "."); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "change");
  writeFileSync(join(cwd, "a.txt"), "staged\n"); git("add", ".");
  writeFileSync(join(cwd, "a.txt"), "worktree\n");
  for (const [args, expected] of [
    [[], git("show", "--format=fuller", "-m", "--first-parent", "HEAD")],
    [["HEAD~1...HEAD", "--json"], git("diff", "HEAD~1...HEAD")],
    [["--staged"], git("diff", "--staged")], [["--worktree"], git("diff")],
  ] as [string[], string][]) {
    const r = invoke(["packet", ...args], "ignored redirected stdin", cwd);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(r.stdout).data.input.diff, expected);
  }
  const legacy = invoke(["-look", "HEAD"], "", cwd);
  assert.equal(invoke(["abridge", "-look", "HEAD"], "", cwd).stdout, legacy.stdout);
});

test("abridge alias uses an API-key provider and the production compiler with a mock server", async (t) => {
  let calls = 0;
  const requestedModels: string[] = [];
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer test-fake-key");
    let body = "";
    req.on("data", b => { body += b; });
    req.on("end", () => {
      requestedModels.push(JSON.parse(body).model);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ output: [{ type: "function_call", call_id: `call-${calls}`, name: "submit", arguments: JSON.stringify({ remove: [], replace: [], fold: [], summary: "Change text." }) }], usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  for (const flags of [["-model", "test-model"], []]) {
    const child = spawn(process.execPath, [cli, "abridge", "-json", ...flags], {
      cwd: tmpdir(),
      env: { ...offlineEnv, COLUMBO_MODEL: "preferred-model", MEAT_MODEL: "legacy-model", COLUMBO_CACHE: "", OPENAI_API_KEY: "test-fake-key", OPENAI_BASE_URL: `http://127.0.0.1:${addr.port}` },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.stdin.end(fixture);
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).smart_diff, fixture);
    assert.doesNotMatch(stderr, /fatal: not a git repository/);
  }
  assert.deepEqual(new Set(requestedModels), new Set(["test-model", "preferred-model"]));
});
