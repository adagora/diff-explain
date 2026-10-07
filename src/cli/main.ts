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
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arrayAt, trimSpace, encodeUTF8, decodeUTF8 } from "../meat/bytes.ts";
import { type Request, type Result, Abridge } from "../meat/meat.ts";
import { ResolveModel, NewModelFromEnv } from "../meat/provider.ts";
import { RubricHash } from "../meat/rubric.ts";
import { ElisionLine } from "../meat/elision.ts";
import { isTerminal, renderResult, renderJSON, palette, gitWantsColor, type Writer } from "./render.ts";
import { cacheDir, cacheKey, cacheLoad, cacheStore } from "./cache.ts";
import { stdinIsPiped, readAllStdin } from "./stdin.ts";
import { formatDiffLook } from "./shape.ts";
import { formatReviewPrompt } from "./prompt.ts";
import { reviewWithAgent } from "./agent.ts";
import { collectSnapshot, SnapshotError, maxGitOutputBytes } from "./snapshot.ts";
import { observeHelp, observeSnapshot, inventoryArtifact, evidenceArtifact, planningArtifact, capabilityArtifact, type ObserveOperation } from "./observe.ts";
import { doctorReport } from "./doctor.ts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function goTrimSpaceString(s: string): string {
  return decodeUTF8(trimSpace(encodeUTF8(s)));
}

