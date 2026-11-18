// Opt-in offline artifacts. Coordinates always refer to captured original bytes.
import { canonicalJSON, hashBytes, SnapshotError, type EvidenceSnapshot } from "./snapshot.ts";
import { analyzeDiff, splitSourceLines, validateSupportedDiff, type SourceLine } from "../meat/diff.ts";
import { fitsSingleRun, splitDiffForAbridging, maxTotalDiffBytes, mapMovesToChunk } from "../meat/chunk.ts";
import { detectExactMoves } from "../meat/moves.ts";
import { mandatoryImportRemovalPlan, mandatoryRemovalMask } from "../meat/imports.ts";
import { applyMandatoryMovePrecedence } from "../meat/moves.ts";
import { maxDiffBytes } from "../meat/meat.ts";
import { RubricHash } from "../meat/rubric.ts";

export const observeOperations = ["inventory", "evidence", "plan", "capabilities"] as const;
export type ObserveOperation = typeof observeOperations[number];
export const observeHelp = `  -inventory      Emit a bounded versioned offline inventory as JSON.
  -evidence id    Expand an inventory entry as paginated original bytes (base64).
  -plan           Forecast API partitions for captured snapshot bytes. No model.
  -capabilities   Report local operations and controls. No source or auth probe.
  -page-size n    Inventory/plan entries per page (default 20, maximum 100).
  -max-bytes n    Evidence bytes per page (default 8192, maximum 16384).
  -cursor token  Continue a page; rejects changed snapshots or queries.
  -snapshot id   Require this snapshot identity before selection/expansion.
`;

export interface OriginalRange {
  readonly byte_start: number;
  readonly byte_end: number;
  readonly line_start: number;
  readonly line_end: number;
}

export interface InventoryEntry {
  readonly id: string;
  readonly kind: "file" | "hunk" | "envelope" | "relationship";
  readonly parent: string | null;
  readonly range: OriginalRange;
  readonly content: "text" | "binary" | "metadata" | "combined" | "envelope";
  readonly old_path: string | null;
  readonly new_path: string | null;
  readonly paths_truncated: boolean;
  readonly source_lines: { readonly old_start: number; readonly old_count: number; readonly new_start: number; readonly new_count: number } | null;
  readonly relationship?: { readonly removed: OriginalRange; readonly added: OriginalRange };
}

export interface Observation {
  readonly snapshot: EvidenceSnapshot;
  readonly lines: readonly SourceLine[];
  readonly offsets: readonly number[];
  readonly entries: readonly InventoryEntry[];
  readonly numberedBytes: number;
  readonly compiler: { readonly eligible: boolean; readonly reason: string | null };
}

const display = new TextDecoder("utf-8");
const prefix = (raw: Uint8Array, value: string): boolean => {
  const expected = Buffer.from(value);
  return raw.length >= expected.length && expected.every((b, i) => raw[i] === b);
};
const boundedText = (raw: Uint8Array): string => display.decode(raw.subarray(0, 512));
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1024);

function range(offsets: readonly number[], start: number, end: number): OriginalRange {
  return { byte_start: offsets[start]!, byte_end: offsets[end]!, line_start: start + 1, line_end: end + 1 };
}

// Git's quoted path encoding can contain octal UTF-8 bytes, not JSON escapes.
function pathText(raw: Uint8Array): string {
  const text = boundedText(raw);
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const bytes: number[] = [];
  for (let i = 1; i < raw.length - 1 && i < 512; i++) {
    const b = raw[i]!;
    if (b !== 92) { bytes.push(b); continue; }
    const next = raw[++i]!;
    if (next >= 48 && next <= 55 && i + 2 < raw.length - 1) {
      const digits = String.fromCharCode(next, raw[i + 1]!, raw[i + 2]!);
      if (/^[0-7]{3}$/.test(digits)) { bytes.push(parseInt(digits, 8)); i += 2; continue; }
    }
    bytes.push(next === 116 ? 9 : next === 110 ? 10 : next === 114 ? 13 : next);
  }
  return display.decode(Uint8Array.from(bytes));
}

