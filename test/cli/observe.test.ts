import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSnapshot, canonicalJSON, hashBytes, SnapshotError } from "../../src/cli/snapshot.ts";
import { observeSnapshot, inventoryArtifact, evidenceArtifact, planningArtifact, capabilityArtifact } from "../../src/cli/observe.ts";
import { maxDiffBytes } from "../../src/meat/meat.ts";

const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const patch = (name = "a.txt", body = "-old\n+new\n") => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}`;
async function observation(raw: string | Uint8Array) {
  return observeSnapshot(await collectSnapshot([], false, false, {
    stdinIsPiped: () => true,
    readAllStdin: async () => typeof raw === "string" ? Buffer.from(raw) : raw,
    git: () => { throw new Error("stdin must not invoke Git"); },
  }));
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof SnapshotError && error.code === code;
}
function alteredCursor(token: string, edits: Record<string, unknown>) {
  const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
  const bytes = Buffer.from(canonicalJSON({ ...payload, ...edits }));
  return bytes.toString("base64url") + "." + hashBytes(bytes);
}

test("stdin identity freezes canonical descriptor hashing independently of display labels", async () => {
  const obs = await observation("x\r\n");
  const { diff, observations, ...descriptor } = obs.snapshot;
  assert.deepEqual(descriptor, {
    version: 1,
    input_digest: "b35e09fa2ced9ebcad9d16336fb961146fe34bfbebc562679da85f8a314c9dca",
    id: "9421f2d1f127767f24d973073cc0150ce5f917dc3e991522f20793cf915a1b34",
    source: { kind: "stdin", provenance: "unknown", collection: { version: 1, bytes: "exact" } },
    context: { availability: "unavailable", consistency: "unverified", before_tree: null, after_tree: null, reason: "stdin_provenance_unknown" },
  });
  assert.deepEqual(Buffer.from(diff), Buffer.from("x\r\n"));
  assert.deepEqual(observations, { selector: "stdin", repository: null });
  const relabelled = observeSnapshot({ ...obs.snapshot, observations: { selector: "display only", repository: "another checkout" } });
  assert.equal(inventoryArtifact(relabelled).snapshot.id, descriptor.id);
});

test("binary inventory preserves unquoted same-file paths containing space b slash", async () => {
  const path = "folder b/file.bin";
  const raw = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 3\nKcmZQzWC8#H2LJ>B\n\n`;
  const obs = await observation(raw);
  const file = obs.entries.find(entry => entry.kind === "file")!;
  assert.equal(file.old_path, `a/${path}`);
  assert.equal(file.new_path, `b/${path}`);
  assert.equal(file.content, "binary");
  assert.deepEqual(Buffer.from(evidenceArtifact(obs, file.id).data, "base64"), Buffer.from(raw));
});

test("exact moves expose original coordinates and warn when a selected hunk excludes its counterpart", async () => {
  const bodies = ["const firstSubstantialValue = 123456;", "const secondSubstantialValue = 234567;", "return firstSubstantialValue + secondSubstantialValue;"];
  const raw = `--- a/x.js\n+++ b/x.js\n@@ -1,3 +0,0 @@\n${bodies.map(line => "-" + line + "\n").join("")}@@ -10,0 +8,3 @@\n${bodies.map(line => "+" + line + "\n").join("")}`;
  const obs = await observation(raw);
  const relationship = obs.entries.find(entry => entry.kind === "relationship")!;
  assert.ok(relationship);
  assert.equal(inventoryArtifact(obs).summary.relationships, 1);
  assert.equal(inventoryArtifact(obs).summary.regions, 1);
  const { removed, added } = relationship.relationship!;
  assert.equal(removed.line_start, 4);
  assert.equal(removed.line_end, 7);
  assert.equal(added.line_start, 8);
  assert.equal(added.line_end, 11);
  assert.equal(Buffer.from(obs.snapshot.diff.subarray(removed.byte_start, removed.byte_end)).toString(), bodies.map(line => "-" + line + "\n").join(""));
  assert.equal(Buffer.from(obs.snapshot.diff.subarray(added.byte_start, added.byte_end)).toString(), bodies.map(line => "+" + line + "\n").join(""));
  for (const hunk of obs.entries.filter(entry => entry.kind === "hunk")) {
    const evidence = evidenceArtifact(obs, hunk.id);
    assert.deepEqual(evidence.relationships.crossing, [relationship.id]);
    assert.equal(evidence.relationships.total, 1);
    assert.equal(evidence.relationships.omitted, 0);
  }
  const whole = evidenceArtifact(obs, obs.entries.find(entry => entry.kind === "file")!.id);
  assert.deepEqual(whole.relationships.crossing, []);
  assert.equal(planningArtifact(obs).entries[0]!.relationships, 0);
  assert.equal(planningArtifact(obs).coverage.mandatory_removed_lines, 0);
});

