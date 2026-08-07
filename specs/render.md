# render

> Status: stage 1 ✅ | stage 2 ⬜
> Go sources: `cmd/meat/render.go`
> Go tests: `cmd/meat/render_test.go` (9 tests — colorization, tty detection,
> plain-file rendering, git-config color policy, `-json` wire form)

## Purpose

Turns a compiled `Result` into what the user actually sees: a colorized or
plain terminal rendering, or a `-json` document. Color is never decided
unconditionally by "is this a tty" — it defers to git's own `color.diff`/
`color.ui` policy, matching `git show`'s behavior. Paging (when to shell out
to a pager vs. write directly) and the `-json` wire form are also owned
here. This subject does not decide *what* the diff says — only how it's
displayed.

## Vocabulary

- **Diff palette / palette slot** — the four independently-resolved color
  assignments (`meta`, `frag`, `old`, `new`) used to colorize one rendered
  unified diff, one per unified-diff line kind. The all-empty value means
  "no color." See G3, G5.
- **Diff-metadata line ("meta" classification)** — any unified-diff line
  that is structural/header content rather than a context or changed row:
  `diff --git`, `index`, `---`/`+++` file headers, mode/rename/copy/
  similarity lines. Classified independently of `+`/`-` coloring so that
  `---`/`+++` file headers are never mistaken for removed/added content
  lines. See G3.
