// Byte-slice primitives for the engine (H1: `diff`, `chunk`, `editplan`,
// `imports`, `moves`, and `python` operate on `Uint8Array`, never `string`,
// so every offset/range/budget is a true UTF-8 byte offset by construction).
// This is the one file in the port allowed to index a byte array directly or
// use `!` — everything else calls in here instead of indexing raw bytes.
//
// `slice` returns a view (`Uint8Array.prototype.subarray`), not a copy,
// mirroring Go's O(1) string slicing. Callers must treat every `Uint8Array`
// this module hands back as immutable, exactly as Go treats a `string`.

const RUNE_ERROR = 0xfffd;
const MAX_UTF8_BYTES = 4;

const ASCII_SPACE = new Set<number>([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

// Go's unicode.IsSpace beyond Latin-1 (verified against `go run` output):
// U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. Notably
// *not* U+FEFF (BOM) — the opposite of JS's `\s`/`.trim()` (H14).
const SPACE_RUNES = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function isSpaceRuneWide(codePoint: number): boolean {
  if (codePoint >= 0x2000 && codePoint <= 0x200a) return true;
  return SPACE_RUNES.has(codePoint);
}

/** Go's `unicode.IsSpace` (H14/H2). */
export function isSpaceRune(codePoint: number): boolean {
  return isSpaceRuneWide(codePoint);
}

/** Go's `unicode.IsLetter` (category L) — H2, not an ASCII-range approximation. */
export function isLetterRune(codePoint: number): boolean {
  return /\p{L}/u.test(String.fromCodePoint(codePoint));
}

/** Go's `unicode.IsNumber` (category N) — H2, not an ASCII-range approximation. */
export function isNumberRune(codePoint: number): boolean {
  return /\p{N}/u.test(String.fromCodePoint(codePoint));
}

/** Go's `unicode.IsControl` — true only for the Latin-1 control points (category Cc). */
export function isControlRune(codePoint: number): boolean {
  if (codePoint > 0xff) return false;
  return /\p{Cc}/u.test(String.fromCodePoint(codePoint));
}

/** Go's `utf8.RuneStart`: true unless `b` is a UTF-8 continuation byte. */
export function isRuneStart(b: number): boolean {
  return (b & 0xc0) !== 0x80;
}

export interface DecodedRune {
  readonly codePoint: number;
  readonly size: number;
}

/**
 * Go's `utf8.DecodeRune(b[i:])`. Invalid encodings decode as one byte of
 * `codePoint: 0xFFFD` (`RuneError`), matching Go exactly — Go's doc:
 * "If the encoding is invalid, it returns (RuneError, 1)." Decoding at or
 * past the end of `b` returns size 0, matching `utf8.DecodeRune(nil)`.
 */
export function decodeRune(b: Uint8Array, i: number): DecodedRune {
  if (i >= b.length) return { codePoint: RUNE_ERROR, size: 0 };
  const b0 = b[i]!;
  if (b0 < 0x80) return { codePoint: b0, size: 1 };
  if (b0 < 0xc2) return { codePoint: RUNE_ERROR, size: 1 }; // continuation byte or overlong C0/C1 lead
  const invalid = { codePoint: RUNE_ERROR, size: 1 };

  if (b0 < 0xe0) {
    const b1 = b[i + 1];
    if (b1 === undefined || (b1 & 0xc0) !== 0x80) return invalid;
    return { codePoint: ((b0 & 0x1f) << 6) | (b1 & 0x3f), size: 2 };
  }
  if (b0 < 0xf0) {
    const b1 = b[i + 1];
    if (b1 === undefined || (b1 & 0xc0) !== 0x80) return invalid;
    if (b0 === 0xe0 && b1 < 0xa0) return invalid; // overlong
    if (b0 === 0xed && b1 > 0x9f) return invalid; // surrogate range D800-DFFF
    const b2 = b[i + 2];
    if (b2 === undefined || (b2 & 0xc0) !== 0x80) return invalid;
    return { codePoint: ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f), size: 3 };
  }
  if (b0 < 0xf5) {
    const b1 = b[i + 1];
    if (b1 === undefined || (b1 & 0xc0) !== 0x80) return invalid;
    if (b0 === 0xf0 && b1 < 0x90) return invalid; // overlong
    if (b0 === 0xf4 && b1 > 0x8f) return invalid; // > U+10FFFF
    const b2 = b[i + 2];
    if (b2 === undefined || (b2 & 0xc0) !== 0x80) return invalid;
    const b3 = b[i + 3];
    if (b3 === undefined || (b3 & 0xc0) !== 0x80) return invalid;
    return {
      codePoint: ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
      size: 4,
    };
  }
  return invalid;
}

/**
 * Go's `utf8.DecodeLastRune(b[:end])`: decode the rune ending exactly at
 * byte offset `end`, scanning backward. Ports Go's algorithm verbatim,
 * including its bounded backward walk (at most `MAX_UTF8_BYTES` bytes) and
 * the "decoded size must land exactly on `end`" check that rejects a
 * truncated or lead-less run as a single invalid byte.
 */
export function decodeLastRune(b: Uint8Array, end: number): DecodedRune {
  if (end <= 0) return { codePoint: RUNE_ERROR, size: 0 };
  const last = b[end - 1]!;
  if (last < 0x80) return { codePoint: last, size: 1 };

  const lim = Math.max(end - MAX_UTF8_BYTES, 0);
  let start = end - 1;
  for (start--; start >= lim; start--) {
    if (isRuneStart(b[start]!)) break;
  }
  if (start < 0) start = 0;

  const decoded = decodeRune(b, start);
  if (start + decoded.size !== end) return { codePoint: RUNE_ERROR, size: 1 };
  return decoded;
}

export interface Rune extends DecodedRune {
  readonly offset: number;
}

/** Go's `for _, r := range s`: yields each rune with its starting byte offset (H2). */
export function* runes(b: Uint8Array): Generator<Rune> {
  let i = 0;
  while (i < b.length) {
    const { codePoint, size } = decodeRune(b, i);
    yield { codePoint, offset: i, size: size === 0 ? 1 : size };
    i += size === 0 ? 1 : size;
  }
}

/** Go's `s[i]` with panic-on-out-of-range semantics, not JS's silent `undefined`. */
export function at(b: Uint8Array, i: number): number {
  if (i < 0 || i >= b.length) {
    throw new RangeError(`index out of range [${i}] with length ${b.length}`);
  }
  return b[i]!;
}

/**
 * The `noUncheckedIndexedAccess` equivalent of `at` for ordinary (non-byte)
 * arrays — `SourceLine[]`, `DiffLineKind[]`, and the like, indexed
 * throughout the engine's parallel-array layouts. Every engine file outside
 * this one indexes such arrays through here rather than asserting `!`,
 * exactly as `at`/`slice` are the sanctioned way to index a `Uint8Array`.
 */
export function arrayAt<T>(arr: readonly T[], i: number): T {
  const value = arr[i];
  if (value === undefined) {
    throw new RangeError(`index out of range [${i}] with length ${arr.length}`);
  }
  return value;
}

/**
 * Go's `s[start:end]` with panic-on-invalid-bounds semantics. Returns a
 * view, not a copy (see module doc).
 */
export function slice(b: Uint8Array, start: number, end: number = b.length): Uint8Array {
  if (start < 0 || end < start || end > b.length) {
    throw new RangeError(`slice bounds out of range [${start}:${end}] with length ${b.length}`);
  }
  return b.subarray(start, end);
}

/** Go's `bytes.Equal`. */
export function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Go's `bytes.HasPrefix`. */
export function hasPrefix(b: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > b.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (b[i] !== prefix[i]) return false;
  }
  return true;
}

