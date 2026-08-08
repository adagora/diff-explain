import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  at,
  arrayAt,
  slice,
  equals,
  hasPrefix,
  hasSuffix,
  indexOf,
  concat,
  countOccurrences,
  splitBytes,
  trimSpace,
  splitLines,
  isRuneStart,
  decodeRune,
  decodeLastRune,
  runes,
  isSpaceRune,
  isLetterRune,
  isNumberRune,
  isControlRune,
  encodeUTF8,
  decodeUTF8,
  isValidUTF8,
} from "../../src/meat/bytes.ts";

const b = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);
const s = (text: string): Uint8Array => encodeUTF8(text);
const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");

describe("at", () => {
  test("returns the byte at a valid index", () => {
    assert.equal(at(b(1, 2, 3), 1), 2);
  });
  test("throws RangeError below zero", () => {
    assert.throws(() => at(b(1, 2, 3), -1), RangeError);
  });
  test("throws RangeError at length", () => {
    assert.throws(() => at(b(1, 2, 3), 3), RangeError);
  });
  test("throws RangeError on empty array", () => {
    assert.throws(() => at(b(), 0), RangeError);
  });
});

describe("arrayAt", () => {
  test("returns the element at a valid index", () => {
    assert.equal(arrayAt(["a", "b", "c"], 1), "b");
  });
  test("throws RangeError below zero", () => {
    assert.throws(() => arrayAt(["a", "b", "c"], -1), RangeError);
  });
  test("throws RangeError at length", () => {
    assert.throws(() => arrayAt(["a", "b", "c"], 3), RangeError);
  });
  test("throws RangeError on empty array", () => {
    assert.throws(() => arrayAt([], 0), RangeError);
  });
});

describe("slice", () => {
  test("returns a view sharing the underlying buffer", () => {
    const src = b(1, 2, 3, 4, 5);
    const view = slice(src, 1, 4);
    assert.deepEqual(Array.from(view), [2, 3, 4]);
    src[1] = 99;
    assert.equal(view[0], 99, "slice must be a view, not a copy");
  });
  test("defaults end to the array length", () => {
    assert.deepEqual(Array.from(slice(b(1, 2, 3), 1)), [2, 3]);
  });
  test("empty slice at start===end is allowed", () => {
    assert.deepEqual(Array.from(slice(b(1, 2, 3), 3, 3)), []);
  });
  test("throws when end > length", () => {
    assert.throws(() => slice(b(1, 2, 3), 0, 4), RangeError);
  });
  test("throws when start < 0", () => {
    assert.throws(() => slice(b(1, 2, 3), -1, 2), RangeError);
  });
  test("throws when end < start", () => {
    assert.throws(() => slice(b(1, 2, 3), 2, 1), RangeError);
  });
});

describe("equals", () => {
  test("true for identical contents", () => {
    assert.ok(equals(b(1, 2, 3), b(1, 2, 3)));
  });
  test("false for different lengths", () => {
    assert.ok(!equals(b(1, 2), b(1, 2, 3)));
  });
  test("false for same length, different bytes", () => {
    assert.ok(!equals(b(1, 2, 3), b(1, 2, 4)));
  });
  test("true for two empty arrays", () => {
    assert.ok(equals(b(), b()));
  });
});

describe("hasPrefix / hasSuffix", () => {
  test("hasPrefix true/false", () => {
    assert.ok(hasPrefix(s("hello world"), s("hello")));
    assert.ok(!hasPrefix(s("hello"), s("hello world")));
  });
  test("hasSuffix true/false", () => {
    assert.ok(hasSuffix(s("hello world"), s("world")));
    assert.ok(!hasSuffix(s("world"), s("hello world")));
  });
  test("empty prefix/suffix always matches", () => {
    assert.ok(hasPrefix(s("anything"), s("")));
    assert.ok(hasSuffix(s("anything"), s("")));
    assert.ok(hasPrefix(s(""), s("")));
  });
});

describe("indexOf", () => {
  test("finds a substring", () => {
    assert.equal(indexOf(s("hello world"), s("world")), 6);
  });
  test("returns -1 when not found", () => {
    assert.equal(indexOf(s("hello"), s("xyz")), -1);
  });
  test("empty needle matches at 0", () => {
    assert.equal(indexOf(s("hello"), s("")), 0);
  });
  test("needle longer than haystack is -1", () => {
    assert.equal(indexOf(s("hi"), s("hello")), -1);
  });
  test("finds overlapping-looking repeats at first occurrence", () => {
    assert.equal(indexOf(s("aaab"), s("aab")), 1);
  });
});

describe("concat", () => {
  test("joins parts in order", () => {
    assert.deepEqual(Array.from(concat([b(1, 2), b(), b(3), b(4, 5)])), [1, 2, 3, 4, 5]);
  });
  test("empty input yields empty array", () => {
    assert.equal(concat([]).length, 0);
  });
});