test("bounded inventory pages reproduce a deterministic ordered inventory", async () => {
  const obs = await observation(Array.from({ length: 120 }, (_, i) => patch(`file-${i}.txt`)).join(""));
  const seen = [];
  let cursor = "";
  do {
    const page = inventoryArtifact(obs, 7, cursor);
    assert.equal(page.schema, "meat.observe");
    assert.equal(page.version, 1);
    assert.equal(page.snapshot.id, obs.snapshot.id);
    assert.ok(page.entries.length <= 7);
    assert.ok(JSON.stringify(page).length < 12000);
    assert.equal(page.page.offset, seen.length);
    seen.push(...page.entries);
    assert.equal(page.page.omitted, obs.entries.length - seen.length);
    cursor = page.page.next ?? "";
  } while (cursor);
  assert.deepEqual(seen, obs.entries);
  assert.equal(new Set(seen.map(entry => entry.id)).size, seen.length);
  assert.deepEqual(inventoryArtifact(obs, 7), inventoryArtifact(await observation(obs.snapshot.diff), 7));
});

test("base64 evidence reconstructs Unicode, CRLF, invalid UTF-8 and missing final newline byte for byte", async () => {
  const raw = Buffer.concat([Buffer.from(patch("雪.txt", "-é🙂\n+" ).replaceAll("\n", "\r\n")), Buffer.from([0xff, 0xc0, 0x80])]);
  const obs = await observation(raw);
  const file = obs.entries.find(entry => entry.kind === "file")!;
  const pieces: Buffer[] = [];
  let cursor = "";
  do {
    const page = evidenceArtifact(obs, file.id, 1, cursor);
    const data = Buffer.from(page.data, "base64");
    assert.equal(page.encoding, "base64");
    assert.equal(data.length, 1);
    assert.equal(page.range.byte_start, pieces.length);
    assert.equal(page.range.byte_end, pieces.length + 1);
    assert.equal(page.selection.parent_snapshot, obs.snapshot.id);
    assert.ok(page.range.line_start >= file.range.line_start);
    assert.ok(page.range.line_end <= file.range.line_end);
    pieces.push(data);
    cursor = page.page.next ?? "";
    assert.equal(page.page.completeness, cursor ? "truncated" : "complete");
  } while (cursor);
  assert.deepEqual(Buffer.concat(pieces), raw);
  assert.equal(file.range.byte_end, raw.length);
  const hunk = obs.entries.find(entry => entry.kind === "hunk")!;
  const selected = evidenceArtifact(obs, hunk.id);
  assert.deepEqual(Buffer.from(selected.data, "base64"), raw.subarray(hunk.range.byte_start, hunk.range.byte_end));
  assert.equal(selected.selection.excluded_bytes, raw.length - (hunk.range.byte_end - hunk.range.byte_start));
  assert.notEqual((await observation(Buffer.from(raw.toString("utf8")))).snapshot.id, obs.snapshot.id);
  assert.notEqual((await observation(Buffer.from(raw.toString("latin1").replaceAll("\r\n", "\n"), "latin1"))).snapshot.id, obs.snapshot.id);
});

