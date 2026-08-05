# Go → TypeScript hazard register

Places where a faithful-looking translation is wrong. Stage 2 specs **must cite
the relevant hazard by number** wherever the Go code depends on one of these
semantics; stage 3 must check the register before porting any file listed under
"Affects".

Severity is "how likely is this to ship silently and corrupt output", not "how
hard is it to fix".

---

## H1 — Go strings are UTF-8 bytes; JS strings are UTF-16 code units
**Severity: critical. Affects: everything in `meat/`.**

In Go, `len(s)`, `s[i]`, and `s[a:b]` are **byte** operations on the UTF-8
encoding. `strings.Index`, `strings.Count`, and every regexp offset return byte
offsets. In JavaScript, `.length`, `[i]`, and `.slice()` are UTF-16 code units.
For ASCII these agree exactly, which is why this bug ships: every existing test
fixture is ASCII, and every real-world diff containing an accented identifier, a
CJK string literal, or an emoji in a comment silently misaligns.

`meat` is saturated with byte indexing — roughly 460 lines across 13 files match
a byte-indexing grep, concentrated in `imports.go`, `python.go`, `chunk.go`,
`editplan.go`, `diff.go`, and `moves.go`. Its budgets are byte budgets:

| Constant | Value | Where |
|---|---|---|
| `maxDiffBytes` | `400 << 10` | `meat/meat.go:51` |
| `maxTotalDiffBytes` | `4 << 20` | `meat/chunk.go:42` |
| `maxToolOutput` | `16 * 1024` | `meat/tools.go:19` |
| `maxReplacementBytes` | `4 << 10` | `meat/editplan.go:21` |
| `maxSummaryBytes` | `500` | `meat/editplan.go:22` |
| `minMoveNonspaceBytes` | `48` | `meat/moves.go:13` |

And it manipulates encoding directly: `utf8.RuneStart` to avoid cutting a
codepoint when truncating tool output (`meat/tools.go:355`), `utf8.RuneLen` to
count non-space bytes for move eligibility (`meat/moves.go:249`),
`utf8.ValidString` to reject malformed text (`meat/editplan.go:651`).

**Decision: the engine operates on `Uint8Array`.** `diff`, `chunk`, `editplan`,
`imports`, `moves`, and `python` take and return bytes. Decoding to `string`
happens only at the CLI boundary and the model-API boundary. Every offset,
range, and budget in the ported engine is a byte offset by construction, so the
class of bug cannot occur.

Consequences to plan for:
- Build a small byte-slice utility layer first (index-of, split-lines, compare,
  has-prefix, concat, trim). Everything else depends on it, so it is TODO item
  one and it gets the most tests.
- `lineRange` coordinates are 1-based **physical line** numbers, not byte
  offsets (`meat/editplan.go:27-29`) — those port unchanged.
- Never `TextDecoder` mid-pipeline "just to use a string method".
- Where you must run a regex, see H3 for the latin1 trick that keeps offsets
  byte-exact.

## H2 — `[]rune` is codepoints; `.split('')` is not
**Severity: high. Affects: `editplan.go`, `moves.go`.**

`newRunes := []rune(new)` (`meat/editplan.go:572`) iterates Unicode codepoints.
The JS equivalent is `Array.from(s)` or `for...of`, **not** `s.split('')` or
`s[i]`, which yield UTF-16 code units and split surrogate pairs in half. Same
for `for _, r := range s` — Go ranges a string by rune, giving `(byteOffset,
rune)` pairs; the byte offset advances by 1–4 per iteration.

Also affected: `unicode.IsLetter` / `IsNumber` / `IsSpace` / `IsControl`
(`meat/moves.go:206,248`, `meat/editplan.go:659`) are full Unicode property
tests. JS has no built-in equivalent — use `/\p{L}/u`, `/\p{N}/u`, `/\p{Cc}/u`
with the `u` flag. Do not approximate with ASCII ranges; move eligibility and
text validation depend on them.