// Go's `usage` constant (`cmd/meat/main.go:44-86`) behind a TypeScript-only
// "Start here" section that leads with the workflows needing no API key.
// The Go wording is otherwise kept as the user-facing copy.
export const usage = `meat — review a code change from its git diff

Usage: meat [flags] [change]

Start here (no API key needed):
  meat -doctor                Check which review workflows work on this machine.
  meat -look HEAD             Show the change's shape, size, and full diff.
  meat -prompt HEAD           Print a review packet for the agent session you already use.
  meat -prompt -o review.md HEAD
                              Save the packet as exact UTF-8 (safe in PowerShell too).
  meat -agent codex HEAD      Fresh review with your Codex subscription (or -agent claude).
  In Claude Code type /meat HEAD; in Codex type $meat explain HEAD.

Choose the change. Flags always go before it:
  HEAD, a sha, HEAD~3         One commit.
  main...HEAD, A..B           A range, e.g. your branch since it left main.
  -staged, -w                 Staged changes, or unstaged changes to tracked files.
  git diff | meat -prompt     A piped unified diff.

Abridge with an API model (the default when no workflow flag is given):
  meat                 Summarize the most recent commit (HEAD) in the current git repo.
  meat <revision>      Summarize a specific commit or revision (e.g. a sha, HEAD~3).
  meat <range>         Diff across a commit range (e.g. sha1..sha2, main...HEAD).
  meat -staged         Abridge the staged (index) changes: git diff --staged.
  meat -w              Abridge the unstaged working-tree changes: git diff.
  git show <sha> | meat   Abridge the diff piped on stdin.
  git diff | meat         Abridge the working-tree diff piped on stdin.
  meat -look              Look at the diff's shape, color, and length (no model).
  git diff | meat -look   Same, from a piped unified diff.

meat reads a unified diff (from stdin, from a named revision or range, or HEAD
when stdin is a terminal), asks an LLM to drop everything not worth reading, and
prints the abridged diff plus a one-line summary.

-look skips the model: it prints the spatial add/remove/context shape, an
explicit length (+added -deleted ~context), and the unified-diff text itself.
Use the same diff sources as abridge (stdin, revision, range, -staged, -w).

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
  -look           Print shape, color, and length of the diff, then the unified-diff text. No model, no API key.
  -prompt         Export a Markdown review packet for your existing agent. No model, no API key.
  -agent string   Run a subscription CLI review: codex or claude (no meat API call).
  -verbose        With -agent, stream the agent's own log instead of hiding it.
  -o file         Write the output to file as exact UTF-8 instead of stdout.
  -doctor         Check which workflows work here. No model call; probes agent login status.
${observeHelp}\
  -h, --help      Show this help.

Environment:
  OPENAI_API_KEY       API key for OpenAI models (including the default).
  OPENAI_BASE_URL      Optional. Override the OpenAI API base URL.
  ANTHROPIC_API_KEY    API key for Claude models.
  ANTHROPIC_BASE_URL   Optional. Override the Anthropic API base URL.
  XAI_API_KEY          API key for Grok models (ids starting with grok-).
  XAI_BASE_URL         Optional. Override the xAI API base URL (default https://api.x.ai/v1).
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
  readonly look: boolean;
  readonly prompt: boolean;
  readonly agent: string;
  readonly verbose: boolean;
  readonly output: string;
  readonly doctor: boolean;
  readonly operation: ObserveOperation | "";
  readonly evidence: string;
  readonly pageSize: number;
  readonly maxBytes: number;
  readonly cursor: string;
  readonly snapshot: string;
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
 * Registers the Go flags `cmd/meat/main.go:92-96` (`-model` string,
 * `-no-cache`/`-staged`/`-w`/`-json` bool) plus TypeScript-only `-look`
 * (bool, no-model shape/color/length view). `-h`/`-help` are recognized
 * without being registered, matching Go's special case (`flag.go`: an
 * undefined `help`/`h` name triggers usage, not an error).
 */
export function parseFlags(argv: readonly string[]): ParseFlagsResult {
  let model = "";
  let noCache = false;
  let staged = false;
  let worktree = false;
  let jsonOut = false;
  let look = false;
  let prompt = false;
  let agent = "";
  let verbose = false;
  let output = "";
  let doctor = false;
  let operation: ObserveOperation | "" = "";
  let evidence = "";
  let pageSize = 20;
  let maxBytes = 8192;
  let cursor = "";
  let snapshot = "";
  let pageOption = false;
  let byteOption = false;
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

    const observeBool = name === "inventory" || name === "plan" || name === "capabilities";
    const observeString = name === "evidence" || name === "page-size" || name === "max-bytes" || name === "cursor" || name === "snapshot";
    const isBoolFlag = name === "no-cache" || name === "staged" || name === "w" || name === "json" || name === "look" || name === "prompt" ||
      name === "verbose" || name === "doctor" || observeBool;
    if (!isBoolFlag && !observeString && name !== "model" && name !== "agent" && name !== "o") {
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
      if (observeBool) {
        if (boolVal && operation !== "" && operation !== name) return { kind: "error", message: "Choose only one offline observation operation" };
        if (boolVal) operation = name as ObserveOperation;
        else if (operation === name) operation = "";
      }
      else if (name === "no-cache") noCache = boolVal;
      else if (name === "staged") staged = boolVal;
      else if (name === "w") worktree = boolVal;
      else if (name === "look") look = boolVal;
      else if (name === "prompt") prompt = boolVal;
      else if (name === "verbose") verbose = boolVal;
      else if (name === "doctor") doctor = boolVal;
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
    if (name === "agent" && value === "") {
      return { kind: "error", message: "-agent requires codex or claude" };
    }
    if (name === "o") {
      if (value === "") return { kind: "error", message: "-o requires a file path" };
      output = value;
      continue;
    }
    if (name === "evidence") {
      if (value === "" || value.length > 128) return { kind: "error", message: "-evidence requires an inventory entry id" };
      if (operation !== "" && operation !== "evidence") return { kind: "error", message: "Choose only one offline observation operation" };
      operation = "evidence"; evidence = value;
    } else if (name === "page-size" || name === "max-bytes") {
      const number = Number(value);
      const max = name === "page-size" ? 100 : 16384;
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) return { kind: "error", message: `-${name} must be an integer from 1 to ${max}` };
      if (name === "page-size") { pageSize = number; pageOption = true; }
      else { maxBytes = number; byteOption = true; }
    } else if (name === "cursor") {
      if (value === "" || value.length > 2048) return { kind: "error", message: "-cursor requires a bounded continuation token" };
      cursor = value;
    } else if (name === "snapshot") {
      if (!/^[0-9a-f]{64}$/.test(value)) return { kind: "error", message: "-snapshot requires a SHA-256 snapshot id" };
      snapshot = value;
    } else if (name === "agent") agent = value;
    else model = value;
  }

  if (doctor && (model !== "" || noCache || staged || worktree || jsonOut || look || prompt || agent !== "" || verbose ||
    output !== "" || operation !== "" || pageOption || byteOption || cursor !== "" || snapshot !== "" || argv.slice(i).length > 0)) {
    return { kind: "error", message: "-doctor takes no source or other flags" };
  }
  if (verbose && agent === "") {
    return { kind: "error", message: "-verbose applies only to -agent" };
  }
  if (prompt && (look || jsonOut)) {
    return { kind: "error", message: "-prompt cannot be combined with -look or -json" };
  }
  if (agent !== "" && agent !== "codex" && agent !== "claude") {
    return { kind: "error", message: "-agent must be codex or claude" };
  }
  if (agent !== "" && (prompt || look || jsonOut || model !== "" || noCache)) {
    return { kind: "error", message: "-agent cannot combine with -prompt, -look, -json, -model, or -no-cache" };
  }
  if (operation !== "" && (look || prompt || jsonOut || agent !== "" || model !== "" || noCache)) return { kind: "error", message: "Offline observation cannot combine with legacy output, agent, model or cache flags" };
  if (operation === "" && (pageOption || byteOption || cursor !== "" || snapshot !== "")) return { kind: "error", message: "Observation options require an offline observation operation" };
  if (operation === "capabilities" && (staged || worktree || argv.slice(i).length > 0 || pageOption || byteOption || cursor !== "" || snapshot !== "")) return { kind: "error", message: "-capabilities does not take a source or pagination options" };
  if (operation === "evidence" && snapshot === "") return { kind: "error", message: "-evidence requires -snapshot from its parent inventory" };
  if (pageOption && operation !== "inventory" && operation !== "plan") return { kind: "error", message: "-page-size requires -inventory or -plan" };
  if (byteOption && operation !== "evidence") return { kind: "error", message: "-max-bytes requires -evidence" };
  return { kind: "ok", flags: { model, noCache, staged, worktree, jsonOut, look, prompt, agent, verbose, output, doctor, operation, evidence, pageSize, maxBytes, cursor, snapshot, positional: argv.slice(i) } };
}

// ---------------------------------------------------------------------------
// Recovery hints: extra lines after an error, never a change to its text or
// exit code. They name the command the user most likely meant.
// ---------------------------------------------------------------------------

/** Words people type for a workflow, mapped to the flag that runs it. */
const workflowWords: Readonly<Record<string, string>> = {
  look: "-look", shape: "-look", show: "-look",
  prompt: "-prompt", packet: "-prompt", explain: "-prompt",
  review: "-agent codex", agent: "-agent codex", codex: "-agent codex", claude: "-agent claude",
  json: "-json", inventory: "-inventory", plan: "-plan", capabilities: "-capabilities",
  doctor: "-doctor", setup: "-doctor", check: "-doctor", help: "-h",
  staged: "-staged", worktree: "-w", unstaged: "-w",
};

/** A hint for an undefined flag that names a known workflow word. */
export function flagHint(message: string): string {
  const name = /^flag provided but not defined: -(.+)$/.exec(message)?.[1];
  const flag = name === undefined ? undefined : workflowWords[name.toLowerCase()];
  return flag === undefined ? "" : `hint: did you mean ${flag}?\n`;
}

/** A hint for a source that failed to resolve because of a misplaced flag or a workflow word. */
export function sourceHint(positional: readonly string[]): string {
  const flags = positional.slice(1).filter(arg => arg.startsWith("-"));
  if (flags.length > 0) {
    const rest = positional.filter(arg => !arg.startsWith("-"));
    return `hint: flags go before the change: meat ${[...flags, ...rest].join(" ")}\n`;
  }
  const first = positional[0];
  const flag = first === undefined ? undefined : workflowWords[first.toLowerCase()];
  if (flag === undefined) return "";
  const rest = positional.slice(1);
  if (flag === "-h" || flag === "-doctor") return `hint: did you mean meat ${flag}?\n`;
  return `hint: did you mean meat ${flag} ${rest.length > 0 ? rest.join(" ") : "HEAD"}?\n`;
}

function quoteArg(arg: string): string {
  return /^[\w./\\~^@:+=-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`;
}

