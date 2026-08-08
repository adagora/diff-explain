// tools.ts is the agent's toolbox (meat/tools.go): read_file, grep (via `git
// grep`), preview_plan, submit — confined to a repo root and bounded at a
// fixed per-result byte cap. Fully self-contained: confirmed by grepping
// every cross-reference between rubric.go/meat.go/tools.go (see TODO.md item
// 4l's "As built" note) that tools.go has zero dependency on rubric.go in
// either direction, so unlike rubric.ts/chunk.ts this item hits no forward
// dependency at all.
//
// H1: `maxToolOutput` truncation is a byte-offset cut walked back to a UTF-8
// rune boundary, never a character-count truncation. H10: path confinement
// (`resolveInRoot`) is ported as an exact, verbatim sequence — no
// `fs.realpath`/symlink resolution, which would add a check Go doesn't have
// and change the security properties. H6: only `grep`'s `git` subprocess
// call takes a cancellation signal; `readFile`/`previewPlan`/`submit` have
// no cancellation path at all, matching Go exactly.

import { at, arrayAt, slice, hasSuffix, indexOf, concat, trimSpace, isRuneStart, encodeUTF8, decodeUTF8 } from "./bytes.ts";
import {
  type EditPlan,
  type Submission,
  type EditPlanReplacement,
  type CompiledPlan,
  type PlanStats,
  compileEditPlanMoves,
  compileSubmissionMoves,
} from "./editplan.ts";
import { type LineRange, type LineFold } from "./plan.ts";
import { type DetectedMove, formatMovePairs, maxMoveHints } from "./moves.ts";
import { type Tool } from "./model.ts";
import { execFile } from "node:child_process";
import { readFile as readFileBytes } from "node:fs/promises";
import { isAbsolute, normalize, resolve as resolvePath, join, sep } from "node:path";

/** Go's `maxToolOutput` (`meat/tools.go:19`): bounds the size of any single tool result fed back to the model. */
export const maxToolOutput = 16 * 1024;

/**
 * Go's `toolbox` (`meat/tools.go:21-38`): per-run state the tools need.
 * `root`/`rawDiff`/`noMoves`/`moves` are set once at construction and never
 * mutated after; `smartDiff`/`submitted`/`submittedPlan`/`submitFeedback`/
 * `submitSeen` are the mutable submission state `submit`/`clearSubmission`
 * write. `null` stands in for Go's nil pointer (`submitted`/`submittedPlan`).
 */
export interface Toolbox {
  readonly root: string;
  readonly rawDiff: Uint8Array;
  smartDiff: Uint8Array;
  submitted: Submission | null;
  submittedPlan: CompiledPlan | null;
  submitFeedback: string;
  submitSeen: boolean;
  /** Disables per-plan move DETECTION for chunk runs (`specs/chunk.md`); `moves` carries the whole-diff moves mapped into this chunk's coordinates instead, enforced but not (re)detected. */
  readonly noMoves: boolean;
  readonly moves: readonly DetectedMove[] | undefined;
}

export function newToolbox(params: { root?: string; rawDiff: Uint8Array; noMoves?: boolean; moves?: readonly DetectedMove[] }): Toolbox {
  return {
    root: params.root ?? "",
    rawDiff: params.rawDiff,
    smartDiff: new Uint8Array(0),
    submitted: null,
    submittedPlan: null,
    submitFeedback: "",
    submitSeen: false,
    noMoves: params.noMoves ?? false,
    moves: params.moves,
  };
}

/** Go's `editPlanToolSchema` (`meat/tools.go:40-63`): authors JSON Schema text directly rather than deriving it from a type. */
function editPlanToolSchema(withSummary: boolean): Uint8Array {
  let properties =
    '\n\t\t"remove":{\n' +
    '\t\t\t"type":"array",\n' +
    '\t\t\t"description":"Inclusive 1-based ranges of original diff lines to omit. Coordinates never shift.",\n' +
    '\t\t\t"items":{"type":"object","additionalProperties":false,"properties":{"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["start_line","end_line"]}\n' +
    "\t\t},\n" +
    '\t\t"replace":{\n' +
    '\t\t\t"type":"array",\n' +
    '\t\t\t"description":"Single-line source elisions. new must match old with each omitted span visibly replaced by ... or … .",\n' +
    '\t\t\t"items":{"type":"object","additionalProperties":false,"properties":{"line":{"type":"integer","minimum":1},"old":{"type":"string","minLength":1},"new":{"type":"string"}},"required":["line","old","new"]}\n' +
    "\t\t},\n" +
    '\t\t"fold":{\n' +
    '\t\t\t"type":"array",\n' +
    '\t\t\t"description":"Ranges of two or more same-polarity hunk source lines to replace with one machine-generated, indentation-preserving ... row.",\n' +
    '\t\t\t"items":{"type":"object","additionalProperties":false,"properties":{"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["start_line","end_line"]}\n' +
    "\t\t}";
  let required = '"remove","replace","fold"';
  if (withSummary) {
    properties += ',"summary":{"type":"string","description":"One-line, high-level description of what the change does."}';
    required += ',"summary"';
  }
  return encodeUTF8(`{"type":"object","additionalProperties":false,"properties":{${properties}},"required":[${required}]}`);
}

