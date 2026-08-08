// imports.ts — the mandatory (compiler-owned) import-removal pass
// (meat/imports.go). A pure classifier: decides which physical lines are
// import declarations (or their scaffolding) and must be hidden from every
// rendering, independent of what any model or hand-authored plan says.
//
// DESIGN DECISION — the one file in the byte-oriented engine that decodes
// to JS strings, and why that's still H1-safe: this file's classification
// leans on 18 of Go's regexes (H3b — the single largest `\s` concentration
// named in migration/HAZARDS.md). `RegExp` cannot run against a
// `Uint8Array`, and hand-rolling 18 regex-equivalent byte scanners — several
// with multi-line joining, capture groups, and backtracking-adjacent
// alternation — would be far more error-prone than the regexes they
// replace. This file's own H1 analysis (specs/imports.md) already concludes
// every classification decision here is ASCII-anchored and "position-safe
// under either a consistent byte or a consistent UTF-16 indexing scheme
// individually" — and this file's only output is line-index-based
// (`LineRange[]`), never a byte offset, so nothing downstream measures a
// decoded string's `.length` as a byte budget (the actual failure mode H1
// warns about). Every regex `.test()` call below runs against a lossily
// decoded string (`toRegexText`, `TextDecoder` without `{fatal: true}` —
// never throws, substitutes U+FFFD for invalid sequences, unlike
// `bytes.ts`'s strict `decodeUTF8`) computed from a `Uint8Array` at the
// point of use; every non-regex string operation (HasPrefix/HasSuffix/
// Count/TrimSpace/comparison-to-empty/Split) stays on the original bytes via
// `bytes.ts` primitives. One known, accepted limitation: a Python `from`
// clause's captured member list (`pythonFromStartRE`'s one capture group) is
// extracted from the decoded string and re-encoded to bytes for further
// processing — round-trips exactly for valid UTF-8 (the only case any
// fixture exercises) but would not reproduce invalid-UTF-8 input
// byte-for-byte. See TODO.md item 4h's "As built" note.

import {
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
  splitBytes,
  countOccurrences,
} from "./bytes.ts";
import {
  type SourceLine,
  type DiffLayout,
  type DiffLineKind,
  type SourceLanguage,
  isHunkSource,
  containingHunk,
  nextLayoutLine,
} from "./diff.ts";
import { type LineRange, type PlanState, planStateRepresented, leadingWhitespace, isIdentifierStart, isIdentifierContinue } from "./plan.ts";
import {
  scanPythonTripleLine,
  newTripleStateRef,
  pythonTripleNone,
  trimPythonCode,
  isPythonSuiteHeaderStart,
  pythonSuiteHeaderEnd,
  hasPythonBodyAfter,
  pythonTripleStateBeforeLine,
  hunkHasVisibleChange,
} from "./python.ts";

const lossyDecoder = new TextDecoder("utf-8");
function toRegexText(b: Uint8Array): string {
  return lossyDecoder.decode(b);
}

const MINUS = 0x2d;
const PLUS = 0x2b;
const SPACE = 0x20;
const OPEN_PAREN_BYTE = 0x28;
const CLOSE_PAREN_BYTE = 0x29;
const BACKTICK = 0x60;
const SLASH = 0x2f;
const SINGLE_QUOTE = 0x27;
const DOUBLE_QUOTE = 0x22;
const BACKSLASH = 0x5c;
const DOT = 0x2e;

const OPEN_PAREN_BYTES = encodeUTF8("(");
const CLOSE_PAREN_BYTES = encodeUTF8(")");
const OPEN_CURLY_BYTES = encodeUTF8("{");
const CLOSE_CURLY_BYTES = encodeUTF8("}");
const OPEN_SQUARE_BYTES = encodeUTF8("[");
const CLOSE_SQUARE_BYTES = encodeUTF8("]");
const DOUBLE_SLASH = encodeUTF8("//");
const COMMA_BYTES = encodeUTF8(",");
const SEMICOLON = encodeUTF8(";");
const BACKSLASH_BYTES = encodeUTF8("\\");
const SPACE_BYTES = encodeUTF8(" ");
const COLON = encodeUTF8(":");
const AT_AT = encodeUTF8("@@");
const PACKAGE_PREFIX = encodeUTF8("package ");
const IMPORT_SPACE = encodeUTF8("import ");
const IMPORT_ONLY = encodeUTF8("import");
const REQUIRE_PAREN_NO_SPACE = encodeUTF8("require(");
const REQUIRE_PAREN_SPACE = encodeUTF8("require (");
const CONST_SPACE = encodeUTF8("const ");
const LET_SPACE = encodeUTF8("let ");
const VAR_SPACE = encodeUTF8("var ");
const DOUBLE_COLON = encodeUTF8("::");
const PUB_USE_PREFIX = encodeUTF8("pub use ");
const LESS_THAN = encodeUTF8("<");
const DOUBLE_QUOTE_BYTES = encodeUTF8('"');
const TRY_COLON = encodeUTF8("try:");
const IF_SPACE = encodeUTF8("if ");
const WITH_SPACE = encodeUTF8("with ");
const ASYNC_WITH_SPACE = encodeUTF8("async with ");
const EXCEPT_PREFIX = encodeUTF8("except");
const ELSE_COLON = encodeUTF8("else:");
const FINALLY_COLON = encodeUTF8("finally:");
const ELIF_SPACE = encodeUTF8("elif ");

// The 18 regexes (meat/imports.go:741-763). Every `\s` is rewritten
// explicitly as `[\t\n\f\r ]` — Go's RE2 `\s`, not JS's wider `\s` (H3b).
// The four JS-language patterns carry Go's `(?s)` flag as JS's `s` (dotAll).
const RE_GO_IMPORT_BLOCK_START = /^import[\t\n\f\r ]*\([\t\n\f\r ]*(?:\/\/.*)?$/;
const RE_GO_IMPORT_BLOCK_END = /^\)[\t\n\f\r ]*(?:\/\/.*)?$/;
const RE_GO_IMPORT_MEMBER =
  /^(?:(?:[._]|[A-Za-z_][A-Za-z0-9_]*)[\t\n\f\r ]+)?(?:"(?:[^"\\]|\\.)*"|`[^`]*`)[\t\n\f\r ]*(?:\/\/.*)?$/;