/** Commands that need no API key, for the selection the user just made. */
export function noKeyHint(selection: string, stdin: boolean, dotEnv: boolean, entry: string): string {
  const s = selection === "" ? "" : ` ${selection}`;
  const rows: Array<[string, string]> = [
    [`meat -prompt${s}`, "review packet for the agent session you already use"],
    [`meat -agent codex${s}`, "fresh review with your Codex subscription (or -agent claude)"],
    [`meat -look${s}`, "offline shape and full diff"],
    ["meat -doctor", "check which of these work on this machine"],
  ];
  const width = Math.max(...rows.map(([command]) => command.length)) + 3;
  let hint = "hint: these need no API key:\n" + rows.map(([command, what]) => `  ${command.padEnd(width)}${what}\n`).join("");
  if (stdin) hint += "  (pipe the same diff into each command)\n";
  if (dotEnv) hint += `hint: a .env file is here, but meat does not load it. To use it: node --env-file=.env ${quoteArg(entry)}${s}\n`;
  return hint;
}

// ---------------------------------------------------------------------------
// Output destination: stdout, or a file written whole with -o
// ---------------------------------------------------------------------------

interface Output {
  readonly writer: Writer;
  bytes(chunk: Uint8Array): void;
  /** With -o, write everything collected to the file; nothing is written for a failed run. */
  finish(): void;
}

