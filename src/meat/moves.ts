// moves.ts — exact, source-evidenced detection of code relocated between two
// different hunks of the same diff (meat/moves.go). A move is real only
// when both sides are byte-identical modulo a constant per-row indentation
// offset; nothing here guesses. H1: byte-oriented throughout — normalized
// line bodies, byte-length budgets, and replacement splicing all operate on
// `Uint8Array`, never a decoded string.

import { at, arrayAt, slice, equals, runes, isLetterRune, isNumberRune, isSpaceRune } from "./bytes.ts";
import {
  type SourceLine,
  type DiffLayout,
  isHunkSource,
  splitSourceLines,
  analyzeDiff,
  joinEditPlanErrors,
} from "./diff.ts";
import { type LineRange, type PlanState, type PlannedReplacement, applyPlannedReplacements, leadingWhitespace } from "./plan.ts";

export const minMoveSubstantiveRows = 3;
export const minMoveNonspaceBytes = 48;
export const maxMoveHints = 12;

const SPACE = 0x20;
const TAB = 0x09;
const MINUS = 0x2d;
const PLUS = 0x2b;

/** Go's `detectedMove` (`meat/moves.go:17-23`): two inclusive, 1-based physical-line ranges in the original diff. */
export interface DetectedMove {
  readonly removed: LineRange;
  readonly added: LineRange;
}

/** Go's `moveLineInfo` (`meat/moves.go:31-35`). */
export interface MoveLineInfo {
  readonly normalized: Uint8Array;
  readonly indent: number;
  readonly substantive: boolean;
}

const ZERO_INFO: MoveLineInfo = { normalized: new Uint8Array(0), indent: 0, substantive: false };

interface MoveRun {
  readonly start: number; // zero-based, inclusive
  readonly end: number; // zero-based, inclusive
  readonly hunkId: number;
}

interface MoveOccurrence {
  readonly index: number;
  readonly marker: number; // byte
}

interface MoveAnchor {
  removed: number;
  added: number;
}

/**
 * Converts normalized line bytes into a lossless string key for `Map`
 * bucketing only — never used for text semantics. A byte-for-byte (Latin-1
 * style) mapping, so it agrees exactly with Go's byte-exact `string` map
 * keys, unlike a UTF-8 decode (which can throw on invalid sequences and
 * would be the wrong tool for a pure hashing/bucketing key anyway).
 */
function byteKey(b: Uint8Array): string {
  let key = "";
  for (let i = 0; i < b.length; i++) {
    key += String.fromCharCode(at(b, i));
  }
  return key;
}

function trimRightASCII(b: Uint8Array): Uint8Array {
  let end = b.length;
  while (end > 0) {
    const c = at(b, end - 1);
    if (c !== SPACE && c !== TAB) break;
    end--;
  }
  return slice(b, 0, end);
}

/**
 * Go's `normalizeMoveLine` (`meat/moves.go:200-216`). The trailing trim is
 * deliberately ASCII-literal-only (space/tab) — a *different* whitespace
 * definition from `substantialMove`'s Unicode-space scan below (H2); do not
 * unify them.
 */
export function normalizeMoveLine(bodyIn: Uint8Array): MoveLineInfo {
  const body = trimRightASCII(bodyIn);
  const indentText = leadingWhitespace(body);
  const normalized = slice(body, indentText.length, body.length);
  let substantive = false;
  for (const r of runes(normalized)) {
    if (isLetterRune(r.codePoint) || isNumberRune(r.codePoint)) {
      substantive = true;
      break;
    }
  }
  return { normalized, indent: indentationColumns(indentText), substantive };
}

/** Go's `indentationColumns` (`meat/moves.go:218-228`): tabs advance to the next multiple of 8; anything else advances by 1. */
export function indentationColumns(indent: Uint8Array): number {
  let columns = 0;
  for (const r of runes(indent)) {
    if (r.codePoint === TAB) {
      columns += 8 - (columns % 8);
    } else {
      columns++;
    }
  }
  return columns;
}

