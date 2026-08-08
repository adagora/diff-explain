// The vector runner (CONFORMANCE.md). Walks `conformance/vectors/` — 111
// language-neutral oracles frozen from the Go implementation at stage 0 — and
// asserts each ported function's output against them, with no knowledge of
// what any vector *means*: it just checks bytes. See migration/CONFORMANCE.md
// and TODO.md item 3.
//
// Every function this file calls belongs to a module that stage 3 has not
// ported yet as of this writing. That is the point: "build it early and
// failing... the passing count is the port's real progress metric" (stage3
// -port.md). Each test dynamically imports its module and lets an import
// failure or a thrown "not implemented" surface as an ordinary failing
// assertion — never a crash of the whole file — so the pass count climbs
// item by item as the engine gets ported, instead of jumping from 0 to 111
// all at once.
//
// PROVISIONAL SHAPES: the exact field names/casing and string-vs-Uint8Array
// choice for each not-yet-written module's exports are informed guesses
// (idiomatic camelCase runtime fields; Go's byte-oriented files — diff,
// chunk, editplan, imports, moves, python, and elision by inference from its
// own Hazards section — pass/return Uint8Array; validate/compile-style
// functions are assumed to throw an `Error` whose `.message` matches Go's
// exact text, mirroring `errText(err)` in the deleted-but-read dump test).
// `ElisionLine` and `RubricHash` keep their exact Go casing per
// `migration/TARGET.md`'s cross-boundary export list / CONFORMANCE.md's
// "exported" callouts. When the item that ports a module lands, adjust this
// file's assumptions to match what was actually built — that is expected
// maintenance, not a bug in this runner.
//
// Vector generation logic (the authoritative source for every shape below)
// is `meat/conformance_dump_test.go` and `cmd/meat/conformance_dump_test.go`
// — permitted, purely-additive Go test files, read in full while writing
// this runner, never edited.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { equals, encodeUTF8, decodeUTF8 } from "../src/meat/bytes.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..");
const vectorsDir = join(repoRoot, "conformance", "vectors");

// ---------------------------------------------------------------------------
// Corpus loading — mirrors `loadCorpus` in meat/conformance_dump_test.go
// exactly: testdata/python/*.diff (excluding *.golden.diff) plus, from every
// immediate subdirectory of analysis/, *.original.diff and *.live.diff.
// Sorted by name, matching Go's sort.Slice.
// ---------------------------------------------------------------------------

interface CorpusEntry {
  readonly name: string;
  readonly diff: Uint8Array;
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => join(dir, f));
}