/** Go's `(*toolbox).previewPlanTool` (`meat/tools.go:65-71`). */
export function previewPlanTool(): Tool {
  return {
    name: "preview_plan",
    description:
      "Validate a complete remove/replace/fold plan against the numbered ORIGINAL diff and preview the resulting reading diff with retention statistics. Imports are removed automatically and moved code must be treated symmetrically; the feedback reports anything that needs fixing. Large previews are explicitly truncated. Plans are never incremental.",
    inputSchema: editPlanToolSchema(false),
  };
}

/** Go's `(*toolbox).submitTool` (`meat/tools.go:75-81`): always advertised; read_file/grep are only offered when confined to a repo root. */
export function submitTool(): Tool {
  return {
    name: "submit",
    description:
      "Submit a final complete remove/replace/fold plan against the numbered ORIGINAL diff plus a one-line summary. Meat applies the plan locally (removing imports automatically and rejecting asymmetric treatment of moved code); do not submit a rewritten diff.",
    inputSchema: editPlanToolSchema(true),
  };
}

/** Go's `(*toolbox).tools` (`meat/tools.go:84-101`): the schemas advertised to the model. Root empty -> exactly 2 tools, in order (G2); otherwise exactly 4, in order. */
export function tools(tb: Toolbox): Tool[] {
  if (tb.root === "") {
    return [previewPlanTool(), submitTool()];
  }
  return [
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the repository to gather clues about whether a diff line is load-bearing (or whether a file is generated). Paths are relative to the repo root. Optionally restrict to an inclusive 1-based line range with start_line/end_line.",
      inputSchema: encodeUTF8(
        '{"type":"object","properties":{"path":{"type":"string","description":"File path relative to the repo root."},"start_line":{"type":"integer","description":"1-based first line (optional)."},"end_line":{"type":"integer","description":"1-based last line (optional)."}},"required":["path"]}',
      ),
    },
    {
      name: "grep",
      description: "Search the repository for a regular expression (git grep). Use it to find call sites, type definitions, generator directives, or whether a symbol is used elsewhere. Optionally scope to a path prefix.",
      inputSchema: encodeUTF8(
        '{"type":"object","properties":{"pattern":{"type":"string","description":"Regular expression to search for."},"path":{"type":"string","description":"Optional path prefix (relative to repo root)."}},"required":["pattern"]}',
      ),
    },
    previewPlanTool(),
    submitTool(),
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Go's `(*toolbox).run` (`meat/tools.go:106-119`): dispatches a tool call by
 * name. Only `grep` receives `signal` — this is the exact scope H6 covers
 * for this file. `readFile`/`previewPlan`/`submit` are plain synchronous
 * functions (no cancellation path at all, matching Go exactly); `await`ing
 * their already-resolved tuple here is a no-op.
 */
export async function run(tb: Toolbox, signal: AbortSignal, name: string, input: Uint8Array): Promise<readonly [text: string, isError: boolean]> {
  switch (name) {
    case "read_file":
      return readFile(tb, input);
    case "grep":
      return grep(tb, signal, input);
    case "preview_plan":
      return previewPlan(tb, input);
    case "submit":
      return submit(tb, input);
    default:
      return [`unknown tool ${JSON.stringify(name)}`, true];
  }
}

/**
 * Go's `(*toolbox).resolveInRoot` (`meat/tools.go:123-140`) — H10, the sole
 * gate between model-supplied path strings and the filesystem or `git`.
 * Ported as the exact six-step sequence the spec pins; no step resolves
 * symlinks (deliberate — see the file header comment and `migration/
 * HAZARDS.md` H10).
 */
function resolveInRoot(tb: Toolbox, rel: string): string {
  const clean = normalize(rel);
  if (isAbsolute(clean)) {
    throw new Error("path must be relative to the repo root");
  }
  const rootAbs = resolvePath(tb.root);
  const absAbs = resolvePath(join(tb.root, clean));
  if (absAbs !== rootAbs && !absAbs.startsWith(rootAbs + sep)) {
    throw new Error("path escapes the repo root");
  }
  return absAbs;
}

interface ReadFileInput {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

function decodeReadFileInput(raw: Uint8Array): ReadFileInput {
  const parsed: unknown = JSON.parse(decodeUTF8(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("json: cannot unmarshal into readFileInput");
  }
  const obj = parsed as Record<string, unknown>;
  const path = "path" in obj ? obj["path"] : "";
  const startLine = "start_line" in obj ? obj["start_line"] : 0;
  const endLine = "end_line" in obj ? obj["end_line"] : 0;
  if (typeof path !== "string") throw new Error("json: path must be a string");
  if (typeof startLine !== "number") throw new Error("json: start_line must be a number");
  if (typeof endLine !== "number") throw new Error("json: end_line must be a number");
  return { path, startLine, endLine };
}

// Lenient, non-throwing UTF-8 decode (WHATWG default: invalid sequences
// become U+FFFD) — a deliberate, narrow exception to this codebase's
// otherwise-fatal `decodeUTF8` (bytes.ts). Go's `string(data)` performs zero
// UTF-8 validation at all (a binary or malformed file passes through as
// whatever bytes it has); a JS `string` cannot represent an arbitrary
// invalid byte sequence the way a Go string can, so exact fidelity is
// already impossible here — and Go's own behavior is moot the moment this
// text is JSON-marshaled into a tool-result message anyway, since
// `encoding/json` itself substitutes U+FFFD for invalid UTF-8 when
// marshaling a Go string. Lenient decode is the closest faithful match to
// Go's actual end-to-end behavior, not merely a convenience. Used only for
// `readFile`'s file content and `grep`'s subprocess output — every other
// decode in this file (tool-call JSON payloads) uses the fatal
// `bytes.ts` `decodeUTF8`, since those always originate as valid UTF-8 JSON.
const lenientUtf8Decoder = new TextDecoder("utf-8", { fatal: false });
function decodeLenient(b: Uint8Array): string {
  return lenientUtf8Decoder.decode(b);
}

/** Go's `sliceLines` (`meat/tools.go:315-331`). */
function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split("\n");
  if (start < 1) start = 1;
  if (end < 1 || end > lines.length) end = lines.length;
  if (start > lines.length) return "";
  let out = "";
  for (let i = start; i <= end; i++) {
    out += `${i}\t${arrayAt(lines, i - 1)}\n`;
  }
  return out;
}

/** Go's `(*toolbox).readFile` (`meat/tools.go:148-166`). */
export async function readFile(tb: Toolbox, raw: Uint8Array): Promise<readonly [text: string, isError: boolean]> {
  let input: ReadFileInput;
  try {
    input = decodeReadFileInput(raw);
  } catch (err) {
    return [`invalid input: ${errorMessage(err)}`, true];
  }
  let abs: string;
  try {
    abs = resolveInRoot(tb, input.path);
  } catch (err) {
    return [errorMessage(err), true];
  }
  let data: Buffer;
  try {
    data = await readFileBytes(abs);
  } catch (err) {
    return [`read ${input.path}: ${errorMessage(err)}`, true];
  }
  let text = decodeLenient(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (input.startLine > 0 || input.endLine > 0) {
    text = sliceLines(text, input.startLine, input.endLine);
  }
  return [truncateForTool(text), false];
}

interface GrepInput {
  readonly pattern: string;
  readonly path: string;
}

function decodeGrepInput(raw: Uint8Array): GrepInput {
  const parsed: unknown = JSON.parse(decodeUTF8(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("json: cannot unmarshal into grepInput");
  }
  const obj = parsed as Record<string, unknown>;
  const pattern = "pattern" in obj ? obj["pattern"] : "";
  const path = "path" in obj ? obj["path"] : "";
  if (typeof pattern !== "string") throw new Error("json: pattern must be a string");
  if (typeof path !== "string") throw new Error("json: path must be a string");
  return { pattern, path };
}

interface GitResult {
  readonly stdout: Uint8Array;
  readonly error: (Error & { code?: number | string }) | null;
}

function runGit(args: readonly string[], cwd: string, signal: AbortSignal): Promise<GitResult> {
  return new Promise((resolveResult) => {
    execFile("git", args as string[], { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, signal }, (error, stdout) => {
      resolveResult({
        stdout: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength),
        error: error as (Error & { code?: number | string }) | null,
      });
    });
  });
}

const CR = new Uint8Array([0x0d]);
const LF = new Uint8Array([0x0a]);
// bufio.Scanner's default buffer cap (`sc.Buffer(64*1024, 1024*1024)`,
// meat/tools.go:335) — the exact H12 site.
const MAX_SCAN_LINE_BYTES = 1024 * 1024;

/**
 * Go's `capLines` (`meat/tools.go:333-348`). Operates on bytes throughout
 * (H1/H12): a single physical "line" (bufio.Scanner token) longer than
 * `MAX_SCAN_LINE_BYTES` makes the scan stop exactly as if EOF were reached —
 * silently, with no error and no truncation marker, indistinguishable from
 * genuine end-of-output. This is a documented divergence from H12's general
 * "exceeding a cap is an error" framing, reproduced deliberately (see
 * `migration/HAZARDS.md` H12 and `specs/tools.md`'s Hazards section).
 */
function capLines(s: Uint8Array, max: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let n = 0;
  let pos = 0;
  while (pos < s.length) {
    const lf = indexOf(slice(s, pos, s.length), LF);
    const tokenEnd = lf < 0 ? s.length : pos + lf;
    const nextPos = lf < 0 ? s.length : pos + lf + 1;
    if (tokenEnd - pos > MAX_SCAN_LINE_BYTES) {
      break;
    }
    let line = slice(s, pos, tokenEnd);
    if (hasSuffix(line, CR)) line = slice(line, 0, line.length - 1);
    if (n >= max) {
      parts.push(encodeUTF8(`... (truncated, more than ${max} lines)\n`));
      break;
    }
    parts.push(line, LF);
    n++;
    pos = nextPos;
  }
  return concat(parts);
}

/** Go's `(*toolbox).grep` (`meat/tools.go:173-201`) — H6 (the sole `ctx`-consuming site in this file), H12 (via `capLines`). */
export async function grep(tb: Toolbox, signal: AbortSignal, raw: Uint8Array): Promise<readonly [text: string, isError: boolean]> {
  let input: GrepInput;
  try {
    input = decodeGrepInput(raw);
  } catch (err) {
    return [`invalid input: ${errorMessage(err)}`, true];
  }
  if (trimSpace(encodeUTF8(input.pattern)).length === 0) {
    return ["pattern is required", true];
  }
  const args = ["grep", "-n", "-I", "--no-color", "-e", input.pattern];
  if (input.path !== "") {
    try {
      // Validation only — the resolved absolute path is discarded; the
      // original, unresolved string is what actually reaches `git`, which
      // resolves it itself relative to cwd (specs/tools.md Mechanism).
      resolveInRoot(tb, input.path);
    } catch (err) {
      return [errorMessage(err), true];
    }
    args.push("--", input.path);
  }
  const { stdout, error } = await runGit(args, tb.root, signal);
  if (stdout.length === 0) {
    if (error !== null && typeof error.code === "number" && error.code === 1) {
      return ["(no matches)", false];
    }
    if (error !== null) {
      return [`git grep: ${errorMessage(error)}`, true];
    }
    return ["(no matches)", false];
  }
  // If stdout is non-empty, `error` is never consulted at all, regardless of
  // its value — success is determined purely by "did stdout contain
  // anything" (specs/tools.md Mechanism step 7).
  return [truncateForTool(decodeLenient(capLines(stdout, 200))), false];
}

interface DecodedPlan {
  readonly remove: readonly LineRange[] | null;
  readonly replace: readonly EditPlanReplacement[] | null;
  readonly fold: readonly LineFold[] | null;
  readonly summary: string;
}

const EDIT_PLAN_KEYS = new Set(["remove", "replace", "fold"]);
const SUBMISSION_KEYS = new Set(["remove", "replace", "fold", "summary"]);

function decodeRange(item: unknown, context: string): LineRange {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`json: ${context} must be an object`);
  }
  const obj = item as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "start_line" && key !== "end_line") {
      throw new Error(`json: unknown field ${JSON.stringify(key)} in ${context}`);
    }
  }
  const startLine = obj["start_line"];
  const endLine = obj["end_line"];
  if (typeof startLine !== "number" || typeof endLine !== "number") {
    throw new Error(`json: ${context}.start_line/end_line must be numbers`);
  }
  return { startLine, endLine };
}