- **Commit color** — the color used for meat's synthesized `"# <summary>"`
  header line, deliberately distinct from the diff-line palette slots
  (matching `git show`'s commit-header styling), resolved only when some
  palette slot is active. See G1.
- **`gitWantsColor`** — the tty-aware query of git's `color.diff`/
  `color.ui` policy that gates whether a render colorizes at all, deferring
  to git's `always`/`auto`/`never` semantics instead of coloring
  unconditionally on a tty. See G9.
- **Pager resolution** — the same fallback chain `git show` uses to pick a
  pager (`GIT_PAGER`, `core.pager`, `$PAGER`, then `less`), obtained via
  `git var GIT_PAGER`; a resolved pager of `""` or `"cat"` means "write
  directly, no paging." Not exercised by any test in this file — see Open
  questions.
- **`-json` wire form** — see G10; the field-name contract itself is the
  External Surface entry in `migration/INVENTORY.md`
  (`meat/meat.go:94-105` + `cmd/meat/render.go:16-19`), not re-specified
  here, only pinned by test.

## Guarantees

G1. Rendering with no color renders the summary as a single `"#
    <summary>\n"` header line, a blank separator line, then the diff body
    verbatim, and produces no ANSI escapes anywhere in the output.
    — `cmd/meat/render_test.go:19-29`: exact string equality against `"#
    did a thing\n\n@@ -1 +1 @@\n-old\n+new\n"`, plus an explicit
    "contains no `\x1b[`" check. Mechanism: `formatBody`
    `cmd/meat/render.go:72-101` — header block (`:74-82`), blank-line
    separator (`:88-90`), then one colorized line per diff row (`:96-99`).
    With the zero palette, commit color short-circuits to `""` so the
    header is written plain (`:80`).

G2. When the (trimmed) diff body is empty or all-whitespace, the rendered
    body says so with the literal line `"(no meaningful change to read)"`,
    regardless of whether a color palette is active.
    — `cmd/meat/render_test.go:31-38`: runs the case under both the empty
    palette and a fully-colored fake palette, checking `strings.Contains`
    in both. Mechanism: `formatBody` `cmd/meat/render.go:91-95` —
    `strings.TrimRight` then a `TrimSpace` emptiness check; the literal is
    written via a plain `WriteString`, never passed through
    `colorizeDiffLine` — so the source guarantees this line is never
    colorized even under an active palette, though the test only checks
    substring presence, not that plainness (see Open questions).

G3. Each unified-diff line kind is colorized with the *correct* palette
    slot, not merely "some" color: context lines are never colored;
    `+`-prefixed lines get the "new" slot; `-`-prefixed lines get the "old"
    slot; `@@` fragment headers get the "frag" slot; and every git
    diff-metadata line — `diff --git`, `index`, `---`/`+++` file headers
    (explicitly *not* the old/new slots despite their `-`/`+`-like
    appearance), mode/rename/copy/similarity lines — gets the "meta" slot.
    — `cmd/meat/render_test.go:42-84` (`TestColorizeDiffLineSlots`), an
    18-row table checked against a hand-fixed palette
    (`coloredP = diffPalette{meta:"\x1b[1m", frag:"\x1b[36m", old:"\x1b[31m",
    new:"\x1b[32m"}`, `render_test.go:17`); each case asserts the exact
    expected slot's escape prefix, not just "input changed." Mechanism:
    `colorizeDiffLine` `cmd/meat/render.go:116-134` dispatches by
    `isDiffMeta` (checked first) → `@@` prefix → `+` prefix → `-` prefix →
    default (unchanged); `isDiffMeta` `cmd/meat/render.go:136-149`
    special-cases `+++`/`---` before falling back to the `diffMetaPrefixes`
    table `cmd/meat/render.go:151-165` (12 literal, space-terminated
    prefixes).

G4. Every colorized (non-context) line is wrapped so that it ends with a
    fixed ANSI reset sequence, and the original line text is always
    preserved unmodified inside the wrapping — color-coding never drops or
    mutates content.
    — Same table as G3, `cmd/meat/render_test.go:66-83`: every case checks
    the original line text survives, and, for non-empty expected colors,
    that the output ends with the reset sequence. Mechanism:
    `colorizeDiffLine` `cmd/meat/render.go:132-133` returns `color + line +
    ansiReset`; reset constant `"\x1b[m"` `cmd/meat/render.go:47`.

G5. Disabling color (`palette(false)`) yields exactly the empty/all-blank
    palette value, and passing that empty palette into the line colorizer
    returns every input line completely unchanged, for every line kind
    (including diff-metadata and fragment lines, not just plain context).
    — `cmd/meat/render_test.go:87-96` (`TestPaletteDisabledIsAllPlain`):
    asserts `palette(false)` equals the zero `diffPalette` value; round-trips
    a `+`, a `-`, a `@@` line, and a `diff --git` line through
    `colorizeDiffLine` with that empty palette and requires byte-identical
    output. Mechanism: `palette` `cmd/meat/render.go:57-67` returns the
    zero-value palette directly when `color` is false, without calling
    `diffColor` (no subprocess in this branch).

G6. A writer that is not a real file handle (e.g., an in-memory string
    builder) is never treated as a terminal.
    — `cmd/meat/render_test.go:99-103` (`TestIsTerminalNonFile`), using a
    `strings.Builder`. Mechanism: `isTerminal` `cmd/meat/render.go:230-236`
    — the type assertion to `*os.File` fails for non-file writers and
    returns `false` before any OS call.

G7. Both a plain regular file and `/dev/null` — a character device, the
    same OS category as an actual terminal — are correctly reported as
    non-terminals; this specifically guards against a naïve "is it a
    character device" check, which would misclassify `/dev/null` as a tty.
    — `cmd/meat/render_test.go:108-126` (`TestIsTerminalRegularFileAndDevNull`);
    the `/dev/null` half self-skips via `t.Skipf` if it can't be opened.
    Mechanism: `isTerminal` `cmd/meat/render.go:230-236` calls
    `isatty(f.Fd())`, described in-source as "a real isatty(3) ioctl rather
    than a char-device check" (`render.go:227-229`); `isatty` itself is
    defined in the `isatty_*.go` build-tag family (`cli.md` territory — on
    unix, `isatty_unix.go:12-16`, a `TCGETS`/`TIOCGETA` ioctl).

G8. Rendering a result to a non-terminal writer (e.g., a redirected/regular
    file) produces plain-text output (no ANSI escapes anywhere) that
    includes the diff content, the `"# <summary>"` header, and — when
    supplied — the elision-manifest line (prefixed `"# "`); and it never
    invokes a pager.
    — `cmd/meat/render_test.go:131-154` (`TestRenderResultToFileIsPlain`),
    described in its own comment as "a near-end-to-end check of the public
    entry point": feeds `renderResult` a real regular file, then re-opens
    it and checks for absence of `\x1b[`, presence of the diff content and
    the summary header, and presence of the elision line. Mechanism:
    `renderResult` `cmd/meat/render.go:33-45` — `tty := isTerminal(w)` is
    `false` for a regular file, so `color := tty && gitWantsColor(tty)`
    short-circuits to `false` without ever calling `gitWantsColor`, then
    the `!tty` branch (`render.go:37-39`) writes the body directly and
    returns, never reaching `page` (`render.go:41-44`). The elision line is
    written unconditionally as `"# %s\n"` when non-empty
    (`render.go:83-87`), between the summary header and the blank
    separator.

G9. Color decisions defer entirely to git's own `color.diff`/`color.ui`
    policy rather than to the raw tty flag: an explicit `color.diff=never`
    disables color even when the destination is reported as a tty, and an
    explicit `color.diff=always` enables color even when it is not.
    — `cmd/meat/render_test.go:160-176` (`TestGitWantsColorHonorsConfig`);
    self-skips via `t.Skipf` if `git` isn't on `PATH`. Mechanism:
    `gitWantsColor` `cmd/meat/render.go:170-184` runs `git config
    --get-colorbool color.diff <true|false>` (the trailing argument is the
    caller's tty-ness), then parses stdout as the literal trimmed string
    `"true"`; any subprocess error (including "no such git") yields
    `false` (`render.go:180-182`) — that specific fallback is not itself
    exercised, since the test requires git to be present to run at all
    (see Open questions).

G10. The `-json` wire form is exactly one JSON object with fixed
    snake_case keys, carrying the real result fields (`smart_diff`,
    `summary`, `input_tokens`, `output_tokens`) plus the caller-supplied
    elision-manifest string under `elision`; it performs no HTML-escaping
    (a literal `<` in `summary` stays `<`, never becomes `<`); and it
    contains no ANSI escapes.
    — `cmd/meat/render_test.go:180-211` (`TestRenderJSON`): JSON-decodes
    the output and checks each of the five keys' decoded values, plus a
    raw-bytes check for absent `\x1b[` and absent `<`. Mechanism:
    `renderJSON` `cmd/meat/render.go:23-27` builds a `json.Encoder`, calls
    `SetEscapeHTML(false)`, and encodes a `jsonResult` that embeds
    `meat.Result` (json tags at `meat/meat.go:94-105`) and adds `Elision
    string \`json:"elision,omitempty"\`` (`cmd/meat/render.go:16-19`) — the
    `omitempty` behavior itself (dropping an empty elision field entirely)
    is not exercised, since every call in this test supplies a non-empty
    elision string (see Open questions).

## Open questions

- **The entire tty=true render path is never exercised end-to-end.** No
  test provides `renderResult` a writer that `isTerminal` reports `true`
  for (that would require a real pty). Consequently the full `palette(true)`
  → `diffColor` resolution and `page`/`gitPager` are never invoked through
  the public entry point — only `gitWantsColor` in isolation (G9) and
  `colorizeDiffLine`/`palette` against a hand-built palette (G3-G5) are
  pinned.
- **`diffColor` (`cmd/meat/render.go:189-195`) has essentially zero test
  coverage.** One test (`TestFormatBodyEmptyDiff`, using the fully-colored
  fake palette) incidentally triggers a real, unguarded `git config
  --get-color color.diff.commit yellow` subprocess call when git happens to
  be on `PATH` — with no `LookPath`/`Skipf` guard the way
  `TestGitWantsColorHonorsConfig` has one — but the test's assertion is
  insensitive to whether that call succeeds, fails, or is slow, since the
  literal it checks for is written on a separate, uncolored branch
  regardless. Neither `diffColor`'s success path (parsing git's
  `--get-color` stdout) nor its error-swallowing fallback is directly
  checked by any assertion.
- **`gitPager` and `page` (`cmd/meat/render.go:197-225`) are entirely
  untested.** No test asserts: the "empty or `cat` pager writes directly,
  no subprocess" branch; that a non-trivial pager is run via `sh -c
  <pager>` with stdin wired to the rendered text; or the `LESS=FRX`
  env-injection-unless-already-set behavior.
- **`gitWantsColor`'s subprocess-failure fallback is untested** — the test
  requires git to be present (skipping otherwise), so `err != nil → return
  false` (covering both "git absent" and "git present but the command
  fails") is never actually reached.
- **The `-json` `omitempty` behavior on `Elision` is unverified** — every
  call passes a non-empty elision string.
- **`formatBody`'s "no meaningful change" line is only checked by
  substring, not by exact/plain-text equality** — a regression that wrapped
  this specific line in an ANSI color when a palette is active would not
  necessarily be caught (G2).
