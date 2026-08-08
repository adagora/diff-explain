// Port of the cache.go-scoped tests in cmd/meat/cache_test.go:
// TestCacheKeyDependsOnDiffModelAndRubric (G1), TestCacheRoundTrip (G2),
// TestCacheDisabledWithEmptyDir (G3), TestCacheMissOnCorruptEntry (G4),
// TestCacheDirEnvOverride (G5). TestRunCacheHitSkipsCompute,
// TestRunNoCacheBypassesReadButWritesThrough, and TestRunComputeErrorPropagates
// exercise `run`/`runOpts`, which live in main.go, not cache.go
// (specs/cache.md Mechanism "Scope note") — deferred to item 5d's tests.
//
// Also adds direct coverage for cache.ts's own header note on H15: a
// syntactically valid but field-incomplete or `null` cache entry is a hit
// at the zero value, not a miss, and a present-but-wrong-typed field is a
// miss — none of this is exercised by cache_test.go (specs/cache.md Open
// questions only lists the field-incomplete case, doesn't test it either).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cacheDir, cacheKey, cacheLoad, cacheStore } from "../../src/cli/cache.ts";
import { type Result } from "../../src/meat/meat.ts";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";

async function tempCacheDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "meat-cache-"));
}

const emptyResult: Result = { smartDiff: new Uint8Array(0), summary: "", inputTokens: 0, outputTokens: 0 };

// Ported from meat/cache_test.go's TestCacheKeyDependsOnDiffModelAndRubric (G1).
describe("cacheKey (cmd/meat/cache.go:31-41, G1)", () => {
  test("deterministic for the same triple", () => {
    assert.equal(cacheKey("diff A", "model-1", "rubric-1"), cacheKey("diff A", "model-1", "rubric-1"));
  });
  test("changing the diff changes the key", () => {
    assert.notEqual(cacheKey("diff A", "model-1", "rubric-1"), cacheKey("diff B", "model-1", "rubric-1"));
  });
  test("changing the model changes the key", () => {
    assert.notEqual(cacheKey("diff A", "model-1", "rubric-1"), cacheKey("diff A", "model-2", "rubric-1"));
  });
  test("changing the rubric changes the key", () => {
    assert.notEqual(cacheKey("diff A", "model-1", "rubric-1"), cacheKey("diff A", "model-1", "rubric-2"));
  });
  test("no naive-concatenation collision at the model/diff boundary", () => {
    assert.notEqual(cacheKey("a", "b", "r"), cacheKey("a\x00b", "", "r"));
  });
  test("hashes UTF-8 bytes, not UTF-16 code units (H1)", () => {
    const key = cacheKey("café diff", "m", "r");
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from("r", "utf8"), Buffer.from([0]), Buffer.from("m", "utf8"), Buffer.from([0]), Buffer.from("café diff", "utf8")]))
      .digest("hex");
    assert.equal(key, expected);
  });
});

// Ported from meat/cache_test.go's TestCacheRoundTrip (G2).
describe("cacheStore / cacheLoad round trip (cmd/meat/cache.go:46-92, G2)", () => {
  test("miss on an empty cache, hit with equal fields after store", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("some diff", "m", "r");
    const want: Result = { smartDiff: encodeUTF8("+ kept line\n"), summary: "a summary", inputTokens: 123, outputTokens: 45 };

    assert.equal(await cacheLoad(dir, key), null);
    await cacheStore(dir, key, want);
    const got = await cacheLoad(dir, key);
    assert.ok(got !== null);
    assert.deepEqual(got, want);
  });

  test("round-trips a multibyte smartDiff byte-exact (H1)", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    const want: Result = { smartDiff: encodeUTF8("café élision 😀\n"), summary: "s", inputTokens: 1, outputTokens: 2 };
    await cacheStore(dir, key, want);
    const got = await cacheLoad(dir, key);
    assert.ok(got !== null);
    assert.equal(decodeUTF8(got.smartDiff), decodeUTF8(want.smartDiff));
  });

  test("cacheStore leaves no leftover .tmp files behind on success", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await cacheStore(dir, key, emptyResult);
    const names = await readdir(dir);
    assert.deepEqual(
      names.filter((n) => n.endsWith(".tmp")),
      [],
    );
    assert.ok(names.includes(`${key}.json`));
  });
});

// Ported from meat/cache_test.go's TestCacheDisabledWithEmptyDir (G3).
describe("empty dir disables the cache (cmd/meat/cache.go:47-49,64-66, G3)", () => {
  test("storing to \"\" is a no-op and loading from \"\" always misses", async () => {
    const key = cacheKey("d", "m", "r");
    await cacheStore("", key, { ...emptyResult, summary: "x" });
    assert.equal(await cacheLoad("", key), null);
  });
});

// Ported from meat/cache_test.go's TestCacheMissOnCorruptEntry (G4).
describe("a syntactically invalid entry is a miss (cmd/meat/cache.go:54-57, G4)", () => {
  test("malformed JSON bytes on disk", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await writeFile(join(dir, `${key}.json`), "{not json");
    assert.equal(await cacheLoad(dir, key), null);
  });
});

// Ported from meat/cache_test.go's TestCacheDirEnvOverride (G5).
describe("cacheDir (cmd/meat/cache.go:15-24, G5)", () => {
  const original = process.env["MEAT_CACHE"];
  const restore = (): void => {
    if (original === undefined) delete process.env["MEAT_CACHE"];
    else process.env["MEAT_CACHE"] = original;
  };

  test("MEAT_CACHE set to a value wins verbatim", () => {
    process.env["MEAT_CACHE"] = "/custom/path";
    try {
      assert.equal(cacheDir(), "/custom/path");
    } finally {
      restore();
    }
  });

  test("MEAT_CACHE set to empty disables caching, distinct from unset", () => {
    process.env["MEAT_CACHE"] = "";
    try {
      assert.equal(cacheDir(), "");
    } finally {
      restore();
    }
  });

  test("MEAT_CACHE entirely absent falls back to the home directory joined with .meat", () => {
    delete process.env["MEAT_CACHE"];
    try {
      assert.equal(cacheDir(), join(homedir(), ".meat"));
    } finally {
      restore();
    }
  });
});

// New coverage for H15's lenient-decode corners (specs/cache.md Open
// questions: the field-incomplete case is described but not tested by Go).
describe("cacheLoad's lenient JSON decode (H15)", () => {
  test("a field-incomplete object is a hit with the missing fields at their zero value", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ summary: "x" }));
    const got = await cacheLoad(dir, key);
    assert.deepEqual(got, { smartDiff: new Uint8Array(0), summary: "x", inputTokens: 0, outputTokens: 0 });
  });

  test("an empty object is a hit at the all-zero value", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await writeFile(join(dir, `${key}.json`), "{}");
    assert.deepEqual(await cacheLoad(dir, key), emptyResult);
  });

  test("a top-level JSON null is a hit at the all-zero value, matching Go's null-into-struct no-op", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await writeFile(join(dir, `${key}.json`), "null");
    assert.deepEqual(await cacheLoad(dir, key), emptyResult);
  });

  test("a present field of the wrong type is a miss, not a coerced hit", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ summary: 5 }));
    assert.equal(await cacheLoad(dir, key), null);
  });

  test("a top-level JSON array is a miss", async () => {
    const dir = await tempCacheDir();
    const key = cacheKey("d", "m", "r");
    await writeFile(join(dir, `${key}.json`), "[]");
    assert.equal(await cacheLoad(dir, key), null);
  });
});
