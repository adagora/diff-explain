// chunk.ts splits an oversized unified diff into independently abridgeable
// chunks (meat/chunk.go). A single agent run re-sends the whole numbered
// diff every turn, so its size is bounded by a per-run byte budget. A larger
// diff is split at structural boundaries — between file sections when
// possible, between hunks of one oversized file otherwise, and between
// synthesized sub-hunks of one oversized hunk as a last resort — into chunks
// that each fit the budget both as raw text and in numbered form.
//
// This file ports `splitDiffForAbridging`/`fitsSingleRun` and every pure
// helper the splitter needs — the vector-tested surface (`split/`,
// `fits-single-run/`) and everything `TestSplitDiff_*`/`TestFitsSingleRun`
// exercise directly, with no live model involved. `abridgeChunked` itself
// (the merge step that runs a real agent loop per chunk) is deferred to
// `meat.ts` (item 4n): it calls `abridgeOne`/`Model`/`Request`/`Result`/
// `runOptions`, none of which exist yet, and its own tests
// (`TestAbridge_Chunked*`, `TestRequestStaysPositionalCompatible`) all need
// a scripted-model harness that belongs there too. `mapMovesToChunk`,
// `chunkError`, `firstLineText`, `pieceContainsLine`, and
// `stripReplicatedMeta` have no vector and no test coverage independent of
// `abridgeChunked` — they move to `meat.ts` alongside their one caller
// rather than landing here untested. See `TODO.md` item 4k's "As built" note.
//
// H1: byte-oriented throughout, matching every budgeting computation in
// `meat/chunk.go` (confirmed by the spec: zero `[]rune` constructs in the
// whole file). `prefixText`/`prefixRaw` are byte-length prefix sums so any
// span's size is an O(1) subtraction — never rescan a span's bytes inside a
// greedy loop, which would make the splitter quadratic.

import { at, arrayAt, slice, hasPrefix, hasSuffix, indexOf, equals, concat, encodeUTF8 } from "./bytes.ts";
import {
  type SourceLine,
  type DiffLayout,
  type SourceLanguage,
  splitSourceLines,
  analyzeDiff,
  isHunkSource,
  joinEditPlanErrors,
  fields,
  parseGoInt,
} from "./diff.ts";
import { type LineRange, type PlannedFold, type PlanState, newPlanState } from "./plan.ts";
import { mandatoryRemovalMask, mandatoryImportRemovalPlan, addMandatoryPythonSuitePlaceholders, countCodeBackticks } from "./imports.ts";
import { type DetectedMove, detectExactMoves, applyMandatoryMovePrecedence } from "./moves.ts";
import {
  type PythonTripleStateRef,
  type PythonDelimiters,
  pythonTripleNone,
  newTripleStateRef,
  scanPythonTripleLine,
  pythonDelimiterBalanceWithState,
  endsPythonBackslash,
  trimPythonCode,
  isPythonSuiteHeaderStart,
} from "./python.ts";

/** Go's `maxTotalDiffBytes` (`meat/chunk.go:42`): bounds the raw diff accepted for chunked abridging. Consumed by `meat.ts`'s top-level dispatch. */
export const maxTotalDiffBytes = 4 << 20;

/** Go's `maxChunks` (`meat/chunk.go:50`): refuses pathological amplification rather than exploding into hundreds of chunks/agent runs (G27). */
export const maxChunks = 32;

const PLUS_BYTE = 0x2b;
const MINUS_BYTE = 0x2d;
const SPACE_BYTE = 0x20;
const LF = encodeUTF8("\n");
const CR = encodeUTF8("\r");
const AT_BYTE = encodeUTF8("@");
const COMMA_BYTE = encodeUTF8(",");
const ZERO_BYTE = encodeUTF8("0");
const ELLIPSIS_ASCII = encodeUTF8("...");
const HUNK_PREFIX = encodeUTF8("@@ ");
const HUNK_CLOSER = encodeUTF8(" @@");

/** Go's `diffChunk` (`meat/chunk.go:52-78`): one independently abridgeable slice of the original diff. */
export interface DiffChunk {
  /** A well-formed unified diff for this slice (verbatim for whole-section/hunk-run chunks, synthesized for split-hunk segments). */
  readonly text: Uint8Array;
  /** The replicated file-metadata block, set for every piece of a split section; empty for whole-section chunks. */
  readonly metaPrefix: Uint8Array;
  /** Groups pieces of the same split file section for merge-time dedup; -1 for a chunk made of whole sections (H15: plain sentinel, never a bare truthy check). */
  readonly sectionId: number;
  /** True for a piece that isn't the section's first — its `metaPrefix` duplicates metadata the merge step drops once the file has surfaced. */
  readonly continuation: boolean;
  /** True for envelope-only text with no hunk content — copied verbatim with no agent run. */
  readonly passthrough: boolean;
  /** One entry per physical line of `text`, mapping back to the 0-based original-diff line index, or -1 for synthesized lines. */
  readonly origins: readonly number[];
}

/** Go's `numberedLen` (`meat/chunk.go:83-89`): the exact size of `numberedDiff` output for `count` lines totaling `textLen` text bytes. */
function numberedLen(textLen: number, count: number): number {
  if (count === 0) return 0;
  const width = String(count).length;
  return textLen + count * (width + 2);
}