describe("countOccurrences", () => {
  test("counts non-overlapping occurrences", () => {
    assert.equal(countOccurrences(s("ababab"), s("ab")), 3);
  });
  test("overlapping candidate positions are not double-counted", () => {
    // "aaa" contains "aa" starting at 0 and 1, but Go's strings.Count only
    // finds the non-overlapping one at offset 0, then resumes after it.
    assert.equal(countOccurrences(s("aaa"), s("aa")), 1);
  });
  test("needle not present is zero", () => {
    assert.equal(countOccurrences(s("abc"), s("xyz")), 0);
  });
  test("multi-byte needle (triple-quote token)", () => {
    assert.equal(countOccurrences(s('"""a""""""'), s('"""')), 3);
  });
});

describe("splitBytes", () => {
  const DOT = ".".codePointAt(0) as number;

  test("splits on every occurrence of the delimiter", () => {
    const got = splitBytes(s("a.b.c"), DOT).map((p) => Buffer.from(p).toString());
    assert.deepEqual(got, ["a", "b", "c"]);
  });
  test("consecutive delimiters produce empty parts", () => {
    const got = splitBytes(s("a..b"), DOT).map((p) => Buffer.from(p).toString());
    assert.deepEqual(got, ["a", "", "b"]);
  });
  test("a leading/trailing delimiter produces leading/trailing empty parts", () => {
    const got = splitBytes(s(".a."), DOT).map((p) => Buffer.from(p).toString());
    assert.deepEqual(got, ["", "a", ""]);
  });
  test("no delimiter present returns the whole input as one element", () => {
    const got = splitBytes(s("abc"), DOT).map((p) => Buffer.from(p).toString());
    assert.deepEqual(got, ["abc"]);
  });
  test("empty input returns one empty element, matching Go's strings.Split", () => {
    const got = splitBytes(s(""), DOT);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.length, 0);
  });
});

describe("decodeRune — verified against `go run` (unicode/utf8)", () => {
  const cases: Array<[string, number[], number, number]> = [
    ["ascii", [0x41], 0x41, 1],
    ["2byte-valid (NEL U+0085)", [0xc2, 0x85], 0x85, 2],
    ["2byte-overlong-C0", [0xc0, 0x80], RUNE_ERROR(), 1],
    ["2byte-overlong-C1", [0xc1, 0xbf], RUNE_ERROR(), 1],
    ["3byte-valid (U+3000)", [0xe3, 0x80, 0x80], 0x3000, 3],
    ["3byte-overlong-E0", [0xe0, 0x80, 0x80], RUNE_ERROR(), 1],
    ["3byte-surrogate-ED", [0xed, 0xa0, 0x80], RUNE_ERROR(), 1],
    ["4byte-valid-min (U+10000)", [0xf0, 0x90, 0x80, 0x80], 0x10000, 4],
    ["4byte-overlong-F0", [0xf0, 0x80, 0x80, 0x80], RUNE_ERROR(), 1],
    ["4byte-toobig-F4", [0xf4, 0x90, 0x80, 0x80], RUNE_ERROR(), 1],
    ["4byte-max-valid (U+10FFFF)", [0xf4, 0x8f, 0xbf, 0xbf], 0x10ffff, 4],
    ["lone-continuation", [0x80], RUNE_ERROR(), 1],
    ["truncated-2byte", [0xc2], RUNE_ERROR(), 1],
    ["truncated-3byte", [0xe3, 0x80], RUNE_ERROR(), 1],
    ["invalid-continuation", [0xc2, 0x41], RUNE_ERROR(), 1],
    ["5byte-lead-F5", [0xf5, 0x80, 0x80, 0x80], RUNE_ERROR(), 1],
  ];
  for (const [name, bytes, codePoint, size] of cases) {
    test(name, () => {
      const d = decodeRune(b(...bytes), 0);
      assert.equal(d.codePoint, codePoint, `codePoint for ${name}`);
      assert.equal(d.size, size, `size for ${name}`);
    });
  }
  test("empty input has size 0", () => {
    const d = decodeRune(b(), 0);
    assert.equal(d.size, 0);
  });
  test("decoding at end of buffer has size 0", () => {
    const d = decodeRune(b(0x41, 0x42), 2);
    assert.equal(d.size, 0);
  });
});

function RUNE_ERROR(): number {
  return 0xfffd;
}

