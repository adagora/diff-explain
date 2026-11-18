// Port of cmd/meat/readdiff_test.go's 7 tests (TestReadDiffRevisionArg,
// TestReadDiffRevRange, TestReadDiffBadRevision, TestReadDiffTooManyArgs,
// TestReadDiffMergeCommit, TestReadDiffStagedAndWorktree,
// TestReadDiffFlagConflicts) plus cache_test.go's three `run`/`runOpts`
// tests (TestRunCacheHitSkipsCompute, TestRunNoCacheBypassesReadButWritesThrough,
// TestRunComputeErrorPropagates) — these live in main.go, not cache.go
// (specs/cache.md Mechanism "Scope note"), deferred here per cache.test.ts's
// own header note.
//
// `install_test.go` (G8, installed binary name) is npm-packaging territory
// (migration/TARGET.md's `bin`/`name` split) — deferred to item 6
// (Packaging), not ported here; specs/cli.md's own Open questions already
// flag that this Go test's *intent* carries over, not its mechanism.
//
// Also adds direct tests — this codebase's convention for logic with no
// dedicated Go test (specs/cli.md Open questions: "main(), fatal(),
// gitRoot(), flag parsing, and usage text... are not exercised by either
// test file") — for `parseFlags` (new: hand-rolled in place of Go's `flag`
// package, see main.ts's own file-header note on why not `parseArgs`),
// `fatalMessage` (the documented "prefixes 'meat:' exactly once" Invariant),
// and a regression test for a real bug found during item 6 (Packaging):
// npm's `bin` wiring invokes this file through a symlink, which the naive
// version of the entry-point guard never fired through.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeUTF8, decodeUTF8, trimSpace } from "../../src/meat/bytes.ts";
import { type Result } from "../../src/meat/meat.ts";
import { cacheKey, cacheLoad, cacheStore } from "../../src/cli/cache.ts";
import { formatBody, palette, type Writer } from "../../src/cli/render.ts";
import {
  readDiff,
  isRevRange,
  git,
  run,
  type RunOpts,
  parseFlags,
  fatalMessage,
  usage,
} from "../../src/cli/main.ts";

const noSignal = new AbortController().signal;
const mainModulePath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function runGit(args: readonly string[]): void {
  execFileSync("git", args as string[], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// readDiff/git() operate on process.cwd() with no cwd parameter, exactly
// like Go's exec.Command relying on os.Getwd() unless the test changes it
// (t.Chdir) — this is the direct equivalent, scoped with a restore.
async function withTempRepo<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meat-main-"));
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
  }
}

