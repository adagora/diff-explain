// diff.ts parses unified diffs into an immutable line-oriented layout
// (meat/diff.go). **Foundation** — everything downstream (editplan, chunk,
// imports, moves, python, elision) reads this layout and never re-parses.
//
// H1: byte-oriented throughout, never `string`. `sourceLine.text` and every
// classification input is a `Uint8Array`; this is the very first
// byte-consuming stage in the pipeline, so every downstream byte budget is
// ultimately measured over text this file produced. Decoding to a JS string
// happens only at the CLI/model-API boundary, never here.

import {
  type Line,
  splitLines,
  at,
  arrayAt,
  slice,
  equals,
  hasPrefix,
  hasSuffix,
  indexOf,
  concat,
  trimSpace,
  encodeUTF8,
  isSpaceRune,
  runes,
} from "./bytes.ts";

export type SourceLine = Line;
/** Go's `splitSourceLines` (`meat/diff.go:66-86`) — the byte-slice layer's `splitLines` primitive under its diff.go name. */
export const splitSourceLines = splitLines;

export type DiffLineKind =
  | "other"
  | "header"
  | "index"
  | "rename_from"
  | "rename_to"
  | "copy_from"
  | "copy_to"
  | "mail_signature"
  | "old_file"
  | "new_file"
  | "hunk_header"
  | "hunk_context"
  | "hunk_change"
  | "no_newline";

export type SourceLanguage = "unknown" | "go" | "python" | "javascript" | "rust" | "c" | "java";

/**
 * Go's `diffLayout` (`meat/diff.go:53-61`): N-entry parallel arrays, one
 * entry per physical line. Classification never changes after `analyzeDiff`
 * returns — every consumer only reads these fields (Invariants,
 * `specs/diff.md`).
 */
export interface DiffLayout {
  kinds: DiffLineKind[];
  markerOwner: number[];
  python: boolean[];
  languages: SourceLanguage[];
  fileId: number[];
  hunkId: number[];
  problems: string[];
}

export interface HunkRange {
  readonly start: number;
  readonly end: number;
}

const GIT_DIFF_HEADER = encodeUTF8("diff --git ");
const DIFF_CC = encodeUTF8("diff --cc ");
const DIFF_COMBINED = encodeUTF8("diff --combined ");
const MAIL_SIGNATURE_TEXT = encodeUTF8("-- ");
const NO_NEWLINE_MARKER_TEXT = encodeUTF8("\\ No newline at end of file");
const INDEX_PREFIX = encodeUTF8("index ");
const SIMILARITY_INDEX_PREFIX = encodeUTF8("similarity index ");
const DISSIMILARITY_INDEX_PREFIX = encodeUTF8("dissimilarity index ");
const RENAME_FROM_PREFIX = encodeUTF8("rename from ");
const RENAME_TO_PREFIX = encodeUTF8("rename to ");
const COPY_FROM_PREFIX = encodeUTF8("copy from ");
const COPY_TO_PREFIX = encodeUTF8("copy to ");
const OLD_MARKER_SPACE = encodeUTF8("--- ");
const OLD_MARKER_TAB = encodeUTF8("---\t");
const NEW_MARKER_SPACE = encodeUTF8("+++ ");
const NEW_MARKER_TAB = encodeUTF8("+++\t");
const HUNK_MARK = encodeUTF8("@@");
const HUNK_MARK_SPACE = encodeUTF8("@@ ");
const TAB = encodeUTF8("\t");
const COMMA = encodeUTF8(",");
const LF = encodeUTF8("\n");

const SPACE_BYTE = 0x20;
const PLUS_BYTE = 0x2b;
const MINUS_BYTE = 0x2d;
const QUOTE_BYTE = 0x22;

/** Go's `isGitDiffHeader` (`meat/diff.go:100-102`). */
export function isGitDiffHeader(text: Uint8Array): boolean {
  return hasPrefix(text, GIT_DIFF_HEADER);
}

