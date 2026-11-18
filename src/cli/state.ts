import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, link, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CLIError } from "./errors.ts";

type Source = { path: string; sha256: string };
type Intent = { kind: "intent"; id: string; actor: string; goal: string; criteria: string[] };
type Evidence = { kind: "evidence"; id: string; actor: string; task: string; claim: string; basis: "source" | "reported_check" | "inference"; sources: Source[]; limits: string[] };
type Decision = { kind: "decision"; id: string; actor: string; task: string; question: string; answer: string | null; supersedes?: string };
type RecordValue = Intent | Evidence | Decision;
type Stored = { schema_version: 1; repository: string; record: RecordValue };
const maxBytes = 1024 * 1024;
const maxRecords = 1000;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export const stateHelp = {
  status: "columbo status [--task ID] [--details] [--json]\nRead compact repository state, intent, evidence freshness, and decisions. --details includes full claims and decision history. No writes or model calls.\n",
  snapshot: "columbo snapshot --file PATH [--file PATH ...] [--json]\nHash selected regular files relative to the repository root. Copy data.sources into an evidence record; source text is not stored.\n",
  record: "columbo record --file RECORD.json [--json]\nSave an immutable, attributed intent, evidence, or decision record in worktree-local Git metadata. Read columbo help record-schema for the input contract. No source edits or model calls.\n",
  "record-schema": "Record JSON (unknown fields rejected):\nintent: {kind: 'intent', id, actor, goal, criteria: [string]}\nevidence: {kind: 'evidence', id, actor, task, claim, basis: 'source'|'reported_check'|'inference', sources: [{path, sha256}], limits: [string]}\ndecision: {kind: 'decision', id, actor, task, question, answer: string|null, supersedes?: ID}\nUse valid JSON with double quotes. IDs use 1-80 letters, digits, underscores or hyphens and start with a letter/digit. task references an intent ID. Evidence requires at least one source from columbo snapshot. A decision resolution supersedes the prior decision ID for that task. Actor labels are assertions, not authenticated identities; answers are not execution authorization.\n",
};

export function recordSchema() {
  const text = { type: "string", minLength: 1, maxLength: 16000, pattern: "\\S" };
  const id = { type: "string", pattern: idPattern.source };
  const strings = { type: "array", maxItems: 100, items: text };
  const variant = (kind: string, properties: Record<string, unknown>, required: string[]) => ({
    type: "object", additionalProperties: false,
    properties: { kind: { const: kind }, id, actor: text, ...properties },
    required: ["kind", "id", "actor", ...required],
  });
  return {
    kind: "columbo.record_schema", schema_version: 1,
    schema: { oneOf: [
      variant("intent", { goal: text, criteria: { ...strings, minItems: 1 } }, ["goal", "criteria"]),
      variant("evidence", {
        task: id, claim: text, basis: { enum: ["source", "reported_check", "inference"] },
        sources: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
          properties: { path: text, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["path", "sha256"] } },
        limits: strings,
      }, ["task", "claim", "basis", "sources", "limits"]),
      variant("decision", { task: id, question: text, answer: { anyOf: [text, { type: "null" }] }, supersedes: id }, ["task", "question", "answer"]),
    ] },
    constraints: ["Text fields are limited to 16000 UTF-8 bytes.", "IDs are immutable and worktree-local.", "Tasks and superseded decisions must already exist.", "Evidence paths must be unique canonical repository-relative regular files with matching byte hashes.", "Claims and actor labels are assertions. Answers are not authorization."],
  };
}

function fail(kind: string, message: string): never {
  throw new CLIError(kind, message, "Run columbo help record-schema for records, or columbo help status for inspection.");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * maxBytes });
}

async function repository() {
  try {
    const root = await realpath(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
    const dir = resolve(root, git(root, ["rev-parse", "--git-path", "columbo-state-v1"]).trim());
    return { root, dir };
  } catch {
    throw new CLIError("repository_required", "This command requires an accessible Git working tree", "Run columbo status --json from the project working tree.");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_record", "Expected a JSON object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 16000) fail("invalid_record", `${field} must be a nonempty string of at most 16000 UTF-8 bytes`);
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field);
  if (!idPattern.test(result) || result.trim() !== result) fail("invalid_record", `${field} must be a safe ID of at most 80 characters`);
  return result;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) fail("invalid_record", `${field} must be an array of at most 100 strings`);
  return value.map(item => text(item, field));
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("invalid_record", `Unknown field ${key}`);
}