describe("decodeLastRune — verified against `go run` (unicode/utf8)", () => {
  test("ascii", () => {
    const d = decodeLastRune(s("hiA"), 3);
    assert.equal(d.codePoint, 0x41);
    assert.equal(d.size, 1);
  });
  test("empty is size 0", () => {
    assert.equal(decodeLastRune(b(), 0).size, 0);
  });
  test("2byte valid at end", () => {
    const buf = b(0x41, 0xc2, 0x85);
    const d = decodeLastRune(buf, 3);
    assert.equal(d.codePoint, 0x85);
    assert.equal(d.size, 2);
  });
  test("truncated lead-only byte at end is invalid, size 1", () => {
    const buf = b(0x41, 0xc2);
    const d = decodeLastRune(buf, 2);
    assert.equal(d.codePoint, RUNE_ERROR());
    assert.equal(d.size, 1);
  });
  test("stray continuation byte at end is invalid, size 1", () => {
    const buf = b(0x41, 0x80);
    const d = decodeLastRune(buf, 2);
    assert.equal(d.codePoint, RUNE_ERROR());
    assert.equal(d.size, 1);
  });
  test("3byte valid at end", () => {
    const buf = b(0x41, 0xe3, 0x80, 0x80);
    const d = decodeLastRune(buf, 4);
    assert.equal(d.codePoint, 0x3000);
    assert.equal(d.size, 3);
  });
  test("3byte truncated at end is invalid, size 1", () => {
    const buf = b(0x41, 0xe3, 0x80);
    const d = decodeLastRune(buf, 3);
    assert.equal(d.codePoint, RUNE_ERROR());
    assert.equal(d.size, 1);
  });
  test("4byte valid at end", () => {
    const buf = b(0x41, 0xf0, 0x90, 0x80, 0x80);
    const d = decodeLastRune(buf, 5);
    assert.equal(d.codePoint, 0x10000);
    assert.equal(d.size, 4);
  });
  test("many continuation bytes with no lead within MAX_UTF8_BYTES is invalid, size 1", () => {
    const buf = b(0x41, 0x80, 0x80, 0x80, 0x80, 0x80);
    const d = decodeLastRune(buf, 6);
    assert.equal(d.codePoint, RUNE_ERROR());
    assert.equal(d.size, 1);
  });
});

describe("isRuneStart", () => {
  test("ASCII bytes are rune starts", () => {
    assert.ok(isRuneStart(0x41));
  });
  test("continuation bytes are not", () => {
    assert.ok(!isRuneStart(0x80));
    assert.ok(!isRuneStart(0xbf));
  });
  test("multi-byte lead bytes are rune starts", () => {
    assert.ok(isRuneStart(0xc2));
    assert.ok(isRuneStart(0xe3));
    assert.ok(isRuneStart(0xf0));
  });
});

describe("runes", () => {
  test("iterates codepoints with byte offsets", () => {
    const text = s("aé中"); // 1 + 2 + 3 bytes
    const got = Array.from(runes(text)).map((r) => [r.codePoint, r.offset, r.size]);
    assert.deepEqual(got, [
      [0x61, 0, 1],
      [0xe9, 1, 2],
      [0x4e2d, 3, 3],
    ]);
  });
  test("empty input yields nothing", () => {
    assert.deepEqual(Array.from(runes(b())), []);
  });
  test("advances past an invalid byte by exactly one", () => {
    const text = b(0x41, 0x80, 0x42);
    const got = Array.from(runes(text)).map((r) => [r.codePoint, r.offset]);
    assert.deepEqual(got, [
      [0x41, 0],
      [0xfffd, 1],
      [0x42, 2],
    ]);
  });
});

describe("isSpaceRune — verified against `go run` (unicode.IsSpace)", () => {
  const spaceTrue = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  const spaceFalse = [0x1fff, 0x200b, 0xfeff];
  for (const cp of spaceTrue) {
    test(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} is space`, () => {
      assert.ok(isSpaceRune(cp));
    });
  }
  for (const cp of spaceFalse) {
    test(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} is not space`, () => {
      assert.ok(!isSpaceRune(cp));
    });
  }
});

describe("isLetterRune / isNumberRune / isControlRune", () => {
  test("letters", () => {
    assert.ok(isLetterRune(0x41)); // A
    assert.ok(isLetterRune(0x4e2d)); // 中
    assert.ok(!isLetterRune(0x31)); // '1'
  });
  test("numbers", () => {
    assert.ok(isNumberRune(0x31)); // '1'
    assert.ok(!isNumberRune(0x41));
  });
  test("control characters", () => {
    assert.ok(isControlRune(0x00));
    assert.ok(isControlRune(0x1f));
    assert.ok(isControlRune(0x7f));
    assert.ok(isControlRune(0x9f)); // C1 control
    assert.ok(!isControlRune(0x41));
    assert.ok(!isControlRune(0x3000), "IsControl is Latin-1 only in Go, unlike full \\p{Cc}");
  });
});

