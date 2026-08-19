# cli

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `cmd/meat/main.go`, `cmd/meat/stdin.go`, `cmd/meat/isatty_*.go`
> Go tests: `cmd/meat/readdiff_test.go` (7 tests — revision/range resolution,
> staged/worktree, argument validation), `cmd/meat/install_test.go` (1 test —
> installed binary name)

## Purpose

Resolves *which* diff to read — a revision, a revision range, staged
changes, unstaged changes, piped stdin, or (the default) a summary of
HEAD — and validates flag/argument combinations before any git call or
model call is made. Also governs what the built, installed command is
named. Does not cover rendering the result (`render.md`) or caching it
(`cache.md`).

## Vocabulary

- **Revision** — a single git commit reference (a SHA, `HEAD`, `HEAD~3`, a
  branch/tag name), as opposed to a range. Read via `git show`.
- **Range** (`A..B` / `A...B`) — git's two-dot/three-dot revision-range
  syntax; detected purely by substring (presence of `..` — true for both
  forms, since `...` contains `..`) with no further disambiguation. Both
  are diffed identically via `git diff <range>`. See G2.
- **Staged** (`-staged`) — the index-vs-HEAD diff (`git diff --staged`).
  See G6.
- **Worktree** (`-w`) — the working-tree-vs-index diff (`git diff`), i.e.
  unstaged changes. See G6.
- **Source** — the second return value of `readDiff`; names the origin of
  the diff (a revision string, `"HEAD"`, `"stdin"`, or a staged/worktree
  hint) for the caller's "no diff to read (%s)" message
  (`cmd/meat/main.go:110`) — not the diff content itself.
- **First-parent diff** — the diff of a merge commit against its first
  parent only (`git show -m --first-parent`), so meat's HEAD/revision
  summary of a merge commit shows what the merge introduced onto the base
  branch, rather than the empty diff plain `git show` gives on a merge
  commit. See G5.
- **Piped stdin** — stdin whose file mode is not a character device;
  triggers reading the whole diff from stdin instead of consulting git at
  all. On Unix, `/dev/null` is itself a character device, so stdin
  redirected from `/dev/null` is *not* piped by this check — it behaves
  like an interactive terminal.
- **Command name** vs. **project/module identifier** — the literal string
  a user types at a shell to invoke the tool (`meat`) is independent of
  the internal namespace string tooling uses to name/fetch the project
  (`meat.dev`). See G8.

## Guarantees

### Diff source resolution (`readdiff_test.go`)

G1. Given a single explicit revision argument (a commit SHA), the diff
    reader shows exactly that commit — via `git show`, not a default — and
    reports the revision string itself as the "source." A second, later
    commit made after the SHA was captured never leaks into the output,
    proving the argument is honored rather than silently falling back to
    HEAD.
    — `cmd/meat/readdiff_test.go:12-64` (source check `:55-57`; content
    checks `:58-63`). Mechanism: single-revision branch of `readDiff`
    (`cmd/meat/main.go:251-266`), routing to `gitShow`
    (`cmd/meat/main.go:287-289`, `git show --format=fuller -m
    --first-parent <rev>`).

G2. A revision-range argument (`..` or `...` syntax) is diffed across the
    range with `git diff`, never summarized with `git show`; the returned
    "source" is the exact range string passed in, and the result carries
    no per-commit metadata (no commit-message text), only the content
    change.
    — `cmd/meat/readdiff_test.go:68-122`, looped over both `base +
    "..HEAD"` and `base + "...HEAD"` (`:104`); source check `:109-111`;
    changed-file presence `:112-115`; absence of commit-message text
    `:116-120`. Mechanism: `isRevRange` (`cmd/meat/main.go:294-296`,
    `strings.Contains(rev, "..")`) and the `git("diff", rev)` dispatch
    (`cmd/meat/main.go:258-259`).

G3. An unknown/unresolvable revision argument causes the diff reader to
    return a non-nil error, never a silent empty diff.
    — `cmd/meat/readdiff_test.go:125-138` (repo with zero commits,
    revision `"deadbeef"`; only `err == nil` is checked, no message-text
    assertion). Mechanism: the `git()` subprocess wrapper's error path
    (`cmd/meat/main.go:298-308`), surfaced through `readDiff`'s wrap
    (`cmd/meat/main.go:264`).

G4. More than one positional argument is rejected with an error, and this
    rejection happens before any git subprocess is invoked.
    — `cmd/meat/readdiff_test.go:141-145` (`readDiff([]string{"a","b"},
    false, false)`, no git-availability guard in this test at all).
    Mechanism: `cmd/meat/main.go:248-250`, the `len(args) > 1` check, which
    precedes every subprocess call in `readDiff`.