function loadCorpus(): CorpusEntry[] {
  const paths = listFiles(join(repoRoot, "testdata", "python"), ".diff").filter(
    (p) => !p.endsWith(".golden.diff"),
  );
  const analysisDir = join(repoRoot, "analysis");
  if (existsSync(analysisDir)) {
    for (const entry of readdirSync(analysisDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(analysisDir, entry.name);
      paths.push(...listFiles(sub, ".original.diff"), ...listFiles(sub, ".live.diff"));
    }
  }
  const corpus = paths.map((p) => ({
    name: basename(p).replace(/\.diff$/, ""),
    diff: new Uint8Array(readFileSync(p)),
  }));
  corpus.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return corpus;
}

const corpus = loadCorpus();

test("corpus is non-empty and has the expected 9 entries", () => {
  assert.equal(corpus.length, 9, `corpus: ${corpus.map((c) => c.name).join(", ")}`);
});

// ---------------------------------------------------------------------------
// Vector file helpers
// ---------------------------------------------------------------------------

function vectorPath(...parts: string[]): string {
  return join(vectorsDir, ...parts);
}
function readVectorBytes(...parts: string[]): Uint8Array {
  return new Uint8Array(readFileSync(vectorPath(...parts)));
}
function readVectorText(...parts: string[]): string {
  return readFileSync(vectorPath(...parts), "utf8");
}
function readVectorJSON<T>(...parts: string[]): T {
  return JSON.parse(readVectorText(...parts)) as T;
}
function vectorExists(...parts: string[]): boolean {
  return existsSync(vectorPath(...parts));
}

// ---------------------------------------------------------------------------
// Module loading — dynamic, so a not-yet-created source file rejects the
// `import()` promise (caught inside each test) instead of crashing this
// file's static import graph at load time.
// ---------------------------------------------------------------------------

// `any` is the honest type here: the target module doesn't exist on disk yet
// for most of this file's lifetime, so there is no real shape to declare.
// eslint and tsc both leave test/ alone (see the file-level note above).
async function importSrc(relPathFromSrc: string): Promise<any> {
  const url = pathToFileURL(join(repoRoot, "src", relPathFromSrc)).href;
  return import(url);
}

// ---------------------------------------------------------------------------
// string/Uint8Array normalization — see the PROVISIONAL SHAPES note above.
// ---------------------------------------------------------------------------

function toBytesVal(x: string | Uint8Array): Uint8Array {
  return typeof x === "string" ? encodeUTF8(x) : x;
}
function toTextVal(x: string | Uint8Array): string {
  return typeof x === "string" ? x : decodeUTF8(x);
}

/** Calls `fn`; returns "" on success, or the thrown Error's `.message`. */
function errorTextOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

interface LineRangeLike {
  startLine: number;
  endLine: number;
}
function normalizeRange(r: LineRangeLike): { startLine: number; endLine: number } {
  return { startLine: r.startLine, endLine: r.endLine };
}
interface DetectedMoveLike {
  removed: LineRangeLike;
  added: LineRangeLike;
}
function normalizeMove(m: DetectedMoveLike): unknown {
  return { removed: normalizeRange(m.removed), added: normalizeRange(m.added) };
}
interface VectorLineRange {
  start_line: number;
  end_line: number;
}
interface VectorMove {
  Removed: VectorLineRange;
  Added: VectorLineRange;
}
function normalizeVectorMove(m: VectorMove): unknown {
  return {
    removed: { startLine: m.Removed.start_line, endLine: m.Removed.end_line },
    added: { startLine: m.Added.start_line, endLine: m.Added.end_line },
  };
}
function normalizeVectorRange(r: VectorLineRange): unknown {
  return { startLine: r.start_line, endLine: r.end_line };
}

// ===========================================================================
// 1. The frozen prompt surface (rubric.ts) — CONFORMANCE.md: "the single
//    cheapest high-value check in the project."
// ===========================================================================

describe("rubric surface (src/meat/rubric.ts)", () => {
  test("protocol-version.txt === abridgeProtocolVersion", async () => {
    const mod = await importSrc("meat/rubric.ts");
    assert.equal(mod.abridgeProtocolVersion, readVectorText("protocol-version.txt"));
  });

  test("prompt-surface.txt === promptSurface()", async () => {
    const mod = await importSrc("meat/rubric.ts");
    const got = toBytesVal(mod.promptSurface());
    assert.ok(equals(got, readVectorBytes("prompt-surface.txt")));
  });

  test("rubric-hash.txt === RubricHash()", async () => {
    const mod = await importSrc("meat/rubric.ts");
    assert.equal(mod.RubricHash(), readVectorText("rubric-hash.txt"));
  });
});

// ===========================================================================
// 2. Per-diff deterministic stages (diff.ts, moves.ts, imports.ts, chunk.ts)
// ===========================================================================

describe("diff layout (src/meat/diff.ts)", () => {
  for (const entry of corpus) {
    test(`diff-layout/${entry.name}`, async () => {
      const mod = await importSrc("meat/diff.ts");
      const lines = mod.splitSourceLines(entry.diff);
      const layout = mod.analyzeDiff(lines);
      const want = readVectorJSON<{
        line_count: number;
        kinds: string[];
        languages: string[];
        python: boolean[];
        file_id: number[];
        hunk_id: number[];
        marker_owner: number[];
        problems: string[];
      }>("diff-layout", `${entry.name}.json`);

      assert.equal(lines.length, want.line_count);
      assert.deepEqual(layout.kinds, want.kinds);
      assert.deepEqual(layout.languages, want.languages);
      assert.deepEqual(layout.python, want.python);
      assert.deepEqual(layout.fileId, want.file_id);
      assert.deepEqual(layout.hunkId, want.hunk_id);
      assert.deepEqual(layout.markerOwner, want.marker_owner);
      assert.deepEqual(layout.problems, want.problems);
    });
  }
});

describe("source lines (src/meat/diff.ts)", () => {
  for (const entry of corpus) {
    test(`source-lines/${entry.name}`, async () => {
      const mod = await importSrc("meat/diff.ts");
      const lines = mod.splitSourceLines(entry.diff);
      const got = lines.map((l: { eol: string | Uint8Array }) => toTextVal(l.eol));
      const want = readVectorJSON<{ eols: string[] }>("source-lines", `${entry.name}.json`);
      assert.deepEqual(got, want.eols);
    });
  }
});

describe("numbered diff (src/meat/diff.ts)", () => {
  for (const entry of corpus) {
    test(`numbered/${entry.name}`, async () => {
      const mod = await importSrc("meat/diff.ts");
      const got = toBytesVal(mod.numberedDiff(entry.diff));
      assert.ok(equals(got, readVectorBytes("numbered", `${entry.name}.txt`)));
    });
  }
});

describe("diff validation (src/meat/diff.ts)", () => {
  for (const entry of corpus) {
    test(`validate/${entry.name}`, async () => {
      const mod = await importSrc("meat/diff.ts");
      const got = errorTextOf(() => mod.validateSupportedDiff(entry.diff));
      assert.equal(got, readVectorText("validate", `${entry.name}.txt`));
    });
  }
});

describe("move detection (src/meat/moves.ts)", () => {
  for (const entry of corpus) {
    test(`moves/${entry.name}`, async () => {
      const mod = await importSrc("meat/moves.ts");
      const got: DetectedMoveLike[] = mod.detectedMovesInDiff(entry.diff);
      // Go's nil []detectedMove marshals as JSON null, not [] (H9) — several
      // corpus entries genuinely have no moves.
      const want = readVectorJSON<VectorMove[] | null>("moves", `${entry.name}.json`) ?? [];
      assert.deepEqual(got.map(normalizeMove), want.map(normalizeVectorMove));
    });
  }
});

describe("mandatory import removal (src/meat/imports.ts)", () => {
  for (const entry of corpus) {
    test(`imports/${entry.name}`, async () => {
      const diffMod = await importSrc("meat/diff.ts");
      const importsMod = await importSrc("meat/imports.ts");
      const lines = diffMod.splitSourceLines(entry.diff);
      const layout = diffMod.analyzeDiff(lines);
      const got: LineRangeLike[] = importsMod.mandatoryImportRemovalPlan(lines, layout);
      // Go's nil []lineRange marshals as JSON null, not [] (H9) — several
      // corpus entries genuinely have no mandatory imports.
      const want = readVectorJSON<VectorLineRange[] | null>("imports", `${entry.name}.json`) ?? [];
      assert.deepEqual(got.map(normalizeRange), want.map(normalizeVectorRange));
    });
  }
});

const SPLIT_BUDGETS = [2048, 4096, 8192, 16384];

describe("fits-single-run (src/meat/chunk.ts)", () => {
  for (const entry of corpus) {
    test(`fits-single-run/${entry.name}`, async () => {
      const mod = await importSrc("meat/chunk.ts");
      const want = readVectorJSON<Record<string, boolean>>(
        "fits-single-run",
        `${entry.name}.json`,
      );
      for (const budget of SPLIT_BUDGETS) {
        const key = `b${budget}`;
        assert.equal(mod.fitsSingleRun(entry.diff, budget), want[key], key);
      }
    });
  }
});

describe("diff splitting (src/meat/chunk.ts)", () => {
  interface VectorChunk {
    text: string;
    meta_prefix: string;
    section_id: number;
  }
  interface ChunkLike {
    text: string | Uint8Array;
    metaPrefix: string | Uint8Array;
    sectionId: number;
  }
  for (const entry of corpus) {
    for (const budget of SPLIT_BUDGETS) {
      const key = `b${budget}`;
      test(`split/${entry.name}.${key}`, async () => {
        const mod = await importSrc("meat/chunk.ts");
        const errorVector = vectorExists("split", `${entry.name}.${key}.error.txt`);
        const jsonVector = vectorExists("split", `${entry.name}.${key}.json`);
        assert.ok(errorVector || jsonVector, `no vector for ${entry.name}.${key}`);

        if (errorVector) {
          const got = errorTextOf(() => mod.splitDiffForAbridging(entry.diff, budget));
          assert.equal(got, readVectorText("split", `${entry.name}.${key}.error.txt`));
          return;
        }
        const chunks: ChunkLike[] = mod.splitDiffForAbridging(entry.diff, budget);
        const want = readVectorJSON<VectorChunk[]>("split", `${entry.name}.${key}.json`);
        const gotNormalized = chunks.map((c) => ({
          text: toTextVal(c.text),
          metaPrefix: toTextVal(c.metaPrefix),
          sectionId: c.sectionId,
        }));
        const wantNormalized = want.map((c) => ({
          text: c.text,
          metaPrefix: c.meta_prefix,
          sectionId: c.section_id,
        }));
        assert.deepEqual(gotNormalized, wantNormalized);
      });
    }
  }
});

// ===========================================================================
// 3. Plan compilation over the checked-in golden plans (editplan.ts) — the
//    hard gate — and the elision manifest derived from its output
//    (elision.ts).
// ===========================================================================

describe("plan compilation (src/meat/editplan.ts) — the hard gate", () => {
  interface VectorEditPlan {
    remove: VectorLineRange[];
    replace: Array<{ line: number; old: string; new: string }>;
    fold: VectorLineRange[];
  }
  interface PlanCompileVector {
    error: string;
    smart_diff: string;
    moves: VectorMove[];
  }
  const planDir = join(repoRoot, "testdata", "python");
  const planFiles = existsSync(planDir)
    ? readdirSync(planDir).filter((f) => f.endsWith(".plan.json"))
    : [];

  for (const planFile of planFiles) {
    const base = planFile.replace(/\.plan\.json$/, "");
    test(`plan-compile/${base}`, async () => {
      const mod = await importSrc("meat/editplan.ts");
      const raw = new Uint8Array(readFileSync(join(planDir, `${base}.diff`)));
      const planJSON = JSON.parse(
        readFileSync(join(planDir, planFile), "utf8"),
      ) as VectorEditPlan;
      const plan = {
        remove: planJSON.remove.map((r) => ({ startLine: r.start_line, endLine: r.end_line })),
        replace: planJSON.replace.map((r) => ({ line: r.line, old: r.old, new: r.new })),
        fold: planJSON.fold.map((r) => ({ startLine: r.start_line, endLine: r.end_line })),
      };
      const want = readVectorJSON<PlanCompileVector>("plan-compile", `${base}.json`);

      let compiled: { smartDiff: string | Uint8Array; moves: DetectedMoveLike[] } | undefined;
      const got = errorTextOf(() => {
        compiled = mod.compileEditPlan(raw, plan);
      });
      assert.equal(got, want.error);
      if (want.error === "") {
        assert.ok(compiled, "compileEditPlan reported success but returned nothing");
        assert.equal(toTextVal(compiled!.smartDiff), want.smart_diff);
        assert.deepEqual(
          compiled!.moves.map(normalizeMove),
          want.moves.map(normalizeVectorMove),
        );
        // The golden fixture is the ultimate oracle (CONFORMANCE.md): the
        // rendered plan must also equal the checked-in *.golden.diff bytes.
        const golden = readFileSync(join(planDir, `${base}.golden.diff`), "utf8");
        assert.equal(toTextVal(compiled!.smartDiff), golden);
      }
    });
  }
});

describe("elision manifest (src/meat/elision.ts)", () => {
  const planDir = join(repoRoot, "testdata", "python");
  const planFiles = existsSync(planDir)
    ? readdirSync(planDir).filter((f) => f.endsWith(".plan.json"))
    : [];

  for (const planFile of planFiles) {
    const base = planFile.replace(/\.plan\.json$/, "");
    test(`elision/${base}`, async () => {
      const raw = readFileSync(join(planDir, `${base}.diff`), "utf8");
      const golden = readFileSync(join(planDir, `${base}.golden.diff`), "utf8");
      const mod = await importSrc("meat/elision.ts");
      const got = toTextVal(mod.ElisionLine(encodeUTF8(raw), encodeUTF8(golden)));
      assert.equal(got, readVectorText("elision", `${base}.txt`));
    });
  }
});

// ===========================================================================
// 4. Provider wire serialization (model.ts + openai.ts) — guards H4.
//    Fixture reproduced exactly from meat/conformance_dump_test.go's
//    dumpOpenAIRequest (the raw provider_state bytes' odd spacing and `1.0`
//    are deliberate: a JSON.parse/stringify round-trip normalizes them and
//    must fail this vector).
// ===========================================================================

describe("OpenAI request wire translation (src/meat/model.ts, src/meat/openai.ts)", () => {
  test("openai-request/replay", async () => {
    const modelMod = await importSrc("meat/model.ts");
    const openaiMod = await importSrc("meat/openai.ts");
    const providerStateRaw = encodeUTF8(
      '{"type":"reasoning","id":"rs_1","encrypted_content":"AAAA","summary":[ ],"n":1.0}',
    );
    const messages = [
      {
        role: modelMod.RoleUser ?? "user",
        content: [{ type: "text", text: "abridge this" }],
      },
      {
        role: modelMod.RoleAssistant ?? "assistant",
        content: [
          { type: "provider_state", provider: "openai", providerData: providerStateRaw },
          {
            type: "tool_use",
            id: "call_1",
            toolName: "read_file",
            toolInput: encodeUTF8('{"path":"a/b.go"}'),
          },
        ],
      },
      {
        role: modelMod.RoleUser ?? "user",
        content: [
          { type: "tool_result", toolUseId: "call_1", toolResult: "package a\n", toolError: false },
        ],
      },
    ];
    const items: Array<string | Uint8Array> = openaiMod.toOpenAIInput(messages);
    const got = items.map(toTextVal);
    const want = readVectorJSON<{ input_bytes: string[] }>("openai-request", "replay.json");
    assert.deepEqual(got, want.input_bytes);
  });
});

// ===========================================================================
// 5. CLI-side surfaces (cache.ts, render.ts)
// ===========================================================================

describe("cache key (src/cli/cache.ts)", () => {
  interface CacheKeyCase {
    name: string;
    diff: string;
    model: string;
    rubric: string;
    key: string;
  }
  const cases = readVectorJSON<CacheKeyCase[]>("cache-key", "cases.json");
  for (const c of cases) {
    test(`cache-key/${c.name}`, async () => {
      const mod = await importSrc("cli/cache.ts");
      assert.equal(mod.cacheKey(c.diff, c.model, c.rubric), c.key);
    });
  }
});

describe("-json wire form (src/cli/render.ts)", () => {
  // Literal inputs reproduced from cmd/meat/conformance_dump_test.go — not
  // derivable from the vector's "output" field alone without assuming a
  // round-trip, so they are hardcoded here to match the Go source exactly.
  // `smartDiff` is `Uint8Array` (H1) as actually built — render.ts's own
  // `Result` parameter matches `src/meat/meat.ts`'s, decoding to a string
  // only internally; `renderJSON` itself is a pure function returning the
  // encoded text (not writing to a `Writer`) — see render.ts's own
  // "Signature note" for why.
  const cases = [
    {
      name: "full",
      result: {
        smartDiff: encodeUTF8("@@ -1 +1 @@\n-a\n+b\n"),
        summary: "swap a for b",
        inputTokens: 120,
        outputTokens: 34,
      },
      elision: "kept 2/9 changed lines in 1/3 files",
    },
    {
      name: "no-elision",
      result: { smartDiff: encodeUTF8(""), summary: "No changes.", inputTokens: 0, outputTokens: 0 },
      elision: "",
    },
    {
      name: "html-and-multibyte",
      result: {
        smartDiff: encodeUTF8("+if a < b && c > d {\n"),
        summary: "guard <html> & 日本語",
        inputTokens: 1,
        outputTokens: 2,
      },
      elision: "elided all 4 changed lines in 1 files",
    },
  ];
  interface RenderCase {
    name: string;
    elision_input: string;
    output: string;
  }
  const want = readVectorJSON<RenderCase[]>("json-wire", "cases.json");

  for (const c of cases) {
    test(`json-wire/${c.name}`, async () => {
      const mod = await importSrc("cli/render.ts");
      const wantCase = want.find((w) => w.name === c.name);
      assert.ok(wantCase, `no vector case named ${c.name}`);
      assert.equal(c.elision, wantCase!.elision_input, "fixture drifted from the vector's own input");
      const got = toTextVal(mod.renderJSON(c.result, c.elision));
      assert.equal(got, wantCase!.output);
    });
  }
});