/** Go's `fitsSingleRun` (`meat/chunk.go:91-103`): whether `raw` and its numbered form both fit within `budget` — one agent run can take the whole diff (G41). */
export function fitsSingleRun(raw: Uint8Array, budget: number): boolean {
  if (raw.length > budget) return false;
  const lines = splitSourceLines(raw);
  let textLen = 0;
  for (const l of lines) textLen += l.text.length;
  return numberedLen(textLen, lines.length) <= budget;
}

/** Go's `lineSpan` (`meat/chunk.go:105-108`): a half-open `[start, end)` range of physical line indices. */
interface LineSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Go's `chunkBuilder` (`meat/chunk.go:110-145`). Every field but `chunks` is
 * computed once during setup and never mutated again — a port of Go's
 * pointer-receiver methods as plain functions taking this state as their
 * first argument, matching this codebase's function-over-class convention.
 */
interface ChunkBuilderState {
  readonly lines: readonly SourceLine[];
  readonly layout: DiffLayout;
  readonly budget: number;
  readonly prefixText: readonly number[];
  readonly prefixRaw: readonly number[];
  readonly hidden: readonly boolean[];
  readonly extraHidden: readonly boolean[];
  readonly foldAt: readonly number[];
  readonly folds: readonly PlannedFold[];
  readonly inString: readonly boolean[];
  chunks: DiffChunk[];
}

/**
 * Go's `splitDiffForAbridging` (`meat/chunk.go:150-244`). `raw` must already
 * have passed `validateSupportedDiff`; every returned chunk passes it too.
 * Throws on any structural problem, mirroring this codebase's
 * throw-on-failure convention for compile/validate-style functions (Go's
 * `error` return becomes an ordinary thrown `Error`, which every helper below
 * simply lets propagate — no manual `if err != nil` relay needed).
 */
export function splitDiffForAbridging(raw: Uint8Array, budget: number): DiffChunk[] {
  const lines = splitSourceLines(raw);
  const layout = analyzeDiff(lines);
  if (layout.problems.length > 0) {
    throw joinEditPlanErrors(layout.problems);
  }

  // The whole-diff mandatory mask: the import pass plus move-precedence
  // extension. extraHidden isolates rows a chunk-local compiler could not
  // re-derive (hidden only through a move whose counterpart may land in
  // another chunk); sections containing them are never copied verbatim.
  const importMask = mandatoryRemovalMask(lines.length, mandatoryImportRemovalPlan(lines, layout));
  const hidden: boolean[] = importMask.slice();
  applyMandatoryMovePrecedence(detectExactMoves(lines, layout), hidden);
  const extraHidden: boolean[] = hidden.map((h, i) => h && !arrayAt(importMask, i));

  // The whole-diff mandatory Python suite placeholders, so a dropped import
  // row that props up a visible suite owner is emitted as its fixed `...`
  // row exactly as whole-diff rendering would.
  const placeholderState: PlanState = newPlanState(lines.length);
  placeholderState.hidden = hidden.slice();
  addMandatoryPythonSuitePlaceholders(lines, layout, placeholderState, hidden);

  const prefixText = new Array<number>(lines.length + 1).fill(0);
  const prefixRaw = new Array<number>(lines.length + 1).fill(0);
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    prefixText[i + 1] = arrayAt(prefixText, i) + line.text.length;
    prefixRaw[i + 1] = arrayAt(prefixRaw, i) + line.text.length + line.eol.length;
  }

  const b: ChunkBuilderState = {
    lines,
    layout,
    budget,
    prefixText,
    prefixRaw,
    hidden,
    extraHidden,
    foldAt: placeholderState.foldAt,
    folds: placeholderState.folds,
    inString: stringInteriorMask(lines, layout),
    chunks: [],
  };

  const sections = sectionSpans(b);
  if (sections.length === 0) {
    throw new Error(`diff is ${raw.length >> 10}KB with no file sections to split into abridgeable chunks — try a narrower range`);
  }

  let open = -1; // start line of the accumulating whole-section chunk
  let openEnd = 0;
  const flush = (): void => {
    if (open >= 0) {
      addChunk(b, {
        text: rangeText(b, open, openEnd),
        metaPrefix: new Uint8Array(0),
        sectionId: -1,
        continuation: false,
        passthrough: false,
        origins: rangeOrigins(open, openEnd),
      });
      open = -1;
    }
  };
  for (let id = 0; id < sections.length; id++) {
    const s = arrayAt(sections, id);
    if (spanFullyHidden(b, s)) {
      // The whole-diff compiler removes this section entirely (an
      // import-only file shell); no chunk or model run is needed.
      flush();
      continue;
    }
    if (spanHasExtraHidden(b, s)) {
      // Rows only a whole-diff pass hides (cross-file move counterparts)
      // must be dropped from the chunk text; splitSection's segmenting
      // path owns that, so such a section is never packed verbatim.
      flush();
      splitSection(b, id, s);
      continue;
    }
    if (open >= 0 && spanFits(b, open, s.end)) {
      openEnd = s.end;
      continue;
    }
    flush();
    if (spanFits(b, s.start, s.end)) {
      open = s.start;
      openEnd = s.end;
      continue;
    }
    splitSection(b, id, s);
  }
  flush();
  return b.chunks;
}