describe("trimSpace — verified against `go run` (strings.TrimSpace)", () => {
  test("empty stays empty", () => {
    assert.equal(hex(trimSpace(b())), "");
  });
  test("ASCII-only padding", () => {
    assert.equal(hex(trimSpace(s("   hi   "))), hex(s("hi")));
  });
  test("tabs, newlines, CRLF", () => {
    assert.equal(hex(trimSpace(b(0x09, 0x0a, 0x20, 0x68, 0x69, 0x20, 0x0d, 0x0a))), hex(s("hi")));
  });
  test("trims U+0085 (NEL)", () => {
    const input = concat([b(0xc2, 0x85), s("hi"), b(0xc2, 0x85)]);
    assert.equal(hex(trimSpace(input)), hex(s("hi")));
  });
  test("trims U+00A0 (NBSP)", () => {
    const input = concat([b(0xc2, 0xa0), s("hi"), b(0xc2, 0xa0)]);
    assert.equal(hex(trimSpace(input)), hex(s("hi")));
  });
  test("does NOT trim U+FEFF (BOM) — opposite of JS .trim()", () => {
    const input = concat([b(0xef, 0xbb, 0xbf), s("hi"), b(0xef, 0xbb, 0xbf)]);
    assert.equal(hex(trimSpace(input)), hex(input));
  });
  test("trims U+2000 (em quad)", () => {
    const input = concat([b(0xe2, 0x80, 0x80), s("hi"), b(0xe2, 0x80, 0x80)]);
    assert.equal(hex(trimSpace(input)), hex(s("hi")));
  });
  test("trims U+3000 (ideographic space)", () => {
    const input = concat([b(0xe3, 0x80, 0x80), s("hi"), b(0xe3, 0x80, 0x80)]);
    assert.equal(hex(trimSpace(input)), hex(s("hi")));
  });
  test("all-space input trims to empty", () => {
    assert.equal(hex(trimSpace(b(0x20, 0x20, 0x20, 0x09, 0x0a, 0x20, 0x20))), "");
  });
  test("trailing invalid byte is not space, stays", () => {
    const input = concat([s("hi "), b(0xff)]);
    assert.equal(hex(trimSpace(input)), hex(input));
  });
  test("mixed ASCII-then-NBSP trims both ends correctly", () => {
    const input = concat([s("  hi"), b(0xc2, 0xa0)]);
    assert.equal(hex(trimSpace(input)), hex(s("hi")));
  });
});

describe("splitLines — splitSourceLines primitive (meat/diff.go:66-86)", () => {
  test("empty input yields zero lines, not one phantom line", () => {
    assert.deepEqual(splitLines(b()), []);
  });
  test("no trailing newline yields exactly one line with empty eol", () => {
    const lines = splitLines(s("abc"));
    assert.equal(lines.length, 1);
    assert.equal(hex(lines[0]!.text), hex(s("abc")));
    assert.equal(lines[0]!.eol.length, 0);
  });
  test("trailing newline does not create a phantom final line", () => {
    const lines = splitLines(s("abc\n"));
    assert.equal(lines.length, 1);
    assert.equal(hex(lines[0]!.text), hex(s("abc")));
    assert.equal(hex(lines[0]!.eol), hex(s("\n")));
  });
  test("multiple lines with mixed LF/CRLF terminators", () => {
    const lines = splitLines(s("a\nb\r\nc"));
    assert.equal(lines.length, 3);
    assert.equal(hex(lines[0]!.text), hex(s("a")));
    assert.equal(hex(lines[0]!.eol), hex(s("\n")));
    assert.equal(hex(lines[1]!.text), hex(s("b")));
    assert.equal(hex(lines[1]!.eol), hex(s("\r\n")));
    assert.equal(hex(lines[2]!.text), hex(s("c")));
    assert.equal(lines[2]!.eol.length, 0);
  });
  test("blank lines are preserved", () => {
    const lines = splitLines(s("a\n\nb\n"));
    assert.equal(lines.length, 3);
    assert.equal(lines[1]!.text.length, 0);
  });
  test("a lone CR without LF is not treated as a terminator", () => {
    const lines = splitLines(s("a\rb"));
    assert.equal(lines.length, 1);
    assert.equal(hex(lines[0]!.text), hex(s("a\rb")));
  });
});

describe("UTF-8 boundary helpers", () => {
  test("encode/decode round-trip", () => {
    assert.equal(decodeUTF8(encodeUTF8("hello, 世界")), "hello, 世界");
  });
  test("isValidUTF8 true for valid text", () => {
    assert.ok(isValidUTF8(s("valid")));
  });
  test("isValidUTF8 false for a stray continuation byte", () => {
    assert.ok(!isValidUTF8(b(0x80)));
  });
  test("isValidUTF8 false for a truncated multi-byte sequence", () => {
    assert.ok(!isValidUTF8(b(0xe3, 0x80)));
  });
});