/** Go's `moveRowsMatch` (`meat/moves.go:230-238`). */
export function moveRowsMatch(removed: MoveLineInfo, added: MoveLineInfo, indentOffset: number): boolean {
  if (!equals(removed.normalized, added.normalized)) return false;
  if (removed.normalized.length === 0) return true;
  return added.indent - removed.indent === indentOffset;
}

/**
 * Go's `substantialMove` (`meat/moves.go:240-254`). The two counters are
 * independent measurements over the same window, not implications of one
 * another — see `specs/moves.md` Invariants.
 */
export function substantialMove(infos: readonly MoveLineInfo[], start: number, end: number): boolean {
  let substantiveRows = 0;
  let nonspaceBytes = 0;
  for (let i = start; i <= end; i++) {
    const info = arrayAt(infos, i);
    if (info.substantive) substantiveRows++;
    for (const r of runes(info.normalized)) {
      if (!isSpaceRune(r.codePoint)) nonspaceBytes += r.size;
    }
  }
  return substantiveRows >= minMoveSubstantiveRows && nonspaceBytes >= minMoveNonspaceBytes;
}

/** Go's `rangesOverlap` (`meat/moves.go:256-258`): inclusive-range overlap. */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Go's `detectExactMoves` (`meat/moves.go:58-198`). Conservatively pairs
 * exact changed runs across hunks: a globally unique substantive line
 * anchors each candidate; extension requires byte-exact bodies after
 * leading/trailing indentation normalization and one constant indentation
 * offset for every nonblank row. Small or overlapping candidates are
 * discarded rather than guessed.
 */