function source(value: unknown): Source {
  const item = object(value);
  keys(item, ["path", "sha256"]);
  const path = text(item["path"], "path");
  const sha256 = text(item["sha256"], "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("invalid_record", "sha256 must be a lowercase SHA-256 digest");
  return { path, sha256 };
}

function parseRecord(value: unknown): RecordValue {
  const r = object(value);
  const base = { id: identifier(r["id"], "id"), actor: text(r["actor"], "actor") };
  if (r["kind"] === "intent") {
    keys(r, ["kind", "id", "actor", "goal", "criteria"]);
    const criteria = strings(r["criteria"], "criteria");
    if (!criteria.length) fail("invalid_record", "Intent requires at least one acceptance criterion");
    return { ...base, kind: "intent", goal: text(r["goal"], "goal"), criteria };
  }
  const task = identifier(r["task"], "task");
  if (r["kind"] === "evidence") {
    keys(r, ["kind", "id", "actor", "task", "claim", "basis", "sources", "limits"]);
    const basis = r["basis"];
    if (basis !== "source" && basis !== "reported_check" && basis !== "inference") fail("invalid_record", "Unknown evidence basis");
    const input = r["sources"];
    if (!Array.isArray(input) || !input.length || input.length > 100) fail("invalid_record", "Evidence requires 1-100 source files");
    const sources = input.map(source);
    if (new Set(sources.map(item => item.path)).size !== sources.length) fail("invalid_record", "Duplicate source paths");
    return { ...base, kind: "evidence", task, claim: text(r["claim"], "claim"), basis, sources, limits: strings(r["limits"], "limits") };
  }
  if (r["kind"] === "decision") {
    keys(r, ["kind", "id", "actor", "task", "question", "answer", "supersedes"]);
    const answer = r["answer"] === null ? null : text(r["answer"], "answer");
    return { ...base, kind: "decision", task, question: text(r["question"], "question"), answer,
      ...(r["supersedes"] === undefined ? {} : { supersedes: identifier(r["supersedes"], "supersedes") }) };
  }
  return fail("invalid_record", "kind must be intent, evidence, or decision");
}

async function jsonFile(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes) fail("invalid_record", "Record must be a regular file at most 1 MiB");
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch { return fail("invalid_record", `Cannot parse JSON record at ${path}`); }
}

async function stateExists(dir: string): Promise<boolean> {
  try {
    if (!(await lstat(dir)).isDirectory()) fail("state_invalid", "State directory must be a real directory, not a symlink");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function records(root: string, dir: string): Promise<RecordValue[]> {
  if (!await stateExists(dir)) return [];
  const names = (await readdir(dir)).filter(name => name.endsWith(".json")).sort();
  if (names.length > maxRecords) fail("state_limit", "State exceeds 1000 records; archive completed work before continuing");
  const result: RecordValue[] = [];
  for (const name of names) {
    const stored = object(await jsonFile(join(dir, name)));
    if (stored["schema_version"] !== 1 || stored["repository"] !== root) fail("state_invalid", `Record ${name} belongs to an unsupported schema or repository path`);
    const r = parseRecord(stored["record"]);
    if (name !== `${r.id}.json`) fail("state_invalid", `Record ID does not match filename ${name}`);
    result.push(r);
  }
  return result;
}

async function fingerprint(root: string, path: string): Promise<Source> {
  if (isAbsolute(path) || path.includes("\0")) fail("source_path", "Source paths must be repository-relative");
  const absolute = resolve(root, path);
  const normalized = relative(root, absolute);
  if (!normalized || normalized === ".." || normalized.startsWith(`..${sep}`)) fail("source_path", "Source path escapes repository");
  let cursor = root;
  for (const part of normalized.split(sep)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) fail("source_path", "Source paths cannot traverse symlinks");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.size > 16 * maxBytes) fail("source_path", "Source must be a regular file at most 16 MiB");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    bytes += chunk.length;
    if (bytes > 16 * maxBytes) fail("source_path", "Source grew beyond 16 MiB while reading");
    hash.update(chunk);
  }
  return { path: normalized, sha256: hash.digest("hex") };
}

async function freshness(root: string, evidence: Evidence, fingerprints: Map<string, Promise<Source>>) {
  const sources = await Promise.all(evidence.sources.map(async item => {
    try {
      let pending = fingerprints.get(item.path);
      if (!pending) { pending = fingerprint(root, item.path); fingerprints.set(item.path, pending); }
      const current = await pending;
      return { path: item.path, status: current.sha256 === item.sha256 ? "unchanged" : "changed" };
    } catch {
      return { path: item.path, status: "unavailable" };
    }
  }));
  return { ...evidence, freshness: sources.every(item => item.status === "unchanged") ? "supporting_inputs_unchanged" : "needs_recheck", source_status: sources, verified_by_columbo: false };
}

function validateReferences(record: RecordValue, all: RecordValue[]) {
  if (record.kind === "intent") return;
  if (!all.some(item => item.kind === "intent" && item.id === record.task)) fail("record_reference", `Unknown task ${record.task}; record its intent first`);
  if (record.kind === "decision" && record.supersedes) {
    const previous = all.find(item => item.id === record.supersedes);
    if (previous?.kind !== "decision" || previous.task !== record.task) fail("record_reference", "supersedes must reference a decision in the same task");
  }
}

