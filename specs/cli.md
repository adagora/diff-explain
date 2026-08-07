# cli

> Status: stage 1 ✅ | stage 2 ⬜
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