function decodeRangeArray(value: unknown, field: string): LineRange[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`json: ${field} must be an array`);
  return value.map((item, i) => decodeRange(item, `${field}[${i}]`));
}

function decodeReplace(item: unknown, context: string): EditPlanReplacement {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`json: ${context} must be an object`);
  }
  const obj = item as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "line" && key !== "old" && key !== "new") {
      throw new Error(`json: unknown field ${JSON.stringify(key)} in ${context}`);
    }
  }
  const line = obj["line"];
  const oldText = obj["old"];
  const newText = obj["new"];
  if (typeof line !== "number") throw new Error(`json: ${context}.line must be a number`);
  if (typeof oldText !== "string") throw new Error(`json: ${context}.old must be a string`);
  if (typeof newText !== "string") throw new Error(`json: ${context}.new must be a string`);
  return { line, old: oldText, new: newText };
}

function decodeReplaceArray(value: unknown): EditPlanReplacement[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("json: replace must be an array");
  return value.map((item, i) => decodeReplace(item, `replace[${i}]`));
}

/**
 * Go's `decodeStrict` (`meat/tools.go:300-313`): unknown fields (at any
 * level: top level, or a `remove`/`replace`/`fold` array element) are
 * rejected (G7), and — unlike `readFile`/`grep` — this is the strict
 * decoder `preview_plan`/`submit` use. The "multiple JSON values" check
 * Go needs a second decode attempt for is free here: `JSON.parse` already
 * rejects any trailing non-whitespace content after one complete value.
 */