/** Go's `(*chunkBuilder).add` (`meat/chunk.go:249-255`): refuses pathological amplification before the full expansion is allocated. */
function addChunk(b: ChunkBuilderState, c: DiffChunk): void {
  if (b.chunks.length >= maxChunks) {
    throw new Error(
      `diff splits into more than ${maxChunks} chunks — try a narrower range (a single commit, or per-file with \`git diff -- <path> | meat\`)`,
    );
  }
  b.chunks.push(c);
}

/**
 * Go's `stringScanState` (`meat/chunk.go:293-336`): tracks one diff side's
 * multiline continuation position. String transitions match
 * `embeddedSourceLines`, bracket depth and backslash continuations match the
 * Python delimiter/continuation validators.
 */
interface StringScanState {
  triple: PythonTripleStateRef;
  backtick: boolean;
  brackets: PythonDelimiters;
  backslash: boolean;
}

function newStringScanState(): StringScanState {
  return { triple: newTripleStateRef(), backtick: false, brackets: { round: 0, square: 0, curly: 0 }, backslash: false };
}

/** Go's `stringScanState.inString` (`meat/chunk.go:303-306`). OR of all four sub-states — a cut landing here would desynchronize whichever one is currently true. */
function stringScanStateInString(s: StringScanState): boolean {
  return (
    s.triple.value !== pythonTripleNone || s.backtick || s.backslash || s.brackets.round > 0 || s.brackets.square > 0 || s.brackets.curly > 0
  );
}

function clampNonNegative(n: number): number {
  return n < 0 ? 0 : n;
}

/** Go's `stringScanState.scan` (`meat/chunk.go:308-336`). Mutates `s` in place. */
function scanStringScanState(s: StringScanState, text: Uint8Array, language: SourceLanguage): void {
  if (language === "python" || language === "java") {
    const inTriple = s.triple.value !== pythonTripleNone;
    if (language === "python") {
      // A local copy: this line's bracket-balance scan tracks triple-quote
      // state only to skip counting inside a string on this call, and must
      // NOT commit its own transitions back into the real `s.triple` —
      // `scanPythonTripleLine` below is the only call that does that.
      const tripleForBalance: PythonTripleStateRef = { value: s.triple.value };
      const delta = pythonDelimiterBalanceWithState(text, tripleForBalance);
      s.brackets = {
        round: clampNonNegative(s.brackets.round + delta.round),
        square: clampNonNegative(s.brackets.square + delta.square),
        curly: clampNonNegative(s.brackets.curly + delta.curly),
      };
    }
    scanPythonTripleLine(text, s.triple);
    if (language === "python") {
      s.backslash = !inTriple && s.triple.value === pythonTripleNone && endsPythonBackslash(text);
    }
  }
  if (language === "go" || language === "javascript") {
    if (countCodeBackticks(text) % 2 === 1) s.backtick = !s.backtick;
  }
}

/**
 * Go's `stringInteriorMask` (`meat/chunk.go:257-291`). Marks hunk-body lines
 * that begin while either diff side's lexical position is inside a
 * multiline string/continuation. Language resets at every hunk header
 * (`specs/chunk.md` Mechanism §3) — string/bracket/backslash state never
 * carries across a hunk boundary of the same file.
 */
function stringInteriorMask(lines: readonly SourceLine[], layout: DiffLayout): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let oldSide = newStringScanState();
  let newSide = newStringScanState();
  let language: SourceLanguage = "unknown";
  for (let i = 0; i < layout.kinds.length; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (kind === "hunk_header") {
      language = arrayAt(layout.languages, i);
      oldSide = newStringScanState();
      newSide = newStringScanState();
      continue;
    }
    const text = arrayAt(lines, i).text;
    if (language === "unknown" || !isHunkSource(kind) || text.length === 0) continue;
    mask[i] = stringScanStateInString(oldSide) || stringScanStateInString(newSide);
    const body = slice(text, 1, text.length);
    const marker = at(text, 0);
    if (marker === MINUS_BYTE) {
      scanStringScanState(oldSide, body, language);
    } else if (marker === PLUS_BYTE) {
      scanStringScanState(newSide, body, language);
    } else if (marker === SPACE_BYTE) {
      // A context line's text is byte-identical on both sides of the diff —
      // both trackers must consume it to stay synchronized with their
      // respective files' true lexical position.
      scanStringScanState(oldSide, body, language);
      scanStringScanState(newSide, body, language);
    }
  }
  return mask;
}

/** Go's `(*chunkBuilder).sections` (`meat/chunk.go:340-355`). Any preamble before the first file header joins the first section. */
function sectionSpans(b: ChunkBuilderState): LineSpan[] {
  const spans: LineSpan[] = [];
  for (let i = 0; i < b.lines.length; i++) {
    const id = arrayAt(b.layout.fileId, i);
    if (id < 0) continue;
    if (spans.length === 0) {
      spans.push({ start: 0, end: b.lines.length });
    } else if (arrayAt(b.layout.fileId, i - 1) !== id) {
      const last = arrayAt(spans, spans.length - 1);
      spans[spans.length - 1] = { start: last.start, end: i };
      spans.push({ start: i, end: b.lines.length });
    }
  }
  return spans;
}

function rangeText(b: ChunkBuilderState, start: number, end: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = start; i < end; i++) {
    const line = arrayAt(b.lines, i);
    parts.push(line.text, line.eol);
  }
  return concat(parts);
}

