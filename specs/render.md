# render

> Status: stage 1 ✅ | stage 2 ✅
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

## Mechanism

### Responsibility boundary

`render.go` owns everything that happens *after* a `meat.Result` (plus a
separately-computed elision-manifest string) already exists: whether
output is colorized, how ANSI escapes are applied to a diff's lines,
whether/how a pager is invoked, and how the `-json` document is encoded.
It does not compute the diff, the summary, the token counts, or the
elision string — those arrive as arguments (`res *meat.Result`, `elision
string`). `renderJSON`/`renderResult` have exactly one caller each, both
in `cmd/meat/main.go:149,154` (`cli.md` territory), and both call sites
pass `os.Stdout` as the writer. `isTerminal` (`render.go:230-236`) is
also reused directly by `main.go:117` for an unrelated "is this an
interactive run" flag governing status-line updates — that is `main.go`'s
own concern, not part of the render/color decision described here.

### The `-json` encoding path

`renderJSON` (`render.go:23-27`) is the entire `-json` mechanism:
1. Construct a `json.Encoder` over the destination writer.
2. Call `enc.SetEscapeHTML(false)` (`render.go:25`) — disables Go's
   default rewriting of `<`, `>`, `&` to `<`/`>`/`&`
   inside JSON string values. **H4**: this is a deliberate, load-bearing
   off switch — a literal `<` in `Summary` must appear as `<` in the
   wire form. `JSON.stringify` in TypeScript does not HTML-escape by
   default, so the port matches Go's *chosen* behavior automatically —
   but only because this exists; never add escaping "for safety."
3. Encode one `jsonResult{Result: *res, Elision: elision}` value
   (`render.go:26`) — `meat.Result` is embedded **by value** (a copy of
   `*res`), not by pointer.
4. `renderJSON` never inspects `w`; no color, no pager, unconditional.

### Data shapes: the `-json` wire object

`jsonResult` (`render.go:16-19`) embeds `meat.Result`
(`meat/meat.go:94-105`) plus one field:

| Field (Go) | JSON key | `omitempty`? | Present when |
|---|---|---|---|
| `SmartDiff` | `smart_diff` | no (`meat/meat.go:99`) | always, even `""` |
| `Summary` | `summary` | no (`meat/meat.go:101`) | always, even `""` |
| `InputTokens` | `input_tokens` | no (`meat/meat.go:103`) | always, even `0` |
| `OutputTokens` | `output_tokens` | no (`meat/meat.go:104`) | always, even `0` |
| `Elision` | `elision` | **yes** (`render.go:18`) | only when caller-supplied `elision` is non-empty |

**H9**: only `Elision` carries `omitempty`; the four `Result` fields do
not. A port that treats all five uniformly breaks the contract in one
direction or the other — omitting `smart_diff`/`summary`/`input_tokens`/
`output_tokens` when falsy drops keys a CI-bot parser expects present;
always emitting `elision: ''` adds a key Go's wire form omits,
collapsing "no manifest" and "empty manifest" into one Go-side state
that a port must not un-collapse. `Result` has no slice/map fields, so
only the string-`omitempty` half of H9 is live here.

### The color-decision algorithm

One boolean, `color`, computed once per `renderResult` call
(`render.go:33-36`), gates every downstream decision:
1. `tty := isTerminal(w)` (`render.go:34`) — `w` must be a concrete
   `*os.File` (type assertion, `render.go:231-233`) *and* pass a real
   `isatty(3)` ioctl on its fd (`render.go:235`; the ioctl itself is
   `isatty_*.go` territory, `cli.md`). Any non-`*os.File` writer is
   unconditionally non-tty, no syscall made.
2. `color := tty && gitWantsColor(tty)` (`render.go:35`) — Go's `&&`
   short-circuits: `gitWantsColor` is only invoked when `tty` is already
   `true`.
3. `gitWantsColor(tty)` (`render.go:170-184`): builds a literal
   `"true"`/`"false"` argument from `tty` (`render.go:171-174`), runs
   `git config --get-colorbool color.diff <arg>` (`render.go:179`). With
   an explicit trailing argument, git always exits 0 and prints
   `"true\n"`/`"false\n"` to stdout (verified empirically) rather than
   using the exit-status convention that applies when the argument is
   omitted (documented at `render.go:175-178`). Result is
   `strings.TrimSpace(stdout) == "true"` (`render.go:183`).
4. Any subprocess failure (git missing, non-zero exit) → `false`
   (`render.go:180-182`): **color-off is the fail-safe default.**
5. Net effect: a non-tty writer never consults git at all (step 2's
   short-circuit) and is unconditionally plain, even under
   `color.diff=always`; a tty writer defers entirely to git's
   `color.diff`/`color.ui` merge (opaque to meat — it only ever asks
   about `color.diff`).