/** Go's `bytes.HasSuffix`. */
export function hasSuffix(b: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.length > b.length) return false;
  const offset = b.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) {
    if (b[offset + i] !== suffix[i]) return false;
  }
  return true;
}

/**
 * Go's `bytes.Index`: the byte offset of the first occurrence of `needle` in
 * `haystack`, or -1. An empty `needle` matches at offset 0, matching Go.
 */
export function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  const n = haystack.length;
  const m = needle.length;
  if (m === 0) return 0;
  if (m > n) return -1;
  const first = needle[0]!;
  for (let i = 0; i <= n - m; i++) {
    if (haystack[i] !== first) continue;
    let j = 1;
    for (; j < m; j++) {
      if (haystack[i + j] !== needle[j]) break;
    }
    if (j === m) return i;
  }
  return -1;
}

/** Go's `strings.Count`: non-overlapping occurrences of `needle` in `haystack`. An empty `needle` matches `haystack.length + 1` times, matching Go. */
export function countOccurrences(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return haystack.length + 1;
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const idx = indexOf(slice(haystack, offset, haystack.length), needle);
    if (idx < 0) break;
    count++;
    offset += idx + needle.length;
  }
  return count;
}

/**
 * Go's `strings.Split(s, string(delimiter))` for a single-byte delimiter:
 * splits on every occurrence, including consecutive ones (producing empty
 * parts), and always returns at least one element (the whole input) when
 * the delimiter never occurs.
 */