/** Go's `(*chunkBuilder).rangeOrigins` (`meat/chunk.go:367-375`): the 0-based original line indices for `[start, end)`, one per physical line of `rangeText(start, end)`. */
function rangeOrigins(start: number, end: number): number[] {
  const origins: number[] = [];
  for (let i = start; i < end; i++) origins.push(i);
  return origins;
}

function spanSizes(b: ChunkBuilderState, start: number, end: number): readonly [textLen: number, rawLen: number, count: number] {
  return [arrayAt(b.prefixText, end) - arrayAt(b.prefixText, start), arrayAt(b.prefixRaw, end) - arrayAt(b.prefixRaw, start), end - start];
}

function fits(b: ChunkBuilderState, textLen: number, rawLen: number, count: number): boolean {
  return rawLen <= b.budget && numberedLen(textLen, count) <= b.budget;
}

function spanFits(b: ChunkBuilderState, start: number, end: number): boolean {
  const [textLen, rawLen, count] = spanSizes(b, start, end);
  return fits(b, textLen, rawLen, count);
}

/** Go's `(*chunkBuilder).spanFullyHidden` (`meat/chunk.go:817-827`). */
function spanFullyHidden(b: ChunkBuilderState, s: LineSpan): boolean {
  for (let i = s.start; i < s.end; i++) {
    if (!arrayAt(b.hidden, i)) return false;
  }
  return s.end > s.start;
}

/** Go's `(*chunkBuilder).spanHasExtraHidden` (`meat/chunk.go:805-815`). */
function spanHasExtraHidden(b: ChunkBuilderState, s: LineSpan): boolean {
  for (let i = s.start; i < s.end; i++) {
    if (arrayAt(b.extraHidden, i)) return true;
  }
  return false;
}

/**
 * Go's `(*chunkBuilder).splitSection` (`meat/chunk.go:394-555`). Cuts one
 * oversized file section into pieces at hunk boundaries, replicating the
 * file-metadata block on every piece; a hunk that is itself oversized is
 * split further by `splitHunk`. Preamble lines before the file's metadata
 * travel with the first piece only and are never replicated (G20).
 */
function splitSection(b: ChunkBuilderState, sectionId: number, s: LineSpan): void {
  let firstHunk = s.end;
  for (let i = s.start; i < s.end; i++) {
    if (arrayAt(b.layout.kinds, i) === "hunk_header") {
      firstHunk = i;
      break;
    }
  }
  if (firstHunk === s.end) {
    const kb = (arrayAt(b.prefixRaw, s.end) - arrayAt(b.prefixRaw, s.start)) >> 10;
    throw new Error(`file section at line ${s.start + 1} is ${kb}KB with no hunks to split — try a narrower diff (per-file with \`git diff -- <path> | meat\`)`);
  }
  let metaStart = firstHunk;
  for (let i = s.start; i < firstHunk; i++) {
    if (arrayAt(b.layout.fileId, i) >= 0) {
      metaStart = i;
      break;
    }
  }
  const preamble: LineSpan = { start: s.start, end: metaStart };
  const preambleText = rangeText(b, preamble.start, preamble.end);
  const meta: LineSpan = { start: metaStart, end: firstHunk };
  const metaText = rangeText(b, meta.start, meta.end);

  // The section tail: lines after the last hunk-body line (a format-patch
  // mail signature, version trailer, or stray prose). It is not part of any
  // hunk's split accounting; it is re-attached to the section's final piece
  // so identity abridgement preserves it byte-for-byte.
  let tailStart = s.end;
  while (tailStart > firstHunk) {
    const kind = arrayAt(b.layout.kinds, tailStart - 1);
    if (isHunkSource(kind) || kind === "no_newline" || kind === "hunk_header") break;
    tailStart--;
  }

  const hunks: LineSpan[] = [];
  for (let i = firstHunk; i < tailStart; ) {
    let j = i + 1;
    while (j < tailStart && arrayAt(b.layout.kinds, j) !== "hunk_header") j++;
    hunks.push({ start: i, end: j });
    i = j;
  }

  let piece = 0;
  const emit = (body: Uint8Array, bodyOrigins: readonly number[]): void => {
    let prefix = metaText;
    let prefixOrigins = rangeOrigins(meta.start, meta.end);
    if (piece === 0) {
      prefix = concat([preambleText, metaText]);
      prefixOrigins = [...rangeOrigins(preamble.start, preamble.end), ...prefixOrigins];
    }
    addChunk(b, {
      text: concat([prefix, body]),
      metaPrefix: metaText,
      sectionId,
      continuation: piece > 0,
      passthrough: false,
      origins: [...prefixOrigins, ...bodyOrigins],
    });
    piece++;
  };
  // prefixSizes is the byte/line cost every piece pays before its body: the
  // replicated metadata, plus the preamble on the first piece.
  const prefixSizes = (): readonly [number, number, number] => {
    let [textLen, rawLen, count] = spanSizes(b, meta.start, meta.end);
    if (piece === 0) {
      const [pt, pr, pc] = spanSizes(b, preamble.start, preamble.end);
      textLen += pt;
      rawLen += pr;
      count += pc;
    }
    return [textLen, rawLen, count];
  };
  const runFits = (start: number, end: number): boolean => {
    const [pt, pr, pc] = prefixSizes();
    const [t, r, c] = spanSizes(b, start, end);
    return fits(b, pt + t, pr + r, pc + c);
  };

  let open = -1; // start line of the accumulating hunk run
  let openEnd = 0;
  const flush = (): void => {
    if (open >= 0) {
      emit(rangeText(b, open, openEnd), rangeOrigins(open, openEnd));
      open = -1;
    }
  };
  for (const h of hunks) {
    if (spanFullyHidden(b, h)) {
      // An import-only hunk: the whole-diff compiler removes it entirely,
      // header included. Skip it; the surrounding pieces concatenate across
      // the gap. Note: unlike the top-level loop above, this branch does
      // NOT flush — see specs/chunk.md Mechanism §5 for the documented
      // consequence (a fully-hidden hunk's raw bytes can be absorbed into an
      // adjacent hunk-run chunk's emitted text).
      continue;
    }
    if (spanHasExtraHidden(b, h)) {
      // Rows hidden only by whole-diff move analysis must be dropped from
      // the emitted text; the segmenting path owns that.
      flush();
      splitHunk(b, h, prefixSizes, emit);
      continue;
    }
    if (open >= 0 && runFits(open, h.end)) {
      openEnd = h.end;
      continue;
    }
    flush();
    if (runFits(h.start, h.end)) {
      open = h.start;
      openEnd = h.end;
      continue;
    }
    splitHunk(b, h, prefixSizes, emit);
  }
  flush();

  // Preserve the section envelope. The tail attaches to the section's final
  // piece when it fits, or becomes its own prose piece; if no piece was ever
  // emitted, any preamble and tail still survive as prose.
  let tailText = rangeText(b, tailStart, s.end);
  if (tailText.length > 0 && piece > 0) {
    const last = arrayAt(b.chunks, b.chunks.length - 1);
    const candidate = concat([last.text, tailText]);
    if (fitsSingleRun(candidate, b.budget)) {
      b.chunks[b.chunks.length - 1] = { ...last, text: candidate, origins: [...last.origins, ...rangeOrigins(tailStart, s.end)] };
      tailText = new Uint8Array(0);
    }
  }
  let prose = tailText;
  if (piece === 0) {
    prose = concat([preambleText, tailText]);
  }
  if (prose.length > 0) {
    if (!fitsSingleRun(prose, b.budget)) {
      throw new Error(
        `cannot fit the diff trailer at line ${tailStart + 1} into a chunk under the size limit — try a narrower diff (per-file with \`git diff -- <path> | meat\`)`,
      );
    }
    addChunk(b, { text: prose, metaPrefix: new Uint8Array(0), sectionId: -1, continuation: false, passthrough: true, origins: [] });
  }
}