### Palette resolution

`palette(color bool)` (`render.go:57-67`):
1. `color == false` → return the zero `diffPalette{}` directly, **no
   subprocess** (`render.go:58-60`).
2. `color == true` → resolve four slots via `diffColor(slot, def)`:
   `meta`/`"bold"`, `frag`/`"cyan"`, `old`/`"red"`, `new`/`"green"`
   (`render.go:61-66`) — up to four `git` subprocess calls per render.
3. `diffColor(slot, def)` (`render.go:189-195`) runs `git config
   --get-color color.diff.<slot> <def>` and returns stdout **completely
   unprocessed** — `return string(out)` (`render.go:194`), no
   `TrimSpace`, unlike `gitWantsColor`. Verified empirically: `--get-color`
   prints only the raw ANSI escape (e.g. `\x1b[1m` for `bold`) with **no
   trailing newline**, so the absence of trimming here is correct, not
   an oversight — a port must not "helpfully" add a trim.
4. Subprocess failure → `""` for that slot (`render.go:191-193`); `def`
   is used by *git*, not Go, as the fallback color name for an
   unconfigured slot (an unconfigured slot still exits 0).
5. `commitColor(p)` (`render.go:105-110`) is a fifth, on-demand slot:
   returns `""` immediately via full-struct equality against the zero
   palette (`render.go:106`, no subprocess), and only then calls
   `diffColor("commit", "yellow")` (`render.go:109`) — queried at most
   once per render, only when at least one main slot is already active.

### Applying color to a diff's lines

`colorizeDiffLine(line, p)` (`render.go:116-134`):
1. **Metadata check first**: `isDiffMeta` (`render.go:139-149`) —
   `"+++"`/`"---"` checked explicitly before anything else
   (`render.go:140-142`), then 12 literal, space-terminated prefixes
   (`render.go:152-165`): `"diff "`, `"index "`, `"old mode "`, `"new
   mode "`, `"new file mode "`, `"deleted file mode "`, `"similarity
   index "`, `"dissimilarity index "`, `"rename from "`, `"rename to "`,
   `"copy from "`, `"copy to "`. Match → `p.meta`.
2. Else `"@@"` prefix → `p.frag`.
3. Else `"+"` prefix → `p.new`.
4. Else `"-"` prefix → `p.old`.
5. Else (context/anything else) → returned unchanged (`render.go:128`,
   distinct code path from the empty-color fallback).
6. Resolved color `""` (unresolved slot, or `palette(false)`) → line
   returned unchanged (`render.go:130-132`).
7. Otherwise wrap as `c + line + ansiReset`, `ansiReset = "\x1b[m"`
   (`render.go:47`) — original text never mutated, only concatenated
   (`render.go:132-133`).

Classification order is load-bearing: checking `isDiffMeta` first
(`render.go:119`, before `:123,125`) is what prevents `"+++"`/`"---"`
file headers from being miscolored as added/removed content.

### Body assembly (`formatBody`, `render.go:72-101`)

1. `res.Summary != ""` (`render.go:74`) → write header: `commitColor(p)`
   non-empty → `<color># <summary><reset>\n`; else plain `"# <summary>\n"`
   (`render.go:77-81`). **Empty `Summary` means no header line at all**
   — a presence decision, not just a color decision.
2. `elision != ""` (`render.go:83-86`) → write `"# <elision>\n"`, always
   plain, no color slot consulted.
3. If anything was written in steps 1-2 (`b.Len() > 0`,
   `render.go:88-90`) → append one blank `"\n"`. If both are empty, **no
   header block, no separator** — output starts directly with diff
   content.
4. `diff := strings.TrimRight(res.SmartDiff, "\n")` (`render.go:91`).
5. `strings.TrimSpace(diff) == ""` (`render.go:92`, Unicode-aware — see
   H14) → write literal `"(no meaningful change to read)\n"` and return
   (`render.go:93-94`) — via bare `WriteString`, never through
   `colorizeDiffLine`, so categorically un-colorizable.
6. Otherwise split on `"\n"` (`render.go:96`) and append
   `colorizeDiffLine(line, p) + "\n"` per line, in original order
   (`render.go:97-99`).

### Pager selection and invocation

Pager selection is **one** subprocess call, not a chain meat itself
walks:
1. `gitPager()` (`render.go:219-225`) runs `git var GIT_PAGER`, trims
   stdout (`render.go:224`). All of "`GIT_PAGER` → `core.pager` →
   `$PAGER` → `less`" (described in this file's own comment,
   `render.go:197-199`) happens **inside git**; meat issues exactly one
   call and takes git's answer verbatim. Environment reaches git via
   ordinary subprocess inheritance (no `Env` override on this call), so
   whatever `$PAGER`/`$GIT_PAGER` meat's process sees, git sees too.