export function detectExactMoves(lines: readonly SourceLine[], layout: DiffLayout): DetectedMove[] {
  if (lines.length === 0 || layout.kinds.length !== lines.length) return [];

  const infos: MoveLineInfo[] = new Array(lines.length).fill(ZERO_INFO);
  const occurrences = new Map<string, MoveOccurrence[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    if (!isHunkSource(arrayAt(layout.kinds, i)) || line.text.length < 1) continue;
    const info = normalizeMoveLine(slice(line.text, 1, line.text.length));
    infos[i] = info;
    if (info.substantive) {
      const key = byteKey(info.normalized);
      const occurrence: MoveOccurrence = { index: i, marker: at(line.text, 0) };
      const bucket = occurrences.get(key);
      if (bucket) bucket.push(occurrence);
      else occurrences.set(key, [occurrence]);
    }
  }

  const runs: MoveRun[] = [];
  const runAt: number[] = new Array(lines.length).fill(-1);
  {
    let i = 0;
    while (i < lines.length) {
      const text = arrayAt(lines, i).text;
      const first = text.length > 0 ? at(text, 0) : -1;
      if (arrayAt(layout.kinds, i) !== "hunk_change" || text.length === 0 || (first !== MINUS && first !== PLUS)) {
        i++;
        continue;
      }
      const marker = first;
      const hunkId = arrayAt(layout.hunkId, i);
      const start = i;
      while (
        i + 1 < lines.length &&
        arrayAt(layout.kinds, i + 1) === "hunk_change" &&
        arrayAt(lines, i + 1).text.length > 0 &&
        at(arrayAt(lines, i + 1).text, 0) === marker &&
        arrayAt(layout.hunkId, i + 1) === hunkId
      ) {
        i++;
      }
      const runIndex = runs.length;
      runs.push({ start, end: i, hunkId });
      for (let j = start; j <= i; j++) runAt[j] = runIndex;
      i++;
    }
  }

  const anchors: MoveAnchor[] = [];
  for (const found of occurrences.values()) {
    if (found.length !== 2) continue;
    const anchor: MoveAnchor = { removed: -1, added: -1 };
    for (const occurrence of found) {
      if (occurrence.marker === MINUS) anchor.removed = occurrence.index;
      else if (occurrence.marker === PLUS) anchor.added = occurrence.index;
    }
    if (anchor.removed >= 0 && anchor.added >= 0) anchors.push(anchor);
  }
  anchors.sort((a, b) => (a.removed !== b.removed ? a.removed - b.removed : a.added - b.added));

  const candidateSet = new Map<string, DetectedMove>();
  const lastSegment = new Map<string, DetectedMove>();
  for (const anchor of anchors) {
    const removed = anchor.removed;
    const added = anchor.added;
    const removedRunIndex = arrayAt(runAt, removed);
    const addedRunIndex = arrayAt(runAt, added);
    if (removedRunIndex < 0 || addedRunIndex < 0) continue;
    const removedRun = arrayAt(runs, removedRunIndex);
    const addedRun = arrayAt(runs, addedRunIndex);
    if (removedRun.hunkId < 0 || removedRun.hunkId === addedRun.hunkId) continue;

    const alignmentKey = `${removedRunIndex}:${addedRunIndex}:${removed - added}`;
    const previous = lastSegment.get(alignmentKey);
    if (
      previous !== undefined &&
      removed + 1 >= previous.removed.startLine &&
      removed + 1 <= previous.removed.endLine &&
      added + 1 >= previous.added.startLine &&
      added + 1 <= previous.added.endLine
    ) {
      continue;
    }

    const indentOffset = arrayAt(infos, added).indent - arrayAt(infos, removed).indent;
    let removedStart = removed;
    let removedEnd = removed;
    let addedStart = added;
    let addedEnd = added;
    while (
      removedStart > removedRun.start &&
      addedStart > addedRun.start &&
      moveRowsMatch(arrayAt(infos, removedStart - 1), arrayAt(infos, addedStart - 1), indentOffset)
    ) {
      removedStart--;
      addedStart--;
    }
    while (
      removedEnd < removedRun.end &&
      addedEnd < addedRun.end &&
      moveRowsMatch(arrayAt(infos, removedEnd + 1), arrayAt(infos, addedEnd + 1), indentOffset)
    ) {
      removedEnd++;
      addedEnd++;
    }

    const candidate: DetectedMove = {
      removed: { startLine: removedStart + 1, endLine: removedEnd + 1 },
      added: { startLine: addedStart + 1, endLine: addedEnd + 1 },
    };
    lastSegment.set(alignmentKey, candidate);
    if (substantialMove(infos, removedStart, removedEnd)) {
      const candidateKey = `${candidate.removed.startLine}-${candidate.removed.endLine}:${candidate.added.startLine}-${candidate.added.endLine}`;
      candidateSet.set(candidateKey, candidate);
    }
  }

  const candidates = [...candidateSet.values()];
  candidates.sort((a, b) => {
    if (a.removed.startLine !== b.removed.startLine) return a.removed.startLine - b.removed.startLine;
    if (a.added.startLine !== b.added.startLine) return a.added.startLine - b.added.startLine;
    return a.removed.endLine - b.removed.endLine;
  });

  const ambiguous: boolean[] = new Array(candidates.length).fill(false);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (
        rangesOverlap(arrayAt(candidates, i).removed, arrayAt(candidates, j).removed) ||
        rangesOverlap(arrayAt(candidates, i).added, arrayAt(candidates, j).added)
      ) {
        ambiguous[i] = true;
        ambiguous[j] = true;
      }
    }
  }
  const moves: DetectedMove[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (!arrayAt(ambiguous, i)) moves.push(arrayAt(candidates, i));
  }
  return moves;
}

/** Go's `detectedMovesInDiff` (`meat/moves.go:441-448`). */
export function detectedMovesInDiff(raw: Uint8Array): DetectedMove[] {
  const lines = splitSourceLines(raw);
  const layout = analyzeDiff(lines);
  if (layout.problems.length > 0) return [];
  return detectExactMoves(lines, layout);
}

/**
 * Go's `applyMandatoryMovePrecedence` (`meat/moves.go:260-280`): gives
 * compiler-mandatory import hiding priority over model move enforcement. A
 * single OR-propagate pass, not a fixpoint — safe because moves are
 * pairwise non-overlapping by construction (detection's own postcondition).
 * Mutates `mandatory` in place, exactly as Go mutates the slice.
 */