G5. Summarizing a merge commit (the no-argument, no-flag default path,
    which resolves to HEAD) yields the first-parent diff — what the merged
    branch changed relative to the base — including both the changed file
    from the merged branch and the merge commit's own message text.
    — `cmd/meat/readdiff_test.go:150-197` (repo built with an explicit
    `main` branch, a `feature` branch merged with `--no-ff`; checks at
    `:191-193,194-196`). Mechanism: the no-args/no-flags fallback branch of
    `readDiff` (`cmd/meat/main.go:275-280`, `gitShow("HEAD")`) and
    `gitShow`'s `-m --first-parent` flags (`cmd/meat/main.go:287-289`).

G6. `-staged` (index vs. HEAD) and `-w` (working tree vs. index) are
    independently exact: `-staged` reflects only what's staged, unaffected
    by a later unstaged edit; `-w` reflects only the unstaged edit, and —
    because it diffs against the index, not HEAD — never mentions the
    original committed content as removed.
    — `cmd/meat/readdiff_test.go:201-249`. Fixture: commit `v1`, stage `v2
    staged`, then leave `v3 worktree` unstaged (no `git add`).
    `readDiff(nil, true, false)` checked at `:238-240` (`"v2 staged"`
    present, `"v3 worktree"` absent); `readDiff(nil, false, true)` checked
    at `:246-248` (`"v3 worktree"` present, the removed-line form of `v1`
    absent). Mechanism: `cmd/meat/main.go:234-247` — `staged` → `git diff
    --staged`; `worktree` → `git diff`; both branches return before the
    positional-argument or stdin checks.

G7. Three flag/argument combinations are each independently rejected with
    an error: `-staged` with `-w`; `-staged` with a revision argument;
    `-w` with a revision argument. None of these three checks require git
    on `PATH`.
    — `cmd/meat/readdiff_test.go:252-262` (three separate calls, each
    checked for `err == nil` only). Mechanism: mutual exclusion of
    `-staged`/`-w` (`cmd/meat/main.go:228-230`) for the first case; the
    combined check `(staged || worktree) && len(args) > 0`
    (`cmd/meat/main.go:231-233`) for the other two — both land on the
    *same* error branch/message, since that check doesn't distinguish
    which flag triggered it.

`readDiff(args []string, staged, worktree bool) (diff, source string, err
error)` (`cmd/meat/main.go:227-281`) resolves in this order: (1) `-staged`
+ `-w` together, or either + a revision argument → error (G7); (2)
`-staged` alone (G6); (3) `-w` alone (G6); (4) more than one positional
argument → error (G4); (5) exactly one argument: range → `git diff` (G2),
else single revision → `git show -m --first-parent` (G1); (6) no
arguments, no flags: piped stdin → read stdin verbatim, source `"stdin"`
(**not exercised by any test** — see Open questions); otherwise → default
to summarizing HEAD (G5).

Exact error/message text a port must still match (none of it is
string-asserted by any test in this file, since every check here is
`err == nil`/`err != nil` only):
- `"-staged and -w are mutually exclusive"` (`cmd/meat/main.go:229`)
- `"-staged/-w cannot be combined with a revision argument"` (`:232`)
- `"reading staged changes: %w"` / `"reading working-tree changes: %w"`
  (`:237`, `:244`)
- `"too many arguments: want at most one revision, got %d"` (`:249`)
- `"reading %q: %w"` (`:264`)
- `"reading HEAD (are you in a git repo?): %w"` (`:278`)
- `"git %s: %s"` — args joined with spaces, then trimmed stderr (`:303`)
- Success-path source hints (also unpinned): `"staged; nothing staged?"`
  (`:239`), `"worktree; no unstaged changes?"` (`:246`).

### Installed command name (`install_test.go`)