/**
 * Go's `(*chunkBuilder).splitHunk` (`meat/chunk.go:579-689`). Cuts one
 * oversized hunk into segments, each emitted as its own piece body: a
 * synthesized `@@` header plus the segment's hunk lines. Cut placement
 * respects atomic units (`unitEnd`): a source line travels with its
 * no-newline markers, with every following line that begins inside a
 * multiline string literal, and — for Python — with a decorator/suite-header
 * owner's absorbed body rows.
 */
function splitHunk(
  b: ChunkBuilderState,
  h: LineSpan,
  prefixSizes: () => readonly [number, number, number],
  emit: (body: Uint8Array, bodyOrigins: readonly number[]) => void,
): void {
  const header = parseHunkHeaderForSplit(arrayAt(b.lines, h.start).text);
  let headerEOL = arrayAt(b.lines, h.start).eol;
  if (headerEOL.length === 0) headerEOL = LF;
  const bodyStart = h.start + 1;
  const bodyEnd = h.end;

  // unitEnd returns the end of the atomic unit starting at line i.
  const unitEnd = (i: number): number => {
    let j = i + 1;
    while (j < bodyEnd && (arrayAt(b.layout.kinds, j) === "no_newline" || arrayAt(b.inString, j))) j++;
    // A Python decorator or suite header absorbs following rows through its
    // first row that will actually EMIT as semantic body on the kept/added
    // side (recursively for nested owners) — see specs/chunk.md Mechanism
    // §7's byte-by-byte trace of why this terminates correctly.
    let last = i;
    while (pythonOwnerLine(b, last)) {
      let advanced = false;
      while (j < bodyEnd && isHunkSource(arrayAt(b.layout.kinds, j)) && arrayAt(b.lines, j).text.length > 0) {
        const row = j;
        j++;
        while (j < bodyEnd && (arrayAt(b.layout.kinds, j) === "no_newline" || arrayAt(b.inString, j))) j++;
        last = row;
        advanced = true;
        if (emitsPythonBody(b, row)) break;
      }
      if (!advanced) break;
    }
    return j;
  };

  let oldOff = 0;
  let newOff = 0;
  let atBodyStart = true;
  let i = bodyStart;
  while (i < bodyEnd) {
    let segStarted = false;
    let segHeading: Uint8Array = new Uint8Array(0);
    let segOldStart = 0;
    let segNewStart = 0;
    let segVisOld = 0;
    let segVisNew = 0;
    let segTextLen = 0;
    let segRawLen = 0;
    let segCount = 0;
    const bodyParts: Uint8Array[] = [];
    const bodyOrigins: number[] = [];
    let hasChange = false;
    while (i < bodyEnd) {
      const next = unitEnd(i);
      const u = unitStats(b, i, next);
      if (u.count === 0) {
        // Fully dropped unit: advances original coordinates only.
        oldOff += u.dropOld;
        newOff += u.dropNew;
        atBodyStart = false;
        i = next;
        continue;
      }
      if (!segStarted) {
        segOldStart = header.oldStart + oldOff;
        segNewStart = header.newStart + newOff;
        if (atBodyStart) segHeading = header.heading;
        segStarted = true;
      }
      const candidateHeader = synthHunkHeader(segOldStart, segVisOld + u.visOld, header.oldZero, segNewStart, segVisNew + u.visNew, header.newZero, segHeading);
      const [pt, pr, pc] = prefixSizes();
      if (
        !fits(
          b,
          pt + candidateHeader.length + segTextLen + u.textLen,
          pr + candidateHeader.length + headerEOL.length + segRawLen + u.rawLen,
          pc + 1 + segCount + u.count,
        )
      ) {
        break;
      }
      segVisOld += u.visOld;
      segVisNew += u.visNew;
      segTextLen += u.textLen;
      segRawLen += u.rawLen;
      segCount += u.count;
      oldOff += u.visOld + u.dropOld;
      newOff += u.visNew + u.dropNew;
      hasChange = hasChange || u.hasChange;
      appendUnit(b, bodyParts, bodyOrigins, i, next);
      atBodyStart = false;
      i = next;
    }
    if (!segStarted) {
      // Only dropped units remained; nothing more to emit.
      break;
    }
    if (segCount === 0) {
      throw new Error(
        `cannot split the diff near line ${i + 1} into a chunk under the size limit — try a narrower diff (per-file with \`git diff -- <path> | meat\`)`,
      );
    }
    if (!hasChange) {
      // A segment with only dropped/context content and no actual +/- row —
      // not emitted, not an error (no plan could retain a change-free hunk
      // either). Continue the outer loop at the current i.
      continue;
    }
    const segmentHeader = synthHunkHeader(segOldStart, segVisOld, header.oldZero, segNewStart, segVisNew, header.newZero, segHeading);
    emit(concat([segmentHeader, headerEOL, ...bodyParts]), [-1, ...bodyOrigins]);
  }
}