test("continuations bind snapshots, operations, selections and limits, and validate structure", async () => {
  const obs = await observation(patch("a") + patch("b"));
  const changed = await observation(patch("a", "-old\n+changed\n") + patch("b"));
  const token = inventoryArtifact(obs, 1).page.next!;
  assert.throws(() => inventoryArtifact(changed, 1, token), errorCode("source_changed"));
  assert.throws(() => inventoryArtifact(obs, 2, token), errorCode("invalid_request"));
  assert.throws(() => planningArtifact(obs, 1, token), errorCode("invalid_request"));
  for (const bad of ["garbage", token + ".extra", token.slice(0, -1), "x".repeat(2049), alteredCursor(token, { version: 2 }), alteredCursor(token, { offset: -1 }), alteredCursor(token, { offset: 1.5 }), alteredCursor(token, { offset: obs.entries.length })]) {
    assert.throws(() => inventoryArtifact(obs, 1, bad), errorCode("invalid_request"));
  }
  const files = obs.entries.filter(entry => entry.kind === "file");
  const evidenceToken = evidenceArtifact(obs, files[0]!.id, 3).page.next!;
  assert.throws(() => evidenceArtifact(obs, files[1]!.id, 3, evidenceToken), errorCode("invalid_request"));
  assert.throws(() => evidenceArtifact(obs, files[0]!.id, 4, evidenceToken), errorCode("invalid_request"));
  assert.throws(() => evidenceArtifact(changed, files[0]!.id, 3, evidenceToken), errorCode("source_changed"));
  assert.throws(() => evidenceArtifact(obs, "f:nonexistent"), errorCode("invalid_request"));
});

test("huge headers and display paths remain bounded while evidence preserves every byte", async () => {
  const long = "雪".repeat(100000);
  const obs = await observation(`diff --git a/${long} b/${long}\n--- a/${long}\n+++ b/${long}\n@@ -1 +1 @@ ${long}\n-a\n+b\n`);
  const artifact = inventoryArtifact(obs);
  assert.ok(JSON.stringify(artifact).length < 7000);
  const file = artifact.entries.find(entry => entry.kind === "file")!;
  assert.equal(file.paths_truncated, true);
  assert.ok(file.old_path!.length <= 512);
  assert.equal(file.range.byte_end, obs.snapshot.diff.length);
  const first = evidenceArtifact(obs, file.id, 16384);
  assert.equal(Buffer.from(first.data, "base64").length, 16384);
  assert.deepEqual(Buffer.from(first.data, "base64"), Buffer.from(obs.snapshot.diff.subarray(0, 16384)));
  assert.equal(first.page.completeness, "truncated");
});

test("unsupported combined, binary, metadata, malformed and unparsed hunks stay inspectable", async () => {
  for (const [raw, content, hasHunk] of [
    ["diff --git a/b b/b\nBinary files a/b and b/b differ\n", "binary", false],
    ["diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n", "metadata", false],
    ["diff --cc a\nindex 123,456..789\n--- a/a\n+++ b/a\n@@@ -1,1 -1,1 +1,1 @@@\n++x\n", "combined", true],
    ["--- a/a\n+++ b/a\n@@ -1,3 +1,2 @@\n-a\n+b\n", "text", true],
    ["--- a/a\n+++ b/a\n@@ unknown @@\n-a\n+b\n", "text", true],
  ] as const) {
    const obs = await observation(raw);
    const page = inventoryArtifact(obs);
    assert.equal(page.entries[0]!.content, content);
    assert.equal(page.entries.some(entry => entry.kind === "hunk"), hasHunk);
    assert.deepEqual(Buffer.from(evidenceArtifact(obs, page.entries[0]!.id).data, "base64"), Buffer.from(raw));
    if (content === "combined") assert.equal(page.compiler.eligible, false);
    if (raw.includes("unknown")) assert.equal(page.entries.find(entry => entry.kind === "hunk")!.source_lines, null);
  }
});