function openOutput(path: string): Output {
  if (path === "") {
    return { writer: processWriter(process.stdout), bytes: (chunk) => void process.stdout.write(chunk), finish: () => {} };
  }
  // No fd: rendering treats the destination as a non-terminal (plain, no pager).
  const chunks: Buffer[] = [];
  return {
    writer: { write: (text) => void chunks.push(Buffer.from(text, "utf8")) },
    bytes: (chunk) => void chunks.push(Buffer.from(chunk)),
    finish: () => {
      const data = Buffer.concat(chunks);
      const temp = `${path}.meat-${process.pid}.tmp`;
      try {
        writeFileSync(temp, data);
        renameSync(temp, path);
      } catch (err) {
        rmSync(temp, { force: true });
        throw new Error(`writing ${path}: ${errorMessage(err)}`);
      }
      process.stderr.write(`meat: wrote ${path} (${data.length} bytes)\n`);
    },
  };
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
    // stderr is captured, as Go's `.Output()` does, so git's own message
    // appears once (inside ours) and success-path warnings stay quiet.
    const out = execFileSync("git", args as string[], { maxBuffer: maxGitOutputBytes, stdio: ["ignore", "pipe", "pipe"] });
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
    // Go's flag package printed the whole usage here; a pointer keeps the
    // actual error visible. Exit code 2 is unchanged.
    process.stderr.write(`${fatalMessage(parsed.message)}\n${flagHint(parsed.message)}Run "meat -h" for usage and examples.\n`);
    process.exit(2);
  }
  const { model: modelFlag, noCache, staged, worktree, jsonOut, look, prompt, agent, verbose, output, positional } = parsed.flags;

  if (parsed.flags.doctor) {
    process.stdout.write(doctorReport());
    return;
  }

  const out = openOutput(output);
  const finishOutput = (): void => {
    try {
      out.finish();
    } catch (err) {
      fatal(errorMessage(err));
    }
  };

  if (parsed.flags.operation !== "") {
    try {
      const { operation, evidence, pageSize, maxBytes, cursor, snapshot: expected } = parsed.flags;
      if (operation === "capabilities") {
        out.writer.write(JSON.stringify(capabilityArtifact()) + "\n");
        finishOutput();
        return;
      }
      const snapshot = await collectSnapshot(positional, staged, worktree);
      if (trimSpace(snapshot.diff).length === 0) throw new SnapshotError("empty_input", "No diff to read; select a nonempty change.");
      if (expected !== "" && expected !== snapshot.id) throw new SnapshotError("source_changed", "Snapshot identity changed; capture a new inventory.");
      const observation = observeSnapshot(snapshot);
      const artifact = operation === "inventory" ? inventoryArtifact(observation, pageSize, cursor) :
        operation === "evidence" ? evidenceArtifact(observation, evidence, maxBytes, cursor) : planningArtifact(observation, pageSize, cursor);
      out.writer.write(JSON.stringify(artifact) + "\n");
    } catch (error) {
      const diagnostic = { schema: "meat.observe", version: 1, kind: "diagnostic", code: error instanceof SnapshotError ? error.code : "invalid_request",
        stage: "observation", message: errorMessage(error).slice(0, 2048) };
      process.stderr.write(JSON.stringify(diagnostic) + "\n");
      process.exitCode = 1;
      return;
    }
    finishOutput();
    return;
  }

  let diff: Uint8Array;
  let source: string;
  try {
    ({ diff, source } = await readDiff(positional, staged, worktree));
  } catch (err) {
    fatal(`${errorMessage(err)}\n${sourceHint(positional)}`.trimEnd());
  }
  if (trimSpace(diff).length === 0) {
    fatal(`no diff to read (${source})`);
  }

  if (prompt) {
    out.writer.write(formatReviewPrompt(diff, source));
    finishOutput();
    return;
  }

  if (agent !== "") {
    try {
      await reviewWithAgent(agent, formatReviewPrompt(diff, source), output === "" ? { verbose } : { verbose, output: (chunk) => out.bytes(chunk) });
    } catch (err) {
      fatal(errorMessage(err));
    }
    finishOutput();
    return;
  }

  if (look) {
    // No model, no cache, no API key. Color follows the same tty + git
    // color.diff policy as abridge rendering; piped output stays plain.
    const tty = isTerminal(out.writer);
    const color = tty && gitWantsColor(tty);
    out.writer.write(formatDiffLook(diff, palette(color)));
    finishOutput();
    return;
  }

  // The selection as typed, for recovery hints.
  const selection = positional.length > 0 ? quoteArg(arrayAt(positional, 0)) : staged ? "-staged" : worktree ? "-w" : source === "stdin" ? "" : "HEAD";

  // Progress feedback is strictly interactive: only when stderr is a
  // terminal and the result is not going to a redirected stdout (so
  // `meat > file` and `meat 2> log` stay clean), and never when -json
  // writes to stdout.
  let progress: (msg: string) => void = () => {};
  const interactive = isTerminal(processWriter(process.stderr)) &&
    (output !== "" || (!jsonOut && isTerminal(processWriter(process.stdout))));
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
    let model: Awaited<ReturnType<typeof NewModelFromEnv>>;
    try {
      model = await NewModelFromEnv(signal, modelFlag);
    } catch (err) {
      throw new Error(`${errorMessage(err)}\n${noKeyHint(selection, source === "stdin", existsSync(".env"), process.argv[1] ?? "meat")}`.trimEnd());
    }
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
      out.writer.write(renderJSON(res, elision));
      return;
    }
    // On an interactive terminal, render like `git show`: git's diff
    // colors and git's pager. Otherwise (piped/redirected/-o) print plain.
    renderResult(out.writer, res, elision);
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
  finishOutput();
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
  // A reader that stops early (`meat -look HEAD | head`) closes the pipe.
  // Exit quietly, as git does, instead of crashing on an unhandled EPIPE.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  main().catch((err: unknown) => {
    process.stderr.write(`meat: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
