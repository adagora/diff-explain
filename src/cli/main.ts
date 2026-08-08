#!/usr/bin/env node
// main.ts (cmd/meat/main.go): the only orchestrator in the CLI package. It
// parses flags, resolves *which* diff to read (`readDiff`), decides
// interactivity, and wires together three externally-defined subsystems it
// does not implement — cache (`cache.ts`), rendering (`render.ts`), and the
// engine (`../meat/meat.ts` and friends). `stdin.ts` is a leaf utility this
// file consumes.
//
// H1: the two raw-byte-reinterpretation boundaries where OS output becomes
// the `diff` value — `git()`'s captured stdout and `readAllStdin`'s stdin
// read — stay `Uint8Array` all the way through this file. `diff` is never
// decoded to a string except at the one place that specifically needs one:
// `run()`'s `cacheKey` call (`cache.ts`'s own established signature, item
// 5b — not revisited here). `Abridge`'s `Request.unifiedDiff` and
// `ElisionLine`'s `raw` parameter both take the same bytes directly, with
// no decode/re-encode round trip.
//
// H11: `isTerminal` (imported from `render.ts`) is reused directly here for
// the interactivity check gating progress-line updates, exactly as
// `render.md`'s Responsibility boundary describes for Go's `main.go:117`.
//
// H12: `git()` is this file's own instance of the `exec.Command(...)
// .Output()` pattern (captures stdout, extracts stderr into the error
// message on a real exit failure) — a separate implementation from
// `render.ts`'s subprocess calls, matching how Go's `main.go` and
// `render.go` each define their own `git`-invoking helpers rather than
// sharing one.
//
// H14: two independent empty-diff checks exist in the real Go source at
// different layers — `meat.Abridge`'s own (`meat/meat.go:119`, already
// ported) and this file's CLI-side `strings.TrimSpace(diff) == ""` before
// ever calling into the engine (`cmd/meat/main.go:109`). Both — and
// `git()`'s stderr trim — use `bytes.ts`'s Go-matching `trimSpace`, never
// `.trim()`.
//
// Flag parsing (`parseFlags`) is hand-rolled rather than `node:util`'s
// `parseArgs` (`migration/TARGET.md`'s "flag -> parseArgs" mapping note):
// Go's `flag` package stops scanning at the first non-flag argument —
// load-bearing for this CLI's git-shaped positionals (`HEAD~3`, `a..b`,
// `main...HEAD`) — which `parseArgs`'s interleaved-positionals default does
// not reproduce. No Go test exercises flag parsing at all
// (specs/cli.md Open questions), so this is new coverage, not a port.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arrayAt, trimSpace, encodeUTF8, decodeUTF8 } from "../meat/bytes.ts";
import { type Request, type Result, Abridge } from "../meat/meat.ts";
import { ResolveModel, NewModelFromEnv } from "../meat/provider.ts";
import { RubricHash } from "../meat/rubric.ts";
import { ElisionLine } from "../meat/elision.ts";
import { isTerminal, renderResult, renderJSON, type Writer } from "./render.ts";
import { cacheDir, cacheKey, cacheLoad, cacheStore } from "./cache.ts";
import { stdinIsPiped, readAllStdin } from "./stdin.ts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function goTrimSpaceString(s: string): string {
  return decodeUTF8(trimSpace(encodeUTF8(s)));
}