test("raw repeated file markers and mail envelope divide the original input without gaps", async () => {
  const raw = "From abc\nSubject: patch\n\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+b\n--- a/two\n+++ b/two\n@@ -0,0 +1 @@\n+c\n-- \nversion\n";
  const obs = await observation(raw);
  const regions = obs.entries.filter(entry => entry.kind === "file" || entry.kind === "envelope");
  assert.deepEqual(regions.map(entry => entry.kind), ["envelope", "file", "file", "envelope"]);
  let offset = 0;
  const pieces = regions.map(entry => {
    assert.equal(entry.range.byte_start, offset);
    offset = entry.range.byte_end;
    return Buffer.from(evidenceArtifact(obs, entry.id).data, "base64");
  });
  assert.equal(offset, Buffer.byteLength(raw));
  assert.deepEqual(Buffer.concat(pieces), Buffer.from(raw));
  for (const hunk of obs.entries.filter(entry => entry.kind === "hunk")) {
    const parent = regions.find(entry => entry.id === hunk.parent)!;
    assert.ok(hunk.range.byte_start >= parent.range.byte_start && hunk.range.byte_end <= parent.range.byte_end);
  }
});

test("hunk evidence excludes plain trailing prose while file evidence retains it", async () => {
  const raw = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\nplain trailer\n";
  const obs = await observation(raw);
  const file = obs.entries.find(entry => entry.kind === "file")!;
  const hunk = obs.entries.find(entry => entry.kind === "hunk")!;
  assert.equal(hunk.range.line_start, 4);
  assert.equal(hunk.range.line_end, 7);
  assert.equal(hunk.range.byte_end, Buffer.byteLength(raw.slice(0, raw.indexOf("plain trailer"))));
  assert.equal(Buffer.from(evidenceArtifact(obs, hunk.id).data, "base64").toString(), "@@ -1 +1 @@\n-a\n+b\n");
  assert.equal(Buffer.from(evidenceArtifact(obs, file.id).data, "base64").toString(), raw);
});

test("planning warns on exact moves whose complete sides land in separate partitions", async () => {
  const rows = ["alpha", "beta", "gamma"].map(name => `const ${name} = '${name.repeat(18000)}';`);
  const raw = `--- a/x.js\n+++ b/x.js\n@@ -1,3 +0,0 @@\n${rows.map(row => "-" + row + "\n").join("")}@@ -10,0 +8,3 @@\n${rows.map(row => "+" + row + "\n").join("")}`;
  const obs = await observation(raw);
  const relationship = obs.entries.find(entry => entry.kind === "relationship")!;
  assert.ok(relationship);
  const plan = planningArtifact(obs);
  assert.equal(plan.compiler.eligible, true, plan.compiler.reason ?? "");
  assert.equal(plan.forecast.partitions, 2);
  const intersects = (partition: typeof plan.entries[number], range: { line_start: number; line_end: number }) => partition.original_ranges.some(origin => origin.line_start < range.line_end && origin.line_end > range.line_start);
  const { removed, added } = relationship.relationship!;
  assert.equal(plan.entries.filter(entry => intersects(entry, removed)).length, 1);
  assert.equal(plan.entries.filter(entry => intersects(entry, added)).length, 1);
  assert.ok(plan.entries.every(entry => intersects(entry, removed) !== intersects(entry, added)));
  assert.ok(plan.entries.every(entry => entry.relationships > 0));
  assert.equal(plan.coverage.cross_partition_move_validation, "not_performed");
});