function headerPaths(raw: Uint8Array): readonly [Uint8Array | null, Uint8Array | null] {
  const value = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).subarray(11);
  if (value[0] === 34) {
    let i = 1;
    for (; i < value.length; i++) {
      if (value[i] === 92) { i++; continue; }
      if (value[i] === 34) return [value.subarray(0, i + 1), value.subarray(i + 2)];
    }
    return [value, null];
  }
  const separator = value.indexOf(" b/");
  if (separator >= 0) {
    // Spaces are legal in unquoted Git paths. Prefer the split whose a/ and
    // b/ names agree; rename/copy metadata supplies differing names below.
    for (let split = separator; split >= 0; split = value.indexOf(" b/", split + 1)) {
      if (value.subarray(2, split).equals(value.subarray(split + 3))) {
        return [value.subarray(0, split), value.subarray(split + 1)];
      }
    }
    return [value.subarray(0, separator), value.subarray(separator + 1)];
  }
  return [null, null];
}

export function observeSnapshot(snapshot: EvidenceSnapshot): Observation {
  const lines = splitSourceLines(snapshot.diff);
  const layout = analyzeDiff(lines);
  const offsets = [0];
  let textBytes = 0;
  for (const line of lines) {
    textBytes += line.text.length;
    offsets.push(offsets[offsets.length - 1]! + line.text.length + line.eol.length);
  }
  const numberedBytes = textBytes + lines.length * (String(lines.length).length + 2);
  let compiler: Observation["compiler"] = { eligible: true, reason: null };
  try {
    validateSupportedDiff(snapshot.diff);
    if (snapshot.diff.length > maxTotalDiffBytes) throw new Error("Input exceeds the engine's aggregate diff byte limit; raw evidence remains available.");
  }
  catch (error) { compiler = { eligible: false, reason: message(error) }; }

  const boundaries: { start: number; kind: "file" | "envelope" }[] = [];
  let combinedSection = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    const combinedHeader = prefix(text, "diff --cc ") || prefix(text, "diff --combined ");
    if (combinedHeader) combinedSection = true;
    else if (layout.kinds[i] === "header" || layout.kinds[i] === "mail_signature") combinedSection = false;
    if (layout.kinds[i] === "header" || combinedHeader ||
        (!combinedSection && layout.kinds[i] === "old_file" && (i === 0 || layout.fileId[i - 1] !== layout.fileId[i]))) {
      boundaries.push({ start: i, kind: "file" });
    } else if (layout.kinds[i] === "mail_signature") {
      boundaries.push({ start: i, kind: "envelope" });
    }
  }
  if (boundaries[0]?.start !== 0 && lines.length > 0) boundaries.unshift({ start: 0, kind: "envelope" });
  const entries: InventoryEntry[] = [];
  for (let j = 0; j < boundaries.length; j++) {
    const { start, kind } = boundaries[j]!;
    const end = boundaries[j + 1]?.start ?? lines.length;
    const id = `${kind === "file" ? "f" : "m"}:${offsets[start]}`;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let truncated = false;
    let content: InventoryEntry["content"] = kind === "envelope" ? "envelope" : "metadata";
    const hunks: number[] = [];
    if (kind === "file" && prefix(lines[start]!.text, "diff --git ")) {
      const paths = headerPaths(lines[start]!.text);
      oldPath = paths[0] ? pathText(paths[0]) : null;
      newPath = paths[1] ? pathText(paths[1]) : null;
      truncated = paths.some(p => p !== null && p.length > 512);
    }
    for (let i = start; i < end; i++) {
      const raw = lines[i]!.text;
      const lineKind = layout.kinds[i];
      if (lineKind === "old_file" || lineKind === "new_file") {
        const path = raw.subarray(4);
        const tab = path.indexOf(9);
        const value = path.subarray(0, tab < 0 ? path.length : tab);
        truncated ||= value.length > 512;
        if (lineKind === "old_file") oldPath = pathText(value);
        else newPath = pathText(value);
      } else if (lineKind === "rename_from" || lineKind === "copy_from") {
        const value = raw.subarray(lineKind === "rename_from" ? 12 : 10);
        oldPath = pathText(value); truncated ||= value.length > 512;
      } else if (lineKind === "rename_to" || lineKind === "copy_to") {
        const value = raw.subarray(lineKind === "rename_to" ? 10 : 8);
        newPath = pathText(value); truncated ||= value.length > 512;
      }
      if (lineKind === "hunk_header" || prefix(raw, "@@@ ")) hunks.push(i);
      if (prefix(raw, "GIT binary patch") || prefix(raw, "Binary files ")) content = "binary";
      if (prefix(raw, "diff --cc ") || prefix(raw, "diff --combined ")) content = "combined";
    }
    if (hunks.length > 0 && content === "metadata") content = "text";
    entries.push({ id, kind, parent: null, range: range(offsets, start, end), content,
      old_path: oldPath, new_path: newPath, paths_truncated: truncated, source_lines: null });
    for (let h = 0; h < hunks.length; h++) {
      const first = hunks[h]!;
      let last = hunks[h + 1] ?? end;
      if (layout.kinds[first] === "hunk_header" && !prefix(lines[first]!.text, "@@@")) {
        let bodyEnd = first + 1;
        while (bodyEnd < last && layout.hunkId[bodyEnd] === layout.hunkId[first]) bodyEnd++;
        last = bodyEnd;
      }
      const header = boundedText(lines[first]!.text);
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
      const values = match ? [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)] : null;
      const sourceLines = values?.every(Number.isSafeInteger) ? {
        old_start: values[0]!, old_count: values[1]!, new_start: values[2]!, new_count: values[3]!,
      } : null;
      entries.push({ id: `h:${offsets[first]}`, kind: "hunk", parent: id, range: range(offsets, first, last),
        content, old_path: null, new_path: null, paths_truncated: false, source_lines: sourceLines });
    }
  }
  if (compiler.eligible) {
    for (const move of detectExactMoves(lines, layout)) {
      const removed = range(offsets, move.removed.startLine - 1, move.removed.endLine);
      const added = range(offsets, move.added.startLine - 1, move.added.endLine);
      entries.push({ id: `v:${removed.byte_start}:${added.byte_start}`, kind: "relationship", parent: null,
        range: range(offsets, Math.min(move.removed.startLine, move.added.startLine) - 1, Math.max(move.removed.endLine, move.added.endLine)),
        content: "text", old_path: null, new_path: null, paths_truncated: false, source_lines: null, relationship: { removed, added } });
    }
  }
  entries.sort((a, b) => a.range.byte_start - b.range.byte_start || (a.kind === "file" ? -1 : b.kind === "file" ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { snapshot, lines, offsets, entries, numberedBytes, compiler };
}

interface Cursor {
  readonly version: 1;
  readonly snapshot: string;
  readonly query: string;
  readonly offset: number;
}

function cursorToken(snapshot: string, query: string, offset: number): string {
  const payload = canonicalJSON({ version: 1, snapshot, query, offset });
  return Buffer.from(payload).toString("base64url") + "." + hashBytes(Buffer.from(payload));
}

function cursorOffset(token: string, snapshot: string, query: string, total: number): number {
  if (token === "") return 0;
  try {
    if (token.length > 2048) throw new Error("oversized cursor");
    const [encoded, digest, extra] = token.split(".");
    const raw = Buffer.from(encoded ?? "", "base64url");
    if (extra !== undefined || hashBytes(raw) !== digest) throw new Error("invalid cursor checksum");
    const value = JSON.parse(raw.toString("utf8")) as Cursor;
    if (value.version !== 1) throw new Error("unsupported cursor version");
    if (value.snapshot !== snapshot) throw new SnapshotError("source_changed", "Continuation belongs to a different snapshot; capture a new inventory.");
    if (value.query !== query || !Number.isSafeInteger(value.offset) || value.offset <= 0 || value.offset >= total) throw new Error("cursor does not match this query");
    return value.offset;
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("invalid_request", `Invalid continuation: ${message(error)}`);
  }
}

function envelope(observation: Observation, kind: string) {
  const { snapshot } = observation;
  return { schema: "meat.observe", version: 1, kind, snapshot: {
    id: snapshot.id, input_digest: snapshot.input_digest, source: snapshot.source, context: snapshot.context,
    // Display labels are observations; bounded forms never participate in identity.
    observations: { selector: snapshot.observations.selector.slice(0, 512), repository: snapshot.observations.repository?.slice(0, 512) ?? null },
  } };
}

function paginate<T>(items: readonly T[], observation: Observation, query: string, limit: number, token: string) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SnapshotError("invalid_request", "Page size must be from 1 to 100");
  const offset = cursorOffset(token, observation.snapshot.id, query, items.length);
  const end = Math.min(items.length, offset + limit);
  return { entries: items.slice(offset, end), page: { offset, total: items.length, omitted: items.length - end,
    next: end < items.length ? cursorToken(observation.snapshot.id, query, end) : null } };
}