/**
 * Go's `unitInfo` (`meat/chunk.go:691-701`): one atomic unit's sizes and
 * per-side row counts of its emitted lines, per-side counts of its dropped
 * lines, and whether any emitted row is a change.
 */
interface UnitInfo {
  textLen: number;
  rawLen: number;
  count: number;
  visOld: number;
  visNew: number;
  dropOld: number;
  dropNew: number;
  hasChange: boolean;
}

/** Go's `(*chunkBuilder).unitStats` (`meat/chunk.go:703-743`). */
function unitStats(b: ChunkBuilderState, start: number, end: number): UnitInfo {
  const u: UnitInfo = { textLen: 0, rawLen: 0, count: 0, visOld: 0, visNew: 0, dropOld: 0, dropNew: 0, hasChange: false };
  for (let i = start; i < end; i++) {
    let uo = 0;
    let un = 0;
    const line = arrayAt(b.lines, i);
    if (isHunkSource(arrayAt(b.layout.kinds, i)) && line.text.length > 0) {
      const marker = at(line.text, 0);
      if (marker === SPACE_BYTE) {
        uo = 1;
        un = 1;
      } else if (marker === MINUS_BYTE) {
        uo = 1;
      } else if (marker === PLUS_BYTE) {
        un = 1;
      }
    }
    if (arrayAt(b.hidden, i)) {
      const ph = placeholderRow(b, i);
      if (ph !== null) {
        u.visOld += uo;
        u.visNew += un;
        u.textLen += ph.text.length;
        u.rawLen += ph.text.length + ph.eol.length;
        u.count++;
        if (arrayAt(b.layout.kinds, i) === "hunk_change") u.hasChange = true;
        continue;
      }
      u.dropOld += uo;
      u.dropNew += un;
      continue;
    }
    u.visOld += uo;
    u.visNew += un;
    u.textLen += line.text.length;
    u.rawLen += line.text.length + line.eol.length;
    u.count++;
    if (arrayAt(b.layout.kinds, i) === "hunk_change") u.hasChange = true;
  }
  return u;
}

/**
 * Go's `(*chunkBuilder).appendUnit` (`meat/chunk.go:749-764`): writes the
 * emitted text of one atomic unit into `parts`/`origins` in place — visible
 * lines verbatim, hidden lines dropped, placeholder-carrying hidden lines as
 * their fixed `...` row.
 */
function appendUnit(b: ChunkBuilderState, parts: Uint8Array[], origins: number[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    if (arrayAt(b.hidden, i)) {
      const ph = placeholderRow(b, i);
      if (ph !== null) {
        parts.push(ph.text, ph.eol);
        origins.push(-1);
      }
      continue;
    }
    const line = arrayAt(b.lines, i);
    parts.push(line.text, line.eol);
    origins.push(i);
  }
}

interface PlaceholderRow {
  readonly text: Uint8Array;
  readonly eol: Uint8Array;
}

/** Go's `(*chunkBuilder).placeholderRow` (`meat/chunk.go:768-775`): the fixed mandatory-placeholder row for hidden line `i`, when the whole-diff compiler would emit one there. */
function placeholderRow(b: ChunkBuilderState, i: number): PlaceholderRow | null {
  const fi = arrayAt(b.foldAt, i);
  if (fi < 0) return null;
  const f = arrayAt(b.folds, fi);
  if (f.marker === null) {
    throw new Error(`internal: mandatory placeholder fold at line ${i} has no marker`);
  }
  return { text: concat([encodeUTF8(f.marker), f.indent, ELLIPSIS_ASCII]), eol: f.eol };
}