test("source coordinate parsing preserves zero and omitted counts and refuses negative or unsafe fields", async () => {
  for (const [header, expected] of [
    ["@@ -0,0 +1,2 @@", { old_start: 0, old_count: 0, new_start: 1, new_count: 2 }],
    ["@@ -7 +9 @@", { old_start: 7, old_count: 1, new_start: 9, new_count: 1 }],
    ["@@ -7,2 +9,0 @@", { old_start: 7, old_count: 2, new_start: 9, new_count: 0 }],
    ["@@ --1,1 +1,1 @@", null],
    ["@@ -1,-1 +1,1 @@", null],
    ["@@ -9007199254740992,1 +1,1 @@", null],
  ] as const) {
    const obs = await observation(`--- a/x\n+++ b/x\n${header}\n`);
    assert.deepEqual(obs.entries.find(entry => entry.kind === "hunk")!.source_lines, expected);
  }
});

test("capabilities freezes the offline version 1 contract and unknown observations", () => {
  assert.deepEqual(capabilityArtifact(), {
    schema: "meat.observe", version: 1, kind: "capabilities",
    operations: ["inventory", "evidence", "plan", "capabilities"],
    artifacts: ["inventory", "evidence", "execution_plan", "capabilities"], schemas: { "meat.observe": [1] },
    execution: { models: "not_probed", gateway: "not_probed", subscription_auth: "unknown" },
    adapters: { api: { available: "not_probed", context: "live_checkout", usage: "provider_reported" }, codex: { available: "not_probed", authentication: "unknown", usage: "unknown" }, claude: { available: "not_probed", authentication: "unknown", usage: "unknown" }, current_session: { usage: "unknown" } },
    controls: { bounded_inventory: "supported", original_byte_expansion: "supported", deterministic_partition_forecast: "supported", snapshot_context_tools: "unsupported", aggregate_deadline: "unsupported", aggregate_model_calls: "unsupported", hard_token_cap: "unsupported", hard_money_cap: "unsupported", resume: "unsupported" },
    bounds: { default_page_size: 20, max_page_size: 100, default_evidence_bytes: 8192, max_evidence_bytes: 16384 },
    legacy: ["-look", "-prompt", "-agent", "-json", "API abridging"],
  });
});

test("planning forecasts bounded partitions without pretending to know execution or cost", async () => {
  const obs = await observation(Array.from({ length: 40 }, (_, i) => patch(`file-${i}`, `-${"a".repeat(6000)}\n+${"b".repeat(6000)}\n`)).join(""));
  const first = planningArtifact(obs, 1);
  assert.ok(first.forecast.partitions > 1);
  assert.equal(first.input_basis, "observation_snapshot");
  assert.equal(first.legacy_selector_execution_equivalence, "not_assessed");
  assert.equal(first.dispatch, "not_performed");
  assert.equal(first.forecast.model_calls, "unknown");
  assert.equal(first.forecast.tokens, "unknown");
  assert.equal(first.forecast.cost, "unknown");
  assert.equal(first.cache.eligibility, "unassessed");
  assert.equal(first.coverage.semantic_validation, "not_performed");
  assert.equal(first.coverage.cross_partition_move_validation, "not_performed");
  const partitions = [...first.entries];
  let cursor = first.page.next;
  while (cursor) {
    const page = planningArtifact(obs, 1, cursor);
    assert.equal(page.plan_id, first.plan_id);
    partitions.push(...page.entries);
    cursor = page.page.next;
  }
  assert.equal(partitions.length, first.forecast.partitions);
  assert.equal(partitions.filter(entry => !entry.passthrough).length, first.forecast.model_runs);
  for (const entry of partitions) {
    assert.ok(entry.bytes <= maxDiffBytes && entry.numbered_bytes <= maxDiffBytes);
    assert.equal(entry.origin_mapping, "recorded");
    assert.ok(entry.original_ranges.every(range => range.line_start >= 1 && range.line_end <= obs.lines.length + 1));
  }
  assert.equal(planningArtifact(obs).plan_id, first.plan_id);
  const unsupported = planningArtifact(await observation("diff --cc a\n@@@ -1 -1 +1 @@@\n++a\n"));
  assert.equal(unsupported.compiler.eligible, false);
  assert.equal(unsupported.forecast.model_runs, 0);
  assert.deepEqual(unsupported.entries, []);
});