export function inventoryArtifact(observation: Observation, limit = 20, cursor = "") {
  return { ...envelope(observation, "inventory"), input: {
    bytes: observation.snapshot.diff.length, numbered_bytes: observation.numberedBytes, lines: observation.lines.length,
  }, compiler: observation.compiler, coordinate_space: "original_diff; bytes 0-based, lines 1-based, ends exclusive",
  summary: { files: observation.entries.filter(e => e.kind === "file").length,
    hunks: observation.entries.filter(e => e.kind === "hunk").length, regions: observation.entries.filter(e => e.kind === "file" || e.kind === "envelope").length,
    relationships: observation.entries.filter(e => e.kind === "relationship").length },
  ...paginate(observation.entries, observation, `inventory:${limit}`, limit, cursor) };
}

export function evidenceArtifact(observation: Observation, id: string, maxBytes = 8192, cursor = "") {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16384) throw new SnapshotError("invalid_request", "Evidence byte limit must be from 1 to 16384");
  const entry = observation.entries.find(e => e.id === id);
  if (!entry) throw new SnapshotError("invalid_request", `Unknown evidence entry ${id.slice(0, 128)}; inspect the inventory first.`);
  const size = entry.range.byte_end - entry.range.byte_start;
  const offset = cursorOffset(cursor, observation.snapshot.id, `evidence:${id}:${maxBytes}`, size);
  const start = entry.range.byte_start + offset;
  const end = Math.min(entry.range.byte_end, start + maxBytes);
  let firstLine = entry.range.line_start - 1;
  while (observation.offsets[firstLine + 1]! <= start) firstLine++;
  let lastLine = firstLine;
  while (observation.offsets[lastLine + 1]! < end) lastLine++;
  const crossBoundary = observation.entries.filter(e => {
    if (!e.relationship) return false;
    const overlaps = (r: OriginalRange) => r.byte_start < entry.range.byte_end && r.byte_end > entry.range.byte_start;
    return overlaps(e.relationship.removed) !== overlaps(e.relationship.added);
  });
  return { ...envelope(observation, "evidence"), selection: {
    id, parent_snapshot: observation.snapshot.id, range: entry.range,
    excluded_bytes: observation.snapshot.diff.length - size, coverage: "selected original bytes only; parent review not established",
  }, range: { byte_start: start, byte_end: end, line_start: firstLine + 1, line_end: lastLine + 2 },
  encoding: "base64", data: Buffer.from(observation.snapshot.diff.subarray(start, end)).toString("base64"),
  relationships: { basis: "deterministic_exact_moves", crossing: crossBoundary.slice(0, 20).map(e => e.id), total: crossBoundary.length,
    omitted: Math.max(0, crossBoundary.length - 20), discovery: "parent inventory pages include all relationship entries" },
  page: { offset, total: size, omitted: entry.range.byte_end - end, completeness: end === entry.range.byte_end ? "complete" : "truncated",
    next: end < entry.range.byte_end ? cursorToken(observation.snapshot.id, `evidence:${id}:${maxBytes}`, end - entry.range.byte_start) : null } };
}

