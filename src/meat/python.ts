// python.ts — Python-aware plan validators layered on top of the
// language-agnostic structural rules (meat/python.go). Conservative,
// text-level: recognizes fixed syntactic signatures rather than parsing
// Python, and rejects a plan rather than guessing. H1: pervasive and
// exclusive — every scan here is byte-indexed, never rune-based (H2 does
// not apply to this file; contrast moves.ts).
//
// `isPythonSuiteOwner` (Go: meat/python.go:787-790) is deliberately not
// ported: verified dead code (grep the whole Go repo — the only match is
// its own definition, no production or test call site). Its
// same-line-colon check would also be *wrong* for a multi-line suite
// header; every real caller needing "is this header complete" uses
// `pythonSuiteHeaderEnd` instead, which is the only one of the two that's
// correct for multi-line headers. See specs/python.md's Open questions.

import { at, arrayAt, slice, equals, hasPrefix, hasSuffix, indexOf, trimSpace, encodeUTF8, decodeUTF8, splitBytes, countOccurrences } from "./bytes.ts";
import { type SourceLine, type DiffLayout, type DiffLineKind, isHunkSource, containingHunk, nextLayoutLine, joinEditPlanErrors } from "./diff.ts";
import {
  type PlanState,
  type PlannedReplacement,
  applyPlannedReplacements,
  leadingWhitespace,
  planStateRepresented,
  isIdentifierStart,
  isIdentifierContinue,
} from "./plan.ts";

const HASH = 0x23;
const BACKSLASH = 0x5c;
const SINGLE_QUOTE = 0x27;
const DOUBLE_QUOTE = 0x22;
const EQUALS = 0x3d;
const DOT = 0x2e;
const SPACE = 0x20;
const TAB = 0x09;
const MINUS = 0x2d;
const PLUS = 0x2b;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const OPEN_SQUARE = 0x5b;
const CLOSE_SQUARE = 0x5d;
const OPEN_CURLY = 0x7b;
const CLOSE_CURLY = 0x7d;

const TRIPLE_SINGLE = encodeUTF8("'''");
const TRIPLE_DOUBLE = encodeUTF8('"""');
const COLON = encodeUTF8(":");
const AT_BYTES = encodeUTF8("@");
const EQUALS_BYTES = encodeUTF8("=");

/** Go's `pythonTripleState` (`meat/python.go:582-588`): a 3-way discriminator — Python triple-quoted strings don't nest, so no depth count is needed. */
export type PythonTripleState = "none" | "single" | "double";
export const pythonTripleNone: PythonTripleState = "none";
const pythonTripleSingle: PythonTripleState = "single";
const pythonTripleDouble: PythonTripleState = "double";

/**
 * Stands in for Go's `*pythonTripleState` out-parameter. `scanPythonTripleLine`
 * and `pythonDelimiterBalanceWithState` mutate `.value` in place, exactly as
 * Go mutates through the pointer — used instead of returning an updated
 * state alongside each function's real return value, since this file
 * threads state through many hand-written loops and a 1:1 mutable-ref shape
 * keeps each translation close to its Go original.
 */
export interface PythonTripleStateRef {
  value: PythonTripleState;
}
export function newTripleStateRef(initial: PythonTripleState = pythonTripleNone): PythonTripleStateRef {
  return { value: initial };
}

/** Go's `pythonDelimiters` (`meat/python.go:379-391`): three independent signed counters, never merged except by `pythonDelimiterDepth`. */
export interface PythonDelimiters {
  readonly round: number;
  readonly square: number;
  readonly curly: number;
}
const ZERO_DELIMITERS: PythonDelimiters = { round: 0, square: 0, curly: 0 };

function addDelimiters(a: PythonDelimiters, b: PythonDelimiters): PythonDelimiters {
  return { round: a.round + b.round, square: a.square + b.square, curly: a.curly + b.curly };
}
function delimitersEqual(a: PythonDelimiters, b: PythonDelimiters): boolean {
  return a.round === b.round && a.square === b.square && a.curly === b.curly;
}

function isHunkSectionBoundary(k: DiffLineKind): boolean {
  return k === "header" || k === "old_file" || k === "hunk_header" || k === "mail_signature";
}