test("planning reports passthrough prose and unavailable origins honestly", async () => {
  const body = Array.from({ length: 30 }, () => "-" + "a".repeat(6000) + "\n").join("") + Array.from({ length: 30 }, () => "+" + "b".repeat(6000) + "\n").join("");
  const obs = await observation(`--- a/x\n+++ b/x\n@@ -1,30 +1,30 @@\n${body}-- \n${"v".repeat(300000)}\n`);
  const plan = planningArtifact(obs);
  assert.equal(plan.compiler.eligible, true, plan.compiler.reason ?? "");
  const passthrough = plan.entries.filter(entry => entry.passthrough);
  assert.ok(passthrough.length > 0);
  for (const entry of passthrough) {
    assert.equal(entry.origin_mapping, "unavailable");
    assert.deepEqual(entry.original_ranges, []);
  }
  assert.equal(plan.forecast.model_runs, plan.forecast.partitions - passthrough.length);
  assert.equal(plan.forecast.model_calls, "unknown");
});

test("CLI observations are one JSON document, offline, and do not populate cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "meat-observe-"));
  const env = { ...process.env, PATH: "", HOME: dir, USERPROFILE: dir, XDG_CACHE_HOME: dir, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1", MEAT_GATEWAY_URL: "http://127.0.0.1:1" };
  try {
    const run = (args: string[], input: string | undefined = patch()) => spawnSync(process.execPath, [main, ...args], { cwd: dir, env, input, encoding: "utf8", timeout: 10000 });
    const caps = spawnSync(process.execPath, [main, "-capabilities"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10000 });
    assert.equal(caps.status, 0, caps.stderr);
    assert.equal(caps.stderr, "");
    assert.deepEqual(JSON.parse(caps.stdout), capabilityArtifact());
    const inventory = run(["-inventory"]);
    assert.equal(inventory.status, 0, inventory.stderr);
    assert.equal(inventory.stderr, "");
    const artifact = JSON.parse(inventory.stdout);
    const evidence = run(["-evidence", artifact.entries[0].id, "-snapshot", artifact.snapshot.id, "-max-bytes", "3"]);
    assert.equal(evidence.status, 0, evidence.stderr);
    assert.equal(evidence.stderr, "");
    assert.equal(Buffer.from(JSON.parse(evidence.stdout).data, "base64").length, 3);
    const plan = run(["-plan"]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(plan.stderr, "");
    assert.equal(JSON.parse(plan.stdout).kind, "execution_plan");
    for (const [args, input, code] of [
      [["-inventory"], "", "empty_input"],
      [["-inventory", "-cursor", "bogus"], patch(), "invalid_request"],
      [["-evidence", artifact.entries[0].id, "-snapshot", artifact.snapshot.id], patch("changed"), "source_changed"],
      [["-evidence", "f:unknown", "-snapshot", artifact.snapshot.id], patch(), "invalid_request"],
    ] as const) {
      const result = run([...args], input);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const diagnostic = JSON.parse(result.stderr);
      assert.equal(diagnostic.schema, "meat.observe");
      assert.equal(diagnostic.version, 1);
      assert.equal(diagnostic.kind, "diagnostic");
      assert.equal(diagnostic.code, code);
    }
    for (const args of [["-inventory", "-page-size", "0"], ["-plan", "-page-size", "101"], ["-evidence", "f:0"], ["-inventory", "-max-bytes", "1"], ["-plan", "-json"], ["-capabilities", "HEAD"], ["-evidence", "f:0", "-snapshot", artifact.snapshot.id, "-max-bytes", "16385"]]) {
      const result = run(args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.length > 0);
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