// Ported from readdiff_test.go's TestReadDiffRevisionArg.
test("readDiff([sha]): summarizes exactly that commit, not HEAD (readdiff_test.go:12-64)", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  await withTempRepo(async (dir) => {
    runGit(["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    runGit(["add", "a.txt"]);
    runGit(["commit", "-q", "-m", "first commit: add a.txt"]);
    const sha = decodeUTF8(trimSpace(git("rev-parse", "HEAD")));

    // A second commit so HEAD != the revision we ask for; confirms the arg
    // is honored rather than defaulting to HEAD.
    writeFileSync(join(dir, "b.txt"), "world\n");
    runGit(["add", "b.txt"]);
    runGit(["commit", "-q", "-m", "second commit: add b.txt"]);

    const { diff, source } = await readDiff([sha], false, false);
    assert.equal(source, sha);
    const text = decodeUTF8(diff);
    assert.ok(text.includes("a.txt") && text.includes("first commit"), `diff does not describe the requested commit:\n${text}`);
    assert.ok(!text.includes("b.txt"), `diff leaked a later commit (b.txt); arg not honored:\n${text}`);
  });
});

// Ported from readdiff_test.go's TestReadDiffRevRange.
test("readDiff([A..B / A...B]): diffs the range, never summarizes a single commit (readdiff_test.go:68-122)", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  await withTempRepo(async (dir) => {
    runGit(["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    runGit(["add", "a.txt"]);
    runGit(["commit", "-q", "-m", "first commit: add a.txt"]);
    const base = decodeUTF8(trimSpace(git("rev-parse", "HEAD")));

    writeFileSync(join(dir, "b.txt"), "world\n");
    runGit(["add", "b.txt"]);
    runGit(["commit", "-q", "-m", "second commit: add b.txt"]);

    for (const rng of [`${base}..HEAD`, `${base}...HEAD`]) {
      const { diff, source } = await readDiff([rng], false, false);
      assert.equal(source, rng);
      const text = decodeUTF8(diff);
      assert.ok(text.includes("b.txt"), `range ${rng} diff missing b.txt:\n${text}`);
      // `git diff` of a range carries no commit metadata; if we'd run
      // `git show` instead, the commit message would leak in.
      assert.ok(!text.includes("second commit"), `range ${rng} produced commit metadata; used 'git show' not 'git diff':\n${text}`);
    }
  });
});

// Ported from readdiff_test.go's TestReadDiffBadRevision.
test("readDiff([unknown revision]): surfaces an error (readdiff_test.go:125-138)", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  await withTempRepo(async () => {
    runGit(["init", "-q"]);
    await assert.rejects(() => readDiff(["deadbeef"], false, false));
  });
});

// Ported from readdiff_test.go's TestReadDiffTooManyArgs: no git-availability
// guard, since this proves the check fires before any subprocess call (G4).
test("readDiff([a, b]): rejects more than one positional argument (readdiff_test.go:141-145)", async () => {
  await assert.rejects(() => readDiff(["a", "b"], false, false));
});

// Ported from readdiff_test.go's TestReadDiffMergeCommit.
//
// readDiff([], false, false) — no args, no flags — falls through to
// stdinIsPiped(): node --test's own fd 0 is neither a character device nor
// a real pipe (an internal socket used by the test runner itself), so this
// specific branch is only safe to exercise in a spawned child with
// controlled stdio, exactly like stdin.test.ts's own tests do for the same
// underlying reason (see that file's header comment). Every other readDiff
// call in this file returns before ever reaching that check, so this is
// the only test that needs the spawn.
test("readDiff on a merge commit: first-parent diff, not the empty plain-'git show' diff (readdiff_test.go:150-197)", (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "meat-main-"));
  const runGitIn = (args: readonly string[]): void => {
    execFileSync("git", args as string[], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
  };
  runGitIn(["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  runGitIn(["add", "a.txt"]);
  runGitIn(["commit", "-q", "-m", "base"]);
  runGitIn(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "feat.txt"), "feature work\n");
  runGitIn(["add", "feat.txt"]);
  runGitIn(["commit", "-q", "-m", "feature commit"]);
  runGitIn(["checkout", "-q", "main"]);
  writeFileSync(join(dir, "main.txt"), "main work\n");
  runGitIn(["add", "main.txt"]);
  runGitIn(["commit", "-q", "-m", "main commit"]);
  runGitIn(["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);

  const probePath = join(dir, "probe.mjs");
  writeFileSync(
    probePath,
    `import { readDiff } from ${JSON.stringify(new URL("../../src/cli/main.ts", import.meta.url).href)};\n` +
      `const { diff, source } = await readDiff([], false, false);\n` +
      `process.stdout.write(JSON.stringify({ diff: Buffer.from(diff).toString("base64"), source }));\n`,
  );
  const result = spawnSync(process.execPath, [probePath], { cwd: dir, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  assert.equal(result.status, 0, `probe failed:\n${result.stderr ?? ""}`);
  const parsed = JSON.parse(result.stdout) as { diff: string; source: string };
  const text = Buffer.from(parsed.diff, "base64").toString("utf8");
  assert.equal(parsed.source, "HEAD");
  assert.ok(text.includes("feat.txt"), `merge commit produced no first-parent diff (feat.txt missing):\n${text}`);
  assert.ok(text.includes("merge feature"), `merge commit metadata missing:\n${text}`);
});

// Ported from readdiff_test.go's TestReadDiffStagedAndWorktree.
test("readDiff(-staged) / readDiff(-w): independently exact (readdiff_test.go:201-249)", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  await withTempRepo(async (dir) => {
    runGit(["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "v1\n");
    runGit(["add", "a.txt"]);
    runGit(["commit", "-q", "-m", "v1"]);

    // Stage one change, then make a further unstaged edit.
    writeFileSync(join(dir, "a.txt"), "v2 staged\n");
    runGit(["add", "a.txt"]);
    writeFileSync(join(dir, "a.txt"), "v3 worktree\n");

    const staged = await readDiff([], true, false);
    const stagedText = decodeUTF8(staged.diff);
    assert.ok(
      stagedText.includes("v2 staged") && !stagedText.includes("v3 worktree"),
      `-staged should show index-vs-HEAD only:\n${stagedText}`,
    );

    const wt = await readDiff([], false, true);
    const wtText = decodeUTF8(wt.diff);
    assert.ok(
      wtText.includes("v3 worktree") && !wtText.includes("-v1"),
      `-w should show worktree-vs-index only:\n${wtText}`,
    );
  });
});

// Ported from readdiff_test.go's TestReadDiffFlagConflicts: no git needed —
// both checks precede any subprocess call (G7).
test("readDiff: rejects nonsensical flag combinations (readdiff_test.go:252-262)", async () => {
  await assert.rejects(() => readDiff([], true, true), "-staged with -w: want error");
  await assert.rejects(() => readDiff(["HEAD"], true, false), "-staged with a revision: want error");
  await assert.rejects(() => readDiff(["HEAD"], false, true), "-w with a revision: want error");
});

// Direct coverage for isRevRange's naive substring check (specs/cli.md Open
// questions: "no boundary test... untested either way" in Go).
describe("isRevRange (cmd/meat/main.go:291-296)", () => {
  test("both range forms match", () => {
    assert.equal(isRevRange("a..b"), true);
    assert.equal(isRevRange("a...b"), true);
  });
  test("a plain revision does not match", () => {
    assert.equal(isRevRange("HEAD~3"), false);
  });
});

// Direct coverage for git()'s own H12 error-formatting (indirectly exercised
// by TestReadDiffBadRevision above too, via readDiff's wrapping).
test("git(): a real exit failure becomes 'git <args>: <stderr>' (cmd/meat/main.go:298-308, H12)", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not found");
    return;
  }
  await withTempRepo(async () => {
    runGit(["init", "-q"]);
    // A short, non-full-hex string: git rejects it as ambiguous/invalid
    // rather than (as it does for a syntactically-valid-looking 40-char
    // hex string, even one naming no real object) silently accepting it.
    assert.throws(() => git("rev-parse", "--verify", "deadbeef"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith("git rev-parse --verify deadbeef: "), err.message);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// run() / runOpts (deferred from cache.test.ts — these live in main.go)
// ---------------------------------------------------------------------------

function newOpts(
  diff: string,
  model: string,
  compute: () => Promise<Result>,
): { opts: RunOpts; calls: { count: number }; out: { text: string } } {
  const calls = { count: 0 };
  const out = { text: "" };
  const w: Writer = { write: (text: string) => void (out.text += text) };
  const opts: RunOpts = {
    diff: encodeUTF8(diff),
    model,
    rubric: "test-rubric",
    cacheDir: mkdtempSync(join(tmpdir(), "meat-run-")),
    noCache: false,
    compute: async () => {
      calls.count++;
      return compute();
    },
    render: (res: Result) => {
      out.text += formatBody(res, "", palette(false));
    },
    stderr: w,
  };
  return { opts, calls, out };
}

// Ported from cache_test.go's TestRunCacheHitSkipsCompute (deferred here).
test("run(): a cache hit never calls compute (cache_test.go:117-152)", async () => {
  const diff = "diff --git a/x b/x\n+new\n";
  const model = "m";
  const fresh: Result = { smartDiff: encodeUTF8("+new (kept)\n"), summary: "computed", inputTokens: 7, outputTokens: 3 };
  const { opts, calls, out } = newOpts(diff, model, async () => fresh);

  // First run: miss -> compute once -> store.
  await run(noSignal, opts);
  assert.equal(calls.count, 1, "first run: compute should be called once");
  assert.ok(out.text.includes("tokens in=7 out=3 in "), `fresh run should report tokens and elapsed time:\n${out.text}`);

  // Second run with compute that would FAIL if called: proves the hit path
  // never touches it.
  const opts2: RunOpts = {
    ...opts,
    compute: async () => {
      calls.count++;
      throw new Error("compute must not be called on a cache hit");
    },
  };
  out.text = "";
  await run(noSignal, opts2);
  assert.equal(calls.count, 1, "second run should not have called compute");
  assert.ok(out.text.includes("computed"), `cached summary not printed:\n${out.text}`);
  assert.ok(out.text.includes("meat: cached"), `expected cache-hit notice:\n${out.text}`);
});

// Ported from cache_test.go's TestRunNoCacheBypassesReadButWritesThrough.
test("run(): -no-cache recomputes even with a stale entry, and refreshes it (cache_test.go:156-178)", async () => {
  const diff = "d";
  const model = "m";
  const fresh: Result = { smartDiff: new Uint8Array(0), summary: "fresh", inputTokens: 0, outputTokens: 0 };
  const { opts, calls, out } = newOpts(diff, model, async () => fresh);

  // Pre-seed a stale entry.
  await cacheStore(opts.cacheDir, cacheKey(diff, model, opts.rubric), {
    smartDiff: new Uint8Array(0),
    summary: "stale",
    inputTokens: 0,
    outputTokens: 0,
  });

  const opts2: RunOpts = { ...opts, noCache: true };
  await run(noSignal, opts2);
  assert.equal(calls.count, 1, "-no-cache should recompute");
  assert.ok(!out.text.includes("stale") && out.text.includes("fresh"), `-no-cache served stale result:\n${out.text}`);

  const got = await cacheLoad(opts.cacheDir, cacheKey(diff, model, opts.rubric));
  assert.ok(got !== null && got.summary === "fresh", `cache not refreshed after -no-cache run: ${JSON.stringify(got)}`);
});

// Ported from cache_test.go's TestRunComputeErrorPropagates.
test("run(): a compute failure surfaces and does not populate the cache (cache_test.go:182-190)", async () => {
  const { opts } = newOpts("d", "m", async () => {
    throw new Error("llm down");
  });
  await assert.rejects(() => run(noSignal, opts), /llm down/);
  const got = await cacheLoad(opts.cacheDir, cacheKey("d", "m", opts.rubric));
  assert.equal(got, null, "failed compute should not populate the cache");
});

// ---------------------------------------------------------------------------
// parseFlags — new code, no Go test (specs/cli.md Open questions)
// ---------------------------------------------------------------------------

describe("parseFlags (cmd/meat/main.go:88-103, hand-rolled per Go's flag package)", () => {
  test("both single- and double-dash spellings work for every flag", () => {
    for (const spelling of ["-json", "--json"]) {
      const r = parseFlags([spelling]);
      assert.equal(r.kind, "ok");
      assert.ok(r.kind === "ok" && r.flags.jsonOut);
    }
  });

  test("-model=x and -model x both set the model", () => {
    const r1 = parseFlags(["-model=gpt-5.6-sol"]);
    assert.ok(r1.kind === "ok" && r1.flags.model === "gpt-5.6-sol");
    const r2 = parseFlags(["-model", "gpt-5.6-sol"]);
    assert.ok(r2.kind === "ok" && r2.flags.model === "gpt-5.6-sol");
  });

  test("a bare bool flag never consumes the next argument", () => {
    const r = parseFlags(["-staged", "HEAD~3"]);
    assert.ok(r.kind === "ok" && r.flags.staged && r.flags.positional.length === 1 && r.flags.positional[0] === "HEAD~3");
  });

  test("parsing stops at the first non-flag argument, even if what follows looks like a flag", () => {
    // Load-bearing for git-shaped positionals: `meat HEAD~3 -staged` treats
    // "-staged" as a SECOND positional, not a flag.
    const r = parseFlags(["HEAD~3", "-staged"]);
    assert.ok(r.kind === "ok");
    assert.deepEqual(r.kind === "ok" ? r.flags.positional : null, ["HEAD~3", "-staged"]);
    assert.ok(r.kind === "ok" && !r.flags.staged);
  });

  test("'--' terminates flag scanning and is itself dropped", () => {
    const r = parseFlags(["--", "-staged"]);
    assert.ok(r.kind === "ok");
    assert.deepEqual(r.kind === "ok" ? r.flags.positional : null, ["-staged"]);
  });

  test("an unknown flag is a parse error", () => {
    const r = parseFlags(["-bogus"]);
    assert.equal(r.kind, "error");
    assert.ok(r.kind === "error" && r.message.includes("flag provided but not defined: -bogus"), r.kind === "error" ? r.message : "");
  });

  test("-h, -help, and --help all request help without being registered", () => {
    for (const spelling of ["-h", "-help", "--help"]) {
      assert.equal(parseFlags([spelling]).kind, "help");
    }
  });

  test("a string flag missing its value is a parse error", () => {
    const r = parseFlags(["-model"]);
    assert.equal(r.kind, "error");
    assert.ok(r.kind === "error" && r.message.includes("flag needs an argument: -model"));
  });

  test("multiple flags combine", () => {
    const r = parseFlags(["-staged", "-json", "-model=x"]);
    assert.ok(r.kind === "ok" && r.flags.staged && r.flags.jsonOut && r.flags.model === "x" && r.flags.positional.length === 0);
  });

  test("-look is a bool flag and defaults to false", () => {
    const off = parseFlags([]);
    assert.ok(off.kind === "ok" && off.flags.look === false);
    const on = parseFlags(["-look"]);
    assert.ok(on.kind === "ok" && on.flags.look === true);
    const withSource = parseFlags(["-look", "-staged"]);
    assert.ok(withSource.kind === "ok" && withSource.flags.look && withSource.flags.staged);
  });
});

// ---------------------------------------------------------------------------
// fatalMessage — the "prefixes 'meat:' exactly once" Invariant
// ---------------------------------------------------------------------------

describe("fatalMessage (cmd/meat/main.go:319-325, Invariants)", () => {
  test("prepends 'meat: ' when absent", () => {
    assert.equal(fatalMessage("no diff to read (HEAD)"), "meat: no diff to read (HEAD)");
  });
  test("does not double-prefix an already-prefixed message", () => {
    assert.equal(fatalMessage("meat: something from Abridge"), "meat: something from Abridge");
  });
});

test("usage text is non-empty and documents every flag", () => {
  for (const flag of ["-model", "-no-cache", "-staged", "-w", "-json", "-look"]) {
    assert.ok(usage.includes(flag), `usage text missing ${flag}`);
  }
});

test("usage text documents xAI/Grok credentials", () => {
  assert.ok(usage.includes("XAI_API_KEY"), "usage text missing XAI_API_KEY");
  assert.ok(usage.includes("XAI_BASE_URL"), "usage text missing XAI_BASE_URL");
  assert.ok(usage.includes("grok-"), "usage text missing grok- model-id hint");
  assert.ok(usage.includes("https://api.x.ai/v1"), "usage text missing default xAI base URL");
});

// Regression test: found while verifying item 6 (Packaging)'s "bin wiring"
// checklist item against a real `npm install --global` of a packed
// tarball. npm's bin wiring invokes this file through a symlink (e.g.
// `bin/meat -> lib/node_modules/meat/dist/cli/main.js`); Node resolves
// `import.meta.url` to the real, symlink-followed path but leaves
// `process.argv[1]` as the path actually invoked (the symlink), so a naive
// `fileURLToPath(import.meta.url) === process.argv[1]` check silently
// never fires main() through a bin symlink — the process would exit 0
// having done nothing at all, no error, no output. This test reproduces
// that exact shape without needing a real npm install.
test("main() runs when invoked through a symlink, matching npm's bin wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "meat-mainmod-"));
  const link = join(dir, "meat-bin");
  symlinkSync(mainModulePath, link);
  const result = spawnSync(process.execPath, [link, "-h"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("Usage:"), `expected usage text on stderr, got:\n${JSON.stringify(result.stderr)}`);
});

test("CLI -h (the real main() entry) documents XAI_API_KEY and Grok", () => {
  const result = spawnSync(process.execPath, [mainModulePath, "-h"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("XAI_API_KEY"), `expected XAI_API_KEY in -h output, got:\n${JSON.stringify(result.stderr)}`);
  assert.ok(result.stderr.includes("XAI_BASE_URL"), `expected XAI_BASE_URL in -h output, got:\n${JSON.stringify(result.stderr)}`);
  assert.ok(result.stderr.includes("https://api.x.ai/v1"), `expected api.x.ai default in -h output, got:\n${JSON.stringify(result.stderr)}`);
});