/** Go's `isFormatPatchSignature` (`meat/diff.go:463-465`): exactly `"-- "`. */
export function isFormatPatchSignature(line: Uint8Array): boolean {
  return equals(line, MAIL_SIGNATURE_TEXT);
}

/** Go's `isNoNewlineMarker` (`meat/diff.go:467-469`). */
export function isNoNewlineMarker(line: Uint8Array): boolean {
  return equals(line, NO_NEWLINE_MARKER_TEXT);
}

function isFileMarker(line: Uint8Array, space: Uint8Array, tab: Uint8Array): boolean {
  return hasPrefix(line, space) || hasPrefix(line, tab);
}

/** Go's `isRawOldFileHeader` (`meat/diff.go:453-457`): a `---`/`+++` pair at `index`/`index+1`. */
export function isRawOldFileHeader(lines: readonly SourceLine[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const first = arrayAt(lines, index);
  const second = arrayAt(lines, index + 1);
  return (
    isFileMarker(first.text, OLD_MARKER_SPACE, OLD_MARKER_TAB) &&
    isFileMarker(second.text, NEW_MARKER_SPACE, NEW_MARKER_TAB)
  );
}

/** Go's `hunkSourceKind` (`meat/diff.go:354-366`). */
export function hunkSourceKind(text: Uint8Array): DiffLineKind {
  if (text.length === 0) return "other";
  const first = at(text, 0);
  if (first === SPACE_BYTE) return "hunk_context";
  if (first === PLUS_BYTE || first === MINUS_BYTE) return "hunk_change";
  return "other";
}

/** Go's `isHunkSource` (`meat/diff.go:158-160`). */
export function isHunkSource(kind: DiffLineKind): boolean {
  return kind === "hunk_context" || kind === "hunk_change";
}

/**
 * Go's `strings.Fields` (used by `parseHunkCounts`/`diffHeaderLanguage`,
 * `meat/diff.go:369,402`, and — exported for reuse — `chunk.go`'s own
 * `parseHunkHeaderForSplit`, `meat/chunk.go:865`): split on runs of Unicode
 * whitespace (`unicode.IsSpace`, i.e. `isSpaceRune`), discarding empty
 * fields. A distinct whitespace definition from H3's regex `\s` and H14's
 * `TrimSpace` — see `specs/diff.md`'s "Related but unregistered" hazard
 * note.
 */
export function fields(b: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  let start = -1;
  for (const r of runes(b)) {
    if (isSpaceRune(r.codePoint)) {
      if (start >= 0) {
        result.push(slice(b, start, r.offset));
        start = -1;
      }
    } else if (start < 0) {
      start = r.offset;
    }
  }
  if (start >= 0) result.push(slice(b, start, b.length));
  return result;
}

/**
 * Go's `strconv.Atoi`: optional leading `+`/`-`, then 1+ ASCII digits. `null`
 * on any other input. Exported for `chunk.go`'s own `parseHunkStart`
 * (`meat/chunk.go:887`), which needs the identical integer-parsing semantics.
 */
export function parseGoInt(b: Uint8Array): number | null {
  if (b.length === 0) return null;
  let i = 0;
  let negative = false;
  const first = at(b, 0);
  if (first === PLUS_BYTE || first === MINUS_BYTE) {
    negative = first === MINUS_BYTE;
    i = 1;
  }
  if (i >= b.length) return null;
  let value = 0;
  for (; i < b.length; i++) {
    const c = at(b, i);
    if (c < 0x30 || c > 0x39) return null;
    value = value * 10 + (c - 0x30);
  }
  return negative ? -value : value;
}

function parseHunkRange(field: Uint8Array, sign: number): number | null {
  if (field.length < 2 || at(field, 0) !== sign) return null;
  let rangeText = slice(field, 1, field.length);
  let count = 1;
  const comma = indexOf(rangeText, COMMA);
  if (comma >= 0) {
    const parsed = parseGoInt(slice(rangeText, comma + 1, rangeText.length));
    if (parsed === null || parsed < 0) return null;
    count = parsed;
    rangeText = slice(rangeText, 0, comma);
  }
  // The start-line field must parse as an integer, but its value is never used.
  if (parseGoInt(rangeText) === null) return null;
  return count;
}

export interface HunkCounts {
  readonly oldCount: number;
  readonly newCount: number;
  readonly countsKnown: boolean;
}

const UNKNOWN_COUNTS: HunkCounts = { oldCount: 0, newCount: 0, countsKnown: false };

/** Go's `parseHunkCounts` (`meat/diff.go:368-379`). */
export function parseHunkCounts(header: Uint8Array): HunkCounts {
  const flds = fields(header);
  if (flds.length < 4 || !equals(arrayAt(flds, 0), HUNK_MARK) || !equals(arrayAt(flds, 3), HUNK_MARK)) {
    return UNKNOWN_COUNTS;
  }
  const oldCount = parseHunkRange(arrayAt(flds, 1), MINUS_BYTE);
  if (oldCount === null) return UNKNOWN_COUNTS;
  const newCount = parseHunkRange(arrayAt(flds, 2), PLUS_BYTE);
  if (newCount === null) return UNKNOWN_COUNTS;
  return { oldCount, newCount, countsKnown: true };
}

function trimQuotes(b: Uint8Array): Uint8Array {
  let start = 0;
  let end = b.length;
  while (start < end && at(b, start) === QUOTE_BYTE) start++;
  while (end > start && at(b, end - 1) === QUOTE_BYTE) end--;
  return slice(b, start, end);
}

/**
 * ASCII-only lowercasing, not Go's full Unicode `strings.ToLower`. Safe
 * here specifically because `pathLanguage` only ever tests the *result*
 * against fixed ASCII suffix patterns (`.go`, `.py`, ...): non-ASCII bytes
 * are left untouched but can never match an ASCII suffix pattern anyway, so
 * the suffix-match outcome is identical to Go's full Unicode lowercase for
 * every reachable input. Do not reuse this helper anywhere a full
 * case-insensitive comparison (not just an ASCII-suffix test) is needed.
 */
function toLowerASCII(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const c = at(b, i);
    out[i] = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  }
  return out;
}