function originRanges(origins: readonly number[]): { line_start: number; line_end: number }[] {
  const sorted = [...new Set(origins.filter(i => i >= 0))].sort((a, b) => a - b);
  const result: { line_start: number; line_end: number }[] = [];
  for (const i of sorted) {
    const last = result[result.length - 1];
    if (last?.line_end === i + 1) last.line_end = i + 2;
    else result.push({ line_start: i + 1, line_end: i + 2 });
  }
  return result;
}

export function planningArtifact(observation: Observation, limit = 20, cursor = "") {
  const { snapshot, compiler, lines } = observation;
  const layout = analyzeDiff(lines);
  let eligible = compiler.eligible;
  let reason = compiler.reason;
  let chunks: ReturnType<typeof splitDiffForAbridging> = [];
  try {
    if (eligible) {
      if (fitsSingleRun(snapshot.diff, maxDiffBytes)) chunks = [{ text: snapshot.diff, origins: lines.map((_, i) => i),
        metaPrefix: new Uint8Array(), sectionId: -1, continuation: false, passthrough: false }];
      else {
        if (snapshot.diff.length > maxTotalDiffBytes) throw new Error("Input exceeds the engine's aggregate diff byte limit; select a narrower range.");
        chunks = splitDiffForAbridging(snapshot.diff, maxDiffBytes);
      }
    }
  } catch (error) { eligible = false; reason = message(error); }
  const moves = compiler.eligible ? detectExactMoves(lines, layout) : [];
  const partitions = chunks.map((chunk, i) => {
    const spans = originRanges(chunk.origins);
    const chunkLines = splitSourceLines(chunk.text);
    const selected = new Set(chunk.origins);
    const mapped = mapMovesToChunk(moves, chunk.origins);
    const completeMoves = new Set(mapped.map(move => `${chunk.origins[move.removed.startLine - 1]}:${chunk.origins[move.added.startLine - 1]}`));
    const intersects = (start: number, end: number): boolean => {
      for (let line = start - 1; line < end; line++) if (selected.has(line)) return true;
      return false;
    };
    return { id: `p:${i}`, bytes: chunk.text.length, numbered_bytes: chunkLines.reduce((n, l) => n + l.text.length, 0) +
      chunkLines.length * (String(chunkLines.length).length + 2),
      passthrough: chunk.passthrough, original_ranges: spans.slice(0, 32), ranges_omitted: Math.max(0, spans.length - 32),
      origin_mapping: chunk.origins.length === 0 && chunk.text.length > 0 ? "unavailable" : "recorded",
      omitted_range_details: spans.length > 32 ? "unavailable_in_this_plan; full witnesses pending P3" : "none",
      synthetic_lines: chunk.origins.filter(n => n < 0).length,
      relationships: moves.filter(move => {
        return (intersects(move.removed.startLine, move.removed.endLine) || intersects(move.added.startLine, move.added.endLine)) &&
          !completeMoves.has(`${move.removed.startLine - 1}:${move.added.startLine - 1}`);
      }).length };
  });
  const mandatory = compiler.eligible ? mandatoryRemovalMask(lines.length, mandatoryImportRemovalPlan(lines, layout)) : [];
  if (compiler.eligible) applyMandatoryMovePrecedence(moves, mandatory);
  const planIdentity = hashBytes(Buffer.from(canonicalJSON({ version: 1, snapshot: snapshot.id, workflow: "api",
    context_policy: "legacy_live_checkout", rubric_protocol: RubricHash(), partition_policy: "legacy.v1", partition_budget: maxDiffBytes })));
  return { ...envelope(observation, "execution_plan"), plan_id: planIdentity, workflow: "api", dispatch: "not_performed",
    input_basis: "observation_snapshot", legacy_selector_execution_equivalence: "not_assessed",
    compiler: { eligible, reason }, context_policy: "legacy_live_checkout; source binding is not implemented for execution",
    tools: { read_file: "live_checkout", search: "live_checkout" }, cache: { eligibility: "unassessed", reason: "Legacy cache lacks evidence/context identity; planning does not read it." },
    limits: { per_partition_bytes: maxDiffBytes, aggregate_diff_bytes: maxTotalDiffBytes, aggregate_execution_budget: "unsupported" },
    forecast: { partitions: chunks.length, model_runs: chunks.filter(c => !c.passthrough).length, model_calls: "unknown", tokens: "unknown", cost: "unknown" },
    coverage: { selected_bytes: snapshot.diff.length, partition_origins: "original_diff_lines", mandatory_removed_lines: mandatory.filter(Boolean).length,
      compiler_owned_omissions: "import and exact-move precedence forecast; final witness pending P3",
      cross_partition_move_validation: "not_performed", semantic_validation: "not_performed" },
    ...paginate(partitions, observation, `plan:${limit}`, limit, cursor) };
}

export function capabilityArtifact() {
  return { schema: "meat.observe", version: 1, kind: "capabilities", operations: observeOperations,
    artifacts: ["inventory", "evidence", "execution_plan", "capabilities"], schemas: { "meat.observe": [1] },
    execution: { models: "not_probed", gateway: "not_probed", subscription_auth: "unknown" },
    adapters: { api: { available: "not_probed", context: "live_checkout", usage: "provider_reported" },
      codex: { available: "not_probed", authentication: "unknown", usage: "unknown" },
      claude: { available: "not_probed", authentication: "unknown", usage: "unknown" }, current_session: { usage: "unknown" } },
    controls: { bounded_inventory: "supported", original_byte_expansion: "supported", deterministic_partition_forecast: "supported",
      snapshot_context_tools: "unsupported", aggregate_deadline: "unsupported", aggregate_model_calls: "unsupported", hard_token_cap: "unsupported", hard_money_cap: "unsupported", resume: "unsupported" },
    bounds: { default_page_size: 20, max_page_size: 100, default_evidence_bytes: 8192, max_evidence_bytes: 16384 },
    legacy: ["-look", "-prompt", "-agent", "-json", "API abridging"] };
}
