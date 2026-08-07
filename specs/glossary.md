# Glossary

Shared vocabulary, defined once. Link here from subject specs rather than
redefining terms locally. Terms are grouped by the subject that owns them;
grouping is informational, not a restriction on where a term may be used.

## Edit plans (`editplan.md`)

**Edit plan** — the model- or hand-authored set of `remove` / `replace` /
`fold` operations, expressed in *source coordinates*: 1-based, inclusive
physical line numbers of the original raw diff. Contains no prose.
`meat/editplan.go:27-55`.

**Remove** — a line range hidden entirely; the rendered reading diff carries
no trace of it, not even a placeholder. `meat/editplan.go:399-401`.

**Fold** — a contiguous range of one hunk's source lines, on one side (`+`,
`-`, or context), collapsed into a single machine-rendered ellipsis row. The
placeholder is always the three ASCII characters `"..."` (never the Unicode
`…`), carrying the fold's marker byte and the common leading indentation of
the folded lines. `meat/editplan.go:391-398,421-470`.

**Replace** — a single-line, in-place elision of one hunk source line.

**Reading diff / `smartDiff`** — the compiled, human-facing output of
`compileEditPlan`: what a reviewer reads, as opposed to the immutable raw
unified diff. `meat/editplan.go:119`.

## Moves (`moves.md`)

**Move / move pair / detected move** — an exact, source-evidenced relocation
of a changed block between two different hunks: a `Removed` line range and an
`Added` line range whose bodies are byte-identical modulo one constant
per-row indentation offset. `meat/moves.go:20-23`, algorithm
`meat/moves.go:58-198`.

**Move symmetry** — the invariant that every row of a detected move pair
receives identical compression treatment (kept / removed / folded, including
matching fold boundaries) on both sides. Enforced by `validateMoveSymmetry`
`meat/moves.go:352-394`; a violation names both sides' full move coordinates,
not just the offending row. See `moves.md` G2, G14.

**Exact interior** — only the contiguous matching interior of two change
runs is reported as the move; non-matching wrapper lines on either side are
excluded from the pair. See `moves.md` G10.

**Uniform reindent** — one constant indentation-column offset between every
non-blank aligned row of a candidate; per-row varying indent is not a move.
See `moves.md` G8, G12.

**Local elision (move)** — a model-authored `replace` on a kept move
endpoint; both sides must yield the same indent-normalized body after
replacements (`validateMoveReplacementSymmetry` `meat/moves.go:396-439`).
See `moves.md` G15–G18.

**Move pair notation** — prompt/feedback form
`-<start>..<end> ↔ +<start>..<end>` (e.g. `-6..9 ↔ +16..19`)
`meat/moves.go:474`.

**Canonical surface move fixture** — `surfaceFixtureDiff`
(`meat/rubric.go:18-36`), aliased as `exactMoveDiff` in move tests
(`meat/moves_test.go:12`): one exact cross-file move at removed 6–9 ↔
added 16–19.

## Imports (`imports.md`)

**Compiler-owned / mandatory import removal** — the deterministic pass,
independent of any model or hand-authored plan, that decides which
import-declaration lines are hidden in every rendering regardless of plan
content. Authored plans may not explicitly target these rows.
`mandatoryImportRemovalPlan` `meat/imports.go:156-250`. See `imports.md` G1,
G7.

**Import scaffolding** — declaration openers, members, closers, and framing
the reading diff must not retain (`import (`, package paths,
`from … import`, `require(…)`, `use`, `#include`, etc.). See `imports.md`
G7–G8.

**Embedded import** — import-like rows inside a source string/fixture
(Python `"""…"""`, Go raw strings), including truncated and cross-language
content. See `imports.md` G9, `rubric.md` G10.

**Guarded Python import** — `try`/`except`/`if TYPE_CHECKING` (and similar
suite owners) whose indented body is only imports — framing is dropped with
the imports. A **mixed guarded suite** mixes import rows with non-import
body: imports drop; owner/skeleton and non-import body stay. See
`imports.md` G14–G15.

**Hunk section text** — the free text after the second `@@` on a hunk
header; **not** authority for classifying body rows as imports. See
`imports.md` G13.

**Crossing fold (imports)** — a fold spanning some mandatory-import rows
**and** some non-import behavioral rows; rejected with
`crosses automatically removed import rows`. See `imports.md` G18.

**Move-precedence extension** — an exact counterpart row of an
already-mandatory-hidden row becomes mandatory-hidden too, even across a
file-extension boundary that alone would not classify it as import content
— this is what lets a moved import block stay hidden on both sides.
`meat/moves.go:265-280`. See `imports.md` G6, `moves.md` G19–G21,
`chunk.md` G25.

## Chunking (`chunk.md`)

**Chunk** — one independently abridgeable slice of an oversized diff,
produced by splitting at file, then hunk, then sub-hunk boundaries; each
chunk is abridged by its own agent run with the same rubric, then merged
back together. `meat/chunk.go:52-78`. Full vocabulary (section, hunk run,
segment/sub-hunk, cut, atomic unit, passthrough, gap convention, etc.) is
defined in `chunk.md`.