const RE_GO_IMPORT_SINGLE =
  /^import[\t\n\f\r ]+(?:(?:[._]|[A-Za-z_][A-Za-z0-9_]*)[\t\n\f\r ]+)?(?:"(?:[^"\\]|\\.)*"|`[^`]*`)[\t\n\f\r ]*(?:\/\/.*)?$/;

const RE_PYTHON_IMPORT_LIST =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_][A-Za-z0-9_]*)?(?:[\t\n\f\r ]*,[\t\n\f\r ]*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_][A-Za-z0-9_]*)?)*$/;
const RE_PYTHON_FROM_START =
  /^from[\t\n\f\r ]+(?:\.*(?:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)?)[\t\n\f\r ]+import[\t\n\f\r ]+(.+)$/;
const RE_PYTHON_FROM_LIST =
  /^(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_][A-Za-z0-9_]*)?(?:[\t\n\f\r ]*,[\t\n\f\r ]*[A-Za-z_][A-Za-z0-9_]*(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_][A-Za-z0-9_]*)?)*)$/;

const RE_JS_SIDE_EFFECT_IMPORT = /^import[\t\n\f\r ]+["'`][^"'`]+["'`][\t\n\f\r ]*;?[\t\n\f\r ]*(?:\/\/.*)?$/s;
const RE_JS_FROM_IMPORT =
  /^import[\t\n\f\r ]+.+[\t\n\f\r ]+from[\t\n\f\r ]+["'`][^"'`]+["'`](?:[\t\n\f\r ]+(?:with|assert)[\t\n\f\r ]*\{.*\})?[\t\n\f\r ]*;?[\t\n\f\r ]*(?:\/\/.*)?$/s;
const RE_JS_TS_REQUIRE_IMPORT =
  /^import[\t\n\f\r ]+[A-Za-z_$][A-Za-z0-9_$]*[\t\n\f\r ]*=[\t\n\f\r ]*require[\t\n\f\r ]*\([\t\n\f\r ]*["'`][^"'`]+["'`][\t\n\f\r ]*\)[\t\n\f\r ]*;?[\t\n\f\r ]*(?:\/\/.*)?$/s;
const RE_JS_REQUIRE =
  /^(?:require[\t\n\f\r ]*\([\t\n\f\r ]*["'`][^"'`]+["'`][\t\n\f\r ]*\)|(?:const|let|var)[\t\n\f\r ]+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^;]*\}|\[[^;]*\])[\t\n\f\r ]*=[\t\n\f\r ]*require[\t\n\f\r ]*\([\t\n\f\r ]*["'`][^"'`]+["'`][\t\n\f\r ]*\)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)[\t\n\f\r ]*;?[\t\n\f\r ]*(?:\/\/.*)?$/s;
const RE_JS_REQUIRE_START =
  /^(?:const|let|var)[\t\n\f\r ]+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^;]*|\[[^;]*)[\t\n\f\r ]*=[\t\n\f\r ]*require[\t\n\f\r ]*\(/;
const RE_JS_IMPORT_CONTINUATION_MEMBER = /^[A-Za-z0-9_$,*{}\t\n\f\r ]+(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_$][A-Za-z0-9_$]*)?[,]?$/;
const RE_JS_IMPORT_CONTINUATION_END = /^\}[\t\n\f\r ]+from[\t\n\f\r ]+["'`][^"'`]+["'`][\t\n\f\r ]*;?$/;

const RE_RUST_USE_START = /^(?:pub(?:[\t\n\f\r ]*\([^)]*\))?[\t\n\f\r ]+)?use[\t\n\f\r ]+/;
const RE_RUST_USE_CONTINUATION_MEMBER = /^[A-Za-z0-9_:,*{}\t\n\f\r ]+(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_][A-Za-z0-9_]*)?[,;]?$/;
const RE_C_INCLUDE_START = /^#[\t\n\f\r ]*include(?:_next)?(?:[\t\n\f\r ]|[<"])/;
const RE_JAVA_IMPORT =
  /^import[\t\n\f\r ]+(?:static[\t\n\f\r ]+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$*][A-Za-z0-9_$*]*)*(?:[\t\n\f\r ]+as[\t\n\f\r ]+[A-Za-z_$][A-Za-z0-9_$]*)?[\t\n\f\r ]*;?[\t\n\f\r ]*(?:\/\/.*)?$/;

function isHunkSectionBoundary(k: DiffLineKind): boolean {
  return k === "header" || k === "old_file" || k === "hunk_header" || k === "mail_signature";
}

function stripByte(b: Uint8Array, byteValue: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = at(b, i);
    if (c !== byteValue) out.push(c);
  }
  return new Uint8Array(out);
}

/** Go's `importSideLine` (`meat/imports.go:351-354`): one hunk-source line's absolute index plus its diff-marker-stripped body. */
export interface ImportSideLine {
  readonly index: number;
  readonly text: Uint8Array;
}

/** Go's `importFileSection` (`meat/imports.go:252-255`). */
export interface ImportFileSection {
  readonly start: number;
  readonly end: number;
}

// ---------------------------------------------------------------------------
// Algorithm 3 — embedded source detection (meat/imports.go:616-681,729-739)
// ---------------------------------------------------------------------------

/**
 * Go's `countCodeBackticks` (`meat/imports.go:643-681`). Exported for
 * `chunk.go`'s own `stringScanState.scan` (`meat/chunk.go:332`), which needs
 * the identical Go/JS backtick-string toggle to keep the splitter's
 * cut-avoidance mask in agreement with this file's own embedded-source
 * detection (`specs/chunk.md` Mechanism §3).
 */
export function countCodeBackticks(text: Uint8Array): number {
  let count = 0;
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
    if (b === SLASH && i + 1 < text.length && at(text, i + 1) === SLASH) break;
    if (b === SINGLE_QUOTE || b === DOUBLE_QUOTE) {
      quote = b;
      continue;
    }
    if (b === BACKTICK) {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && at(text, j) === BACKSLASH; j--) backslashes++;
      if (backslashes % 2 === 0) count++;
    }
  }
  return count;
}

/** Go's `embeddedSourceLines` (`meat/imports.go:625-641`). */
function embeddedSourceLines(lines: readonly ImportSideLine[], language: SourceLanguage): boolean[] {
  const flags: boolean[] = new Array(lines.length).fill(false);
  const tripleRef = newTripleStateRef();
  let backtick = false;
  for (let i = 0; i < lines.length; i++) {
    const line = arrayAt(lines, i);
    flags[i] = tripleRef.value !== pythonTripleNone || backtick;
    if (language === "python" || language === "java") {
      scanPythonTripleLine(line.text, tripleRef);
    }
    if (language === "go" || language === "javascript") {
      if (countCodeBackticks(line.text) % 2 === 1) backtick = !backtick;
    }
  }
  return flags;
}

function embeddedSourceEnd(embedded: readonly boolean[], start: number): number {
  for (let i = start; i + 1 < embedded.length; i++) {
    if (arrayAt(embedded, i) && !arrayAt(embedded, i + 1)) return i;
  }
  return embedded.length;
}

function strongEmbeddedImportCandidate(text: Uint8Array, language: SourceLanguage): boolean {
  const trimmed = trimSpace(text);
  if (language === "rust") {
    return indexOf(trimmed, DOUBLE_COLON) >= 0 || indexOf(trimmed, OPEN_CURLY_BYTES) >= 0 || hasPrefix(trimmed, PUB_USE_PREFIX);
  }
  if (language === "c") {
    return indexOf(trimmed, LESS_THAN) >= 0 || indexOf(trimmed, DOUBLE_QUOTE_BYTES) >= 0;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Algorithm 4 — hunk-boundary continuation (meat/imports.go:370-474)
// ---------------------------------------------------------------------------

function stripPythonImportComment(text: Uint8Array): Uint8Array {
  const hash = indexOf(text, encodeUTF8("#"));
  const cut = hash >= 0 ? slice(text, 0, hash) : text;
  return trimSpace(cut);
}

function hunkSectionText(header: Uint8Array): Uint8Array {
  if (!hasPrefix(header, AT_AT)) return new Uint8Array(0);
  const rest = slice(header, 2, header.length);
  const end = indexOf(rest, AT_AT);
  if (end >= 0) return trimSpace(slice(rest, end + 2, rest.length));
  return new Uint8Array(0);
}

/** Go's `hunkStartsImportContinuation` (`meat/imports.go:370-393`). */
function hunkStartsImportContinuation(header: Uint8Array, language: SourceLanguage): boolean {
  const section = hunkSectionText(header);
  if (section.length === 0) return false;
  switch (language) {
    case "go":
      return RE_GO_IMPORT_BLOCK_START.test(toRegexText(section));
    case "python": {
      const stripped = stripPythonImportComment(section);
      const match = RE_PYTHON_FROM_START.exec(toRegexText(stripped));
      if (match === null) return false;
      const rest = match[1] ?? "";
      return rest.replace(/^[\t\n\f\r ]+/, "").startsWith("(");
    }
    case "javascript": {
      const text = toRegexText(section);
      if (
        !hasPrefix(section, IMPORT_SPACE) ||
        RE_JS_SIDE_EFFECT_IMPORT.test(text) ||
        RE_JS_FROM_IMPORT.test(text) ||
        RE_JS_TS_REQUIRE_IMPORT.test(text)
      ) {
        return false;
      }
      return (
        countOccurrences(section, OPEN_CURLY_BYTES) > countOccurrences(section, CLOSE_CURLY_BYTES) ||
        countOccurrences(section, OPEN_SQUARE_BYTES) > countOccurrences(section, CLOSE_SQUARE_BYTES) ||
        countOccurrences(section, OPEN_PAREN_BYTES) > countOccurrences(section, CLOSE_PAREN_BYTES)
      );
    }
    case "rust":
      return RE_RUST_USE_START.test(toRegexText(section)) && indexOf(section, OPEN_CURLY_BYTES) >= 0 && !hasSuffix(trimSpace(section), SEMICOLON);
    default:
      return false;
  }
}

/** Go's `importContinuationEnd` (`meat/imports.go:405-474`). */
function importContinuationEnd(lines: readonly ImportSideLine[], language: SourceLanguage): number {
  if (lines.length === 0) return 0;
  switch (language) {
    case "go": {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = trimSpace(arrayAt(lines, i).text);
        if (trimmed.length === 0 || hasPrefix(trimmed, DOUBLE_SLASH)) continue;
        const text = toRegexText(trimmed);
        if (RE_GO_IMPORT_BLOCK_END.test(text)) return i + 1;
        if (!RE_GO_IMPORT_MEMBER.test(text)) return 0;
      }
      return lines.length;
    }
    case "python": {
      let balance = 1;
      for (let i = 0; i < lines.length; i++) {
        const part = stripPythonImportComment(trimSpace(arrayAt(lines, i).text));
        if (part.length === 0) continue;
        balance += countOccurrences(part, OPEN_PAREN_BYTES) - countOccurrences(part, CLOSE_PAREN_BYTES);
        let member = stripByte(stripByte(part, OPEN_PAREN_BYTE), CLOSE_PAREN_BYTE);
        if (hasSuffix(member, COMMA_BYTES)) member = slice(member, 0, member.length - 1);
        member = trimSpace(member);
        if (member.length > 0 && !RE_PYTHON_FROM_LIST.test(toRegexText(member))) return 0;
        if (balance <= 0) return i + 1;
      }
      return lines.length;
    }
    case "javascript": {
      let balance = 1;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = trimSpace(arrayAt(lines, i).text);
        if (trimmed.length === 0 || hasPrefix(trimmed, DOUBLE_SLASH)) continue;
        balance += countOccurrences(trimmed, OPEN_CURLY_BYTES) - countOccurrences(trimmed, CLOSE_CURLY_BYTES);
        const text = toRegexText(trimmed);
        if (balance <= 0 && RE_JS_IMPORT_CONTINUATION_END.test(text)) return i + 1;
        if (!RE_JS_IMPORT_CONTINUATION_MEMBER.test(text)) return 0;
      }
      return lines.length;
    }
    case "rust": {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = trimSpace(arrayAt(lines, i).text);
        if (trimmed.length === 0 || hasPrefix(trimmed, DOUBLE_SLASH)) continue;
        if (!RE_RUST_USE_CONTINUATION_MEMBER.test(toRegexText(trimmed))) return 0;
        if (hasSuffix(trimmed, SEMICOLON)) return i + 1;
      }
      return lines.length;
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Per-language statement-end scanners (meat/imports.go:765-966)
// ---------------------------------------------------------------------------

function goImportEnd(lines: readonly ImportSideLine[], start: number): number {
  const trimmed = trimSpace(arrayAt(lines, start).text);
  const trimmedText = toRegexText(trimmed);
  if (RE_GO_IMPORT_SINGLE.test(trimmedText)) return start + 1;
  if (!RE_GO_IMPORT_BLOCK_START.test(trimmedText)) return start;
  for (let i = start + 1; i < lines.length && i <= start + 200; i++) {
    const iTrimmed = trimSpace(arrayAt(lines, i).text);
    const iText = toRegexText(iTrimmed);
    if (RE_GO_IMPORT_BLOCK_END.test(iText)) return i + 1;
    if (iTrimmed.length === 0 || hasPrefix(iTrimmed, DOUBLE_SLASH) || RE_GO_IMPORT_MEMBER.test(iText)) continue;
    return i;
  }
  return lines.length;
}

function pythonContinuedImportEnd(lines: readonly ImportSideLine[], start: number, rest: Uint8Array, final: RegExp): number {
  if (hasPrefix(rest, OPEN_PAREN_BYTES)) {
    let balance = countOccurrences(rest, OPEN_PAREN_BYTES) - countOccurrences(rest, CLOSE_PAREN_BYTES);
    if (balance <= 0) {
      let inside = slice(rest, 1, rest.length);
      if (hasSuffix(inside, CLOSE_PAREN_BYTES)) inside = slice(inside, 0, inside.length - 1);
      inside = trimSpace(inside);
      if (hasSuffix(inside, COMMA_BYTES)) inside = slice(inside, 0, inside.length - 1);
      if (final.test(toRegexText(inside))) return start + 1;
      return start;
    }
    let contents = slice(rest, 1, rest.length);
    for (let i = start + 1; i < lines.length && i <= start + 200; i++) {
      const part = stripPythonImportComment(trimSpace(arrayAt(lines, i).text));
      const parensStripped = stripByte(stripByte(part, OPEN_PAREN_BYTE), CLOSE_PAREN_BYTE);
      let member = parensStripped;
      if (hasSuffix(member, COMMA_BYTES)) member = slice(member, 0, member.length - 1);
      member = trimSpace(member);
      if (member.length > 0 && !final.test(toRegexText(member))) return i;
      balance += countOccurrences(part, OPEN_PAREN_BYTES) - countOccurrences(part, CLOSE_PAREN_BYTES);
      contents = concat([contents, SPACE_BYTES, parensStripped]);
      if (balance === 0) {
        let insideAll = trimSpace(contents);
        if (hasSuffix(insideAll, COMMA_BYTES)) insideAll = slice(insideAll, 0, insideAll.length - 1);
        if (final.test(toRegexText(insideAll))) return i + 1;
        return i;
      }
    }
    return lines.length;
  }
  if (hasSuffix(rest, BACKSLASH_BYTES)) {
    let joined = trimSpace(slice(rest, 0, rest.length - 1));
    for (let i = start + 1; i < lines.length && i <= start + 50; i++) {
      let part = stripPythonImportComment(trimSpace(arrayAt(lines, i).text));
      const continued = hasSuffix(part, BACKSLASH_BYTES);
      if (continued) part = slice(part, 0, part.length - 1);
      part = trimSpace(part);
      joined = concat([joined, SPACE_BYTES, part]);
      if (!continued) {
        if (final.test(toRegexText(trimSpace(joined)))) return i + 1;
        return start;
      }
    }
    return lines.length;
  }
  if (final.test(toRegexText(rest))) return start + 1;
  return start;
}

function pythonImportEnd(lines: readonly ImportSideLine[], start: number): number {
  const code = stripPythonImportComment(trimSpace(arrayAt(lines, start).text));
  if (hasPrefix(code, IMPORT_SPACE)) {
    const rest = trimSpace(slice(code, IMPORT_SPACE.length, code.length));
    return pythonContinuedImportEnd(lines, start, rest, RE_PYTHON_IMPORT_LIST);
  }
  const match = RE_PYTHON_FROM_START.exec(toRegexText(code));
  if (match === null) return start;
  const rest = trimSpace(encodeUTF8(match[1] ?? ""));
  return pythonContinuedImportEnd(lines, start, rest, RE_PYTHON_FROM_LIST);
}

function javascriptImportEnd(lines: readonly ImportSideLine[], start: number): number {
  const trimmed = trimSpace(arrayAt(lines, start).text);
  if (!hasPrefix(trimmed, IMPORT_SPACE)) return start;
  const afterImport = trimSpace(slice(trimmed, IMPORT_ONLY.length, trimmed.length));
  if (hasPrefix(afterImport, OPEN_PAREN_BYTES)) return start;
  let joined: Uint8Array = new Uint8Array(0);
  for (let i = start; i < lines.length && i <= start + 80; i++) {
    const trimmedLine = trimSpace(arrayAt(lines, i).text);
    joined = joined.length > 0 ? concat([joined, SPACE_BYTES, trimmedLine]) : trimmedLine;
    const statement = toRegexText(joined);
    if (RE_JS_SIDE_EFFECT_IMPORT.test(statement) || RE_JS_FROM_IMPORT.test(statement) || RE_JS_TS_REQUIRE_IMPORT.test(statement)) {
      return i + 1;
    }
    if (i === start) {
      if (indexOf(trimmed, OPEN_CURLY_BYTES) >= 0 || indexOf(trimmed, OPEN_SQUARE_BYTES) >= 0 || hasSuffix(trimmed, COMMA_BYTES)) continue;
      return start;
    }
    if (trimmedLine.length === 0 || hasPrefix(trimmedLine, DOUBLE_SLASH) || RE_JS_IMPORT_CONTINUATION_MEMBER.test(toRegexText(trimmedLine))) {
      continue;
    }
    return i;
  }
  return lines.length;
}

function javascriptRequireEnd(lines: readonly ImportSideLine[], start: number): number {
  const trimmed = trimSpace(arrayAt(lines, start).text);
  const bareRequire = hasPrefix(trimmed, REQUIRE_PAREN_NO_SPACE) || hasPrefix(trimmed, REQUIRE_PAREN_SPACE);
  const directRequire = bareRequire || RE_JS_REQUIRE_START.test(toRegexText(trimmed));
  let candidate = directRequire;
  for (const keyword of [CONST_SPACE, LET_SPACE, VAR_SPACE]) {
    if (!hasPrefix(trimmed, keyword)) continue;
    const unclosedDestructure =
      countOccurrences(trimmed, OPEN_CURLY_BYTES) > countOccurrences(trimmed, CLOSE_CURLY_BYTES) ||
      countOccurrences(trimmed, OPEN_SQUARE_BYTES) > countOccurrences(trimmed, CLOSE_SQUARE_BYTES);
    if (unclosedDestructure) candidate = true;
  }
  if (!candidate) return start;
  let joined: Uint8Array = new Uint8Array(0);
  for (let i = start; i < lines.length && i <= start + 80; i++) {
    const lineTrimmed = trimSpace(arrayAt(lines, i).text);
    joined = joined.length > 0 ? concat([joined, SPACE_BYTES, lineTrimmed]) : lineTrimmed;
    if (RE_JS_REQUIRE.test(toRegexText(joined))) return i + 1;
  }
  return start;
}

function rustUseEnd(lines: readonly ImportSideLine[], start: number): number {
  const trimmed = trimSpace(arrayAt(lines, start).text);
  if (!RE_RUST_USE_START.test(toRegexText(trimmed))) return start;
  if (hasSuffix(trimmed, SEMICOLON)) return start + 1;
  if (indexOf(trimmed, OPEN_CURLY_BYTES) < 0 && !hasSuffix(trimmed, DOUBLE_COLON)) return start;
  for (let i = start + 1; i < lines.length && i <= start + 200; i++) {
    const candidate = trimSpace(arrayAt(lines, i).text);
    if (candidate.length === 0 || hasPrefix(candidate, DOUBLE_SLASH)) continue;
    if (!RE_RUST_USE_CONTINUATION_MEMBER.test(toRegexText(candidate))) return i;
    if (hasSuffix(candidate, SEMICOLON)) return i + 1;
  }
  return lines.length;
}

function cIncludeEnd(lines: readonly ImportSideLine[], start: number): number {
  const trimmed = trimSpace(arrayAt(lines, start).text);
  if (!RE_C_INCLUDE_START.test(toRegexText(trimmed))) return start;
  for (let i = start; i < lines.length && i <= start + 50; i++) {
    if (!hasSuffix(trimSpace(arrayAt(lines, i).text), BACKSLASH_BYTES)) return i + 1;
  }
  return lines.length;
}

function javaImportEnd(lines: readonly ImportSideLine[], start: number): number {
  if (RE_JAVA_IMPORT.test(toRegexText(trimSpace(arrayAt(lines, start).text)))) return start + 1;
  return start;
}

const EMBEDDED_FALLBACK_LANGUAGES: readonly SourceLanguage[] = ["go", "python", "javascript", "rust", "c", "java"];

function tryImportEnd(lines: readonly ImportSideLine[], start: number, language: SourceLanguage): number {
  switch (language) {
    case "go":
      return goImportEnd(lines, start);
    case "python":
      return pythonImportEnd(lines, start);
    case "javascript": {
      const end = javascriptImportEnd(lines, start);
      if (end > start) return end;
      return javascriptRequireEnd(lines, start);
    }
    case "rust":
      return rustUseEnd(lines, start);
    case "c":
      return cIncludeEnd(lines, start);
    case "java":
      return javaImportEnd(lines, start);
    default:
      return start;
  }
}

/** Go's `importStatementEnd` (`meat/imports.go:683-727`). */
function importStatementEnd(lines: readonly ImportSideLine[], start: number, language: SourceLanguage, embedded: boolean): number {
  const end = tryImportEnd(lines, start, language);
  if (end > start) return end;
  if (!embedded) return start;
  for (const candidate of EMBEDDED_FALLBACK_LANGUAGES) {
    if (candidate === language || !strongEmbeddedImportCandidate(arrayAt(lines, start).text, candidate)) continue;
    const candidateEnd = tryImportEnd(lines, start, candidate);
    if (candidateEnd > start) return candidateEnd;
  }
  return start;
}

// ---------------------------------------------------------------------------
// Algorithm 2 — per-side classification (meat/imports.go:476-506)
// ---------------------------------------------------------------------------

function classifySideImports(lines: readonly ImportSideLine[], language: SourceLanguage, continuation: boolean): boolean[] {
  const hidden: boolean[] = new Array(lines.length).fill(false);
  if (continuation) {
    const end = importContinuationEnd(lines, language);
    for (let i = 0; i < end; i++) hidden[i] = true;
  }
  const embedded = embeddedSourceLines(lines, language);
  let i = 0;
  while (i < lines.length) {
    let scanLines = lines;
    if (arrayAt(embedded, i)) {
      const limit = embeddedSourceEnd(embedded, i);
      if (limit <= i) {
        i++;
        continue;
      }
      scanLines = lines.slice(0, limit);
    }
    const end = importStatementEnd(scanLines, i, language, arrayAt(embedded, i));
    if (end <= i) {
      i++;
      continue;
    }
    for (let j = i; j < end; j++) hidden[j] = true;
    i = end;
  }
  return hidden;
}

// ---------------------------------------------------------------------------
// Algorithm 5 — whole guard-suite removal (meat/imports.go:508-573)
// ---------------------------------------------------------------------------

function isPythonImportGuard(trimmed: Uint8Array): boolean {
  if (!hasSuffix(trimmed, COLON)) return false;
  return (
    equals(trimmed, TRY_COLON) ||
    hasPrefix(trimmed, IF_SPACE) ||
    hasPrefix(trimmed, WITH_SPACE) ||
    hasPrefix(trimmed, ASYNC_WITH_SPACE) ||
    hasPrefix(trimmed, EXCEPT_PREFIX)
  );
}

function isPythonImportGuardClause(trimmed: Uint8Array): boolean {
  if (!hasSuffix(trimmed, COLON)) return false;
  return equals(trimmed, ELSE_COLON) || equals(trimmed, FINALLY_COLON) || hasPrefix(trimmed, ELIF_SPACE) || hasPrefix(trimmed, EXCEPT_PREFIX);
}

function expandPythonImportOnlySuites(lines: readonly ImportSideLine[], hidden: boolean[]): void {
  let i = 0;
  while (i < lines.length) {
    if (arrayAt(hidden, i)) {
      i++;
      continue;
    }
    const body = arrayAt(lines, i).text;
    const trimmed = trimPythonCode(body);
    if (!isPythonImportGuard(trimmed)) {
      i++;
      continue;
    }
    const ownerIndent = leadingWhitespace(body).length;
    let end = i + 1;
    let haveImport = false;
    let importOnly = true;
    while (end < lines.length) {
      const candidate = arrayAt(lines, end).text;
      const candidateTrimmed = trimPythonCode(candidate);
      if (candidateTrimmed.length === 0) {
        end++;
        continue;
      }
      const indent = leadingWhitespace(candidate).length;
      if (indent < ownerIndent || (indent === ownerIndent && !isPythonImportGuardClause(candidateTrimmed))) break;
      if (indent === ownerIndent) {
        end++;
        continue;
      }
      if (arrayAt(hidden, end)) {
        haveImport = true;
        end++;
        continue;
      }
      importOnly = false;
      break;
    }
    if (haveImport && importOnly) {
      for (let j = i; j < end; j++) hidden[j] = true;
      i = end;
      continue;
    }
    i++;
  }
}

// ---------------------------------------------------------------------------
// Algorithm 6 — blank-gap fill (meat/imports.go:575-614)
// ---------------------------------------------------------------------------

function fillImportGroupGaps(lines: readonly ImportSideLine[], hidden: boolean[], embedded: readonly boolean[]): void {
  let previous = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!arrayAt(hidden, i)) continue;
    if (previous >= 0) {
      let blankGap = true;
      for (let j = previous + 1; j < i; j++) {
        if (trimSpace(arrayAt(lines, j).text).length !== 0) {
          blankGap = false;
          break;
        }
      }
      if (blankGap) {
        for (let j = previous + 1; j < i; j++) hidden[j] = true;
      }
    }
    previous = i;
  }

  let i = 0;
  while (i < lines.length) {
    if (!arrayAt(hidden, i)) {
      i++;
      continue;
    }
    while (i < lines.length && arrayAt(hidden, i)) i++;
    while (i < lines.length && arrayAt(embedded, i) && trimSpace(arrayAt(lines, i).text).length === 0) {
      hidden[i] = true;
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// Algorithm 1 — top-level orchestration (meat/imports.go:156-250)
// ---------------------------------------------------------------------------

function importLinesForSide(lines: readonly SourceLine[], layout: DiffLayout, start: number, end: number, side: number): ImportSideLine[] {
  const result: ImportSideLine[] = [];
  for (let i = start; i < end; i++) {
    const text = arrayAt(lines, i).text;
    if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length === 0) continue;
    const marker = at(text, 0);
    if (marker === SPACE || marker === side) {
      result.push({ index: i, text: slice(text, 1, text.length) });
    }
  }
  return result;
}

function hunkChangesOnlyOneSide(lines: readonly SourceLine[], layout: DiffLayout, start: number, end: number): boolean {
  let haveOld = false;
  let haveNew = false;
  for (let i = start; i < end; i++) {
    const text = arrayAt(lines, i).text;
    if (arrayAt(layout.kinds, i) !== "hunk_change" || text.length === 0) continue;
    const marker = at(text, 0);
    if (marker === MINUS) haveOld = true;
    else if (marker === PLUS) haveNew = true;
  }
  return haveOld !== haveNew;
}

/** Go's `isImportOnlyFramingRow` (`meat/imports.go:274-300`). */
function isImportOnlyFramingRow(body: Uint8Array, language: SourceLanguage, oneSidedChange: boolean): boolean {
  const trimmed = trimSpace(body);
  if (trimmed.length === 0) return true;
  if (!oneSidedChange || (language !== "go" && language !== "java")) return false;
  if (!hasPrefix(trimmed, PACKAGE_PREFIX)) return false;
  let name = slice(trimmed, PACKAGE_PREFIX.length, trimmed.length);
  if (hasSuffix(name, SEMICOLON)) name = slice(name, 0, name.length - 1);
  name = trimSpace(name);
  if (name.length === 0) return false;
  for (const segment of splitBytes(name, DOT)) {
    if (segment.length === 0 || !isIdentifierStart(at(segment, 0))) return false;
    for (let i = 1; i < segment.length; i++) {
      if (!isIdentifierContinue(at(segment, i))) return false;
    }
  }
  return true;
}

/** Go's `importFileSections` (`meat/imports.go:302-322`). */
export function importFileSections(layout: DiffLayout): ImportFileSection[] {
  const sections: ImportFileSection[] = [];
  for (let i = 0; i < layout.kinds.length; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (kind !== "header" && kind !== "old_file") continue;
    if (kind === "old_file" && i > 0 && arrayAt(layout.fileId, i - 1) === arrayAt(layout.fileId, i) && arrayAt(layout.kinds, i - 1) !== "mail_signature") {
      continue;
    }
    let end = layout.kinds.length;
    for (let j = i + 1; j < layout.kinds.length; j++) {
      if (arrayAt(layout.kinds, j) === "mail_signature" || arrayAt(layout.fileId, j) !== arrayAt(layout.fileId, i)) {
        end = j;
        break;
      }
    }
    sections.push({ start: i, end });
  }
  return sections;
}

/** Go's `hiddenLineRanges` (`meat/imports.go:324-339`). */
export function hiddenLineRanges(hidden: readonly boolean[]): LineRange[] {
  const ranges: LineRange[] = [];
  let i = 0;
  while (i < hidden.length) {
    if (!arrayAt(hidden, i)) {
      i++;
      continue;
    }
    const start = i;
    while (i + 1 < hidden.length && arrayAt(hidden, i + 1)) i++;
    ranges.push({ startLine: start + 1, endLine: i + 1 });
    i++;
  }
  return ranges;
}

/** Go's `mandatoryRemovalMask` (`meat/imports.go:341-349`). */
export function mandatoryRemovalMask(lines: number, ranges: readonly LineRange[]): boolean[] {
  const hidden: boolean[] = new Array(lines).fill(false);
  for (const r of ranges) {
    for (let line = r.startLine; line <= r.endLine; line++) hidden[line - 1] = true;
  }
  return hidden;
}

/**
 * Go's `mandatoryImportRemovalPlan` (`meat/imports.go:156-250`): the
 * compiler-owned half of every edit plan, derived only from the immutable
 * source diff. No plan-state dependency for this initial computation.
 */
export function mandatoryImportRemovalPlan(lines: readonly SourceLine[], layout: DiffLayout): LineRange[] {
  const hidden: boolean[] = new Array(lines.length).fill(false);

  for (let hunk = 0; hunk < layout.kinds.length; hunk++) {
    if (arrayAt(layout.kinds, hunk) !== "hunk_header") continue;
    const end = nextLayoutLine(layout, hunk + 1, isHunkSectionBoundary);
    const language = arrayAt(layout.languages, hunk);
    const continuation = hunkStartsImportContinuation(arrayAt(lines, hunk).text, language);

    const sideMasks = new Map<number, Set<number>>();
    for (const side of [MINUS, PLUS]) {
      const sideLines = importLinesForSide(lines, layout, hunk + 1, end, side);
      const sideHidden = classifySideImports(sideLines, language, continuation);
      expandPythonImportOnlySuites(sideLines, sideHidden);
      fillImportGroupGaps(sideLines, sideHidden, embeddedSourceLines(sideLines, language));
      const mask = new Set<number>();
      for (let i = 0; i < sideLines.length; i++) {
        if (arrayAt(sideHidden, i)) mask.add(arrayAt(sideLines, i).index);
      }
      sideMasks.set(side, mask);
    }
    const minusMask = sideMasks.get(MINUS);
    const plusMask = sideMasks.get(PLUS);
    if (minusMask === undefined || plusMask === undefined) {
      throw new Error("unreachable: side masks are always set for both '-' and '+'");
    }

    for (let i = hunk + 1; i < end; i++) {
      const text = arrayAt(lines, i).text;
      if (!isHunkSource(arrayAt(layout.kinds, i)) || text.length === 0) continue;
      const marker = at(text, 0);
      if (marker === MINUS) hidden[i] = minusMask.has(i);
      else if (marker === PLUS) hidden[i] = plusMask.has(i);
      else if (marker === SPACE) hidden[i] = minusMask.has(i) && plusMask.has(i);
    }

    // If every changed row is import scaffolding (apart from blank framing),
    // remove the complete hunk, including its stale header and context.
    let haveImportChange = false;
    let importOnly = true;
    const oneSidedChange = hunkChangesOnlyOneSide(lines, layout, hunk + 1, end);
    for (let i = hunk + 1; i < end; i++) {
      if (arrayAt(layout.kinds, i) !== "hunk_change") continue;
      if (arrayAt(hidden, i)) {
        haveImportChange = true;
        continue;
      }
      const text = arrayAt(lines, i).text;
      if (isImportOnlyFramingRow(slice(text, 1, text.length), language, oneSidedChange)) continue;
      importOnly = false;
    }
    if (haveImportChange && importOnly) {
      for (let i = hunk; i < end; i++) hidden[i] = true;
    }
  }

  // A no-newline marker is source framing and cannot outlive an import row.
  for (let i = 0; i < layout.kinds.length; i++) {
    const owner = arrayAt(layout.markerOwner, i);
    if (arrayAt(layout.kinds, i) === "no_newline" && owner >= 0 && arrayAt(hidden, owner)) {
      hidden[i] = true;
    }
  }

  // When every hunk in a file is import-only, remove the complete file
  // shell (diff/index/---/+++ metadata included).
  for (const section of importFileSections(layout)) {
    let sawHunk = false;
    let allHunksHidden = true;
    for (let i = section.start; i < section.end; i++) {
      if (arrayAt(layout.kinds, i) !== "hunk_header") continue;
      sawHunk = true;
      if (!arrayAt(hidden, i)) allHunksHidden = false;
    }
    if (sawHunk && allHunksHidden) {
      for (let i = section.start; i < section.end; i++) hidden[i] = true;
    }
  }

  return hiddenLineRanges(hidden);
}

// ---------------------------------------------------------------------------
// The three plan-state-aware functions (meat/imports.go:8-149), run after a
// plan has been merged — called from editplan.ts's pipeline, not from
// mandatoryImportRemovalPlan itself.
// ---------------------------------------------------------------------------

/** Go's `addMandatoryPythonSuitePlaceholders` (`meat/imports.go:12-55`). Mutates `state` in place. */
export function addMandatoryPythonSuitePlaceholders(lines: readonly SourceLine[], layout: DiffLayout, state: PlanState, mandatory: readonly boolean[]): void {
  for (let owner = 0; owner < lines.length; owner++) {
    const line = arrayAt(lines, owner);
    if (
      !arrayAt(layout.python, owner) ||
      arrayAt(state.hidden, owner) ||
      !isHunkSource(arrayAt(layout.kinds, owner)) ||
      line.text.length < 2 ||
      at(line.text, 0) === MINUS
    ) {
      continue;
    }
    if (pythonTripleStateBeforeLine(lines, layout, owner) !== pythonTripleNone) continue;
    const body = slice(line.text, 1, line.text.length);
    const trimmed = trimPythonCode(body);
    if (!isPythonSuiteHeaderStart(trimmed)) continue;
    const headerEnd = pythonSuiteHeaderEnd(lines, layout, null, owner);
    if (headerEnd === null) continue;
    const ownerIndent = leadingWhitespace(body).length;
    if (!hasPythonBodyAfter(lines, layout, null, headerEnd, ownerIndent) || hasPythonBodyAfter(lines, layout, state, headerEnd, ownerIndent)) {
      continue;
    }
    const { end: hunkEnd } = containingHunk(layout, owner);
    for (let i = headerEnd + 1; i < hunkEnd; i++) {
      const candidateText = arrayAt(lines, i).text;
      if (
        !arrayAt(mandatory, i) ||
        !arrayAt(state.hidden, i) ||
        !isHunkSource(arrayAt(layout.kinds, i)) ||
        candidateText.length < 2 ||
        at(candidateText, 0) === MINUS
      ) {
        continue;
      }
      const candidateBody = slice(candidateText, 1, candidateText.length);
      if (trimPythonCode(candidateBody).length === 0 || leadingWhitespace(candidateBody).length <= ownerIndent) continue;
      const foldIndex = state.folds.length;
      const marker = at(candidateText, 0);
      state.folds.push({
        startLine: i + 1,
        endLine: i + 1,
        planIndex: -1,
        marker: marker === PLUS ? "+" : " ",
        indent: leadingWhitespace(candidateBody),
        eol: arrayAt(lines, i).eol,
      });
      state.foldAt[i] = foldIndex;
      state.folded[i] = foldIndex;
      break;
    }
  }
}

/** Go's `stateWithMandatoryImportsRepresented` (`meat/imports.go:61-93`). Returns a new, independently-mutable `PlanState`. */
export function stateWithMandatoryImportsRepresented(state: PlanState, mandatory: readonly boolean[], layout: DiffLayout): PlanState {
  const validation: PlanState = {
    hidden: [...state.hidden],
    folded: [...state.folded],
    foldAt: [...state.foldAt],
    folds: state.folds,
  };
  for (let hunk = 0; hunk < layout.kinds.length; hunk++) {
    if (arrayAt(layout.kinds, hunk) !== "hunk_header") continue;
    const end = nextLayoutLine(layout, hunk + 1, isHunkSectionBoundary);
    let haveVisibleNonImport = false;
    for (let i = hunk + 1; i < end; i++) {
      if (isHunkSource(arrayAt(layout.kinds, i)) && !arrayAt(mandatory, i) && planStateRepresented(state, i)) {
        haveVisibleNonImport = true;
        break;
      }
    }
    if (!haveVisibleNonImport) continue;
    for (let i = hunk + 1; i < end; i++) {
      if (!arrayAt(mandatory, i)) continue;
      validation.hidden[i] = false;
      validation.folded[i] = -1;
      validation.foldAt[i] = -1;
    }
  }
  return validation;
}

/**
 * Go's `completeMandatoryImportFraming` (`meat/imports.go:98-149`). Mutates
 * `state` in place. Go's own `anyRetainedHunkChange` (`meat/editplan.go:
 * 763-770`) is logically identical to `python.ts`'s already-built
 * `hunkHasVisibleChange` (same condition, `&&` operands swapped) — reused
 * directly rather than re-implemented under a second name.
 */
export function completeMandatoryImportFraming(layout: DiffLayout, state: PlanState, mandatory: readonly boolean[]): void {
  for (let hunk = 0; hunk < layout.kinds.length; hunk++) {
    if (arrayAt(layout.kinds, hunk) !== "hunk_header") continue;
    const end = nextLayoutLine(layout, hunk + 1, isHunkSectionBoundary);
    let hasMandatoryImport = false;
    for (let i = hunk + 1; i < end; i++) {
      if (arrayAt(mandatory, i) && isHunkSource(arrayAt(layout.kinds, i))) {
        hasMandatoryImport = true;
        break;
      }
    }
    if (!hasMandatoryImport || hunkHasVisibleChange(layout, state, hunk + 1, end)) continue;
    for (let i = hunk; i < end; i++) state.hidden[i] = true;
  }

  for (const section of importFileSections(layout)) {
    let hasMandatoryImport = false;
    for (let i = section.start; i < section.end; i++) {
      if (arrayAt(mandatory, i) && isHunkSource(arrayAt(layout.kinds, i))) {
        hasMandatoryImport = true;
        break;
      }
    }
    if (!hasMandatoryImport) continue;
    let sawHunk = false;
    let allHunksHidden = true;
    for (let i = section.start; i < section.end; i++) {
      if (arrayAt(layout.kinds, i) !== "hunk_header") continue;
      sawHunk = true;
      if (planStateRepresented(state, i)) allHunksHidden = false;
    }
    if (sawHunk && allHunksHidden) {
      for (let i = section.start; i < section.end; i++) state.hidden[i] = true;
    }
  }
}