export function splitBytes(b: Uint8Array, delimiter: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === delimiter) {
      parts.push(slice(b, start, i));
      start = i + 1;
    }
  }
  parts.push(slice(b, start, b.length));
  return parts;
}

/** Go's `bytes.Join(parts, nil)` / repeated `append`. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function trimSpaceSlow(b: Uint8Array): Uint8Array {
  let start = 0;
  while (start < b.length) {
    const { codePoint, size } = decodeRune(b, start);
    if (!isSpaceRuneWide(codePoint)) break;
    start += size === 0 ? 1 : size;
  }
  let end = b.length;
  while (end > start) {
    const { codePoint, size } = decodeLastRune(b, end);
    if (!isSpaceRuneWide(codePoint)) break;
    end -= size === 0 ? 1 : size;
  }
  return slice(b, start, end);
}

/**
 * Go's `strings.TrimSpace`, ported byte-for-byte including its ASCII fast
 * path and Unicode-aware slow path (H14) — trims Go's `unicode.IsSpace` set
 * (includes U+0085, excludes U+FEFF), never JS's `.trim()` (the opposite).
 */
export function trimSpace(b: Uint8Array): Uint8Array {
  let start = 0;
  for (; start < b.length; start++) {
    const c = b[start]!;
    if (c >= 0x80) return trimSpaceSlow(slice(b, start, b.length));
    if (!ASCII_SPACE.has(c)) break;
  }
  let stop = b.length;
  for (; stop > start; stop--) {
    const c = b[stop - 1]!;
    if (c >= 0x80) return trimSpaceSlow(slice(b, start, stop));
    if (!ASCII_SPACE.has(c)) break;
  }
  return slice(b, start, stop);
}

export interface Line {
  readonly text: Uint8Array;
  readonly eol: Uint8Array;
}

const LF = new Uint8Array([0x0a]);
const CRLF = new Uint8Array([0x0d, 0x0a]);
const CR = new Uint8Array([0x0d]);
const NO_EOL = new Uint8Array(0);

/**
 * Go's `splitSourceLines` primitive (`meat/diff.go:66-86`): split `text`
 * into physical lines, each carrying its exact line terminator (`""`,
 * `"\n"`, or `"\r\n"`). Empty input yields zero lines — never a single
 * phantom empty line — and text with no trailing newline yields exactly as
 * many lines as there are line bodies, never one extra.
 */
export function splitLines(text: Uint8Array): Line[] {
  if (text.length === 0) return [];
  const lines: Line[] = [];
  let rest = text;
  while (rest.length > 0) {
    const i = indexOf(rest, LF);
    if (i < 0) {
      lines.push({ text: rest, eol: NO_EOL });
      break;
    }
    let line = slice(rest, 0, i);
    let eol: Uint8Array = LF;
    if (hasSuffix(line, CR)) {
      line = slice(line, 0, line.length - 1);
      eol = CRLF;
    }
    lines.push({ text: line, eol });
    rest = slice(rest, i + 1, rest.length);
  }
  return lines;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** The CLI/model-API text boundary (H1) — decode never happens mid-pipeline. */
export function encodeUTF8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

/** The CLI/model-API text boundary (H1). Throws on invalid UTF-8. */
export function decodeUTF8(b: Uint8Array): string {
  return utf8Decoder.decode(b);
}

/** Go's `utf8.Valid`/`utf8.ValidString` (`meat/editplan.go:651`). */
export function isValidUTF8(b: Uint8Array): boolean {
  try {
    utf8Decoder.decode(b);
    return true;
  } catch {
    return false;
  }
}