**Chunk-coordinate move mapping** — at chunk level, moves are never
independently re-detected (`glossary.md`'s "move" detection is a strictly
whole-diff property); only whole-diff-detected moves whose both sides land
contiguously within one chunk are enforced there, translated into that
chunk's own 1-based coordinates. `meat/chunk.go:1003-1041`. See `moves.md`
G3-G7.

## Agent loop (`agent-loop.md`)

**Turn** — one full round-trip through the agent loop: one model call plus
dispatch of every tool call in its reply. **Run** — one execution of the
loop, either the whole diff or one chunk. **Fallback** — a held-back draft
submission returned when a refinement turn can't complete. **Nudge** — the
fixed text sent when the model replies with no tool call. Full definitions
in `agent-loop.md`.

## Tools (`tools.md`)

**Retention pressure** — a boolean computed from a compiled plan's
`rawChanged`/`visibleChanged` stats that signals "the plan is keeping too
much" and triggers exactly one refinement turn. Exact formula and boundary
values in `tools.md` G1. Also used by `imports.md` G21 (identity plan on a
high-retention fixture forces refinement then fallback while remaining
import-free).

## Rubric (`rubric.md`)

**Live-LLM rubric e2e** — opt-in, costed, stochastic smoke tests gated by
`MEAT_E2E=1`; call a real model and assert semantic minima, import absence,
retention ceilings, and no-semicolon-packing — not golden bytes. See
`rubric.md` G7–G12, `test-infrastructure.md`.

**Semantic minimum** — a load-bearing retained substring (or any-of set of
alternatives) that a live reading diff must contain under the e2e suite;
deliberately looser than hermetic golden plans. See `rubric.md` G11.

**Semicolon packing** — cramming several statements onto one added (`+`)
line with `;` instead of dropping uninteresting lines. Live e2e forbids it
except on `for ` lines and `;` inside trailing `//` comments. See
`rubric.md` G12.

## Providers (`providers.md`)

**Backend dispatch** — the model-id-string rule that picks which built-in
`Model` implementation to construct: an id starting with `claude-` (after
stripping an optional `anthropic/` prefix) dispatches to Anthropic; every
other id dispatches to OpenAI. `meat/provider.go:31-42`. See `providers.md`
G2.

**exe.dev managed gateway / managed gateway discovery** — an operator-hosted
reverse proxy that forwards requests to a real provider with credentials
injected at the network edge, so no provider API key needs to live on the
VM. Discovered via a two-gate check — an exe.dev marker file's presence, then
a reflection-endpoint lookup for an attached `"llm"`-type integration — and
used by both provider constructors only when no explicit credential is set
in the environment. `meat/gateway.go:28-73`. See `providers.md` G3-G9,
G16-G17.

**Implicit / edge-injected credential** — the fixed placeholder API-key
string (`"implicit"`) sent to the gateway in place of a real key; the
gateway substitutes the real managed key before forwarding, so the
placeholder itself carries no secret. `meat/anthropic.go:36`. See
`providers.md` G8.

**Opaque provider state (`ProviderData`)** — output from one provider call
(a reasoning trace, a tool-call envelope) that the generic agent loop must
replay unchanged on a later call without interpreting it. Every OpenAI
output item is tagged with its raw bytes this way, and replaying those bytes
verbatim takes priority over re-encoding a block from its normalized fields.
`meat/model.go:41-47`. See `providers.md` G22.

## Cache (`cache.md`)

**Cache key** — the SHA-256 hex digest naming a cached result, computed
from three NUL-separated fields in fixed order: rubric hash, model id, diff
text. `cmd/meat/cache.go:26-41`. See `cache.md` G1.

**Rubric hash** — the value actually passed as the cache key's "rubric"
input: not raw rubric prose but a hash of the complete rubric/compiler
protocol, so upgrading model guidance or a hard compiler invariant
invalidates every previously cached entry. See `rubric.md`'s
`RubricHash`/`promptSurface`, `cache.md` G1.

**Write-through (refresh)** — storing a freshly computed result under a key
that already had a (possibly stale) entry, unconditionally overwriting it;
this is what `-no-cache` does — it skips the cache *read* only. See
`cache.md` G7.

## Render (`render.md`)

**Diff palette / palette slot** — the four independently-resolved color
assignments (`meta`, `frag`, `old`, `new`) used to colorize one rendered
unified diff, one per unified-diff line kind. See `render.md` G3, G5.

**`gitWantsColor`** — the tty-aware query of git's `color.diff`/`color.ui`
policy that gates whether a render colorizes at all; color is never decided
unconditionally by "is this a tty." See `render.md` G9.

## Python (`python.md`)

**Suite owner / suite header** — a Python line ending in `:` that opens an
indented block (`def`, `class`, `if`, `for`, etc.); its indented body must
survive if the header is retained, and vice versa. **Structural anchor** —
the decorator or suite-header line itself, which folds/replacements must
never touch, only its interior. Full vocabulary (delimiter balance,
triple-quote parity, backslash continuation, reference guard) in
`python.md`.