function decodeEditPlanStrict(raw: Uint8Array, requireSummary: boolean): DecodedPlan {
  const parsed: unknown = JSON.parse(decodeUTF8(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("json: expected a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const allowed = requireSummary ? SUBMISSION_KEYS : EDIT_PLAN_KEYS;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`json: unknown field ${JSON.stringify(key)}`);
    }
  }
  const remove = decodeRangeArray(obj["remove"], "remove");
  const replace = decodeReplaceArray(obj["replace"]);
  const fold = decodeRangeArray(obj["fold"], "fold");
  let summary = "";
  if ("summary" in obj) {
    const summaryValue = obj["summary"];
    if (typeof summaryValue !== "string") throw new Error("json: summary must be a string");
    summary = summaryValue;
  }
  return { remove, replace, fold, summary };
}

const PLAN_ARRAYS_REQUIRED_MESSAGE = "remove, replace, and fold must all be JSON arrays (use [] when empty)";

/**
 * Go's `(*toolbox).previewPlan` (`meat/tools.go:210-223`). Never mutates
 * `tb` on any path (G5) — confirmed by inspection: no assignment to any
 * `tb.` field anywhere in this function.
 */
export function previewPlan(tb: Toolbox, raw: Uint8Array): readonly [text: string, isError: boolean] {
  let decoded: DecodedPlan;
  try {
    decoded = decodeEditPlanStrict(raw, false);
  } catch (err) {
    return [`invalid input: ${errorMessage(err)}`, true];
  }
  if (decoded.remove === null || decoded.replace === null || decoded.fold === null) {
    return [`invalid input: ${PLAN_ARRAYS_REQUIRED_MESSAGE}`, true];
  }
  const plan: EditPlan = { remove: decoded.remove, replace: decoded.replace, fold: decoded.fold };
  let compiled: CompiledPlan;
  try {
    compiled = compileEditPlanMoves(tb.rawDiff, plan, tb.moves, !tb.noMoves);
  } catch (err) {
    return [truncateForTool(`invalid edit plan: ${errorMessage(err)}`), true];
  }
  return [truncateForTool(planFeedback(compiled)), false];
}

/**
 * Go's `(*toolbox).submit` (`meat/tools.go:225-246`). The gate comes before
 * decoding (a second submission attempt never even parses its payload,
 * G10), and the five submission fields are written together in one block,
 * only after full compilation success (Invariants: this atomicity is what
 * lets `submitSeen` never coexist with a stale/empty `smartDiff`).
 */
export function submit(tb: Toolbox, raw: Uint8Array): readonly [text: string, isError: boolean] {
  if (tb.submitSeen) {
    return ["a submission has already been accepted", true];
  }
  let decoded: DecodedPlan;
  try {
    decoded = decodeEditPlanStrict(raw, true);
  } catch (err) {
    return [`invalid input: ${errorMessage(err)}`, true];
  }
  if (decoded.remove === null || decoded.replace === null || decoded.fold === null) {
    return [`invalid input: ${PLAN_ARRAYS_REQUIRED_MESSAGE}`, true];
  }
  const submission: Submission = { remove: decoded.remove, replace: decoded.replace, fold: decoded.fold, summary: decoded.summary };
  let compiled: CompiledPlan;
  try {
    compiled = compileSubmissionMoves(tb.rawDiff, submission, tb.moves, !tb.noMoves);
  } catch (err) {
    return [truncateForTool(`invalid edit plan: ${errorMessage(err)}`), true];
  }
  tb.submitted = submission;
  tb.submittedPlan = compiled;
  tb.smartDiff = compiled.smartDiff;
  tb.submitFeedback = planFeedback(compiled);
  tb.submitSeen = true;
  return [truncateForTool(tb.submitFeedback), false];
}

/** Go's `retentionPressure` (`meat/tools.go:248-253`). Exact boundary per specs/tools.md G1. */
export function retentionPressure(stats: PlanStats): boolean {
  if (stats.rawChanged < 40 || stats.visibleChanged < 20) return false;
  return stats.visibleChanged >= 80 || stats.visibleChanged * 100 >= stats.rawChanged * 45;
}

// The static model-visible plan-feedback fragments (`meat/tools.go:257-262`),
// named so the deferred `promptSurface()` (item 4n) can hash the complete
// frozen surface — quoted verbatim here, not reproduced twice.
export const feedbackPressureHigh =
  "Pressure: high retention. Reconsider repeated rename/call-site hunks after one representative anchor, default git context, mechanical prose, duplicate setup/cases, and assertion batches or suites that can become fixed ... folds. Imports are already removed mechanically. For Python, keep each suite owner, required setup, and decisive stimulus/outcome: never hide a table assignment used by a retained loop, or an entire pytester.makeini/makeconftest configuration that defines the scenario. Move folds inside those boundaries. This is advisory: preserve every distinct contract, security or compatibility caveat, condition, lifecycle edge, transformation, effect, stimulus, and outcome.\n";
export const feedbackPressureOK = "Pressure: acceptable. Preserve uncertain behavior.\n";

/** Go's `planFeedback` (`meat/tools.go:264-290`). Shared by `previewPlan`/`submit`'s success paths. */
export function planFeedback(compiled: CompiledPlan): string {
  const stats = compiled.stats;
  // H8: integer division truncates toward zero.
  const percent = stats.rawChanged > 0 ? Math.trunc((stats.visibleChanged * 100) / stats.rawChanged) : 0;
  let out = `Valid source-derived plan.\nRetention: ${stats.visibleChanged}/${stats.rawChanged} visible changed rows (${percent}%); ${stats.removedChanged} removed, ${stats.foldedChanged} hidden by ${stats.foldCount} folds`;
  if (stats.rawFiles > 0) {
    out += `; files ${stats.visibleFiles}/${stats.rawFiles}`;
  }
  out += ".\n";
  if (compiled.moves.length > 0) {
    out += `Moves: ${compiled.moves.length} exact cross-hunk/cross-file span(s) treated symmetrically (${formatMovePairs(compiled.moves, maxMoveHints)}).\n`;
  }
  out += retentionPressure(stats) ? feedbackPressureHigh : feedbackPressureOK;
  out += "Preview (revised plans still use ORIGINAL line coordinates):\n";
  out += decodeUTF8(compiled.smartDiff);
  return out;
}

/**
 * Go's `(*toolbox).clearSubmission` (`meat/tools.go:292-298`): resets all
 * five submission fields to zero value. Not called anywhere in this file —
 * its only caller is the agent loop's one-time refinement path (item 4n).
 */
export function clearSubmission(tb: Toolbox): void {
  tb.smartDiff = new Uint8Array(0);
  tb.submitted = null;
  tb.submittedPlan = null;
  tb.submitFeedback = "";
  tb.submitSeen = false;
}

/**
 * Go's `truncateForTool` (`meat/tools.go:350-359`) — H1: the cut point is a
 * byte offset walked back to the nearest UTF-8 rune boundary, never a
 * character-count truncation. Applied selectively by callers in this file,
 * not to every returned string (specs/tools.md Mechanism "Truncation").
 */
export function truncateForTool(s: string): string {
  const bytes = encodeUTF8(s);
  if (bytes.length <= maxToolOutput) return s;
  let cut = maxToolOutput;
  while (cut > 0 && !isRuneStart(at(bytes, cut))) cut--;
  return decodeUTF8(slice(bytes, 0, cut)) + `\n... (truncated, ${bytes.length} total bytes)`;
}