const PATH_LANGUAGE_SUFFIXES: ReadonlyArray<readonly [Uint8Array, SourceLanguage]> = [
  [encodeUTF8(".go"), "go"],
  [encodeUTF8(".py"), "python"],
  [encodeUTF8(".pyi"), "python"],
  [encodeUTF8(".js"), "javascript"],
  [encodeUTF8(".jsx"), "javascript"],
  [encodeUTF8(".mjs"), "javascript"],
  [encodeUTF8(".cjs"), "javascript"],
  [encodeUTF8(".ts"), "javascript"],
  [encodeUTF8(".tsx"), "javascript"],
  [encodeUTF8(".mts"), "javascript"],
  [encodeUTF8(".cts"), "javascript"],
  [encodeUTF8(".rs"), "rust"],
  [encodeUTF8(".c"), "c"],
  [encodeUTF8(".h"), "c"],
  [encodeUTF8(".cc"), "c"],
  [encodeUTF8(".hh"), "c"],
  [encodeUTF8(".cpp"), "c"],
  [encodeUTF8(".hpp"), "c"],
  [encodeUTF8(".cxx"), "c"],
  [encodeUTF8(".hxx"), "c"],
  [encodeUTF8(".java"), "java"],
  [encodeUTF8(".kt"), "java"],
  [encodeUTF8(".kts"), "java"],
];

/** Go's `pathLanguage` (`meat/diff.go:427-451`). */
export function pathLanguage(path: Uint8Array): SourceLanguage {
  const lowered = toLowerASCII(trimQuotes(path));
  for (const [suffix, language] of PATH_LANGUAGE_SUFFIXES) {
    if (hasSuffix(lowered, suffix)) return language;
  }
  return "unknown";
}