export async function runState(command: string, args: readonly string[]) {
  const options = new Map<string, string[]>();
  let details = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--details" && command === "status") { details = true; continue; }
    const allowed = command === "status" ? "--task" : "--file";
    if (arg !== allowed || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new CLIError("usage", `Expected ${allowed} with a value`, `Run columbo help ${command}.`, 2);
    options.set(arg, [...(options.get(arg) ?? []), args[++i]!]);
  }
  const files = options.get("--file") ?? [];
  const tasks = options.get("--task") ?? [];
  if (tasks.length > 1 || (command === "record" && files.length !== 1) || (command === "snapshot" && (!files.length || files.length > 100))) throw new CLIError("usage", "Supply one record file, 1-100 snapshot files, or at most one status task", `Run columbo help ${command}.`, 2);
  const { root, dir } = await repository();
  if (command === "snapshot") {
    const sources = await Promise.all(files.map(path => fingerprint(root, path)));
    return { kind: "columbo.snapshot", repository: root, sources: [...new Map(sources.map(item => [item.path, item])).values()].sort((a, b) => a.path.localeCompare(b.path)), source_text_stored: false };
  }
  const all = await records(root, dir);
  for (const record of all) validateReferences(record, all);
  if (command === "record") {
    const record = parseRecord(await jsonFile(resolve(files[0]!)));
    validateReferences(record, all);
    const existing = all.find(item => item.id === record.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) fail("record_conflict", `ID ${record.id} already has different content; use a new ID`);
      return { kind: "columbo.record", created: false, record };
    }
    if (all.length >= maxRecords) fail("state_limit", "At most 1000 records are supported");
    if (record.kind === "evidence") {
      for (const item of record.sources) {
        const current = await fingerprint(root, item.path);
        if (current.path !== item.path || current.sha256 !== item.sha256) fail("source_mismatch", `Source ${item.path} no longer matches; inspect it again and create a fresh snapshot`);
      }
    }
    const stored: Stored = { schema_version: 1, repository: root, record };
    const serialized = JSON.stringify(stored) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) fail("invalid_record", "Stored record including metadata exceeds 1 MiB");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await stateExists(dir);
    const temporary = join(dir, `.${randomUUID()}.tmp`);
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    try { await link(temporary, join(dir, `${record.id}.json`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("record_conflict", `ID ${record.id} was recorded concurrently; run columbo status --json and use a new ID if needed`);
      throw error;
    } finally { await unlink(temporary); }
    return { kind: "columbo.record", created: true, record };
  }
  const task = tasks[0];
  if (task && !all.some(item => item.kind === "intent" && item.id === task)) fail("record_reference", `Unknown task ${task}`);
  const selected = all.filter(item => !task || (item.kind === "intent" ? item.id === task : item.task === task));
  const fingerprints = new Map<string, Promise<Source>>();
  const evidence = [];
  for (const item of selected) if (item.kind === "evidence") evidence.push(await freshness(root, item, fingerprints));
  const decisions = selected.filter((item): item is Decision => item.kind === "decision");
  const leaves = decisions.filter(item => !decisions.some(next => next.supersedes === item.id));
  const decisionConflicts = decisions.filter(item => decisions.filter(next => next.supersedes === item.id).length > 1).map(item => item.id);
  let head: string | null = null;
  try { head = git(root, ["rev-parse", "--verify", "HEAD"]).trim(); } catch {}
  let branch: string | null = null;
  try { branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); } catch {}
  return {
    kind: "columbo.status", repository: root, head, branch,
    git_status_porcelain_v1: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    tasks: selected.filter(item => item.kind === "intent"),
    evidence: details ? evidence : evidence.map(item => ({ id: item.id, task: item.task, basis: item.basis, freshness: item.freshness, source_status: item.source_status, verified_by_columbo: false })),
    decisions: details ? decisions : leaves,
    view: details ? "details" : "summary",
    omitted: { evidence_claims: details ? 0 : evidence.length, superseded_decisions: details ? 0 : decisions.length - leaves.length },
    detail_command: ["columbo", "status", ...(task ? ["--task", task] : []), "--details", "--json"],
    unresolved_decisions: leaves.filter(item => item.answer === null).map(item => item.id), decision_conflicts: decisionConflicts,
    next_actions: [
      ...evidence.filter(item => item.freshness === "needs_recheck").map(item => ({ action: "reinspect", record: item.id, reason: "Supporting inputs changed or are unavailable" })),
      ...leaves.filter(item => item.answer === null).map(item => ({ action: "resolve_decision", record: item.id, reason: item.question })),
      ...decisionConflicts.map(id => ({ action: "reconcile_decisions", record: id, reason: "Multiple decisions supersede the same record" })),
    ],
    limits: ["Claims and actor labels are supplied assertions, not authenticated proof.", "Unchanged supporting bytes do not establish semantic validity; unrecorded dependencies and environment may differ.", "Decision answers do not grant execution permissions. No checks were run by this command."],
  };
}