2. Subprocess failure → `""` (`render.go:221-223`).
3. `page(text)` (`render.go:200-216`): pager `""` or literally `"cat"`
   (`render.go:202`) → write `text` straight to `os.Stdout`, **no
   subprocess** (`render.go:203-204`).
4. Otherwise (**H12**): `exec.Command("sh", "-c", pager)`
   (`render.go:206`) — the whole resolved pager string handed to a
   shell as one command line, not tokenized by meat; required because
   `$PAGER`/`core.pager` values legitimately contain arguments and
   pipes.
5. `cmd.Stdin` = a `strings.Reader` over the full rendered `text`
   (`render.go:207`); `cmd.Stdout`/`cmd.Stderr` hardcoded to the
   process's own `os.Stdout`/`os.Stderr` (`render.go:208-209`) — **not**
   the `w` writer `renderResult` received.
6. If `LESS` is not already set (`os.LookupEnv`, `render.go:212`),
   inject `LESS=FRX` by appending to a copy of `os.Environ()`
   (`render.go:213`, mirroring git's own `less` defaults:
   F=quit-if-fits-one-screen, R=raw ANSI passthrough, X=no
   altscreen-clear). If already set, `cmd.Env` stays `nil` → child
   inherits parent env unmodified.
7. `cmd.Run()` blocks, returns its error (`render.go:215`).
8. Back in `renderResult` (`render.go:41-44`): non-nil error from
   `page` → fallback is `io.WriteString(w, body)` — the *original* `w`,
   not `os.Stdout`. Every real call site passes `w = os.Stdout` already,
   so the two paths coincide in practice, but they are textually
   different targets.

## Invariants

- Color is computed once as a single `bool` and threaded through as
  data (`diffPalette`); nothing downstream re-derives tty/color state
  independently (`render.go:33-36`). Violating this would let the
  header/elision-line color and the diff-line color drift out of sync.
- `isDiffMeta` is always checked before the generic `+`/`-` tests in
  `colorizeDiffLine` (`render.go:118-126`). Reordering recolors
  `+++`/`---` headers and all `diffMetaPrefixes` lines as added/removed
  content.
- The "no meaningful change" placeholder (`render.go:93`) is written
  outside the per-line loop and never through `colorizeDiffLine`. If
  ever routed through it, its literal text would become subject to
  prefix-based miscoloring.
- `gitWantsColor`/`diffColor` subprocess failures fail **closed** (no
  color), never open. Breaking this makes colorization silently depend
  on `git` being installed and well-behaved rather than degrading
  gracefully.
- `gitPager`'s output is trimmed; `diffColor`'s is not (verified:
  `--get-color` carries no trailing newline, `--get-colorbool` does,
  `render.go:183` vs `:194`). A port must replicate "no trim" as
  written, not defensively normalize it.
- Non-tty output never invokes git, due to the `&&` short-circuit
  (`render.go:35`). This is the single most important short-circuit to
  preserve: an always-ask-git port adds a subprocess call to every piped
  invocation and could diverge from Go under `color.diff=always` on a
  pipe (Go: plain; naive port: colored).

## Hazards

- **H4**: `enc.SetEscapeHTML(false)` at `render.go:25` deliberately
  disables HTML-escaping so `<`/`>`/`&` in `Summary` round-trip
  literally. `JSON.stringify`'s default matches this by coincidence of
  TS semantics, not because the port explicitly chose it — never add
  escaping. Pinned by G10.
- **H9**: `jsonResult.Elision` alone carries `json:"elision,omitempty"`
  (`render.go:18`); the four embedded `meat.Result` fields carry none
  (`meat/meat.go:99,101,103,104`). Full table above under Data shapes.
  Map `Elision`'s empty case to `undefined` (key omitted); the other
  four must always serialize their key, including `""`/`0`.
- **H12**: four `exec.Command` sites — `render.go:179` (`git config
  --get-colorbool color.diff <bool>`), `render.go:190` (`git config
  --get-color color.diff.<slot> <default>`, up to 5×/render including
  `commit`), `render.go:206` (`sh -c <pager>` — must stay a whole-string
  shell invocation, never tokenized), `render.go:220` (`git var
  GIT_PAGER` — the single call that embodies git's entire
  pager-resolution chain; meat does not reimplement
  `GIT_PAGER`/`core.pager`/`$PAGER`/`less` itself). All use `.Output()`
  except the pager, which uses `.Run()` with live `Stdout`/`Stderr` and
  the entire rendered body pre-buffered into one Go string before
  `page` is called (`render.go:36`) — no streaming to the pager.