export function applyMandatoryMovePrecedence(moves: readonly DetectedMove[], mandatory: boolean[]): void {
  for (const move of moves) {
    const rows = move.removed.endLine - move.removed.startLine + 1;
    for (let offset = 0; offset < rows; offset++) {
      const removed = move.removed.startLine + offset - 1;
      const added = move.added.startLine + offset - 1;
      if (removed < 0 || removed >= mandatory.length || added < 0 || added >= mandatory.length) continue;
      if (arrayAt(mandatory, removed) || arrayAt(mandatory, added)) {
        mandatory[removed] = true;
        mandatory[added] = true;
      }
    }
  }
}

/** Go's `moveCompression` (`meat/moves.go:282-290`). */
export type MoveCompression = "kept" | "removed" | "fold_start" | "fold_middle" | "fold_end";
/** Go's `moveCompressionKind` (`meat/moves.go:318-324`). */
export type MoveCompressionKind = "kept" | "removed" | "folded";

/** Go's `(moveCompression).kind()` (`meat/moves.go:326-335`). */
export function moveCompressionKind(c: MoveCompression): MoveCompressionKind {
  if (c === "kept") return "kept";
  if (c === "removed") return "removed";
  return "folded";
}

/**
 * Go's `compressionAt` (`meat/moves.go:292-316`). A mandatory row
 * canonicalizes as "removed" **before** any plan-state/fold inspection —
 * this runs first so a compiler-owned Python suite placeholder standing in
 * for a mandatory row never reads as "folded" here.
 */
export function compressionAt(state: PlanState, mandatory: readonly boolean[], line: number): MoveCompression {
  const index = line - 1;
  if (index >= 0 && index < mandatory.length && arrayAt(mandatory, index)) {
    return "removed";
  }
  if (!arrayAt(state.hidden, index)) {
    return "kept";
  }
  const foldIndex = arrayAt(state.folded, index);
  if (foldIndex < 0) {
    return "removed";
  }
  const fold = arrayAt(state.folds, foldIndex);
  if (line === fold.startLine) return "fold_start";
  if (line === fold.endLine) return "fold_end";
  return "fold_middle";
}

/** Go's `formatLineRange` (`meat/moves.go:450-455`). */
export function formatLineRange(r: LineRange): string {
  if (r.startLine === r.endLine) return `line ${r.startLine}`;
  return `lines ${r.startLine}-${r.endLine}`;
}

/** Go's `lineRangeVerb` (`meat/moves.go:457-462`). */
export function lineRangeVerb(r: LineRange): string {
  return r.startLine === r.endLine ? "is" : "are";
}

/**
 * Go's `validateMoveSymmetry` (`meat/moves.go:352-394`): every aligned move
 * row must receive identical keep/remove/fold treatment, including matching
 * fold boundaries — the fine-grained 5-valued compression is compared, not
 * the coarser 3-valued kind, so two rows that are both "folded" but at
 * different structural positions (fold-start vs. fold-middle) still mismatch.
 * Throws (H5) rather than returning an error value; joins multiple problems
 * via `joinEditPlanErrors`.
 */