// Go's `usage` constant (`cmd/meat/main.go:44-86`), reproduced verbatim —
// untested by any Go test (specs/cli.md Open questions), kept byte-for-byte
// anyway since it is literal copy the user reads.
export const usage = `meat — abridge a diff into a "reading diff"

Usage:
  meat                 Summarize the most recent commit (HEAD) in the current git repo.
  meat <revision>      Summarize a specific commit or revision (e.g. a sha, HEAD~3).
  meat <range>         Diff across a commit range (e.g. sha1..sha2, main...HEAD).
  meat -staged         Abridge the staged (index) changes: git diff --staged.
  meat -w              Abridge the unstaged working-tree changes: git diff.
  git show <sha> | meat   Abridge the diff piped on stdin.
  git diff | meat         Abridge the working-tree diff piped on stdin.

meat reads a unified diff (from stdin, from a named revision or range, or HEAD
when stdin is a terminal), asks an LLM to drop everything not worth reading, and
prints the abridged diff plus a one-line summary.

Results are cached under ~/.meat keyed by the SHA of (rubric/compiler protocol +
model + diff contents), so re-running on an unchanged diff is instant; editing
the diff, switching models, or upgrading meat's rubric or compiler invariants
recomputes.

On an interactive terminal the diff is colored and paged like git show (using
your git pager and color.diff config); piped/redirected output stays plain.

Flags:
  -model string   Model to use (default $MEAT_MODEL or a built-in default).
  -no-cache       Ignore any cached result and recompute (still updates cache).
  -staged         Read the staged changes (git diff --staged).
  -w              Read the unstaged working-tree changes (git diff).
  -json           Emit the result as JSON on stdout (no color, no pager).
  -h, --help      Show this help.

Environment:
  OPENAI_API_KEY       API key for OpenAI models (including the default).
  OPENAI_BASE_URL      Optional. Override the OpenAI API base URL.
  ANTHROPIC_API_KEY    API key for Claude models.
  ANTHROPIC_BASE_URL   Optional. Override the Anthropic API base URL.
  MEAT_MODEL           Optional. Default model id.
  MEAT_CACHE           Optional. Cache directory (default ~/.meat; empty disables).

On an exe.dev VM with an attached "llm" integration, meat uses the managed
LLM gateway automatically — no API key needed. Provider-specific API keys or
base URLs override the gateway.
`;

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export interface ParsedFlags {
  readonly model: string;
  readonly noCache: boolean;
  readonly staged: boolean;
  readonly worktree: boolean;
  readonly jsonOut: boolean;
  readonly positional: readonly string[];
}

export type ParseFlagsResult =
  | { readonly kind: "ok"; readonly flags: ParsedFlags }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

// Go's `strconv.ParseBool`'s accepted literal set, used by a bool flag's
// explicit `-flag=value` form.
const BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False"]);

function parseGoBool(value: string): boolean | null {
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  return null;
}

/**
 * Go's `flag` package parsing algorithm (`flag.go`'s `parseOne`),
 * reproduced by hand — see the file header's note on why not `parseArgs`.
 * Registers the same five flags `cmd/meat/main.go:92-96` does: `-model`
 * (string), `-no-cache`/`-staged`/`-w`/`-json` (bool). `-h`/`-help` are
 * recognized without being registered, matching Go's special case
 * (`flag.go`: an undefined `help`/`h` name triggers usage, not an error).
 */
export function parseFlags(argv: readonly string[]): ParseFlagsResult {
  let model = "";
  let noCache = false;
  let staged = false;
  let worktree = false;
  let jsonOut = false;
  let i = 0;

  while (i < argv.length) {
    const s = arrayAt(argv, i);
    if (s.length < 2 || !s.startsWith("-")) {
      break; // not a flag: stop, everything from here on is positional
    }
    let numMinuses = 1;
    if (s.charAt(1) === "-") {
      numMinuses = 2;
      if (s.length === 2) {
        i++; // "--" terminates flag scanning
        break;
      }
    }
    let name = s.slice(numMinuses);
    if (name === "" || name.startsWith("-") || name.startsWith("=")) {
      return { kind: "error", message: `bad flag syntax: ${s}` };
    }
    i++;

    let value = "";
    let hasValue = false;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      hasValue = true;
      name = name.slice(0, eq);
    }

    const isBoolFlag = name === "no-cache" || name === "staged" || name === "w" || name === "json";
    if (!isBoolFlag && name !== "model") {
      if (name === "help" || name === "h") {
        return { kind: "help" };
      }
      return { kind: "error", message: `flag provided but not defined: -${name}` };
    }

    if (isBoolFlag) {
      let boolVal: boolean;
      if (hasValue) {
        const parsed = parseGoBool(value);
        if (parsed === null) {
          return {
            kind: "error",
            message: `invalid boolean value ${JSON.stringify(value)} for -${name}: parse error`,
          };
        }
        boolVal = parsed;
      } else {
        boolVal = true; // bare -flag never consumes the next argument
      }
      if (name === "no-cache") noCache = boolVal;
      else if (name === "staged") staged = boolVal;
      else if (name === "w") worktree = boolVal;
      else jsonOut = boolVal;
      continue;
    }

    // name === "model": a string flag, needs a value — "-model=x" already
    // supplied one above; otherwise the *next* argument is consumed.
    if (!hasValue && i < argv.length) {
      value = arrayAt(argv, i);
      i++;
      hasValue = true;
    }
    if (!hasValue) {
      return { kind: "error", message: `flag needs an argument: -${name}` };
    }
    model = value;
  }

  return { kind: "ok", flags: { model, noCache, staged, worktree, jsonOut, positional: argv.slice(i) } };
}