/** Go's `(*chunkBuilder).pythonOwnerLine` (`meat/chunk.go:777-789`): a visible Python decorator or suite header on the kept/added side. */
function pythonOwnerLine(b: ChunkBuilderState, i: number): boolean {
  const line = arrayAt(b.lines, i);
  if (
    !arrayAt(b.layout.python, i) ||
    arrayAt(b.hidden, i) ||
    !isHunkSource(arrayAt(b.layout.kinds, i)) ||
    line.text.length < 2 ||
    at(line.text, 0) === MINUS_BYTE
  ) {
    return false;
  }
  if (arrayAt(b.inString, i)) return false;
  const trimmed = trimPythonCode(slice(line.text, 1, line.text.length));
  return hasPrefix(trimmed, AT_BYTE) || isPythonSuiteHeaderStart(trimmed);
}

/** Go's `(*chunkBuilder).emitsPythonBody` (`meat/chunk.go:791-803`): whether line `i` will emit as a semantic body row on the kept/added side. */
function emitsPythonBody(b: ChunkBuilderState, i: number): boolean {
  const line = arrayAt(b.lines, i);
  if (line.text.length === 0 || at(line.text, 0) === MINUS_BYTE) return false;
  if (arrayAt(b.hidden, i)) return placeholderRow(b, i) !== null;
  return trimPythonCode(slice(line.text, 1, line.text.length)).length > 0;
}

/**
 * Go's `synthHunkHeader` (`meat/chunk.go:829-837`): renders a segment's `@@`
 * header from its side starts and emitted-row counts. `heading` is arbitrary
 * trailing diff text (e.g. a function signature) and may contain non-ASCII
 * bytes, so this returns bytes, not a plain string (H1) — its length feeds
 * directly into the fits-check in `splitHunk`.
 */
function synthHunkHeader(
  oldStart: number,
  oldCount: number,
  oldZero: boolean,
  newStart: number,
  newCount: number,
  newZero: boolean,
  heading: Uint8Array,
): Uint8Array {
  const o = gapAdjustedStart(oldStart, oldCount, oldZero);
  const n = gapAdjustedStart(newStart, newCount, newZero);
  return concat([encodeUTF8(`@@ -${o},${oldCount} +${n},${newCount} @@`), heading]);
}

/**
 * Go's `gapAdjustedStart` (`meat/chunk.go:839-847`): when a segment has no
 * rows on a side whose original range was nonempty, unified-diff convention
 * names the line before the gap (G7); the `!originallyZero` guard prevents
 * re-decrementing a side whose original count was already zero (G8); the
 * clamp prevents a negative synthesized start for a new-file hunk (G9).
 */
function gapAdjustedStart(start: number, count: number, originallyZero: boolean): number {
  if (count === 0 && !originallyZero) {
    start--;
    if (start < 0) start = 0;
  }
  return start;
}

interface ParsedHunkHeader {
  readonly oldStart: number;
  readonly oldZero: boolean;
  readonly newStart: number;
  readonly newZero: boolean;
  readonly heading: Uint8Array;
}

/**
 * Go's `parseHunkHeaderForSplit` (`meat/chunk.go:849-876`): extracts the
 * range starts, whether each side's original count is zero, and the
 * trailing section heading from an `@@` header. An unparseable header (e.g.
 * a bare `@@`) yields starts of 1 and no heading — reachable (not dead) per
 * `specs/chunk.md` Mechanism §11: structurally-accepted-as-a-hunk-header is
 * not the same as successfully parsing its counts.
 */
function parseHunkHeaderForSplit(text: Uint8Array): ParsedHunkHeader {
  const fallback: ParsedHunkHeader = { oldStart: 1, oldZero: false, newStart: 1, newZero: false, heading: new Uint8Array(0) };
  if (!hasPrefix(text, HUNK_PREFIX)) return fallback;
  const rest = slice(text, HUNK_PREFIX.length, text.length);
  const closer = indexOf(rest, HUNK_CLOSER);
  if (closer < 0) return fallback;
  const heading = slice(rest, closer + HUNK_CLOSER.length, rest.length);
  const flds = fields(slice(rest, 0, closer));
  if (flds.length !== 2) return { ...fallback, heading };
  let oldStart = fallback.oldStart;
  let oldZero = fallback.oldZero;
  let newStart = fallback.newStart;
  let newZero = fallback.newZero;
  const oldParsed = parseHunkStart(arrayAt(flds, 0), MINUS_BYTE);
  if (oldParsed !== null) {
    oldStart = oldParsed.start;
    oldZero = oldParsed.zeroCount;
  }
  const newParsed = parseHunkStart(arrayAt(flds, 1), PLUS_BYTE);
  if (newParsed !== null) {
    newStart = newParsed.start;
    newZero = newParsed.zeroCount;
  }
  return { oldStart, oldZero, newStart, newZero, heading };
}

interface ParsedHunkStart {
  readonly start: number;
  readonly zeroCount: boolean;
}