/** Go's `scanPythonTripleLine` (`meat/python.go:590-641`). Returns the number of open/close transitions seen; mutates `state.value`. */
export function scanPythonTripleLine(text: Uint8Array, state: PythonTripleStateRef): number {
  let transitions = 0;
  let i = 0;
  while (i < text.length) {
    if (state.value !== pythonTripleNone) {
      const delim = state.value === pythonTripleDouble ? TRIPLE_DOUBLE : TRIPLE_SINGLE;
      const idx = indexOf(slice(text, i, text.length), delim);
      if (idx < 0) return transitions;
      i += idx + delim.length;
      state.value = pythonTripleNone;
      transitions++;
      continue;
    }
    if (at(text, i) === HASH) return transitions;
    const rest = slice(text, i, text.length);
    if (hasPrefix(rest, TRIPLE_SINGLE)) {
      state.value = pythonTripleSingle;
      transitions++;
      i += 3;
      continue;
    }
    if (hasPrefix(rest, TRIPLE_DOUBLE)) {
      state.value = pythonTripleDouble;
      transitions++;
      i += 3;
      continue;
    }
    const b = at(text, i);
    if (b === SINGLE_QUOTE || b === DOUBLE_QUOTE) {
      const quote = b;
      i++;
      while (i < text.length) {
        if (at(text, i) === BACKSLASH) {
          i += 2;
          continue;
        }
        if (at(text, i) === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return transitions;
}

/** Go's `pythonDelimiterBalanceWithState` (`meat/python.go:403-466`). Mutates `state.value`. */
export function pythonDelimiterBalanceWithState(text: Uint8Array, state: PythonTripleStateRef): PythonDelimiters {
  let round = 0;
  let square = 0;
  let curly = 0;
  let i = 0;
  while (i < text.length) {
    if (state.value !== pythonTripleNone) {
      const delim = state.value === pythonTripleDouble ? TRIPLE_DOUBLE : TRIPLE_SINGLE;
      const idx = indexOf(slice(text, i, text.length), delim);
      if (idx < 0) return { round, square, curly };
      i += idx + delim.length;
      state.value = pythonTripleNone;
      continue;
    }
    const b = at(text, i);
    if (b === HASH) break;
    const rest = slice(text, i, text.length);
    if (hasPrefix(rest, TRIPLE_SINGLE)) {
      state.value = pythonTripleSingle;
      i += 3;
      continue;
    }
    if (hasPrefix(rest, TRIPLE_DOUBLE)) {
      state.value = pythonTripleDouble;
      i += 3;
      continue;
    }
    if (b === SINGLE_QUOTE || b === DOUBLE_QUOTE) {
      const quote = b;
      i++;
      while (i < text.length) {
        if (at(text, i) === BACKSLASH) {
          i += 2;
          continue;
        }
        if (at(text, i) === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (b === OPEN_PAREN) round++;
    else if (b === CLOSE_PAREN) round--;
    else if (b === OPEN_SQUARE) square++;
    else if (b === CLOSE_SQUARE) square--;
    else if (b === OPEN_CURLY) curly++;
    else if (b === CLOSE_CURLY) curly--;
    i++;
  }
  return { round, square, curly };
}

/** Go's `pythonDelimiterBalance` (`meat/python.go:398-401`): always starts fresh, never carries triple-quote context in from a previous line. */
export function pythonDelimiterBalance(text: Uint8Array): PythonDelimiters {
  return pythonDelimiterBalanceWithState(text, newTripleStateRef());
}

/** Go's `pythonDelimiterDepth` (`meat/python.go:393-396`). */
export function pythonDelimiterDepth(text: Uint8Array): number {
  const d = pythonDelimiterBalance(text);
  return d.round + d.square + d.curly;
}

/**
 * Go's `trimPythonCode` (`meat/python.go:726-754`): a deliberately simpler,
 * non-triple-aware approximation — a single `quote` byte plus `escaped`
 * flag, one byte at a time. Must reproduce this exact (imperfect) machine,
 * never "fixed" into a triple-aware scanner (specs/python.md §3).
 */
export function trimPythonCode(text: Uint8Array): Uint8Array {
  let quote = 0;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const b = at(text, i);
    if (quote !== 0) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (b === BACKSLASH) {
        escaped = true;
        continue;
      }
      if (b === quote) quote = 0;
      continue;
    }
    if (b === SINGLE_QUOTE || b === DOUBLE_QUOTE) {
      quote = b;
      continue;
    }
    if (b === HASH) return trimSpace(slice(text, 0, i));
  }
  return trimSpace(text);
}

/** Go's `pythonCodeWithoutStrings` (`meat/python.go:695-724`): breaks the scan entirely at the first `#` or triple-quote-looking prefix — see specs/python.md's Open questions for the same-line consequence. */
export function pythonCodeWithoutStrings(text: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    const b = at(text, i);
    if (b === HASH) break;
    const rest = slice(text, i, text.length);
    if (hasPrefix(rest, TRIPLE_SINGLE) || hasPrefix(rest, TRIPLE_DOUBLE)) break;
    if (b === SINGLE_QUOTE || b === DOUBLE_QUOTE) {
      const quote = b;
      i++;
      while (i < text.length) {
        if (at(text, i) === BACKSLASH) {
          i += 2;
          continue;
        }
        if (at(text, i) === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out.push(b);
    i++;
  }
  return new Uint8Array(out);
}

/** Go's `isPythonDefinition` (`meat/python.go:374-377`). */
export function isPythonDefinition(trimmedIn: Uint8Array): boolean {
  const trimmed = trimPythonCode(trimmedIn);
  return hasPrefix(trimmed, encodeUTF8("def ")) || hasPrefix(trimmed, encodeUTF8("async def ")) || hasPrefix(trimmed, encodeUTF8("class "));
}

function hasPythonKeyword(text: Uint8Array, keyword: Uint8Array): boolean {
  if (!hasPrefix(text, keyword) || text.length === keyword.length) return false;
  const next = at(text, keyword.length);
  return next === SPACE || next === TAB || next === OPEN_PAREN;
}

const SUITE_KEYWORDS = ["if", "elif", "for", "while", "with", "except", "except*", "match", "case"].map(encodeUTF8);
const ASYNC_KEYWORD_SPACE = ["async for ", "async with "].map(encodeUTF8);
const ASYNC_KEYWORD_PAREN = ["async for(", "async with("].map(encodeUTF8);
const BARE_SUITE_TERMINALS = ["else:", "try:", "except:", "finally:"].map(encodeUTF8);

/** Go's `isPythonSuiteHeaderStart` (`meat/python.go:756-777`): "could this be the start of a suite header" — deliberately no trailing-colon requirement (see `pythonSuiteHeaderEnd`, which owns that check for multi-line headers). */
export function isPythonSuiteHeaderStart(trimmedIn: Uint8Array): boolean {
  const trimmed = trimPythonCode(trimmedIn);
  if (isPythonDefinition(trimmed)) return true;
  for (const keyword of SUITE_KEYWORDS) {
    if (hasPythonKeyword(trimmed, keyword)) return true;
  }
  for (let k = 0; k < ASYNC_KEYWORD_SPACE.length; k++) {
    if (hasPrefix(trimmed, arrayAt(ASYNC_KEYWORD_SPACE, k)) || hasPrefix(trimmed, arrayAt(ASYNC_KEYWORD_PAREN, k))) return true;
  }
  for (const terminal of BARE_SUITE_TERMINALS) {
    if (equals(trimmed, terminal)) return true;
  }
  return false;
}

/** Go's `pythonTripleStateBeforeLine` (`meat/python.go:792-802`): always the *raw* hunk text — takes no `*planState` at all. */
export function pythonTripleStateBeforeLine(lines: readonly SourceLine[], layout: DiffLayout, line: number): PythonTripleState {
  const { start: hunkStart } = containingHunk(layout, line);
  const state = newTripleStateRef();
  for (let i = hunkStart; i < line; i++) {
    const text = arrayAt(lines, i).text;
    if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length < 2 || at(text, 0) === MINUS) continue;
    scanPythonTripleLine(slice(text, 1, text.length), state);
  }
  return state.value;
}

/** Go's `pythonSuiteHeaderEnd` (`meat/python.go:277-306`). Returns the header's terminal line index, or `null` if unresolved (Go: `(0, false)`). */
export function pythonSuiteHeaderEnd(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState | null, start: number): number | null {
  const { end: hunkEnd } = containingHunk(layout, start);
  let depth = 0;
  for (let i = start; i < hunkEnd; i++) {
    if (state !== null) {
      if (arrayAt(state.foldAt, i) >= 0) continue;
      if (arrayAt(state.hidden, i)) continue;
    }
    const text = arrayAt(lines, i).text;
    if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length < 2 || at(text, 0) === MINUS) continue;
    const body = slice(text, 1, text.length);
    const trimmed = trimPythonCode(body);
    if (trimmed.length === 0) continue;
    depth += pythonDelimiterDepth(body);
    if (depth < 0) return null;
    if (depth === 0 && hasSuffix(trimmed, COLON)) return i;
  }
  return null;
}

/** Go's `hasPythonBodyAfter` (`meat/python.go:308-333`). */
export function hasPythonBodyAfter(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState | null, ownerLine: number, indent: number): boolean {
  const { end: hunkEnd } = containingHunk(layout, ownerLine);
  for (let i = ownerLine + 1; i < hunkEnd; i++) {
    if (state !== null) {
      const foldIndex = arrayAt(state.foldAt, i);
      if (foldIndex >= 0) {
        const fold = arrayAt(state.folds, foldIndex);
        if (fold.marker === "-") continue;
        return (fold.marker === "+" || fold.marker === " ") && fold.indent.length > indent;
      }
      if (arrayAt(state.hidden, i)) continue;
    }
    const text = arrayAt(lines, i).text;
    if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length < 2 || at(text, 0) === MINUS) continue;
    const body = slice(text, 1, text.length);
    if (trimPythonCode(body).length === 0) continue;
    return leadingWhitespace(body).length > indent;
  }
  return false;
}

/** Go's `hasPythonDefinitionAfter` (`meat/python.go:335-372`). */
export function hasPythonDefinitionAfter(
  lines: readonly SourceLine[],
  layout: DiffLayout,
  state: PlanState | null,
  decoratorLine: number,
  indent: number,
): boolean {
  const { end: hunkEnd } = containingHunk(layout, decoratorLine);
  const decoratorText = arrayAt(lines, decoratorLine).text;
  let depth = pythonDelimiterDepth(slice(decoratorText, 1, decoratorText.length));
  for (let i = decoratorLine + 1; i < hunkEnd; i++) {
    if (state !== null) {
      if (arrayAt(state.foldAt, i) >= 0) continue;
      if (arrayAt(state.hidden, i)) continue;
    }
    const text = arrayAt(lines, i).text;
    if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length < 2 || at(text, 0) === MINUS) continue;
    const body = slice(text, 1, text.length);
    const trimmed = trimPythonCode(body);
    if (trimmed.length === 0) continue;
    if (depth > 0) {
      depth += pythonDelimiterDepth(body);
      if (depth < 0) return false;
      continue;
    }
    if (leadingWhitespace(body).length !== indent) return false;
    if (hasPrefix(trimmed, AT_BYTES)) {
      depth = pythonDelimiterDepth(body);
      continue;
    }
    return isPythonDefinition(trimmed);
  }
  return false;
}

/** Go's `hunkHasVisibleChange` (`meat/python.go:54-61`). */
export function hunkHasVisibleChange(layout: DiffLayout, state: PlanState, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (arrayAt(layout.kinds, i) === "hunk_change" && planStateRepresented(state, i)) return true;
  }
  return false;
}

/** Go's `pythonLineOnSide` (`meat/python.go:150-155`). `side` is a raw diff-marker byte (`-`/`+`). */
export function pythonLineOnSide(lines: readonly SourceLine[], layout: DiffLayout, line: number, side: number): boolean {
  const text = arrayAt(lines, line).text;
  if (!isHunkSource(arrayAt(layout.kinds, line)) || text.length < 2) return false;
  const marker = at(text, 0);
  return marker === SPACE || marker === side;
}

/** Go's `hiddenPythonRegionBalanced` (`meat/python.go:101-148`). */
export function hiddenPythonRegionBalanced(
  lines: readonly SourceLine[],
  layout: DiffLayout,
  hunkStart: number,
  start: number,
  end: number,
  side: number,
): boolean {
  const beforeTripleRef = newTripleStateRef();
  for (let i = hunkStart; i < start; i++) {
    if (pythonLineOnSide(lines, layout, i, side)) {
      const text = arrayAt(lines, i).text;
      scanPythonTripleLine(slice(text, 1, text.length), beforeTripleRef);
    }
  }
  const beforeTriple = beforeTripleRef.value;
  const enteredTriple = beforeTriple !== pythonTripleNone;
  const actualTripleRef = newTripleStateRef(beforeTriple);
  const localTripleRef = newTripleStateRef();
  let tripleTransitions = 0;
  const bodies: Uint8Array[] = [];
  for (let i = start; i < end; i++) {
    if (!pythonLineOnSide(lines, layout, i, side)) continue;
    const text = arrayAt(lines, i).text;
    const body = slice(text, 1, text.length);
    bodies.push(body);
    scanPythonTripleLine(body, localTripleRef);
    if (enteredTriple) {
      tripleTransitions += scanPythonTripleLine(body, actualTripleRef);
    }
  }
  if (bodies.length === 0) return true;
  const trimmedFirst = trimSpace(arrayAt(bodies, 0));
  const startsWithBareTriple = equals(trimmedFirst, TRIPLE_DOUBLE) || equals(trimmedFirst, TRIPLE_SINGLE);
  if (enteredTriple && tripleTransitions > 0 && (localTripleRef.value !== pythonTripleNone || startsWithBareTriple)) return false;
  if (!enteredTriple && localTripleRef.value !== pythonTripleNone) return false;

  const delimiterTripleRef = newTripleStateRef(enteredTriple && tripleTransitions === 0 ? beforeTriple : pythonTripleNone);
  let balance = ZERO_DELIMITERS;
  for (const body of bodies) {
    balance = addDelimiters(balance, pythonDelimiterBalanceWithState(body, delimiterTripleRef));
    if (balance.round < 0 || balance.square < 0 || balance.curly < 0) return false;
  }
  return delimitersEqual(balance, ZERO_DELIMITERS);
}

export interface PythonNewSideStates {
  readonly insideTriple: boolean[];
  readonly depthBefore: number[];
}

/** Go's `pythonNewSideStates` (`meat/python.go:157-193`): whole-diff precompute feeding only `validateHiddenReferences`. */
export function pythonNewSideStates(lines: readonly SourceLine[], layout: DiffLayout): PythonNewSideStates {
  const insideTriple: boolean[] = new Array(lines.length).fill(false);
  const depthBefore: number[] = new Array(lines.length).fill(0);
  for (let hunk = 0; hunk < layout.kinds.length; hunk++) {
    if (arrayAt(layout.kinds, hunk) !== "hunk_header" || !arrayAt(layout.python, hunk)) continue;
    const end = nextLayoutLine(layout, hunk + 1, isHunkSectionBoundary);
    const tripleRef = newTripleStateRef();
    let round = 0;
    let square = 0;
    let curly = 0;
    for (let i = hunk + 1; i < end; i++) {
      const text = arrayAt(lines, i).text;
      if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length < 2 || at(text, 0) === MINUS) continue;
      insideTriple[i] = tripleRef.value !== pythonTripleNone;
      depthBefore[i] = round + square + curly;
      const delta = pythonDelimiterBalanceWithState(slice(text, 1, text.length), tripleRef);
      round += delta.round;
      square += delta.square;
      curly += delta.curly;
      // A hunk can start mid-expression, with context that closes delimiters
      // opened above the hunk. Clamp each kind independently (G18) so a
      // later top-level assignment still gets reference protection.
      if (round < 0) round = 0;
      if (square < 0) square = 0;
      if (curly < 0) curly = 0;
    }
  }
  return { insideTriple, depthBefore };
}

/** Go's `simpleAssignedReference` (`meat/python.go:804-828`). Returns the dotted-path target, or `null` if not a "simple" assignment. */
export function simpleAssignedReference(body: Uint8Array): Uint8Array | null {
  const trimmed = trimSpace(body);
  const eq = indexOf(trimmed, EQUALS_BYTES);
  if (eq <= 0 || (eq + 1 < trimmed.length && at(trimmed, eq + 1) === EQUALS)) return null;
  let lhs = trimSpace(slice(trimmed, 0, eq));
  const colon = indexOf(lhs, COLON);
  if (colon >= 0) lhs = trimSpace(slice(lhs, 0, colon));
  if (lhs.length === 0) return null;
  for (const segment of splitBytes(lhs, DOT)) {
    if (segment.length === 0 || !isIdentifierStart(at(segment, 0))) return null;
    for (let i = 1; i < segment.length; i++) {
      if (!isIdentifierContinue(at(segment, i))) return null;
    }
  }
  return lhs;
}

/** Go's `containsIdentifier` (`meat/python.go:830-846`): whole-word substring search using the same ASCII identifier-continuation rule used everywhere else in this file. */
export function containsIdentifier(text: Uint8Array, name: Uint8Array): boolean {
  let offset = 0;
  while (offset <= text.length - name.length) {
    const idx = indexOf(slice(text, offset, text.length), name);
    if (idx < 0) return false;
    const matchAt = idx + offset;
    const beforeOK = matchAt === 0 || !isIdentifierContinue(at(text, matchAt - 1));
    const after = matchAt + name.length;
    const afterOK = after === text.length || !isIdentifierContinue(at(text, after));
    if (beforeOK && afterOK) return true;
    offset = matchAt + 1;
  }
  return false;
}

const BOUNDARY_TOKENS = ["(", ")", "[", "]", "{", "}", "'''", '"""'].map(encodeUTF8);

/** Go's `changesPythonBoundaryTokens` (`meat/python.go:16-23`). `oldText`/`newText` are the model's proposed replacement strings, not diff lines. */
export function changesPythonBoundaryTokens(oldText: Uint8Array, newText: Uint8Array): boolean {
  for (const token of BOUNDARY_TOKENS) {
    if (countOccurrences(oldText, token) !== countOccurrences(newText, token)) return true;
  }
  return false;
}

/** Go's `validateHiddenPythonOwners` (`meat/python.go:25-52`). */
export function validateHiddenPythonOwners(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState): void {
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    if (!arrayAt(state.hidden, i) || !arrayAt(layout.python, i) || !isHunkSource(arrayAt(layout.kinds, i)) || line.text.length < 2 || at(line.text, 0) === MINUS) {
      continue;
    }
    if (pythonTripleStateBeforeLine(lines, layout, i) !== pythonTripleNone) continue;
    const body = slice(line.text, 1, line.text.length);
    const trimmed = trimPythonCode(body);
    const indent = leadingWhitespace(body).length;
    if (hasPrefix(trimmed, AT_BYTES)) {
      if (hasPythonDefinitionAfter(lines, layout, null, i, indent) && hasPythonDefinitionAfter(lines, layout, state, i, indent)) {
        problems.push(`remove/fold: hides Python decorator on line ${i + 1} while its definition remains visible`);
      }
    } else if (isPythonSuiteHeaderStart(trimmed)) {
      const rawEnd = pythonSuiteHeaderEnd(lines, layout, null, i);
      if (rawEnd !== null && hasPythonBodyAfter(lines, layout, null, rawEnd, indent) && hasPythonBodyAfter(lines, layout, state, rawEnd, indent)) {
        problems.push(`remove/fold: hides Python suite owner on line ${i + 1} while its body remains visible`);
      }
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}

/** Go's `validateHiddenPythonBoundaries` (`meat/python.go:63-99`). */
export function validateHiddenPythonBoundaries(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState): void {
  const problems: string[] = [];
  for (let hunk = 0; hunk < layout.kinds.length; hunk++) {
    if (arrayAt(layout.kinds, hunk) !== "hunk_header" || !arrayAt(layout.python, hunk)) continue;
    const end = nextLayoutLine(layout, hunk + 1, isHunkSectionBoundary);
    if (!hunkHasVisibleChange(layout, state, hunk + 1, end)) continue;
    let i = hunk + 1;
    while (i < end) {
      if (!arrayAt(state.hidden, i) || !isHunkSource(arrayAt(layout.kinds, i))) {
        i++;
        continue;
      }
      const start = i;
      while (i < end && arrayAt(state.hidden, i) && isHunkSource(arrayAt(layout.kinds, i))) i++;
      for (const side of [MINUS, PLUS]) {
        if (!hiddenPythonRegionBalanced(lines, layout, hunk + 1, start, i, side)) {
          const sideName = side === PLUS ? "new" : "old";
          problems.push(
            `remove/fold: hidden Python region ${start + 1}-${i} crosses ${sideName}-side expression or string boundaries; keep the boundaries and compress only their interior`,
          );
        }
      }
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}

/** Go's `validateHiddenReferences` (`meat/python.go:195-236`). */
export function validateHiddenReferences(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState): void {
  const { insideTriple, depthBefore } = pythonNewSideStates(lines, layout);
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    if (!arrayAt(state.hidden, i) || !arrayAt(layout.python, i) || !isHunkSource(arrayAt(layout.kinds, i)) || line.text.length < 2 || at(line.text, 0) === MINUS) {
      continue;
    }
    if (arrayAt(insideTriple, i) || arrayAt(depthBefore, i) !== 0) continue;
    const name = simpleAssignedReference(pythonCodeWithoutStrings(slice(line.text, 1, line.text.length)));
    if (name === null) continue;
    const fileId = arrayAt(layout.fileId, i);
    for (let j = 0; j < lines.length; j++) {
      const otherText = arrayAt(lines, j).text;
      if (arrayAt(layout.fileId, j) !== fileId || arrayAt(state.hidden, j) || !isHunkSource(arrayAt(layout.kinds, j)) || otherText.length < 2) continue;
      if (at(line.text, 0) === PLUS && at(otherText, 0) === MINUS) continue;
      if (arrayAt(insideTriple, j)) continue;
      const body = pythonCodeWithoutStrings(slice(otherText, 1, otherText.length));
      if (!containsIdentifier(body, name)) continue;
      const foldIndex = arrayAt(state.folded, i);
      const nameText = decodeUTF8(name);
      if (foldIndex >= 0) {
        problems.push(
          `fold[${foldIndex}]: hides definition "${nameText}" on line ${i + 1} while retained line ${j + 1} still references it; keep the definition and fold only its interior`,
        );
      } else {
        problems.push(
          `remove: hides definition "${nameText}" on line ${i + 1} while retained line ${j + 1} still references it; keep the definition and compress only its interior`,
        );
      }
      break;
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}

/** Go's `validatePythonSuiteSkeleton` (`meat/python.go:238-275`). */
export function validatePythonSuiteSkeleton(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState): void {
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    if (!arrayAt(layout.python, i) || arrayAt(state.hidden, i) || !isHunkSource(arrayAt(layout.kinds, i)) || line.text.length < 2 || at(line.text, 0) === MINUS) {
      continue;
    }
    if (pythonTripleStateBeforeLine(lines, layout, i) !== pythonTripleNone) continue;
    const body = slice(line.text, 1, line.text.length);
    const trimmed = trimPythonCode(body);
    if (hasPrefix(trimmed, AT_BYTES)) {
      const indent = leadingWhitespace(body).length;
      if (hasPythonDefinitionAfter(lines, layout, null, i, indent) && !hasPythonDefinitionAfter(lines, layout, state, i, indent)) {
        problems.push(`remove/fold: retained Python decorator on line ${i + 1} has no attached definition`);
      }
      continue;
    }
    if (!isPythonSuiteHeaderStart(trimmed)) continue;
    const rawEnd = pythonSuiteHeaderEnd(lines, layout, null, i);
    if (rawEnd === null) continue;
    const ownerIndent = leadingWhitespace(body).length;
    if (hasPythonBodyAfter(lines, layout, null, rawEnd, ownerIndent)) {
      const retainedEnd = pythonSuiteHeaderEnd(lines, layout, state, i);
      if (retainedEnd === null || !hasPythonBodyAfter(lines, layout, state, retainedEnd, ownerIndent)) {
        problems.push(`remove/fold: retained Python suite owner on line ${i + 1} has no indented body; keep a semantic body line or an interior fold`);
      }
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}

/** Go's `validatePythonDelimiterBalance` (`meat/python.go:468-519`). */
export function validatePythonDelimiterBalance(
  lines: readonly SourceLine[],
  layout: DiffLayout,
  state: PlanState,
  replacements: ReadonlyMap<number, readonly PlannedReplacement[]>,
): void {
  const problems: string[] = [];
  for (let i = 0; i < layout.kinds.length; i++) {
    if (arrayAt(layout.kinds, i) !== "hunk_header" || !arrayAt(layout.python, i)) continue;
    const end = nextLayoutLine(layout, i + 1, isHunkSectionBoundary);
    if (!hunkHasVisibleChange(layout, state, i + 1, end)) continue;
    let rawOld = ZERO_DELIMITERS;
    let rawNew = ZERO_DELIMITERS;
    let keptOld = ZERO_DELIMITERS;
    let keptNew = ZERO_DELIMITERS;
    const rawOldTriple = newTripleStateRef();
    const rawNewTriple = newTripleStateRef();
    const keptOldTriple = newTripleStateRef();
    const keptNewTriple = newTripleStateRef();
    for (let j = i + 1; j < end; j++) {
      const text = arrayAt(lines, j).text;
      if (!isHunkSource(arrayAt(layout.kinds, j)) || text.length < 1) continue;
      const body = slice(text, 1, text.length);
      const edits = replacements.get(j + 1) ?? [];
      const keptBody = edits.length > 0 ? applyPlannedReplacements(body, edits) : body;
      const marker = at(text, 0);
      if (marker === SPACE) {
        rawOld = addDelimiters(rawOld, pythonDelimiterBalanceWithState(body, rawOldTriple));
        rawNew = addDelimiters(rawNew, pythonDelimiterBalanceWithState(body, rawNewTriple));
        if (!arrayAt(state.hidden, j)) {
          keptOld = addDelimiters(keptOld, pythonDelimiterBalanceWithState(keptBody, keptOldTriple));
          keptNew = addDelimiters(keptNew, pythonDelimiterBalanceWithState(keptBody, keptNewTriple));
        }
      } else if (marker === MINUS) {
        rawOld = addDelimiters(rawOld, pythonDelimiterBalanceWithState(body, rawOldTriple));
        if (!arrayAt(state.hidden, j)) {
          keptOld = addDelimiters(keptOld, pythonDelimiterBalanceWithState(keptBody, keptOldTriple));
        }
      } else if (marker === PLUS) {
        rawNew = addDelimiters(rawNew, pythonDelimiterBalanceWithState(body, rawNewTriple));
        if (!arrayAt(state.hidden, j)) {
          keptNew = addDelimiters(keptNew, pythonDelimiterBalanceWithState(keptBody, keptNewTriple));
        }
      }
    }
    if (!delimitersEqual(rawOld, keptOld) || !delimitersEqual(rawNew, keptNew)) {
      problems.push(
        `remove/fold: hunk on line ${i + 1} must preserve Python (), [], and {} delimiter balance; keep both boundaries or fold/remove the complete balanced expression`,
      );
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}

/** Go's `endsPythonBackslash` (`meat/python.go:573-580`). */
export function endsPythonBackslash(body: Uint8Array): boolean {
  const code = trimPythonCode(body);
  let count = 0;
  for (let i = code.length - 1; i >= 0 && at(code, i) === BACKSLASH; i--) count++;
  return count % 2 === 1;
}

/** Go's `validatePythonBackslashContinuations` (`meat/python.go:521-571`). */
export function validatePythonBackslashContinuations(
  lines: readonly SourceLine[],
  layout: DiffLayout,
  state: PlanState,
  replacements: ReadonlyMap<number, readonly PlannedReplacement[]>,
): void {
  const problems: string[] = [];
  for (let hunk = 0; hunk < layout.kinds.length; hunk++) {
    if (arrayAt(layout.kinds, hunk) !== "hunk_header" || !arrayAt(layout.python, hunk)) continue;
    const end = nextLayoutLine(layout, hunk + 1, isHunkSectionBoundary);
    if (!hunkHasVisibleChange(layout, state, hunk + 1, end)) continue;
    for (const side of [MINUS, PLUS]) {
      const sideLines: number[] = [];
      for (let i = hunk + 1; i < end; i++) {
        if (pythonLineOnSide(lines, layout, i, side)) sideLines.push(i);
      }
      const tripleRef = newTripleStateRef();
      for (let i = 0; i + 1 < sideLines.length; i++) {
        const line = arrayAt(sideLines, i);
        const next = arrayAt(sideLines, i + 1);
        const lineText = arrayAt(lines, line).text;
        const body = slice(lineText, 1, lineText.length);
        const insideTriple = tripleRef.value !== pythonTripleNone;
        scanPythonTripleLine(body, tripleRef);
        if (insideTriple || !endsPythonBackslash(body)) continue;
        const lineHidden = arrayAt(state.hidden, line);
        const nextHidden = arrayAt(state.hidden, next);
        if (!lineHidden) {
          const edits = replacements.get(line + 1) ?? [];
          const keptBody = edits.length > 0 ? applyPlannedReplacements(body, edits) : body;
          if (!endsPythonBackslash(keptBody)) continue;
        }
        if (lineHidden !== nextHidden) {
          problems.push(`remove/fold: Python backslash continuation on lines ${line + 1}-${next + 1} must be retained or hidden together`);
        }
      }
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}

/** Go's `validateTripleQuoteParity` (`meat/python.go:643-693`). */
export function validateTripleQuoteParity(
  lines: readonly SourceLine[],
  layout: DiffLayout,
  state: PlanState,
  replacements: ReadonlyMap<number, readonly PlannedReplacement[]>,
): void {
  const problems: string[] = [];
  for (let i = 0; i < layout.kinds.length; i++) {
    if (arrayAt(layout.kinds, i) !== "hunk_header" || !arrayAt(layout.python, i)) continue;
    const end = nextLayoutLine(layout, i + 1, isHunkSectionBoundary);
    if (!hunkHasVisibleChange(layout, state, i + 1, end)) continue;
    const rawOld = newTripleStateRef();
    const rawNew = newTripleStateRef();
    const keptOld = newTripleStateRef();
    const keptNew = newTripleStateRef();
    for (let j = i + 1; j < end; j++) {
      const text = arrayAt(lines, j).text;
      if (!isHunkSource(arrayAt(layout.kinds, j)) || text.length < 1) continue;
      const body = slice(text, 1, text.length);
      const edits = replacements.get(j + 1) ?? [];
      const keptBody = edits.length > 0 ? applyPlannedReplacements(body, edits) : body;
      const marker = at(text, 0);
      if (marker === SPACE) {
        scanPythonTripleLine(body, rawOld);
        scanPythonTripleLine(body, rawNew);
        if (!arrayAt(state.hidden, j)) {
          scanPythonTripleLine(keptBody, keptOld);
          scanPythonTripleLine(keptBody, keptNew);
        }
      } else if (marker === MINUS) {
        scanPythonTripleLine(body, rawOld);
        if (!arrayAt(state.hidden, j)) scanPythonTripleLine(keptBody, keptOld);
      } else if (marker === PLUS) {
        scanPythonTripleLine(body, rawNew);
        if (!arrayAt(state.hidden, j)) scanPythonTripleLine(keptBody, keptNew);
      }
    }
    if (rawOld.value !== keptOld.value || rawNew.value !== keptNew.value) {
      problems.push(
        `remove/fold: hunk on line ${i + 1} must preserve balanced Python triple-quote boundaries; fold or remove the complete string, or keep both boundaries`,
      );
    }
  }
  if (problems.length > 0) throw joinEditPlanErrors(problems);
}