/** Go's `diffHeaderLanguage` (`meat/diff.go:401-414`): last non-`unknown` field wins, scanning `fields[2:]`. */
export function diffHeaderLanguage(line: Uint8Array): SourceLanguage {
  const flds = fields(line);
  if (flds.length < 4) return "unknown";
  let language: SourceLanguage = "unknown";
  for (let i = 2; i < flds.length; i++) {
    const candidate = pathLanguage(arrayAt(flds, i));
    if (candidate !== "unknown") language = candidate;
  }
  return language;
}

/** Go's `fileMarkerLanguage` (`meat/diff.go:416-425`). */
export function fileMarkerLanguage(line: Uint8Array): SourceLanguage {
  if (line.length < 4) return "unknown";
  let path = trimSpace(slice(line, 4, line.length));
  const tab = indexOf(path, TAB);
  if (tab >= 0) path = slice(path, 0, tab);
  return pathLanguage(path);
}

/**
 * Go's `validateSupportedDiffLines` (`meat/diff.go:104-122`) — the
 * combined-diff pre-pass (G1). Runs once, before `analyzeDiff`, which
 * itself performs no combined-diff gating (Invariants, `specs/diff.md`).
 * Throws on the first combined-diff marker found; otherwise returns.
 */
export function validateSupportedDiffLines(lines: readonly SourceLine[]): void {
  let inPatch = false;
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    if (isFormatPatchSignature(line.text)) {
      inPatch = false;
    } else if (hasPrefix(line.text, DIFF_CC) || hasPrefix(line.text, DIFF_COMBINED)) {
      throw new Error(`combined diff on line ${i + 1} is unsupported; use a normal first-parent or two-tree diff`);
    } else if (isGitDiffHeader(line.text)) {
      inPatch = true;
    } else if (isRawOldFileHeader(lines, i)) {
      inPatch = true;
    }
    if (inPatch && hasPrefix(line.text, encodeUTF8("@@@"))) {
      throw new Error(
        `combined diff hunk on line ${i + 1} is unsupported; use a normal first-parent or two-tree diff`,
      );
    }
  }
}

/**
 * Go's `analyzeDiff` (`meat/diff.go:165-352`): the structural classifier
 * state machine. Never throws — structural problems (hunk counts
 * inconsistent) accumulate in `layout.problems` for the caller to join and
 * report (`specs/diff.md` Algorithm 3/4).
 */