G8. The command users build and install is named exactly `meat` (plus the
    platform's executable suffix — `.exe` on Windows, nothing elsewhere);
    it is never named after the project's internal module identifier
    (`meat.dev`) or any other variant. The name a user types to invoke the
    tool is decoupled from the name used to identify the project
    internally.
    — `cmd/meat/install_test.go:15-40` (`TestInstalledBinaryName`): runs
    `go install` against this project's CLI package into a scratch
    `t.TempDir()` `GOBIN` (`:24-26`), then asserts the install destination
    contains a file named exactly `"meat" + <platform suffix>` (`:31-32`),
    an exact filename stat, not a prefix/substring check. On failure:
    `"expected installed binary named %q, GOBIN contains %v"` (`:33-39`).
    Mechanism: `cmd/meat/main.go:29` (`package main`) lives in a directory
    literally named `meat` (`cmd/meat/`); `go.mod:1` fixes the module
    identifier at `meat.dev`, a separate string. The install step derives
    the produced executable's name from the package's directory name, not
    from the module identifier.

## Mechanism

### Responsibility boundary

`main.go` is the only orchestrator in `cmd/meat/`: it parses flags,
resolves *which* diff to read (delegating the actual git/stdin mechanics
to functions it defines itself), decides interactivity, and wires
together three externally-defined subsystems it does not implement —
cache lookup/storage (`cacheDir`/`cacheKey`/`cacheLoad`/`cacheStore`,
`cache.md`), rendering (`isTerminal`/`renderResult`/`renderJSON`,
`render.md`), and the engine (`meat.NewModelFromEnv`, `meat.Abridge`,
`meat.ResolveModel`, `meat.RubricHash`, `meat.ElisionLine`). `stdin.go`
and the `isatty_*.go` family are self-contained leaf utilities `main.go`
and `render.go` both consume.

### Flag parsing and usage text

`main()` builds a `flag.FlagSet` named `"meat"` in
`flag.ContinueOnError` mode, redirects its diagnostic output to stderr,
and replaces its usage function with one that dumps the `usage` constant
verbatim `cmd/meat/main.go:88-91`. Five flags are registered — `-model`
(string, default `""`), `-no-cache` (bool), `-staged` (bool), `-w`
(bool), `-json` (bool) `cmd/meat/main.go:92-96` — then
`fs.Parse(os.Args[1:])` runs; `os.Args[0]` itself is never inspected,
and the FlagSet's `"meat"` name is inert for output purposes since the
custom `Usage` bypasses Go's default `"Usage of NAME:"` template.
`-h`/`-help`/`--help` are recognized automatically by the stdlib flag
package.

The `usage` constant `cmd/meat/main.go:44-86` has five parts: a title
line and 7 example invocations (`:46-53`); two descriptive paragraphs
about how the diff source and cache key are chosen (`:55-62`); a
paragraph on tty-driven color/paging (`:64-65`); a `Flags:` block
(`:67-73`); an `Environment:` block listing six variables (`:75-81`);
and a closing paragraph on exe.dev gateway auto-discovery (`:83-85`).
The package doc comment at the top of the file (`:1-28`) independently
restates a subset of the same usage information in Go-doc form, hand
-maintained in parallel with no shared source and no test keeping the
two in sync.

### Data shapes

No dedicated type represents "which diff to read." `readDiff`'s inputs
are three independent primitives — positional args (`[]string`),
`staged` (`bool`), `worktree` (`bool`) — and its resolution is a plain
sequential if/else chain `cmd/meat/main.go:227-281`, not a constructed
or matched value. Its two string outputs are the entire representation
of the outcome: `diff` (raw bytes reinterpreted as a Go string, never
mutated) and `source`, a human-readable hint whose shape is ad hoc, not
a closed enum — it is either the revision/range argument verbatim, the
literal `"staged; nothing staged?"`, the literal `"worktree; no
unstaged changes?"`, `"stdin"`, or `"HEAD"`.

`runOpts` `cmd/meat/main.go:178-190` is the one real data shape here:
`diff string`, `model string` (already resolved, post-`$MEAT_MODEL`/
default), `rubric string` (rubric hash), `cacheDir string`, `noCache
bool`, `compute func(context.Context) (*meat.Result, error)`, `render
func(*meat.Result)`, `stderr io.Writer`. It deliberately carries
closures rather than raw dependencies (git, LLM credentials)
specifically so `run` is testable without either — this is why
`cache_test.go`'s `run`-level tests never touch a real model or git.

### Diff-source resolution algorithm (`readDiff`)

`readDiff(args []string, staged, worktree bool) (diff, source string,
err error)` `cmd/meat/main.go:227-281`, evaluated as a strict,
non-backtracking sequence — each branch either returns or falls through
to the next:

1. `staged && worktree` → error, no subprocess `:228-230`.
2. `(staged || worktree) && len(args) > 0` → error, no subprocess
   `:231-233`. Because this check precedes the individual
   `staged`/`worktree` branches, it is unreachable to combine a flag
   with any positional argument through those branches — the conflict
   is always caught here first, before any git call, regardless of
   argument count.
3. `staged` alone → `git("diff", "--staged")` `:234-240`.
4. `worktree` alone → `git("diff")` `:241-247`.
5. `len(args) > 1` → error `:248-250`. Reachable only when both flags
   are false (steps 1-2 already excluded the flagged cases), so this,
   too, precedes any git call.
6. `len(args) == 1`: classify the single argument via `isRevRange`
   `:251-266`. A range dispatches to `git("diff", rev)`; a single
   revision dispatches to `gitShow(rev)`.
7. No args, no flags: `stdinIsPiped()` — if true, `readAllStdin()` reads
   stdin to completion and returns it verbatim as `diff`, source
   `"stdin"` `:268-274`.
8. No args, no flags, stdin not piped: `gitShow("HEAD")`, source
   `"HEAD"` `:275-280` — the default "summarize the latest commit"
   behavior.

`isRevRange(rev)` `:291-296` is `strings.Contains(rev, "..")` — a pure
substring test with no further validation. It fires identically for
both `A..B` and `A...B` since the three-dot form contains the two-dot
substring; a revision name that happens to contain `..` without being a
valid range is misclassified with no test either way.

`gitShow(rev)` `:283-289` always runs `git show --format=fuller -m
--first-parent <rev>`. Each flag has a specific purpose recorded in the
function comment: `--format=fuller` emits the full commit-metadata block
so a single-revision summary carries commit-message text (feeding G1);
`-m` forces even a merge commit to produce *some* diff (plain `git show`
on a merge emits none); `--first-parent` restricts that forced diff to
exactly one comparison (against the first parent only), giving the
single "what did the merge introduce onto the base branch" diff that G5
pins.

### `git` subprocess invocation (H12)

`git(args ...string) (string, error)` `cmd/meat/main.go:298-308` wraps
`exec.Command("git", args...)` and calls `.Output()`, which captures
only stdout into `out` and treats any non-zero exit as an error. On
failure: if the error is `*exec.ExitError` (git ran and exited
non-zero), the message is built as `"git %s: %s"` with `args`
space-joined and the process's captured stderr `strings.TrimSpace`'d
`:303`; `.Output()`'s stdlib contract populates `ExitError.Stderr`
because `cmd.Stderr` is left nil. Any other error (e.g. git not found on
`PATH`) is returned unwrapped, with no meat-authored message text.

On success, `string(out)` reinterprets git's raw stdout bytes as a Go
string with **no decoding, validation, or trimming** `:307` — this is
the H1 boundary for this file: OS-process-output bytes become the
`diff` value here and are carried through `main.go` completely
opaquely (never indexed, sliced, or regexed) until they cross into
`meat.Abridge`. The same zero-transformation pattern holds for stdin:
`readAllStdin` `cmd/meat/stdin.go:20-22` is `io.ReadAll(os.Stdin)` with
**no size cap of any kind**, and `main.go:273`'s `string(data)` is the
same raw byte reinterpretation. No byte budget (`maxDiffBytes`/
`maxTotalDiffBytes`, H1) is enforced anywhere in `cmd/meat/` — that
enforcement lives entirely downstream in `meat.Abridge`.

`gitRoot()` `cmd/meat/main.go:310-317` runs `git("rev-parse",
"--show-toplevel")`; any error (not in a repo, or git missing —
indistinguishable) yields `""`; success is `strings.TrimSpace`'d to
drop git's trailing newline. The result becomes
`meat.Request.RepoRoot`, and an empty `RepoRoot` disables the model's
read-only file/grep tools entirely (`meat/meat.go:63-64`) — this is the
call boundary into the engine; `tools.md`/`agent-loop.md` own what
happens on either side of it.

### `main()` orchestration sequence

1. Parse flags; on parse error, `flag.ErrHelp` (`-h`/`--help`) exits
   `0`, any other parse error exits `2` `:97-103`.
2. `readDiff(fs.Args(), *staged, *worktree)`; a non-nil error goes to
   `fatal` `:105-108`.
3. `strings.TrimSpace(diff) == ""` → `fatal("no diff to read (%s)",
   source)` `:109-111` (H14).
4. Compute `interactive := !*jsonOut && isTerminal(os.Stdout) &&
   isTerminal(os.Stderr)` `:117` — reuses `render.go`'s `isTerminal`
   (`render.md` G6/G7), itself backed by the `isatty_*.go` family (H11).
   Progress feedback requires **both** streams to be terminals and is
   unconditionally disabled under `-json`.
5. Build the `progress` closure: no-op when not interactive; otherwise
   writes `"\r\x1b[Kmeat: %s"` to stderr per call, overwriting one
   status line `:116-123`.
6. Build the `compute` closure: constructs the model via
   `meat.NewModelFromEnv(ctx, *model)` (network/credentials touched
   only here) then calls `meat.Abridge(ctx, m, meat.Request{RepoRoot:
   gitRoot(), UnifiedDiff: diff, Progress: progress})` `:125-141`. This
   closure exists precisely so credential/network access happens
   *after* the cache check, never before `:126-128`.
7. Build the `render` closure: clears the progress line if interactive;
   computes `elision := meat.ElisionLine(diff, res.SmartDiff)` **here**,
   in `main.go`, not inside `render.go`; dispatches to `renderJSON`
   (under `-json`) or `renderResult` otherwise `:143-155`.
8. Assemble `runOpts` — `model: meat.ResolveModel(*model)` and `rubric:
   meat.RubricHash()` are resolved unconditionally regardless of cache
   outcome, since the cache key needs them before any hit/miss decision;
   `cacheDir: cacheDir()` `:157-166`.
9. `run(context.Background(), opts)`; a non-nil error clears the
   progress line (if interactive) then goes to `fatal` `:167-172`.
   `context.Background()` is passed with no timeout, no cancellation
   source, and no `os/signal` wiring anywhere in `cmd/meat/` — Ctrl-C
   relies entirely on the OS's default `SIGINT` process termination, not
   a graceful abort path. The budget/deadline machinery H6 describes is
   wired downstream, inside `meat.Abridge`.

### `run()` — cache-aware orchestration

`run(ctx, o runOpts) error` `cmd/meat/main.go:196-218`; its
cache-specific mechanics (key derivation, hit/miss semantics,
write-through) are `cache.md`'s territory (G1, G6-G8) and are only
cross-referenced here:

1. `key := cacheKey(o.diff, o.model, o.rubric)` `:197` (`cache.md` G1).
2. If `!o.noCache`: attempt `cacheLoad(o.cacheDir, key)`. On a hit, call
   `o.render(res)`, print `"\nmeat: cached (sha %s)\n"` with `key[:12]`
   to `o.stderr`, and return — `o.compute` is never referenced on this
   path `:198-204` (`cache.md` G6).
3. Otherwise (miss, or `noCache == true` skipping the read entirely):
   time the call, invoke `res, err := o.compute(ctx)`; a non-nil error
   returns immediately, **before** any store `:206-210` (`cache.md` G8).
4. `cacheStore(o.cacheDir, key, res)` — unconditional write-through
   regardless of whether a (possibly stale) entry already existed under
   `key` `:213` (`cache.md` G7).
5. `o.render(res)`, then print `"\nmeat: tokens in=%d out=%d in %s\n"`
   with `res.InputTokens`, `res.OutputTokens`, and elapsed wall time
   rounded to 100ms `:211-216`.

### Rendering and environment-variable dispatch (call boundaries only)

`main.go` does not itself call `os.Getenv`/`os.LookupEnv` for any of the
External Surface's env vars. `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`XAI_API_KEY`/`XAI_BASE_URL`/
`MEAT_MODEL` resolution is
entirely inside `meat.ResolveModel`/`meat.NewModelFromEnv`
(`providers.md`); `MEAT_CACHE` resolution is entirely inside `cacheDir`
(`cache.md`); `LESS`/pager selection is entirely inside `render.go`'s
`gitPager`/`page` (`render.md`). `main.go`'s only role is documenting
all of them in the `usage` text and passing the `-model` flag value
through as an override string.

### `stdinIsPiped` vs. `isatty`/`isTerminal` — two distinct, non-interchangeable mechanisms (H11)

These are easy to conflate but are deliberately different code paths
answering different questions:

- **`stdinIsPiped()`** `cmd/meat/stdin.go:8-18` calls
  `os.Stdin.Stat()` and tests `fi.Mode()&os.ModeCharDevice == 0` — a
  coarse *file-mode* check with no OS-level tty query. On `/dev/null`
  (itself a character device), this returns **false** ("not piped") —
  `/dev/null`-redirected stdin behaves like an interactive terminal for
  diff-source selection.
- **`isatty()`** (the `isatty_*.go` family, used only via `render.go`'s
  `isTerminal`, which `main.go:117` also calls directly for
  progress/interactivity gating) performs a real `TCGETS`/`TIOCGETA`
  **ioctl** — the actual `isatty(3)` mechanism. On `/dev/null`, this
  ioctl fails, so `isatty("/dev/null")` returns **false** — "not a
  terminal" (pinned by `render.md` G7).

So `/dev/null` redirected onto stdin is classified **oppositely** by the
two mechanisms in the current Go source: "not piped" (behaves like a
terminal, for diff-source selection) vs. "not a terminal" (for
progress/color/paging). This is not a bug to reconcile — it is two
separate, independently-motivated checks — but a port must preserve the
asymmetry rather than assume one `isTTY`-style check can serve both call
sites.

Per H11, the `isatty_*.go` build-tag family (four files,
`syscall.Syscall(syscall.SYS_IOCTL, fd, TCGETS|TIOCGETA, &termios)`,
`cmd/meat/isatty_unix.go:12-16`, `isatty_linux.go:7`,
`isatty_bsd.go:7`) is not to be ported: Node's `tty.isatty(fd)` replaces
all four. `stdinIsPiped`'s `os.ModeCharDevice` check separately becomes
`!fstatSync(0).isCharacterDevice()` — a different Node primitive for the
different Go mechanism it replaces, not the same one reused, and not
`process.stdin.isTTY` either: `.isTTY` answers "is fd 0 a tty," which sits
much closer to what `isatty` itself asks, while Go's check here asks the
coarser "is fd 0 a character device at all." `fs.fstatSync(0)
.isCharacterDevice()` is the literal match (confirmed in
`src/cli/stdin.ts`, item 5a, by spawning child processes with `stdio:
["ignore", ...]` — Node backs an ignored fd with `/dev/null`, a character
device — versus a real piped `stdio: ["pipe", ...]`, and observing
opposite `stdinIsPiped` results).

## Invariants

- **Flag-conflict checks precede everything else in `readDiff`.** Both
  mutual-exclusion checks (`:228-233`) run before the
  `staged`/`worktree` branches and before the positional-argument-count
  check. Reordering this would let `-staged extra-arg` silently execute
  `git diff --staged` while discarding the extra argument. Breaks
  G6/G7.
- **`readDiff` never mutates or trims diff content it returns from git
  or stdin** — only the top-level `strings.TrimSpace(diff) == ""` check
  in `main()` (`:109`) is a non-destructive read of the value, never a
  rewrite. Consequence of violating: bytes reaching `meat.Abridge` would
  no longer be byte-identical to git's/stdin's raw output (H1).
- **`compute` (network/credential-dependent) is invoked only on a cache
  miss**, never on a hit `cmd/meat/main.go:198-204`. Breaking this
  defeats caching's purpose and violates `cache.md` G6.
- **`fatal()` prefixes `"meat:"` exactly once**
  `cmd/meat/main.go:319-325`: it checks
  `strings.HasPrefix(msg, "meat:")` before prepending. Since
  `meat.Abridge`'s own errors are sometimes already `"meat: ..."`-prefixed,
  omitting this check would double the prefix on some paths and not
  others.
- **Exit codes are a three-way convention**: `0` only for `-h`/`--help`
  `:100`; `2` only for flag-parsing errors `:102`; `1` for every other
  runtime failure, always via `fatal` `:326`.
- **Progress output requires both stdout and stderr to be terminals, and
  is fully suppressed under `-json`** `:113-117`. Breaking this leaks
  raw `\r\x1b[K` control sequences into redirected output or corrupts
  `-json`'s stdout stream.
- **`stdinIsPiped` and `isatty`/`isTerminal` are independent mechanisms,
  not interchangeable** — substituting one implementation for the other
  changes the `/dev/null` edge case in one direction or the other.

## Hazards

- **H11** — The `isatty_*.go` build-tag family (four files, ioctl-based
  `TCGETS`/`TIOCGETA` termios fetch, `cmd/meat/isatty_unix.go:12-16`) is
  explicitly *not* to be ported; Node's `tty.isatty(fd)` replaces it,
  used wherever `render.go`'s `isTerminal` — and, transitively,
  `main.go:117`'s interactivity check — is called. `stdinIsPiped`'s
  separate `os.ModeCharDevice` check (`cmd/meat/stdin.go:17`) is a
  *different* mechanism with its own Node equivalent,
  `!fstatSync(0).isCharacterDevice()` (not `process.stdin.isTTY`, which
  answers a `.isTTY`-shaped question much closer to `isatty` itself) —
  the two do not collapse to the same
  replacement, and (per Mechanism above) they classify `/dev/null`
  oppositely in the current Go source, a distinction the port should be
  aware of even though H11 already decided not to preserve the
  underlying ioctl mechanics.
- **H12** — `git()` `cmd/meat/main.go:298-308` is the concrete instance
  of "`exec.Command(...).Output()` captures stdout and treats a
  non-zero exit as an error": stdout only is captured into the success
  value; failure extracts `ExitError.Stderr` to build the `"git %s: %s"`
  message. The pager-subprocess half of H12 (`exec.Command("sh", "-c",
  pager)`) lives in `render.go:206`, out of this file's scope. Also
  relevant here: `readAllStdin` (`cmd/meat/stdin.go:20-22`) imposes **no
  size cap**, unlike the bounded `bufio.Scanner`s H12's third bullet
  describes elsewhere in the codebase — a port must decide deliberately
  whether to bound this read.
- **H1** — `main.go`/`stdin.go` do not enforce any byte budget
  themselves (`maxDiffBytes`/`maxTotalDiffBytes` are downstream, in
  `meat.Abridge`). The load-bearing H1 site in this file is the two
  raw-byte-reinterpretation boundaries where OS output becomes a Go
  string with zero decoding/validation: `git()`'s `return string(out),
  nil` (`cmd/meat/main.go:307`) and stdin's `return string(data),
  "stdin", nil` (`cmd/meat/main.go:273`, data from `stdin.go:21`). Both
  must carry arbitrary bytes through unchanged; a JS port must read
  these as `Buffer`/`Uint8Array` at this boundary, not as decoded text.
  The CLI's own diff-string handling in `main.go` (the `TrimSpace`
  emptiness check, `key[:12]` hex slicing) never indexes or slices the
  diff itself, only tests it and passes it through opaquely.
- **H6** — Does not bite in this file the way it does in
  `meat.go`/`chunk.go`: `main.go` passes a bare `context.Background()`
  into `run` (`:167`) with no deadline, no cancellation, and no
  `os/signal` wiring anywhere in `cmd/meat/`. Ctrl-C is handled solely
  by the OS's default `SIGINT` termination, not by any graceful-abort
  code path in this package.
- **H14** — `strings.TrimSpace(diff) == ""` at `cmd/meat/main.go:109`
  decides whether to `fatal("no diff to read (%s)", source)`. This is
  the same class of empty-diff check `migration/HAZARDS.md`'s H14 entry
  already tracks at `meat/meat.go:119`, but at a *different* call site
  — the CLI itself independently re-checks emptiness before ever
  calling into the engine. Both sites must use the same
  U+0085-included/U+FEFF-excluded trim semantics as Go's
  `unicode.IsSpace`, not JavaScript's native `.trim()`. This site has
  been added to `migration/HAZARDS.md`'s H14 entry.

## Errors

Exit-code convention: `0` = help requested (`flag.ErrHelp`, `:100`); `2`
= flag-parsing error, message produced by the stdlib `flag` package
itself followed by the full `usage` text dump on stderr (`:97-103`); `1`
= every other failure, via `fatal`, which writes `"meat: " + msg\n"` to
stderr (prefix added only if `msg` doesn't already start with
`"meat:"`) then `os.Exit(1)` (`cmd/meat/main.go:319-327`).

Failure modes and exact text, all from `readDiff` unless noted:

- `"-staged and -w are mutually exclusive"` — `cmd/meat/main.go:229`.
- `"-staged/-w cannot be combined with a revision argument"` — `:232`.
- `"reading staged changes: %w"` / `"reading working-tree changes: %w"`
  — `:237`, `:244`.
- `"too many arguments: want at most one revision, got %d"` — `:249`.
- `"reading %q: %w"` (single revision or range) — `:264`.
- **Stdin-read failure is the one branch that is *not* wrapped** —
  `readAllStdin`'s error is returned verbatim, unprefixed by any
  meat-authored text (`:270-272`), unlike every other branch here.
- `"reading HEAD (are you in a git repo?): %w"` — `:278`.
- `"git %s: %s"` (args space-joined, stderr `TrimSpace`'d) — `:303`,
  from the `git()` helper, wrapped into the above by whichever caller
  invoked it.
- Success-path source hints (not errors, but user-visible on a no-op):
  `"staged; nothing staged?"` (`:239`), `"worktree; no unstaged
  changes?"` (`:246`).
- `main()`-level, after `readDiff` succeeds: `"no diff to read (%s)"`
  with `source` interpolated — `cmd/meat/main.go:110`.
- Cache-hit notice (not an error): `"\nmeat: cached (sha %s)\n"` —
  `:201` (`cache.md` G6).
- Cache-miss success notice: `"\nmeat: tokens in=%d out=%d in %s\n"` —
  `:216`.

## Ordering that Go leaves unspecified

None. No `sort.*` call, no map, no goroutine/concurrency anywhere in
`main.go`, `stdin.go`, or the `isatty_*.go` family — `readDiff`'s
resolution is a strict sequential if/else chain.

## Test infrastructure

See `test-infrastructure.md`'s "Real git subprocess dependency" section —
`readdiff_test.go` uses the same real-throwaway-git-repo style documented
there for `editplan_test.go` (not the config-injection style used by
`render_test.go`'s `TestGitWantsColorHonorsConfig`): five of seven tests
self-skip via `exec.LookPath("git")` + `t.Skipf`; the other two
(`TooManyArgs`, `FlagConflicts`) have no such guard, because both prove
their error fires before any subprocess call (G4, G7). Each git-dependent
test roots a fresh repo in `t.TempDir()` + `t.Chdir(dir)`, committing with a
fixed author/committer identity via env vars so commits don't depend on the
ambient user's global gitconfig. `install_test.go`'s test is a real
subprocess/build test in its own right: it shells out to the actual `go`
toolchain, self-skips under `testing.Short()` or when `go` isn't on `PATH`,
and redirects the install into a disposable temp directory.

No stdin-faking of any kind appears in `readdiff_test.go` — no `os.Pipe`,
no fd redirection, no override of `os.Stdin`. The nil-args test relies
entirely on the ambient stdin of the `go test` process itself being a
character device, an implicit environmental assumption rather than an
explicit seam.

## Constants

No named numeric limits (value+unit) are touched by either test file. The
CLI surface these tests exercise (`meat <sha>`, `meat HEAD~3`, `meat
<sha1>..<sha2>`, `meat main...HEAD`, `meat -staged`, `meat -w`) is exactly
the "CLI" line of `migration/INVENTORY.md`'s External Surface section
(`cmd/meat/main.go:6-46,89` for the full flag set and usage text) — these
tests provide the behavioral pinning for the revision/range/staged/worktree
part of that surface; they do not touch `-model`, `-json`, `-no-cache`, or
usage text at all (see Open questions). Two fixed string literals are
pinned exactly by G8 (`"meat"`, `"meat.dev"`) but don't fit `constants.md`'s
value/unit/boundary schema for numeric limits.

## Open questions

- **`stdinIsPiped` and `readAllStdin` (`cmd/meat/stdin.go`) are untested
  anywhere in the Go suite.** No test constructs an `os.Pipe` or otherwise
  fakes stdin's device type; the stdin-piped branch of `readDiff`
  (`cmd/meat/main.go:268-274`) is never exercised. The entire "abridge a
  diff piped on stdin" mode advertised in the CLI's own usage text
  (`cmd/meat/main.go:23-25`) has zero test pinning — this spec's coverage
  of it rests on source-reading alone.
- **The success-path source hint strings for `-staged`/`-w`** are present
  in source but not checked — `TestReadDiffStagedAndWorktree` discards the
  second return value entirely.
- **`main()`, `fatal()`, `gitRoot()`, flag parsing, and usage text
  (`cmd/meat/main.go:44-86`) are not exercised by either test file** —
  `-model`, `-json`, `-no-cache`, and the printed usage text have no
  apparent test owner among the inventoried files.
- **G7's two error branches are indistinguishable by any assertion** —
  `-staged` + revision and `-w` + revision hit the same code and the same
  message; no test proves the message should (or does) differ.
- **No boundary test for a revision string containing `..` as a substring
  without being a valid git range** (e.g. an unusual branch name) — a real
  edge case in `isRevRange`'s naive substring check, untested either way.
- **`install_test.go` checks existence, not correctness or
  executability** — only that a file named `meat` exists at the install
  destination; the test never runs the produced binary or checks its
  executable permission bit.
- **`install_test.go` installs from the local module path, not the
  `@latest`-suffixed form documented for end users** — version-resolution/
  network install behavior is untested.
- **Migration-relevant**: per `migration/TARGET.md`, the TypeScript port
  replaces `go install meat.dev/cmd/meat@latest` with an npm package
  invoked as `npx meat`. G8's underlying concern (installed command name
  independent of project identifier) is exactly the property an npm
  `package.json`'s `bin` field vs. `name` field must preserve — but no Go
  test exercises an npm-equivalent mechanism, since none exists in this
  codebase. Stage 3 needs its own guarantee/test for the npm packaging
  equivalent; this Go test's *intent* carries over, not its mechanism.
- **Stage 2 reconciliation: all 8 guarantees confirmed, no mismatches.**
  The mechanism delivers exactly what each guarantee states, including
  the subtler structural claims (G4's "before any git subprocess," G6's
  "return before the positional-argument or stdin checks").
- **New finding: `stdinIsPiped` and `isatty`/`isTerminal` classify
  `/dev/null` oppositely** — not previously documented anywhere. See
  Mechanism and H11 above.
- **New finding: a second, CLI-side H14 empty-diff check** —
  `main.go:109`'s `strings.TrimSpace(diff) == ""` duplicates the pattern
  `migration/HAZARDS.md`'s H14 entry already tracks at
  `meat/meat.go:119`, at a site the register didn't previously list. Now
  added to the register.
- **`readAllStdin`'s complete absence of a size cap**, in contrast to
  H12's bounded-`bufio.Scanner` sites elsewhere in the codebase — flagged
  as a deliberate port decision point, not a bug.
- **Dead-code check: none found, including `isatty_other.go`.** Its
  build tag (`!(linux || darwin || freebsd || netbsd || openbsd ||
  dragonfly)`) is satisfied by real Go targets (Windows, plan9, js/wasm,
  solaris, illumos, aix) — nothing in this repo (`go.mod`, no CI config)
  restricts `meat` to Unix-like platforms, so its `func isatty(fd
  uintptr) bool { return false }` fallback is live, reachable code, not
  a vestige.