- **H14**: `render.go:92`, `strings.TrimSpace(diff) == ""`, is a
  branch-selecting trim in the same family already catalogued for
  `elision.go`/`diff.go` — it decides between the diff body and the
  fixed placeholder line. Go's `TrimSpace` includes U+0085, excludes
  U+FEFF; JS `.trim()` is the reverse. Not currently exercised by any
  fixture. This site has been added to `migration/HAZARDS.md`'s H14
  entry.
- **H8**: not live here — `InputTokens`/`OutputTokens` are serialized
  unmodified, never divided or truncated by this file.
- Checked and inapplicable: H1/H2/H3 (no byte/rune indexing beyond
  ASCII-safe `\n`-splitting and fixed-literal `HasPrefix`, no regex), H6
  (no `context.Context`/`AbortSignal` use anywhere in this file — the
  git/pager subprocesses are **not** cancellable, unlike `tools.go`'s
  `git grep`), H7/H13 (no sorting, no maps — `diffMetaPrefixes` is a
  fixed-order slice walked linearly, `render.go:143-147`, already
  deterministic), H10 (no path confinement), H11 (build-tag split is
  `isatty_*.go`'s territory), H15 (no ambiguous-nil-vs-zero state beyond
  the H9 field), H16 (no indentation-width logic).

## Errors

`render.go` defines **no custom error strings** — no
`fmt.Errorf`/`errors.New` anywhere in the file. Every failure is a
stdlib `error` value, and every one is swallowed into a plain-value
fallback, never surfaced:

- `gitWantsColor` subprocess error → `false`, silent
  (`render.go:180-182`).
- `diffColor` subprocess error → `""` for that slot, silent
  (`render.go:191-193`).
- `gitPager` subprocess error → `""`, silent, falls into `page`'s
  direct-write branch (`render.go:221-223`).
- `page`'s error (direct-write failure, or `cmd.Run()` failure from a
  broken/missing pager) propagates to `renderResult`, which on any
  non-nil error falls back to `io.WriteString(w, body)` with **no
  logged diagnostic** (`render.go:41-44`); `renderResult` itself returns
  nothing.
- `renderJSON` never checks `enc.Encode`'s error (`render.go:26`);
  unreachable in practice since `jsonResult`'s fields are all
  primitives/strings.

Net: this file is entirely fail-silent toward subprocess/I-O errors —
the only observable consequence of any failure is a degraded rendering
(plain vs. colored, direct-write vs. paged), never a crash or
user-visible message.

## Ordering that Go leaves unspecified

None. No `sort.*` call, no map, no goroutine/concurrency anywhere in
`render.go` — `diffMetaPrefixes` is a fixed-order slice walked linearly
and the diff-line loop preserves input order exactly.

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
- **Stage 2 reconciliation: G1-G10 all confirmed, no mismatches.** Two
  points where the mechanism extends what stage 1 could only partially
  pin: (1) G9's exit-status-vs-printed-text distinction for
  `--get-colorbool` was independently verified by direct invocation
  (`git config --get-colorbool color.diff true` prints `true\n`/exits
  0), confirming the source comment's claim is accurate, though this
  remains untested by any `go test` run; (2) G10's `omitempty`-on-`Elision`
  question has a directly relevant fixture —
  `cmd/meat/conformance_dump_test.go:69` includes a `"no-elision"` case
  — but that file is opt-in conformance-vector scaffolding
  (`DUMP_VECTORS=<dir>`, skipped by default, dumps vectors for the TS
  port rather than asserting Go's own output), so the open question
  stands: no ordinary `go test` run asserts on it today.
- **`diffColor`'s untrimmed-stdout behavior** (no `TrimSpace`, unlike
  `gitWantsColor`) was verified empirically, not by any Go test — no
  guarantee mentions it; a port must not "helpfully" trim it.
- **`commitColor`'s subprocess-avoidance short-circuit** (queried at
  most once per render, only when some other palette slot is already
  active) has no guarantee constraining the "at most once, gated"
  behavior itself, only that it's `""` under the zero palette (G1).
- **`renderResult`'s page-failure fallback writes to `w`, not
  `os.Stdout`** — a real distinction in the code (harmless today only
  because every real caller passes `w = os.Stdout`), not mentioned by
  any guarantee.
- **Pager resolution is one subprocess call embodying git's entire
  fallback chain** (`GIT_PAGER` → `core.pager` → `$PAGER` → `less`),
  not something meat reimplements — important for port fidelity,
  uncovered by any guarantee.
- **Dead-code check: none found.** Every function in `render.go` is
  called either from within the file, from `main.go`, or directly from
  test files. One production-unreachable-but-not-dead branch:
  `gitWantsColor`'s `tty=false` argument path is only reached via direct
  unit-test calls (`render_test.go:173`), never via the real call graph,
  because `render.go:35`'s `&&` short-circuit means the production call
  site only ever passes `true`.
