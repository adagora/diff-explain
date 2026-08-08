// editplan.ts — compiles a model-submitted edit plan against the immutable
// original diff (meat/editplan.go). The model never authors output text: it
// submits remove/replace/fold operations in original line coordinates, and
// compileEditPlan validates the plan (structure, elision projections, move
// symmetry, language rules) and renders the reading diff mechanically. This
// is the file the port is ultimately graded against — the Python golden
// vectors (conformance/vectors/plan-compile) are byte-exact against its
// output (specs/editplan.md G1-G11).
//
// H1: byte-oriented throughout. `remove`/`fold` line coordinates are plain
// numbers (no text), but `replace.old`/`replace.new` arrive as JS strings at
// the model/JSON wire boundary (see `EditPlanReplacement`) and are converted
// to `Uint8Array` immediately on ingestion — never decoded back to a string
// mid-pipeline. H3a (central hazard): the elision-projection matcher is a
// literal two-pointer scan, never a regex — see `compileElisionProjection`/
// `matchElisionLiterals` below and specs/editplan.md Mechanism §1.

import { at, arrayAt, slice, equals, hasPrefix, indexOf, concat, trimSpace, encodeUTF8, isValidUTF8, isControlRune, runes } from "./bytes.ts";
import {
  type SourceLine,
  type DiffLayout,
  isHunkSource,
  splitSourceLines,
  analyzeDiff,
  validateSupportedDiffLines,
  nextLayoutLine,
  joinEditPlanErrors,
} from "./diff.ts";
import {
  type LineRange,
  type LineFold,
  type PlanState,
  type PlannedFold,
  type PlannedReplacement,
  newPlanState,
  planStateRepresented,
  applyPlannedReplacements,
  leadingWhitespace,
} from "./plan.ts";
import { type DetectedMove, detectExactMoves, applyMandatoryMovePrecedence, validateMoveSymmetry, validateMoveReplacementSymmetry } from "./moves.ts";
import {
  mandatoryImportRemovalPlan,
  mandatoryRemovalMask,
  addMandatoryPythonSuitePlaceholders,
  stateWithMandatoryImportsRepresented,
  completeMandatoryImportFraming,
} from "./imports.ts";
import {
  pythonTripleNone,
  trimPythonCode,
  isPythonSuiteHeaderStart,
  pythonTripleStateBeforeLine,
  changesPythonBoundaryTokens,
  hunkHasVisibleChange,
  validateHiddenPythonOwners,
  validateHiddenPythonBoundaries,
  validateHiddenReferences,
  validatePythonSuiteSkeleton,
  validatePythonDelimiterBalance,
  validatePythonBackslashContinuations,
  validateTripleQuoteParity,
} from "./python.ts";

/** Go's `maxReplacementBytes`/`maxSummaryBytes` (`meat/editplan.go:20-23`). */
export const maxReplacementBytes = 4 << 10;
export const maxSummaryBytes = 500;

const AT_BYTES = encodeUTF8("@");
const ELLIPSIS_BYTES = encodeUTF8("...");
const ELLIPSIS_CODEPOINT = 0x2026; // …
const DOT_CODEPOINT = 0x2e; // '.'
const PLUS_BYTE = 0x2b;
const MINUS_BYTE = 0x2d;
const SPACE_BYTE = 0x20;

/**
 * Go's `lineReplacement`'s wire shape (`meat/editplan.go:32-40`), as it
 * actually arrives from JSON: `old`/`new` are JS strings (already decoded by
 * `JSON.parse`), converted to bytes at the point of use below — the
 * model/JSON boundary crossing H1 permits, distinct from `plan.ts`'s
 * `LineReplacement`, which is the already-byte-converted *internal* shape
 * `plannedReplacement` embeds.
 */
export interface EditPlanReplacement {
  readonly line: number;
  readonly old: string;
  readonly new: string;
}

/** Go's `editPlan` (`meat/editplan.go:49-55`): source-anchored operations only, no prose. */
export interface EditPlan {
  readonly remove: readonly LineRange[];
  readonly replace: readonly EditPlanReplacement[];
  readonly fold: readonly LineFold[];
}

/** Go's `submission` (`meat/editplan.go:57-63`): an `editPlan` plus its one-line summary. */
export interface Submission extends EditPlan {
  readonly summary: string;
}