## H3 — RE2 vs. JavaScript's backtracking regex engine
**Severity: high. Affects: `imports.go`, `editplan.go`.**

Three distinct problems.

**(a) Catastrophic backtracking on a model-authored pattern.**
`meat/editplan.go:630` compiles a regex assembled at runtime from the model's
`new` string: quoted literals joined by `.+`, one per visible ellipsis, anchored
`^…$`. Go's RE2 guarantees linear time regardless of input. JavaScript's engine
backtracks, and `^lit.+lit.+lit$` failing to match is the classic exponential
shape. The input is model-authored and only bounded at 4 KiB
(`maxReplacementBytes`), so a degenerate submission could hang the CLI — a
robustness regression that exists in TypeScript and cannot exist in Go.

**Port this as a literal scan, not a regex.** The pattern's meaning is exactly:
the first literal is a prefix, the last is a suffix, and each remaining literal
occurs in order with at least one character between neighbours. A leftmost
greedy two-pointer scan decides that in linear time and is equivalent for the
existence question, because the `.+` gaps are otherwise unconstrained. Record
the equivalence argument in the spec.

**(b) `\s` means different things.** Go's RE2 defines `\s` as `[\t\n\f\r ]` —
ASCII only, and notably excluding vertical tab. JavaScript's `\s` additionally
matches `\v`, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
U+3000, and U+FEFF. Every import-detection pattern in `meat/imports.go:742-762`
uses `\s`. A non-breaking space before a Python `import` would be treated as an
import row by the port and not by Go.

**Replace every `\s` with an explicit `[\t\n\f\r ]` when porting these
patterns.** `\w` and `\d` are identical in both engines and need no change.

**(c) Offsets.** Go regexp returns byte offsets; JS returns UTF-16 indices. If
you must regex a byte slice, decode with **latin1** (`Buffer.from(b).toString('latin1')`),
which maps one byte to one code unit, so match indices *are* byte offsets. This
is safe here because every pattern in `imports.go` is ASCII-anchored — but it is
only safe once (b) is fixed, since UTF-8 continuation bytes decode to latin1
characters that JS `\s` would match.

Also: Go's `(?s)` flag is JS's `s` flag. Go's `^`/`$` default to whole-text
anchors (as JS does without `m`), and neither matches before a trailing newline,
so those agree.

## H4 — `json.RawMessage` is byte-preserving; `JSON.parse` is not
**Severity: high. Affects: `openai.go`, `anthropic.go`, `model.go`.**

`Block.ProviderData` carries opaque provider state that "must be replayed
exactly on a later turn" (`meat/model.go:41-46`) — for OpenAI reasoning models
this is encrypted reasoning items, which are cryptographically bound to their
exact bytes. Go stores them as `json.RawMessage`: raw bytes, never parsed,
validated with `json.Valid` and copied with `bytes.Clone`
(`meat/openai.go:265-268`).

A `JSON.parse` → `JSON.stringify` round-trip is **not** byte-identical. It
normalizes whitespace, reformats numbers (`1.0` → `1`, precision loss beyond
2^53), and rewrites `\u` escapes. Round-tripping encrypted reasoning items
through it will produce state the provider rejects.

**Port `RawMessage` as an opaque `Uint8Array`/string wrapper that is never
parsed**, spliced into the outgoing request body as pre-serialized text. This
means the OpenAI request body cannot be built with a single `JSON.stringify` —
it needs a serializer that can inline raw fragments. `Tool.InputSchema`,
`Block.ToolInput`, and the OpenAI `Input`/`Output` item arrays are all
`RawMessage` too.

Related: Go's `encoding/json` escapes HTML by default and `render.go:25` turns
that **off** via `SetEscapeHTML(false)`. `JSON.stringify` does not escape HTML,
so the ported output matches — but only because the Go side disabled it. Don't
"helpfully" add escaping.

## H5 — Error wrapping and sentinel identity
**Severity: medium. Affects: `chunk.go`, `meat.go`, and all callers.**