// ---------------------------------------------------------------------------
// git subprocess wrapping (H12) and diff-source resolution
// ---------------------------------------------------------------------------

type ExecSyncError = Error & { readonly status?: number | null; readonly stderr?: Buffer };

/**
 * Go's `git` (`cmd/meat/main.go:298-308`, H12). Captures only stdout, as
 * bytes (H1) — never decoded here. A real (non-zero) exit becomes
 * `"git <args>: <stderr>"`, stderr Go-trimmed (H14). Any other failure
 * (e.g. git missing from `PATH`) propagates unwrapped, with no
 * meat-authored message text, matching Go's fallthrough exactly. Exported
 * because `readdiff_test.go` itself calls this directly (same-package
 * access in Go) to fetch a SHA for its own test setup.
 */
export function git(...args: readonly string[]): Uint8Array {
  try {
    const out = execFileSync("git", args as string[]);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (err) {
    const e = err as ExecSyncError;
    if (typeof e.status === "number") {
      const stderr = e.stderr instanceof Buffer ? decodeUTF8(new Uint8Array(e.stderr)) : "";
      throw new Error(`git ${args.join(" ")}: ${goTrimSpaceString(stderr)}`);
    }
    throw err;
  }
}

/**
 * Go's `gitShow` (`cmd/meat/main.go:283-289`). Plain `git show` on a merge
 * commit emits no diff at all; `-m --first-parent` forces the single "what
 * did merging this branch change on main" diff (G5); `--format=fuller`
 * carries the commit-message text a single-revision summary needs (G1).
 */
function gitShow(rev: string): Uint8Array {
  return git("show", "--format=fuller", "-m", "--first-parent", rev);
}

/**
 * Go's `isRevRange` (`cmd/meat/main.go:291-296`): a pure substring test, no
 * further validation — fires identically for both `A..B` and `A...B` since
 * the three-dot form contains the two-dot substring.
 */
export function isRevRange(rev: string): boolean {
  return rev.includes("..");
}

/**
 * Go's `gitRoot` (`cmd/meat/main.go:310-317`): `""` (not a repo, or git
 * missing — indistinguishable) on any error; success is Go-trimmed to drop
 * git's trailing newline.
 */
function gitRoot(): string {
  try {
    return decodeUTF8(trimSpace(git("rev-parse", "--show-toplevel")));
  } catch {
    return "";
  }
}

export interface DiffSource {
  readonly diff: Uint8Array;
  readonly source: string;
}

/**
 * Go's `readDiff` (`cmd/meat/main.go:227-281`, G1-G7): a strict,
 * non-backtracking sequence — each branch either returns or falls through
 * to the next. Throws (rather than Go's third `error` return value) on
 * failure; every Go caller only reads `source` on the success path anyway
 * (`main()`'s `err != nil` branch never does), so dropping it from the
 * error path is behavior-equivalent. `diff` is `Uint8Array` throughout
 * (H1) — the stdin branch already gets bytes from `readAllStdin` (item
 * 5a); the git branches get bytes from `git()` above; neither is decoded.
 */
export async function readDiff(args: readonly string[], staged: boolean, worktree: boolean): Promise<DiffSource> {
  if (staged && worktree) {
    throw new Error("-staged and -w are mutually exclusive");
  }
  if ((staged || worktree) && args.length > 0) {
    throw new Error("-staged/-w cannot be combined with a revision argument");
  }
  if (staged) {
    try {
      return { diff: git("diff", "--staged"), source: "staged; nothing staged?" };
    } catch (err) {
      throw new Error(`reading staged changes: ${errorMessage(err)}`);
    }
  }
  if (worktree) {
    try {
      return { diff: git("diff"), source: "worktree; no unstaged changes?" };
    } catch (err) {
      throw new Error(`reading working-tree changes: ${errorMessage(err)}`);
    }
  }
  if (args.length > 1) {
    throw new Error(`too many arguments: want at most one revision, got ${args.length}`);
  }
  if (args.length === 1) {
    const rev = arrayAt(args, 0);
    // A range (A..B or A...B) is a diff across commits; a single revision
    // is one commit. `git show` on a range emits per-commit output, not
    // the single aggregate diff we want, so dispatch ranges to `git diff`.
    try {
      const diff = isRevRange(rev) ? git("diff", rev) : gitShow(rev);
      return { diff, source: rev };
    } catch (err) {
      throw new Error(`reading ${JSON.stringify(rev)}: ${errorMessage(err)}`);
    }
  }
  if (stdinIsPiped()) {
    // Not wrapped: readAllStdin's error propagates verbatim, unlike every
    // other branch here (specs/cli.md Errors section).
    const diff = await readAllStdin();
    return { diff, source: "stdin" };
  }
  // No pipe and no revision: summarize the top commit.
  try {
    return { diff: gitShow("HEAD"), source: "HEAD" };
  } catch (err) {
    throw new Error(`reading HEAD (are you in a git repo?): ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// run() — cache-aware orchestration
// ---------------------------------------------------------------------------

/**
 * Go's `runOpts` (`cmd/meat/main.go:178-190`). Carries closures rather than
 * raw dependencies (git, LLM credentials) specifically so `run` is
 * testable without either. `diff` is `Uint8Array` (H1); `stderr` reuses
 * `render.ts`'s `Writer` — `process.stderr` satisfies it once adapted the
 * same way `main()` adapts `process.stdout` for `renderResult`.
 */
export interface RunOpts {
  readonly diff: Uint8Array;
  readonly model: string; // already resolved (post $MEAT_MODEL/default)
  readonly rubric: string; // rubric hash, part of the cache key
  readonly cacheDir: string;
  readonly noCache: boolean;
  readonly compute: (signal: AbortSignal) => Promise<Result>;
  readonly render: (res: Result) => void;
  readonly stderr: Writer;
}

/**
 * Go's `time.Duration.String()`, restricted to the non-negative,
 * 100ms-granularity domain `run()` actually produces (`.Round(100ms)`
 * always precedes formatting) — user-facing text with no Go test pinning
 * it (specs/cli.md Open questions), so exact fidelity outside that domain
 * is not attempted (no ns/µs precision, no negative durations).
 */
function formatElapsed(totalMs: number): string {
  if (totalMs === 0) return "0s";
  if (totalMs < 1000) return `${totalMs}ms`;
  const hours = Math.floor(totalMs / 3_600_000);
  let rem = totalMs - hours * 3_600_000;
  const minutes = Math.floor(rem / 60_000);
  rem -= minutes * 60_000;
  const wholeSeconds = Math.floor(rem / 1000);
  const deciseconds = (rem % 1000) / 100;
  const secondsStr = deciseconds === 0 ? `${wholeSeconds}` : `${wholeSeconds}.${deciseconds}`;
  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  out += `${secondsStr}s`;
  return out;
}

/**
 * Go's `run` (`cmd/meat/main.go:196-218`): look up by SHA of (model +
 * diff); on a hit, render and return without ever calling `o.compute` (so
 * cache hits are instant and need no credentials, `cache.md` G6); on a
 * miss, compute, store, then render. `-no-cache` skips the read but still
 * writes through (`cache.md` G7/G8). `cacheKey` decodes `o.diff` to a
 * string only here — `cache.ts`'s own already-shipped signature (item 5b),
 * not revisited by this item.
 */
export async function run(signal: AbortSignal, o: RunOpts): Promise<void> {
  const key = cacheKey(decodeUTF8(o.diff), o.model, o.rubric);
  if (!o.noCache) {
    const cached = await cacheLoad(o.cacheDir, key);
    if (cached !== null) {
      o.render(cached);
      o.stderr.write(`\nmeat: cached (sha ${key.slice(0, 12)})\n`);
      return;
    }
  }

  const start = Date.now();
  const res = await o.compute(signal);
  const elapsed = Math.round((Date.now() - start) / 100) * 100;

  await cacheStore(o.cacheDir, key, res);

  o.render(res);
  o.stderr.write(`\nmeat: tokens in=${res.inputTokens} out=${res.outputTokens} in ${formatElapsed(elapsed)}\n`);
}

// ---------------------------------------------------------------------------
// fatal() and main()
// ---------------------------------------------------------------------------

/**
 * Go's `fatal`'s message-prefixing rule (`cmd/meat/main.go:319-325`,
 * Invariants: "prefixes 'meat:' exactly once"): `meat.Abridge`'s own
 * errors are sometimes already `"meat: ..."`-prefixed, so this checks
 * before prepending rather than always prepending. Split out from `fatal`
 * itself so this rule is directly testable without invoking
 * `process.exit`.
 */
export function fatalMessage(msg: string): string {
  return msg.startsWith("meat:") ? msg : `meat: ${msg}`;
}

function fatal(msg: string): never {
  process.stderr.write(`${fatalMessage(msg)}\n`);
  process.exit(1);
}

function processWriter(stream: { readonly fd: number; write(text: string): boolean }): Writer {
  return { fd: stream.fd, write: (text) => void stream.write(text) };
}

/**
 * Go's `main` (`cmd/meat/main.go:88-173`). Exit codes: `0` for `-h`/
 * `--help`, `2` for a flag-parsing error, `1` for every other runtime
 * failure via `fatal` — Go's three-way convention (Invariants).
 */
export async function main(): Promise<void> {
  const parsed = parseFlags(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stderr.write(usage);
    process.exit(0);
  }
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n${usage}`);
    process.exit(2);
  }
  const { model: modelFlag, noCache, staged, worktree, jsonOut, positional } = parsed.flags;

  let diff: Uint8Array;
  let source: string;
  try {
    ({ diff, source } = await readDiff(positional, staged, worktree));
  } catch (err) {
    fatal(errorMessage(err));
  }
  if (trimSpace(diff).length === 0) {
    fatal(`no diff to read (${source})`);
  }

  // Progress feedback is strictly interactive: only when BOTH stdout and
  // stderr are terminals (so `meat > file` and `meat 2> log` stay clean),
  // and never in -json mode.
  let progress: (msg: string) => void = () => {};
  const interactive = !jsonOut && isTerminal(processWriter(process.stdout)) && isTerminal(processWriter(process.stderr));
  if (interactive) {
    progress = (msg: string) => {
      process.stderr.write(`\r\x1b[Kmeat: ${msg}`);
    };
  }

  // compute produces a fresh result on a cache miss. It is a closure so
  // run() can be unit-tested without an LLM: the real path constructs the
  // selected provider model (which needs credentials/network) only here,
  // AFTER the cache check.
  const compute = async (signal: AbortSignal): Promise<Result> => {
    const model = await NewModelFromEnv(signal, modelFlag);
    // Confine the read-only tools to the repo root, when we're in one, so
    // the agent can inspect surrounding source for clues.
    const req: Request = { repoRoot: gitRoot(), unifiedDiff: diff, progress };
    return Abridge(signal, model, req);
  };

  const render = (res: Result): void => {
    if (interactive) {
      process.stderr.write("\r\x1b[K"); // clear the progress line
    }
    const elision = ElisionLine(diff, res.smartDiff);
    if (jsonOut) {
      process.stdout.write(renderJSON(res, elision));
      return;
    }
    // On an interactive terminal, render like `git show`: git's diff
    // colors and git's pager. Otherwise (piped/redirected) print plain.
    renderResult(processWriter(process.stdout), res, elision);
  };

  const opts: RunOpts = {
    diff,
    model: ResolveModel(modelFlag),
    rubric: RubricHash(),
    cacheDir: cacheDir(),
    noCache,
    compute,
    render,
    stderr: processWriter(process.stderr),
  };
  try {
    await run(new AbortController().signal, opts);
  } catch (err) {
    if (interactive) {
      process.stderr.write("\r\x1b[K");
    }
    fatal(errorMessage(err));
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  // npm's `bin` wiring invokes this file through a symlink (e.g.
  // `.../bin/meat -> .../dist/cli/main.js`); Node resolves `import.meta.url`
  // to the real, symlink-followed path, but leaves `process.argv[1]` as the
  // path actually invoked (the symlink itself) — realpath both sides before
  // comparing, or this guard silently never fires under `npx`/an installed
  // `bin`, only under a direct `node dist/cli/main.js` invocation.
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    process.stderr.write(`meat: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