/** Go's `planStats` (`meat/editplan.go:108-116`). */
export interface PlanStats {
  rawChanged: number;
  visibleChanged: number;
  removedChanged: number;
  foldedChanged: number;
  foldCount: number;
  rawFiles: number;
  visibleFiles: number;
}

/** Go's `compiledPlan` (`meat/editplan.go:118-122`). */
export interface CompiledPlan {
  readonly smartDiff: Uint8Array;
  readonly stats: PlanStats;
  readonly moves: readonly DetectedMove[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Public entry points (meat/editplan.go:124-165)
// ---------------------------------------------------------------------------

/** Go's `applyEditPlan` (`meat/editplan.go:124-132`): validates the summary and atomically applies the plan. */
export function applyEditPlan(raw: Uint8Array, submission: Submission): Uint8Array {
  return compileSubmission(raw, submission).smartDiff;
}

/** Go's `compileSubmission` (`meat/editplan.go:134-136`). */
export function compileSubmission(raw: Uint8Array, submission: Submission): CompiledPlan {
  return compileSubmissionMoves(raw, submission, undefined, true);
}

/** Go's `compileSubmissionMoves` (`meat/editplan.go:138-151`): summary and plan are validated independently; both failures aggregate (G38). */
export function compileSubmissionMoves(
  raw: Uint8Array,
  submission: Submission,
  provided: readonly DetectedMove[] | undefined,
  detect: boolean,
): CompiledPlan {
  const problems: string[] = [];
  const summaryError = validateSummary(encodeUTF8(submission.summary));
  if (summaryError !== null) problems.push(summaryError);

  let compiled: CompiledPlan | undefined;
  try {
    compiled = compileEditPlanMoves(raw, submission, provided, detect);
  } catch (err) {
    problems.push(errorMessage(err));
  }

  if (problems.length > 0) {
    throw joinEditPlanErrors(problems);
  }
  if (compiled === undefined) {
    throw new Error("unreachable: compileEditPlanMoves neither returned nor threw");
  }
  return compiled;
}

/** Go's `compileEditPlan` (`meat/editplan.go:153-157`): validates and applies a plan without requiring a summary. */
export function compileEditPlan(raw: Uint8Array, plan: EditPlan): CompiledPlan {
  return compileEditPlanMoves(raw, plan, undefined, true);
}

/**
 * Go's `compileEditPlanMoves` (`meat/editplan.go:165-411`): the single engine
 * behind every public entry point. See specs/editplan.md Mechanism §0 for the
 * exact 12-step pipeline order and the three-gate table this function
 * implements verbatim.
 */
export function compileEditPlanMoves(
  raw: Uint8Array,
  plan: EditPlan,
  provided: readonly DetectedMove[] | undefined,
  detect: boolean,
): CompiledPlan {
  const problems: string[] = [];

  // 1. Parse + layout.
  const lines = splitSourceLines(raw);
  validateSupportedDiffLines(lines);
  const layout = analyzeDiff(lines);
  if (layout.problems.length > 0) {
    throw joinEditPlanErrors(layout.problems);
  }

  // 2. Move set.
  const moves: readonly DetectedMove[] = detect ? detectExactMoves(lines, layout) : (provided ?? []);

  // 3-4. Mandatory-import computation and planState init.
  const mandatoryRemovals = mandatoryImportRemovalPlan(lines, layout);
  const mandatoryHidden = mandatoryRemovalMask(lines.length, mandatoryRemovals);
  applyMandatoryMovePrecedence(moves, mandatoryHidden);
  const state = newPlanState(lines.length);
  state.hidden = mandatoryHidden.slice();

  // 5. Remove-range application.
  const modelRemoved: boolean[] = new Array(lines.length).fill(false);
  let removalsValid = true;
  for (let i = 0; i < plan.remove.length; i++) {
    const r = arrayAt(plan.remove, i);
    if (r.startLine < 1 || r.endLine < 1 || r.startLine > r.endLine) {
      problems.push(`remove[${i}]: invalid inclusive range ${r.startLine}-${r.endLine}`);
      removalsValid = false;
      continue;
    }
    if (r.endLine > lines.length) {
      problems.push(`remove[${i}]: line ${r.endLine} is past end of diff (${lines.length} lines)`);
      removalsValid = false;
      continue;
    }
    let firstOverlap = 0;
    for (let n = r.startLine; n <= r.endLine; n++) {
      if (arrayAt(modelRemoved, n - 1)) {
        if (firstOverlap === 0) firstOverlap = n;
        removalsValid = false;
        continue;
      }
      modelRemoved[n - 1] = true;
      state.hidden[n - 1] = true;
    }
    if (firstOverlap !== 0) {
      problems.push(`remove[${i}]: overlaps an earlier range at line ${firstOverlap}`);
    }
  }

  // 6. Fold preparation/application.
  let foldsValid = true;
  for (let i = 0; i < plan.fold.length; i++) {
    const f = arrayAt(plan.fold, i);
    let fold: PlannedFold;
    try {
      fold = prepareFold(lines, layout, f, i);
    } catch (err) {
      problems.push(errorMessage(err));
      foldsValid = false;
      continue;
    }
    let mandatoryLines = 0;
    for (let n = f.startLine; n <= f.endLine; n++) {
      if (arrayAt(mandatoryHidden, n - 1)) mandatoryLines++;
    }
    if (mandatoryLines > 0) {
      if (mandatoryLines !== f.endLine - f.startLine + 1) {
        problems.push(`fold[${i}]: crosses automatically removed import rows and behavioral rows in range ${f.startLine}-${f.endLine}; fold only the behavioral rows`);
        foldsValid = false;
      }
      // An import-only fold is redundant: mandatory removal wins and no
      // ellipsis placeholder is emitted for import scaffolding.
      continue;
    }
    let conflictLine = 0;
    for (let n = f.startLine; n <= f.endLine; n++) {
      if (arrayAt(state.hidden, n - 1)) {
        conflictLine = n;
        break;
      }
    }
    if (conflictLine !== 0) {
      const kind = arrayAt(state.folded, conflictLine - 1) >= 0 ? "fold" : "remove";
      problems.push(`fold[${i}]: overlaps ${kind} at line ${conflictLine}`);
      foldsValid = false;
      continue;
    }
    const foldIndex = state.folds.length;
    state.folds.push(fold);
    state.foldAt[f.startLine - 1] = foldIndex;
    for (let n = f.startLine; n <= f.endLine; n++) {
      state.hidden[n - 1] = true;
      state.folded[n - 1] = foldIndex;
    }
  }

  // 7. Gate A.
  if (removalsValid && foldsValid) {
    addMandatoryPythonSuitePlaceholders(lines, layout, state, mandatoryHidden);
    try {
      validateMoveSymmetry(moves, state, mandatoryHidden);
    } catch (err) {
      problems.push(errorMessage(err));
    }
  }
  let pythonValidationState: PlanState = state;
  if (removalsValid && foldsValid) {
    pythonValidationState = stateWithMandatoryImportsRepresented(state, mandatoryHidden, layout);
    try {
      validateHiddenPythonOwners(lines, layout, pythonValidationState);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    try {
      validateHiddenPythonBoundaries(lines, layout, pythonValidationState);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    try {
      validateHiddenReferences(lines, layout, pythonValidationState);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    try {
      validatePythonSuiteSkeleton(lines, layout, pythonValidationState);
    } catch (err) {
      problems.push(errorMessage(err));
    }
  }

  // 8. Replace validation and replacement-overlap check (always run).
  const replacements = new Map<number, PlannedReplacement[]>();
  let replacementsValid = true;
  for (let i = 0; i < plan.replace.length; i++) {
    const r = arrayAt(plan.replace, i);
    if (r.line < 1 || r.line > lines.length) {
      problems.push(`replace[${i}]: line ${r.line} is outside the diff (1-${lines.length})`);
      continue;
    }
    if (arrayAt(mandatoryHidden, r.line - 1)) {
      // A replacement on compiler-hidden import scaffolding is redundant.
      // Ignore it so older cached/model plans that explicitly abridged an
      // import still merge cleanly with the mandatory plan.
      continue;
    }
    if (arrayAt(state.hidden, r.line - 1)) {
      const stateName = arrayAt(state.folded, r.line - 1) >= 0 ? "folded" : "removed";
      problems.push(`replace[${i}]: line ${r.line} is also ${stateName}`);
      continue;
    }
    const oldBytes = encodeUTF8(r.old);
    const newBytes = encodeUTF8(r.new);
    if (oldBytes.length === 0) {
      problems.push(`replace[${i}]: old must not be empty`);
      continue;
    }
    const oldError = validateSingleLineText("old", oldBytes, maxReplacementBytes);
    if (oldError !== null) {
      problems.push(`replace[${i}]: ${oldError}`);
      continue;
    }
    const newError = validateSingleLineText("new", newBytes, maxReplacementBytes);
    if (newError !== null) {
      problems.push(`replace[${i}]: ${newError}`);
      continue;
    }
    if (equals(newBytes, oldBytes)) {
      problems.push(`replace[${i}]: new must elide some part of old`);
      continue;
    }
    if (!isElisionProjection(oldBytes, newBytes)) {
      problems.push(`replace[${i}]: new must match all of old, with every omitted span represented by ... or …`);
      continue;
    }
    if (!isHunkSource(arrayAt(layout.kinds, r.line - 1))) {
      problems.push(`replace[${i}]: line ${r.line} is not a source line inside a diff hunk`);
      continue;
    }
    const lineText = arrayAt(lines, r.line - 1).text;
    const body = slice(lineText, 1, lineText.length);
    if (arrayAt(layout.python, r.line - 1) && pythonTripleStateBeforeLine(lines, layout, r.line - 1) === pythonTripleNone) {
      const code = trimPythonCode(body);
      if (hasPrefix(code, AT_BYTES) || isPythonSuiteHeaderStart(code)) {
        problems.push(`replace[${i}]: line ${r.line} is a Python decorator or suite header; keep structural anchors intact`);
        continue;
      }
    }
    if (arrayAt(layout.python, r.line - 1) && changesPythonBoundaryTokens(oldBytes, newBytes)) {
      problems.push(`replace[${i}]: must preserve Python string and expression boundary tokens`);
      continue;
    }
    const unique = uniqueSubstringIndex(body, oldBytes);
    if (!unique.unique) {
      problems.push(`replace[${i}]: old must occur exactly once after the diff marker on line ${r.line}`);
      continue;
    }
    const planned: PlannedReplacement = {
      line: r.line,
      old: oldBytes,
      new: newBytes,
      planIndex: i,
      start: unique.index,
      end: unique.index + oldBytes.length,
    };
    const existing = replacements.get(r.line);
    if (existing !== undefined) existing.push(planned);
    else replacements.set(r.line, [planned]);
  }
  for (const [lineNo, edits] of replacements) {
    edits.sort((a, b) => a.start - b.start);
    for (let i = 1; i < edits.length; i++) {
      if (arrayAt(edits, i).start < arrayAt(edits, i - 1).end) {
        problems.push(`replace[${arrayAt(edits, i).planIndex}]: span overlaps replace[${arrayAt(edits, i - 1).planIndex}] on line ${lineNo}`);
        replacementsValid = false;
      }
    }
  }

  // 9. Gate B.
  if (removalsValid && foldsValid && replacementsValid && problems.length === 0) {
    try {
      validateMoveReplacementSymmetry(moves, lines, state, mandatoryHidden, replacements);
    } catch (err) {
      problems.push(errorMessage(err));
    }
  }

  // 10. Gate C.
  if (removalsValid && foldsValid && replacementsValid) {
    try {
      validateTripleQuoteParity(lines, layout, pythonValidationState, replacements);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    try {
      validatePythonDelimiterBalance(lines, layout, pythonValidationState, replacements);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    try {
      validatePythonBackslashContinuations(lines, layout, pythonValidationState, replacements);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    completeMandatoryImportFraming(layout, state, mandatoryHidden);
    try {
      validateRetainedStructure(layout, state);
    } catch (err) {
      problems.push(errorMessage(err));
    }
  }

  // 11. Aggregate-and-fail.
  if (problems.length > 0) {
    throw joinEditPlanErrors(problems);
  }

  // 12. Render loop + stats.
  const parts: Uint8Array[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const foldIndex = arrayAt(state.foldAt, i);
    if (foldIndex >= 0) {
      const fold = arrayAt(state.folds, foldIndex);
      if (fold.marker === null) {
        throw new Error("unreachable: a committed fold always has a resolved marker");
      }
      parts.push(encodeUTF8(fold.marker), fold.indent, ELLIPSIS_BYTES, fold.eol);
      continue;
    }
    if (arrayAt(state.hidden, i)) continue;
    const line = arrayAt(lines, i);
    let text = line.text;
    const edits = replacements.get(lineNo);
    if (edits !== undefined && edits.length > 0) {
      text = concat([slice(text, 0, 1), applyPlannedReplacements(slice(text, 1, text.length), edits)]);
    }
    parts.push(text, line.eol);
  }
  const stats = computePlanStats(layout, state);
  return { smartDiff: concat(parts), stats, moves };
}

// ---------------------------------------------------------------------------
// Fold preparation (meat/editplan.go:421-470)
// ---------------------------------------------------------------------------

function markerFromByte(b: number): "+" | "-" | " " {
  if (b === PLUS_BYTE) return "+";
  if (b === MINUS_BYTE) return "-";
  if (b === SPACE_BYTE) return " ";
  throw new Error(`unreachable: hunk source line marker byte ${b} is not one of ' ', '+', '-'`);
}

/** Go's `prepareFold` (`meat/editplan.go:421-470`). Throws on any structural violation; the caller records the message and continues. */
function prepareFold(lines: readonly SourceLine[], layout: DiffLayout, fold: LineFold, planIndex: number): PlannedFold {
  if (fold.startLine < 1 || fold.endLine < 1 || fold.startLine >= fold.endLine) {
    throw new Error(`fold[${planIndex}]: want at least two lines in an inclusive range, got ${fold.startLine}-${fold.endLine}`);
  }
  if (fold.endLine > lines.length) {
    throw new Error(`fold[${planIndex}]: line ${fold.endLine} is past end of diff (${lines.length} lines)`);
  }

  let marker: "+" | "-" | " " | null = null;
  let indent: Uint8Array | null = null;
  for (let n = fold.startLine; n <= fold.endLine; n++) {
    const index = n - 1;
    const kind = arrayAt(layout.kinds, index);
    const lineText = arrayAt(lines, index).text;
    if (!isHunkSource(kind) || lineText.length === 0) {
      throw new Error(`fold[${planIndex}]: line ${n} is not source inside one diff hunk`);
    }
    const lineMarker = markerFromByte(at(lineText, 0));
    if (marker === null) {
      marker = lineMarker;
    } else if (marker !== lineMarker) {
      throw new Error(`fold[${planIndex}]: mixed diff markers '${marker}' and '${lineMarker}' in range ${fold.startLine}-${fold.endLine}`);
    }
    const body = slice(lineText, 1, lineText.length);
    const trimmedBody = trimSpace(body);
    const pythonCodeLine = arrayAt(layout.python, index) && pythonTripleStateBeforeLine(lines, layout, index) === pythonTripleNone;
    if (pythonCodeLine && lineMarker !== "-" && (hasPrefix(trimmedBody, AT_BYTES) || isPythonSuiteHeaderStart(trimmedBody))) {
      throw new Error(`fold[${planIndex}]: line ${n} is a Python decorator or suite owner; keep the anchor and fold only its interior`);
    }
    if (trimmedBody.length === 0) continue;
    const lineIndent = leadingWhitespace(body);
    indent = indent === null ? lineIndent : commonPrefix(indent, lineIndent);
  }
  if (indent === null) {
    throw new Error(`fold[${planIndex}]: range ${fold.startLine}-${fold.endLine} contains only blank source lines`);
  }
  if (marker === null) {
    throw new Error("unreachable: a non-empty fold range always sets a marker on its first iteration");
  }
  return {
    startLine: fold.startLine,
    endLine: fold.endLine,
    planIndex,
    marker,
    indent,
    eol: arrayAt(lines, fold.endLine - 1).eol,
  };
}

/** Go's `commonPrefix` (`meat/editplan.go:489-499`): pure byte-position comparison, no tab/space width interpretation (H16). */
function commonPrefix(a: Uint8Array, b: Uint8Array): Uint8Array {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && at(a, i) === at(b, i)) i++;
  return slice(a, 0, i);
}

// ---------------------------------------------------------------------------
// computePlanStats (meat/editplan.go:501-529)
// ---------------------------------------------------------------------------

function computePlanStats(layout: DiffLayout, state: PlanState): PlanStats {
  const stats: PlanStats = { rawChanged: 0, visibleChanged: 0, removedChanged: 0, foldedChanged: 0, foldCount: 0, rawFiles: 0, visibleFiles: 0 };
  for (let i = 0; i < layout.kinds.length; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (kind === "header") {
      stats.rawFiles++;
      if (planStateRepresented(state, i)) stats.visibleFiles++;
    } else if (kind === "hunk_change") {
      stats.rawChanged++;
      if (arrayAt(state.folded, i) >= 0) {
        stats.foldedChanged++;
      } else if (arrayAt(state.hidden, i)) {
        stats.removedChanged++;
      } else {
        stats.visibleChanged++;
      }
    }
  }
  stats.foldCount = state.folds.length;
  for (const fold of state.folds) {
    if (fold.marker === "+" || fold.marker === "-") stats.visibleChanged++;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Uniqueness and elision-projection mechanism (meat/editplan.go:542-632) —
// H3a, central hazard. Ported as a literal two-pointer scan, never a regex
// (specs/editplan.md Mechanism §1, migration/HAZARDS.md H3a).
// ---------------------------------------------------------------------------

interface UniqueSubstringResult {
  readonly index: number;
  readonly unique: boolean;
}

/** Go's `uniqueSubstringIndex` (`meat/editplan.go:542-553`). */
function uniqueSubstringIndex(text: Uint8Array, sub: Uint8Array): UniqueSubstringResult {
  const first = indexOf(text, sub);
  if (first < 0) return { index: 0, unique: false };
  // Search one byte after the first start, rather than after its end, so
  // overlapping matches ("aa" in "aaa") are also considered ambiguous.
  if (indexOf(slice(text, first + 1, text.length), sub) >= 0) return { index: 0, unique: false };
  return { index: first, unique: true };
}

export interface ElisionPattern {
  readonly literals: readonly Uint8Array[];
  readonly wildcards: number;
}

/**
 * Go's `compileElisionProjection` (`meat/editplan.go:571-632`). Tokenizes
 * `newText` into an alternating literal/wildcard sequence, codepoint-aware
 * (H2) since it must recognize the multi-byte `…` rune and count codepoints
 * to delimit dot-runs. Returns `null` on any strict-mode bail-out or when no
 * wildcard was found at all — never throws, mirroring Go's `(nil, false)`.
 *
 * Exported: `elision.ts` (`meat/elision.go:86`) calls this directly in
 * non-strict mode too, compiling it once per kept line and reusing the
 * result across a bounded scan of candidate raw lines — see
 * `matchElisionLiterals` just below for the other half of that call site.
 */
export function compileElisionProjection(newText: Uint8Array, strict: boolean): ElisionPattern | null {
  const runeList = [...runes(newText)];
  const literals: Uint8Array[] = [];
  let wildcards = 0;
  let lastWasWildcard = false;
  let literalStart = 0;

  let i = 0;
  while (i < runeList.length) {
    const r = arrayAt(runeList, i);
    let wildcard = false;
    let consumedEnd = 0;

    if (r.codePoint === ELLIPSIS_CODEPOINT) {
      wildcard = true;
      consumedEnd = r.offset + r.size;
      i++;
    } else if (r.codePoint === DOT_CODEPOINT) {
      let j = i;
      while (j < runeList.length && arrayAt(runeList, j).codePoint === DOT_CODEPOINT) j++;
      const run = j - i;
      if (run >= 3) {
        if (strict && run !== 3) {
          return null;
        }
        wildcard = true;
        const lastDot = arrayAt(runeList, j - 1);
        consumedEnd = lastDot.offset + lastDot.size;
        i = j;
      }
    }

    if (wildcard) {
      if (lastWasWildcard) {
        if (strict) return null;
        // Non-strict: silently merge this wildcard's bytes into the gap
        // already open — no new literal flush, no second wildcard counted.
        literalStart = consumedEnd;
        continue;
      }
      literals.push(slice(newText, literalStart, r.offset));
      wildcards++;
      lastWasWildcard = true;
      literalStart = consumedEnd;
      continue;
    }

    lastWasWildcard = false;
    i++;
  }
  literals.push(slice(newText, literalStart, newText.length));
  if (wildcards === 0) return null;
  return { literals, wildcards };
}

/**
 * The leftmost greedy two-pointer scan HAZARDS.md's H3a prescribes: `old`
 * must start with `literals[0]`, end with the last literal, and contain
 * every other literal in order with at least one byte between neighbours
 * (specs/editplan.md Mechanism §1, "Equivalence argument for the port").
 * Exported for `elision.ts`, which matches one compiled pattern's literals
 * against many candidate raw lines (`meat/elision.go:95`).
 */
export function matchElisionLiterals(old: Uint8Array, literals: readonly Uint8Array[]): boolean {
  const first = arrayAt(literals, 0);
  if (!hasPrefix(old, first)) return false;
  let cursor = first.length;
  for (let i = 1; i < literals.length - 1; i++) {
    const literal = arrayAt(literals, i);
    const searchStart = cursor + 1;
    if (searchStart > old.length) return false;
    const found = indexOf(slice(old, searchStart, old.length), literal);
    if (found < 0) return false;
    cursor = searchStart + found + literal.length;
  }
  const last = arrayAt(literals, literals.length - 1);
  const lastStart = old.length - last.length;
  if (lastStart < cursor + 1) return false;
  return equals(slice(old, lastStart, old.length), last);
}

function matchesElisionProjection(old: Uint8Array, newText: Uint8Array, strict: boolean): boolean {
  const compiled = compileElisionProjection(newText, strict);
  return compiled !== null && matchElisionLiterals(old, compiled.literals);
}

/** Go's `isElisionProjection` (`meat/editplan.go:555-557`). */
export function isElisionProjection(old: Uint8Array, newText: Uint8Array): boolean {
  return matchesElisionProjection(old, newText, true);
}

/**
 * Go's `isComposedElisionProjection` (`meat/editplan.go:559-564`): recognizes
 * the result after multiple individually validated replacements were
 * applied to one line, where adjacent placeholders may form a run longer
 * than three dots. Verified dead code — zero call sites in the whole Go
 * repository (specs/editplan.md Open questions) — ported for fidelity, not
 * wired to anything.
 */
export function isComposedElisionProjection(old: Uint8Array, newText: Uint8Array): boolean {
  return matchesElisionProjection(old, newText, false);
}

// ---------------------------------------------------------------------------
// validateSummary / validateSingleLineText (meat/editplan.go:634-664)
// ---------------------------------------------------------------------------

/** Go's `validateSummary` (`meat/editplan.go:634-645`). Returns the error message, or `null` if valid. */
function validateSummary(summary: Uint8Array): string | null {
  if (trimSpace(summary).length === 0) {
    return "summary must not be empty";
  }
  if (summary.length > maxSummaryBytes) {
    return `summary is ${summary.length} bytes, over the ${maxSummaryBytes}-byte limit`;
  }
  return validateSingleLineText("summary", summary, maxSummaryBytes);
}

const FORBIDDEN_SINGLE_LINE_CODEPOINTS = new Set<number>([0x0a, 0x0d, 0x00, 0x1b, 0x2028, 0x2029]);

/**
 * Go's `validateSingleLineText` (`meat/editplan.go:647-664`), shared by
 * `validateSummary` and the replace `old`/`new` checks. H2: the control-char
 * scan is genuinely codepoint-aware (`unicode.IsControl`), unlike
 * `leadingWhitespace`'s ASCII-only loop — walked here via `bytes.ts`'s
 * `runes()`, never a decoded JS string.
 */
function validateSingleLineText(name: string, text: Uint8Array, maxBytes: number): string | null {
  if (text.length > maxBytes) {
    return `${name} is ${text.length} bytes, over the ${maxBytes}-byte limit`;
  }
  if (!isValidUTF8(text)) {
    return `${name} is not valid UTF-8`;
  }
  for (const r of runes(text)) {
    if (FORBIDDEN_SINGLE_LINE_CODEPOINTS.has(r.codePoint)) {
      return `${name} must be a single printable line`;
    }
    if (isControlRune(r.codePoint) && r.codePoint !== 0x09) {
      return `${name} contains a control character`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// validateRetainedStructure (meat/editplan.go:666-770)
// ---------------------------------------------------------------------------

function anyRetainedMeaningful(layout: DiffLayout, state: PlanState, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (planStateRepresented(state, i) && kind !== "no_newline" && kind !== "index") return true;
  }
  return false;
}

function anyRetained(state: PlanState, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (planStateRepresented(state, i)) return true;
  }
  return false;
}

function anyRetainedHunkSource(layout: DiffLayout, state: PlanState, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (planStateRepresented(state, i) && isHunkSource(arrayAt(layout.kinds, i))) return true;
  }
  return false;
}

/**
 * Go's `validateRetainedStructure` (`meat/editplan.go:666-734`). Prevents a
 * plan from deleting the metadata that identifies retained source: a
 * complete file or hunk may disappear, but a surviving line keeps its
 * enclosing diff/file/hunk headers. `anyRetainedHunkChange` is Go's own
 * predicate (`meat/editplan.go:763-770`); reused here via `python.ts`'s
 * `hunkHasVisibleChange`, which imports.ts already established is logically
 * identical (same condition, operands swapped).
 */
function validateRetainedStructure(layout: DiffLayout, state: PlanState): void {
  const problems: string[] = [];
  for (let i = 0; i < layout.kinds.length; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (kind === "no_newline" && planStateRepresented(state, i)) {
      const owner = arrayAt(layout.markerOwner, i);
      if (owner < 0 || !planStateRepresented(state, owner)) {
        problems.push(`remove: no-newline marker on line ${i + 1} requires its source line`);
      }
    }

    if (kind === "header") {
      const end = nextLayoutLine(layout, i + 1, (k) => k === "header" || k === "mail_signature");
      const bodyRetained = anyRetainedMeaningful(layout, state, i + 1, end);
      const headerRetained = planStateRepresented(state, i);
      if (!bodyRetained && anyRetained(state, i + 1, end)) {
        problems.push(`remove: file beginning on line ${i + 1} retains only metadata; remove the complete file section`);
      }
      if (headerRetained !== bodyRetained) {
        problems.push(`remove: diff header on line ${i + 1} must be retained exactly when its file body is retained`);
      }
    } else if (kind === "old_file") {
      const end = nextLayoutLine(layout, i + 2, (k) => k === "header" || k === "old_file" || k === "mail_signature");
      if (planStateRepresented(state, i) !== planStateRepresented(state, i + 1)) {
        problems.push(`remove: ---/+++ headers on lines ${i + 1}-${i + 2} must be removed or retained together`);
      }
      const bodyRetained = anyRetainedMeaningful(layout, state, i + 2, end);
      const headersRetained = planStateRepresented(state, i);
      if (headersRetained !== bodyRetained) {
        problems.push(`remove: ---/+++ headers on lines ${i + 1}-${i + 2} must be retained exactly when their file body is retained`);
      }
    } else if (kind === "rename_from") {
      if (i + 1 >= layout.kinds.length || arrayAt(layout.kinds, i + 1) !== "rename_to") {
        problems.push(`rename from metadata on line ${i + 1} has no matching rename to line`);
      } else if (planStateRepresented(state, i) !== planStateRepresented(state, i + 1)) {
        problems.push(`remove: rename metadata on lines ${i + 1}-${i + 2} must be removed or retained together`);
      }
    } else if (kind === "copy_from") {
      if (i + 1 >= layout.kinds.length || arrayAt(layout.kinds, i + 1) !== "copy_to") {
        problems.push(`copy from metadata on line ${i + 1} has no matching copy to line`);
      } else if (planStateRepresented(state, i) !== planStateRepresented(state, i + 1)) {
        problems.push(`remove: copy metadata on lines ${i + 1}-${i + 2} must be removed or retained together`);
      }
    } else if (kind === "hunk_header") {
      const end = nextLayoutLine(layout, i + 1, (k) => k === "header" || k === "old_file" || k === "hunk_header" || k === "mail_signature");
      const headerRetained = planStateRepresented(state, i);
      if (anyRetainedHunkSource(layout, state, i + 1, end) && !headerRetained) {
        problems.push(`remove: retained context/change lines require hunk header on line ${i + 1}`);
      }
      const changeRetained = hunkHasVisibleChange(layout, state, i + 1, end);
      if (headerRetained !== changeRetained) {
        problems.push(`remove: hunk header on line ${i + 1} must be retained exactly when its hunk has a retained change`);
      }
    }
  }
  if (problems.length > 0) {
    throw joinEditPlanErrors(problems);
  }
}