export function validateMoveSymmetry(moves: readonly DetectedMove[], state: PlanState, mandatory: readonly boolean[]): void {
  const problems: string[] = [];
  for (const move of moves) {
    const rows = move.removed.endLine - move.removed.startLine + 1;
    let offset = 0;
    while (offset < rows) {
      const removedCompression = compressionAt(state, mandatory, move.removed.startLine + offset);
      const addedCompression = compressionAt(state, mandatory, move.added.startLine + offset);
      if (removedCompression === addedCompression) {
        offset++;
        continue;
      }

      const start = offset;
      const removedKind = moveCompressionKind(removedCompression);
      const addedKind = moveCompressionKind(addedCompression);
      while (offset + 1 < rows) {
        const nextRemoved = compressionAt(state, mandatory, move.removed.startLine + offset + 1);
        const nextAdded = compressionAt(state, mandatory, move.added.startLine + offset + 1);
        if (
          nextRemoved === nextAdded ||
          moveCompressionKind(nextRemoved) !== removedKind ||
          moveCompressionKind(nextAdded) !== addedKind
        ) {
          break;
        }
        offset++;
      }
      const end = offset;

      const removedMismatch: LineRange = { startLine: move.removed.startLine + start, endLine: move.removed.startLine + end };
      const addedMismatch: LineRange = { startLine: move.added.startLine + start, endLine: move.added.startLine + end };
      let detail = `removed ${formatLineRange(removedMismatch)} ${lineRangeVerb(removedMismatch)} ${removedKind} while added ${formatLineRange(addedMismatch)} ${lineRangeVerb(addedMismatch)} ${addedKind}`;
      if (removedKind === "folded" && addedKind === "folded") {
        detail = `removed ${formatLineRange(removedMismatch)} and added ${formatLineRange(addedMismatch)} are folded with different boundaries`;
      }
      problems.push(
        `move symmetry: removed lines ${move.removed.startLine}-${move.removed.endLine} match added lines ${move.added.startLine}-${move.added.endLine} after indentation normalization; ${detail}. Keep, remove, or fold corresponding move rows identically, including fold boundaries`,
      );
      offset++;
    }
  }
  if (problems.length > 0) {
    throw joinEditPlanErrors(problems);
  }
}

/**
 * Go's `validateMoveReplacementSymmetry` (`meat/moves.go:396-439`): local
 * elisions on kept rows must agree between a move's two sides, comparing
 * only post-replacement normalized text — indentation is deliberately
 * excluded, consistent with detection's own tolerance for a constant
 * per-row offset.
 */
export function validateMoveReplacementSymmetry(
  moves: readonly DetectedMove[],
  lines: readonly SourceLine[],
  state: PlanState,
  mandatory: readonly boolean[],
  replacements: ReadonlyMap<number, readonly PlannedReplacement[]>,
): void {
  const problems: string[] = [];
  for (const move of moves) {
    const rows = move.removed.endLine - move.removed.startLine + 1;
    for (let offset = 0; offset < rows; offset++) {
      const removedLine = move.removed.startLine + offset;
      const addedLine = move.added.startLine + offset;

      if (compressionAt(state, mandatory, removedLine) !== "kept" || compressionAt(state, mandatory, addedLine) !== "kept") {
        continue;
      }
      const removedEdits = replacements.get(removedLine) ?? [];
      const addedEdits = replacements.get(addedLine) ?? [];
      if (removedEdits.length === 0 && addedEdits.length === 0) continue;

      const removedLineText = arrayAt(lines, removedLine - 1).text;
      const addedLineText = arrayAt(lines, addedLine - 1).text;
      let removedBody = slice(removedLineText, 1, removedLineText.length);
      let addedBody = slice(addedLineText, 1, addedLineText.length);
      if (removedEdits.length > 0) removedBody = applyPlannedReplacements(removedBody, removedEdits);
      if (addedEdits.length > 0) addedBody = applyPlannedReplacements(addedBody, addedEdits);
      if (equals(normalizeMoveLine(removedBody).normalized, normalizeMoveLine(addedBody).normalized)) continue;

      problems.push(
        `move symmetry: removed lines ${move.removed.startLine}-${move.removed.endLine} match added lines ${move.added.startLine}-${move.added.endLine} after indentation normalization; corresponding kept lines ${removedLine} and ${addedLine} have different model-authored local elisions. Apply equivalent replacements to both sides or keep both lines verbatim`,
      );
    }
  }
  if (problems.length > 0) {
    throw joinEditPlanErrors(problems);
  }
}

/** Go's `formatMovePairs` (`meat/moves.go:464-480`). */
export function formatMovePairs(moves: readonly DetectedMove[], limit: number): string {
  if (moves.length === 0 || limit <= 0) return "";
  const shown = Math.min(moves.length, limit);
  const parts: string[] = [];
  for (let i = 0; i < shown; i++) {
    const move = arrayAt(moves, i);
    parts.push(`-${move.removed.startLine}..${move.removed.endLine} ↔ +${move.added.startLine}..${move.added.endLine}`);
  }
  if (shown < moves.length) {
    parts.push(`and ${moves.length - shown} more`);
  }
  return parts.join(", ");
}