`fmt.Errorf("...: %w", err)` builds a chain that `errors.Is`/`errors.As` walk.
`chunkError` implements `Unwrap` explicitly so cancellation, deadline, and typed
model errors survive chunk wrapping (`meat/chunk.go:895-908`), and
`TestAbridge_ChunkedErrorPreservesUnwrap` guards it.

TypeScript's equivalent is `new Error(msg, { cause: err })`. There is no
`errors.Is`, so write an explicit `hasCause(err, predicate)` walker. Go's
sentinel errors (`context.Canceled`, `context.DeadlineExceeded`) are compared by
identity; the Node analogues are `AbortError` / `TimeoutError` distinguished by
`err.name`, which is a string comparison and therefore weaker. Define named
error classes and use `instanceof`.

`meat.go:169` and `:228` branch on `callerCtx.Err() != nil` to distinguish
"caller cancelled" from "our own budget expired" — the fallback path depends on
telling those apart, so the port needs two distinguishable abort signals, not
one.

## H6 — `context.Context` → `AbortSignal`
**Severity: medium. Affects: `meat.go`, `chunk.go`, `tools.go`, both providers.**

`context.WithTimeout` composes: the derived context fires on its own deadline
*or* the parent's cancellation. `AbortSignal.any([parent, AbortSignal.timeout(ms)])`
is the direct equivalent (Node ≥ 20). Two consumers to wire:
- `fetch(url, { signal })` for both providers.
- `exec.CommandContext` for `git grep` (`meat/tools.go:188`) — Node's
  `child_process` accepts `{ signal }` and kills the process on abort.

Durations are `time.Duration` nanoseconds in Go and milliseconds in JS.
`defaultBudget = 4 * time.Minute` → `240_000`. Tests override `abridgeBudget`
to `20 * time.Millisecond` (`meat/meat_test.go:293`), so the port needs the same
injection seam.

## H7 — Sort stability is backwards from the intuition
**Severity: medium. Affects: `moves.go`, `editplan.go`.**

`sort.Slice` is **not** stable; `Array.prototype.sort` **is** (mandated since
ES2019). So the port is more deterministic than the original — but if any Go
comparator leaves ties, Go's output for those ties was unspecified, and the
golden fixtures happened to freeze one particular Go outcome.

Call sites: `meat/moves.go:118,172` and `meat/editplan.go:354`. When specifying
these, **write out the comparator's full ordering including tie-breaking**, and
check whether ties are actually reachable. If they are, the port must add an
explicit final tie-breaker rather than inherit whatever Go's pdqsort did.

`sort.SearchInts` (`meat/elision.go:122`) is a plain binary search for the
leftmost insertion point — no JS equivalent, write it.

## H8 — Numbers
**Severity: medium. Affects: arithmetic on offsets and counts.**

Go `int` is 64-bit and `/` on ints truncates toward zero. JS numbers are IEEE
doubles and `/` is float division. **Every ported integer division needs
`Math.trunc()` or `| 0`.** `%` already agrees (both truncate toward zero).

Byte offsets here are bounded by `maxTotalDiffBytes` (4 MiB), far under 2^53, so
precision is not a concern — only the division. Token counts are also safe.
Consider a `branded type` for byte offsets so they can't be mixed with line
numbers.

## H9 — `nil` slice vs. empty slice in JSON
**Severity: medium. Affects: the `-json` wire form.**

Go marshals a `nil` slice as `null` and an empty non-nil slice as `[]`. That
distinction is invisible in the Go source and load-bearing in the output. The
`Result` struct has no slice fields today, so this is currently latent — but
`omitempty` is live: `jsonResult.Elision` is `json:"elision,omitempty"`
(`cmd/meat/render.go:18`), which omits the key when the string is empty. In
TypeScript, assigning `undefined` omits the key and `""` does not. Match Go's
`omitempty` semantics per field, deliberately.

The `-json` output is consumed by CI bots. It is a compatibility contract.

## H10 — Path confinement must be ported verbatim, not "improved"
**Severity: medium (security). Affects: `tools.go`.**

