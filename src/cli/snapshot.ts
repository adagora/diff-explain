import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readAllStdin, stdinIsPiped } from "./stdin.ts";

export class SnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export function hashBytes(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Canonical JSON: recursively sorted object keys, UTF-8 when hashed. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + canonicalJSON(record[key])).join(",") + "}";
  }
  throw new SnapshotError("invalid_request", "Snapshot descriptors must contain JSON values");
}

export interface EvidenceSnapshot {
  version: 1;
  id: string;
  input_digest: string;
  diff: Uint8Array;
  source: { kind: "commit" | "range" | "staged" | "worktree" | "stdin"; [key: string]: unknown };
  context: {
    availability: "immutable_git" | "unavailable";
    consistency: "immutable" | "unverified";
    before_tree: string | null;
    after_tree: string | null;
    reason: string | null;
  };
  observations: { selector: string; repository: string | null };
}

/** Optional local dependencies make source races testable without changing Git state globally. */
export interface SnapshotDependencies {
  cwd?: string;
  git?: (args: readonly string[]) => Uint8Array;
  stdinIsPiped?: () => boolean;
  readAllStdin?: () => Promise<Uint8Array>;
}

const gitConfig = ["-c", "core.quotePath=true", "-c", "diff.suppressBlankEmpty=false"];
/** Shared Git capture bound; independent of the API engine's smaller budgets. */
export const maxGitOutputBytes = 64 * 1024 * 1024;
const diffOptions = [
  "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--binary",
  "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "--find-renames=50%",
  "--diff-algorithm=myers", "--no-indent-heuristic", "--no-relative",
  "--ignore-submodules=none", "--submodule=short", "--inter-hunk-context=0", "-l0",
  "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ",
  // Git's documented cancellation of diff.orderFile, including Git for Windows.
  "-O/dev/null",
];
const collection = {
  version: 1,
  git_config: gitConfig,
  diff_options: diffOptions,
  path_filters: [],
  excluded: ["untracked_files"],
  commit_parent: "first_parent",
  root_base: "empty_tree",
  three_dot_base: "unique_merge_base",
  mutable_capture: "two_comparisons_two_attempts",
};

function snapshot(
  diff: Uint8Array, source: EvidenceSnapshot["source"], context: EvidenceSnapshot["context"],
  observations: EvidenceSnapshot["observations"],
): EvidenceSnapshot {
  // Own the collected bytes: a caller's mutable input must not alter retained evidence.
  const retained = new Uint8Array(diff);
  const input_digest = hashBytes(retained);
  const descriptor = { version: 1, input_digest, source, context };
  return { ...descriptor, version: 1, id: hashBytes(Buffer.from(canonicalJSON(descriptor))), diff: retained, observations };
}

const unavailable = (reason: string): EvidenceSnapshot["context"] => ({
  availability: "unavailable", consistency: "unverified", before_tree: null, after_tree: null, reason,
});

export async function collectSnapshot(
  args: readonly string[], staged: boolean, worktree: boolean, dependencies: SnapshotDependencies = {},
): Promise<EvidenceSnapshot> {
  if ((staged && worktree) || ((staged || worktree) && args.length > 0) || args.length > 1) {
    throw new SnapshotError("invalid_request", "Choose one revision, staged changes, worktree changes, or stdin");
  }
  if (!staged && !worktree && args.length === 0 && (dependencies.stdinIsPiped ?? stdinIsPiped)()) {
    const diff = await (dependencies.readAllStdin ?? readAllStdin)();
    return snapshot(diff, { kind: "stdin", provenance: "unknown", collection: { version: 1, bytes: "exact" } },
      unavailable("stdin_provenance_unknown"), { selector: "stdin", repository: null });
  }
  const cwd = dependencies.cwd ?? process.cwd();
  const run = dependencies.git ?? ((gitArgs: readonly string[]) => new Uint8Array(execFileSync("git", [...gitConfig, ...gitArgs], {
    cwd, maxBuffer: maxGitOutputBytes, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
  })));
  const git = (...gitArgs: string[]): Uint8Array => {
    try { return run(gitArgs); }
    catch (err) {
      if (err instanceof SnapshotError) throw err;
      throw new SnapshotError("invalid_request", `Cannot collect Git evidence: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const text = (...gitArgs: string[]): string => Buffer.from(git(...gitArgs)).toString("utf8").trim();
  const resolve = (selector: string): string => text("rev-parse", "--verify", "--end-of-options", selector + "^{commit}");
  const tree = (commit: string): string => text("rev-parse", "--verify", commit + "^{tree}");
  // Computing the empty tree hash does not write an object or change the index.
  const emptyTree = (): string => text("hash-object", "-t", "tree", "--stdin");
  const repository = text("rev-parse", "--show-toplevel");
  if (staged || worktree) {
    const kind = staged ? "staged" : "worktree";
    const head = (): string | null => {
      try { return resolve("HEAD"); }
      catch {
        // An unborn branch is valid; a missing/corrupt existing HEAD is not.
        const ref = text("symbolic-ref", "-q", "HEAD");
        const refs = text("for-each-ref", "--format=%(refname)", ref);
        if (refs !== "") throw new SnapshotError("invalid_request", "Cannot resolve existing HEAD");
        return null;
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const beforeHead = head();
      const base = beforeHead === null ? emptyTree() : tree(beforeHead);
      const indexBefore = hashBytes(git("ls-files", "--stage", "-z"));
      const diffArgs = ["diff", ...diffOptions, ...(staged ? ["--cached", base] : []), "--"];
      const diff = git(...diffArgs);
      const repeated = git(...diffArgs);
      const indexAfter = hashBytes(git("ls-files", "--stage", "-z"));
      const afterHead = head();
      if (beforeHead === afterHead && indexBefore === indexAfter && hashBytes(diff) === hashBytes(repeated)) {
        return snapshot(diff, { kind, base_commit: beforeHead, base_tree: base,
          index_digest: indexBefore, collection }, unavailable("mutable_context_not_captured"),
        { selector: kind, repository });
      }
    }
    throw new SnapshotError("source_changed", "Index or worktree changed during both capture attempts; collect a new snapshot");
  }
  const selector = args[0] ?? "HEAD";
  const range = /^(.*?)\.(\.\.?)(.*?)$/.exec(selector);
  let source: EvidenceSnapshot["source"];
  let before: string;
  let after: string;
  if (range !== null) {
    const left = resolve(range[1] || "HEAD");
    const right = resolve(range[3] || "HEAD");
    const form = range[2] === ".." ? "three_dot" : "two_dot";
    let base = left;
    if (form === "three_dot") {
      const bases = text("merge-base", "--all", left, right).split(/\r?\n/).filter(Boolean);
      if (bases.length !== 1) throw new SnapshotError("capability_unavailable", "Three-dot evidence requires exactly one merge base");
      base = bases[0]!;
    }
    before = tree(base);
    after = tree(right);
    source = { kind: "range", form, left_commit: left, right_commit: right,
      merge_base: form === "three_dot" ? base : null, collection };
  } else {
    const commit = resolve(selector);
    const parents = text("rev-list", "--parents", "-n", "1", commit).split(/\s+/).slice(1);
    const parent = parents[0] ?? null;
    before = parent === null ? emptyTree() : tree(parent);
    after = tree(commit);
    source = { kind: "commit", commit, parent, collection };
  }
  const diff = git("diff", ...diffOptions, before, after, "--");
  return snapshot(diff, source, { availability: "immutable_git", consistency: "immutable",
    before_tree: before, after_tree: after, reason: null }, { selector, repository });
}