export function analyzeDiff(lines: readonly SourceLine[]): DiffLayout {
  const n = lines.length;
  const layout: DiffLayout = {
    kinds: new Array<DiffLineKind>(n).fill("other"),
    markerOwner: new Array<number>(n).fill(-1),
    python: new Array<boolean>(n).fill(false),
    languages: new Array<SourceLanguage>(n).fill("unknown"),
    fileId: new Array<number>(n).fill(-1),
    hunkId: new Array<number>(n).fill(-1),
    problems: [],
  };

  let inHunk = false;
  let countsKnown = false;
  let hunkProblemReported = false;
  let oldRemain = 0;
  let newRemain = 0;
  let hunkHeaderLine = 0;
  let currentLanguage: SourceLanguage = "unknown";
  let currentFileId = -1;
  let currentHunkId = -1;
  let gitFileSection = false;
  let inFileSection = false;

  const reportHunkProblem = (atLine: number): void => {
    if (hunkProblemReported) return;
    layout.problems.push(
      `hunk header on line ${hunkHeaderLine + 1} has counts inconsistent with its body near line ${atLine + 1}`,
    );
    hunkProblemReported = true;
  };

  let i = 0;
  while (i < n) {
    const text = arrayAt(lines, i).text;

    if (!inHunk) {
      if (isGitDiffHeader(text)) {
        currentFileId++;
        gitFileSection = true;
        inFileSection = true;
        currentLanguage = diffHeaderLanguage(text);
      } else if (isRawOldFileHeader(lines, i)) {
        if (!gitFileSection) currentFileId++;
        inFileSection = true;
        const oldLanguage = fileMarkerLanguage(arrayAt(lines, i).text);
        if (oldLanguage !== "unknown") currentLanguage = oldLanguage;
        const newLanguage = fileMarkerLanguage(arrayAt(lines, i + 1).text);
        if (newLanguage !== "unknown") currentLanguage = newLanguage;
      }
    }
    layout.languages[i] = currentLanguage;
    layout.python[i] = currentLanguage === "python";
    layout.fileId[i] = currentFileId;

    if (inHunk) {
      if (!countsKnown && isRawOldFileHeader(lines, i)) {
        // A bare/otherwise unparseable @@ header has no counts. Recover at an
        // explicit paired file header rather than making it editable.
        inHunk = false;
        continue;
      }
      if (countsKnown && oldRemain === 0 && newRemain === 0) {
        if (isNoNewlineMarker(text)) {
          layout.kinds[i] = "no_newline";
          layout.hunkId[i] = currentHunkId;
          if (i > 0 && isHunkSource(arrayAt(layout.kinds, i - 1))) {
            layout.markerOwner[i] = i - 1;
          }
          i++;
          continue;
        }
        if (
          isRawOldFileHeader(lines, i) ||
          isGitDiffHeader(text) ||
          hasPrefix(text, HUNK_MARK) ||
          isFormatPatchSignature(text)
        ) {
          inHunk = false;
          continue;
        }
        const kind = hunkSourceKind(text);
        if (kind !== "other") {
          reportHunkProblem(i);
          layout.kinds[i] = kind;
          layout.hunkId[i] = currentHunkId;
          i++;
          continue;
        }
        inHunk = false;
        continue;
      }
      if (isNoNewlineMarker(text)) {
        layout.kinds[i] = "no_newline";
        layout.hunkId[i] = currentHunkId;
        if (i > 0 && isHunkSource(arrayAt(layout.kinds, i - 1))) {
          layout.markerOwner[i] = i - 1;
        }
        i++;
        continue;
      }

      const kind = hunkSourceKind(text);
      if (kind !== "other") {
        if (countsKnown) {
          let valid = false;
          const first = at(text, 0);
          if (first === SPACE_BYTE) {
            valid = oldRemain > 0 && newRemain > 0;
            if (valid) {
              oldRemain--;
              newRemain--;
            }
          } else if (first === MINUS_BYTE) {
            valid = oldRemain > 0;
            if (valid) oldRemain--;
          } else if (first === PLUS_BYTE) {
            valid = newRemain > 0;
            if (valid) newRemain--;
          }
          if (!valid) reportHunkProblem(i);
        }
        layout.kinds[i] = kind;
        layout.hunkId[i] = currentHunkId;
        i++;
        continue;
      }

      if (countsKnown && (oldRemain !== 0 || newRemain !== 0)) {
        reportHunkProblem(i);
      }
      // Re-run this line through the outer structural classifier.
      inHunk = false;
      continue;
    }

    if (isFormatPatchSignature(text)) {
      layout.kinds[i] = "mail_signature";
      inFileSection = false;
      gitFileSection = false;
      i++;
    } else if (isGitDiffHeader(text)) {
      layout.kinds[i] = "header";
      i++;
    } else if (
      inFileSection &&
      (hasPrefix(text, INDEX_PREFIX) || hasPrefix(text, SIMILARITY_INDEX_PREFIX) || hasPrefix(text, DISSIMILARITY_INDEX_PREFIX))
    ) {
      layout.kinds[i] = "index";
      i++;
    } else if (inFileSection && hasPrefix(text, RENAME_FROM_PREFIX)) {
      layout.kinds[i] = "rename_from";
      i++;
    } else if (inFileSection && hasPrefix(text, RENAME_TO_PREFIX)) {
      layout.kinds[i] = "rename_to";
      i++;
    } else if (inFileSection && hasPrefix(text, COPY_FROM_PREFIX)) {
      layout.kinds[i] = "copy_from";
      i++;
    } else if (inFileSection && hasPrefix(text, COPY_TO_PREFIX)) {
      layout.kinds[i] = "copy_to";
      i++;
    } else if (isRawOldFileHeader(lines, i)) {
      layout.kinds[i] = "old_file";
      layout.kinds[i + 1] = "new_file";
      layout.languages[i + 1] = currentLanguage;
      layout.python[i + 1] = currentLanguage === "python";
      layout.fileId[i + 1] = currentFileId;
      i += 2;
    } else if ((inFileSection || equals(text, HUNK_MARK) || hasPrefix(text, HUNK_MARK_SPACE)) && hasPrefix(text, HUNK_MARK)) {
      layout.kinds[i] = "hunk_header";
      currentHunkId++;
      layout.hunkId[i] = currentHunkId;
      const counts = parseHunkCounts(text);
      oldRemain = counts.oldCount;
      newRemain = counts.newCount;
      countsKnown = counts.countsKnown;
      inHunk = true;
      hunkHeaderLine = i;
      hunkProblemReported = false;
      i++;
    } else {
      i++;
    }
  }
  if (inHunk && countsKnown && (oldRemain !== 0 || newRemain !== 0)) {
    reportHunkProblem(n - 1);
  }
  return layout;
}