/** Go's `parseHunkStart` (`meat/chunk.go:878-892`). */
function parseHunkStart(field: Uint8Array, sign: number): ParsedHunkStart | null {
  if (field.length < 2 || at(field, 0) !== sign) return null;
  let s = slice(field, 1, field.length);
  let zeroCount = false;
  const comma = indexOf(s, COMMA_BYTE);
  if (comma >= 0) {
    zeroCount = equals(slice(s, comma + 1, s.length), ZERO_BYTE);
    s = slice(s, 0, comma);
  }
  const v = parseGoInt(s);
  if (v === null || v < 0) return null;
  return { start: v, zeroCount };
}

// ---------------------------------------------------------------------------
// abridgeChunked's merge-step helpers (`meat/chunk.go:894-908,1003-1086`).
// Pure — zero dependency on `meat.ts` — but their only caller,
// `abridgeChunked` itself, needs `abridgeOne`/`Model`/`Request`/`Result`
// (item 4n) and so lives in `meat.ts`, not here. See TODO.md item 4k's "As
// built" note (originally deferred these alongside `abridgeChunked`) and
// item 4n's note (confirmed, while starting that item, that these five have
// no dependency on `meat.ts` and belong in this file, Go's own home for
// them — only `abridgeChunked` itself needed to move).
// ---------------------------------------------------------------------------

/**
 * Go's `chunkError` (`meat/chunk.go:894-908`): names the chunk whose agent
 * run failed while preserving the wrapped error chain. `Error()` is a pure
 * label-splice, never a new message (H5) — it takes whatever `err.message`
 * already says (already `"meat: "`-prefixed, from `abridgeOne`'s own
 * convention) and re-prefixes once with the chunk label spliced in, never
 * stacking prefixes. `{ cause: err }` is this port's `Unwrap()` — the
 * closest native equivalent to Go's `errors.Is`/`errors.As` chain walking.
 */
export function chunkError(label: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`meat: ${label}: ${message.replace(/^meat: /, "")}`, { cause: err });
}

/**
 * Go's `mapMovesToChunk` (`meat/chunk.go:1003-1041`): translates whole-diff
 * move coordinates (1-based original lines) into a chunk's own 1-based
 * coordinates using the chunk's line origins. A move maps only when BOTH
 * complete sides landed contiguously in this chunk (G38) — a move split
 * across chunks cannot be enforced, a documented cost of chunking.
 */
export function mapMovesToChunk(moves: readonly DetectedMove[], origins: readonly number[]): DetectedMove[] {
  if (moves.length === 0 || origins.length === 0) return [];
  // chunkLine.get(orig) = 1-based chunk line for original 0-based index orig.
  const chunkLine = new Map<number, number>();
  for (let i = 0; i < origins.length; i++) {
    const orig = arrayAt(origins, i);
    if (orig >= 0) chunkLine.set(orig, i + 1);
  }
  const mapRange = (r: LineRange): LineRange | null => {
    const start = chunkLine.get(r.startLine - 1);
    if (start === undefined) return null;
    for (let orig = r.startLine - 1; orig < r.endLine; orig++) {
      const at = chunkLine.get(orig);
      if (at === undefined || at !== start + (orig - (r.startLine - 1))) return null;
    }
    return { startLine: start, endLine: start + (r.endLine - r.startLine) };
  };
  const mapped: DetectedMove[] = [];
  for (const m of moves) {
    const removed = mapRange(m.removed);
    const added = mapRange(m.added);
    if (removed !== null && added !== null) {
      mapped.push({ removed, added });
    }
  }
  return mapped;
}

/** Go's `firstLineText` (`meat/chunk.go:1043-1049`): the text of `s`'s first physical line. */
export function firstLineText(s: Uint8Array): Uint8Array {
  const nl = indexOf(s, LF);
  const line = nl >= 0 ? slice(s, 0, nl) : s;
  return hasSuffix(line, CR) ? slice(line, 0, line.length - 1) : line;
}

/** Go's `pieceContainsLine` (`meat/chunk.go:1051-1059`): whether any physical line of `piece` equals `text`. */
export function pieceContainsLine(piece: Uint8Array, text: Uint8Array): boolean {
  for (const l of splitSourceLines(piece)) {
    if (equals(l.text, text)) return true;
  }
  return false;
}

/**
 * Go's `stripReplicatedMeta` (`meat/chunk.go:1061-1086`): drops the leading
 * lines of a continuation piece's reading diff that replicate its
 * file-metadata block. Matching is in-order and stops at the first
 * non-matching line (the piece's own first `@@` header, which can never
 * appear in the block by construction — `meta`'s span is built strictly
 * before the first hunk header, specs/chunk.md Mechanism §15).
 */
export function stripReplicatedMeta(smart: Uint8Array, metaPrefix: Uint8Array): Uint8Array {
  const metaLines = splitSourceLines(metaPrefix);
  const smartLines = splitSourceLines(smart);
  let drop = 0;
  let j = 0;
  for (const l of smartLines) {
    let k = j;
    while (k < metaLines.length && !equals(arrayAt(metaLines, k).text, l.text)) k++;
    if (k === metaLines.length) break;
    j = k + 1;
    drop++;
  }
  const parts: Uint8Array[] = [];
  for (let i = drop; i < smartLines.length; i++) {
    const l = arrayAt(smartLines, i);
    parts.push(l.text, l.eol);
  }
  return concat(parts);
}