`meat/tools.go:124-136` confines the model's `read_file` tool to the repo root:
clean the relative path, reject absolute paths, resolve both sides with
`filepath.Abs`, and require the result to equal the root or start with
`root + separator`. It deliberately does **not** resolve symlinks.

Port the same algorithm with `path.resolve` and the same prefix check. Do not
substitute `fs.realpath` — that changes the security properties in both
directions and would diverge from the Go behavior the tests pin. Note that Go's
`filepath.Clean` and Node's `path.normalize` differ on a few edge cases
(trailing slashes, `..` above root); the spec should enumerate the cases the
tests actually cover.

## H11 — The isatty build-tag family collapses to one line
**Severity: low (a simplification). Affects: `cmd/meat/isatty_*.go`.**

Four files, four build tags, `syscall.Syscall` with `unsafe.Pointer` and
per-platform TCGETS/TIOCGETA ioctl numbers — all to answer "is fd a terminal".
Node answers it with `tty.isatty(fd)`. Similarly `stdinIsPiped`'s
`os.ModeCharDevice` check (`cmd/meat/stdin.go:17`) becomes `!process.stdin.isTTY`.

Delete the platform split; do not port it. This is the one place the port gets
strictly simpler, and it should be noted in the spec as an intentional
divergence so a later reader doesn't think coverage was lost.

## H12 — Subprocess and stream buffering
**Severity: low. Affects: `render.go`, `main.go`, `tools.go`, `openai.go`.**

- `exec.Command(...).Output()` captures stdout and treats a non-zero exit as an
  error; Node's `execFile` callback style differs on both counts. Wrap once,
  centrally.
- `exec.Command("sh", "-c", pager)` (`cmd/meat/render.go:206`) runs the pager
  through a shell — preserve that, `$PAGER` values legitimately contain
  arguments and pipes.
- `bufio.Scanner` has explicit buffer caps that are part of behavior:
  1 MiB per line in `tools.go:335`, 16 MiB in `openai.go:419` for SSE frames.
  Exceeding them is an error, not a truncation. Node streams have no such cap,
  so the port must impose these limits explicitly or lose an error path the
  tests may exercise.

## H13 — Map iteration order
**Severity: low. Affects: `openai.go`.**

Go randomizes map iteration order deliberately; JS `Map` and object key order
are deterministic. The one place it matters is the OpenAI streaming reassembly,
which buffers items in `map[int]json.RawMessage` and then sorts the indices
(`meat/openai.go:384,449`) — already deterministic, so it ports directly. Keep
the explicit sort even though a JS `Map` would preserve insertion order; the
sort is the actual contract.

## H14 — Whitespace trimming differs at the edges
**Severity: low. Affects: anywhere `strings.TrimSpace` is used.**

Go's `strings.TrimSpace` uses `unicode.IsSpace`, which includes U+0085 (NEL) but
**not** U+FEFF. JavaScript's `String.prototype.trim` includes U+FEFF but **not**
U+0085. Two codepoints of divergence, both plausible in real source files (BOM
in particular). Where trimming decides whether a diff is empty
(`meat/meat.go:119`) or a summary is blank (`meat/editplan.go:635`), write an
explicit trim helper matching Go's set rather than calling `.trim()`.

## H15 — Zero values and strict mode
**Severity: low (mostly a benefit).**

Go zero-initializes every struct field; `strict` TypeScript with
`exactOptionalPropertyTypes` will force each one to be explicit. That is the
point — see [`TARGET.md`](TARGET.md). Two things to watch: a Go `nil` pointer
receiver can be a meaningful state (`tb.submittedPlan != nil` at
`meat/meat.go:204` gates the retention nudge), and Go's `nil` map/slice reads as
empty rather than throwing. Prefer explicit `null` over `undefined` for ported
nil pointers so the distinction stays visible.

---

## Register new hazards here

Format: `## Hxx — one-line claim` / severity + affected files / what Go does
with a citation / what JS does / the decision. Anything discovered in stage 2 or
3 that a reader of the specs alone would get wrong belongs here.