/**
 * Go's `validateSupportedDiff` (`meat/diff.go:88-98`): the combined-diff
 * pre-pass followed by full structural classification, joining any
 * accumulated problems into one thrown error. Never reaches the model on
 * failure (G1/G2).
 */
export function validateSupportedDiff(diff: Uint8Array): void {
  const lines = splitSourceLines(diff);
  validateSupportedDiffLines(lines);
  const layout = analyzeDiff(lines);
  if (layout.problems.length > 0) {
    throw joinEditPlanErrors(layout.problems);
  }
}

/**
 * Go's `numberedDiff` (`meat/diff.go:126-137`): a display-only 1-based
 * line-number gutter for the model. The gutter's own newline is always LF
 * regardless of the source line's terminator, and — because
 * `splitSourceLines` never emits a phantom trailing line — no phantom final
 * gutter entry is produced either (G5).
 */
export function numberedDiff(diff: Uint8Array): Uint8Array {
  const lines = splitSourceLines(diff);
  if (lines.length === 0) return new Uint8Array(0);
  const width = String(lines.length).length;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    parts.push(encodeUTF8(`${String(i + 1).padStart(width, " ")}|`), line.text, LF);
  }
  return concat(parts);
}

/** Go's `containingHunk` (`meat/diff.go:139-156`). */
export function containingHunk(layout: DiffLayout, line: number): HunkRange {
  let start = line;
  while (start > 0 && arrayAt(layout.kinds, start) !== "hunk_header") start--;
  if (arrayAt(layout.kinds, start) === "hunk_header") start++;
  let end = line + 1;
  while (end < layout.kinds.length) {
    const kind = arrayAt(layout.kinds, end);
    if (kind === "hunk_header" || kind === "header" || kind === "old_file" || kind === "mail_signature") break;
    end++;
  }
  return { start, end };
}

/** Go's `nextLayoutLine` (`meat/diff.go:471-480`). */
export function nextLayoutLine(layout: DiffLayout, start: number, stop: (kind: DiffLineKind) => boolean): number {
  for (let i = start; i < layout.kinds.length; i++) {
    if (stop(arrayAt(layout.kinds, i))) return i;
  }
  return layout.kinds.length;
}

/**
 * Go's `joinEditPlanErrors` (`meat/editplan.go:531-539`). Ported here, not
 * in `editplan.ts`, because `diff.ts`'s own `validateSupportedDiff` is the
 * first (and dependency-order-earliest) caller — see `TODO.md` item 4d's
 * "As built" note. `chunk.ts`/`editplan.ts`/`moves.ts`/`python.ts` import
 * it from here when they need it.
 */
export function joinEditPlanErrors(problems: readonly string[]): Error {
  if (problems.length === 1) {
    return new Error(arrayAt(problems, 0));
  }
  let body = "";
  for (const problem of problems) {
    body += `\n- ${problem}`;
  }
  return new Error(`edit plan has ${problems.length} errors:${body}`);
}
