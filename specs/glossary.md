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
not just the offending row. See `moves.md` G2.

## Imports (`imports.md`)

**Compiler-owned / mandatory import removal** — the deterministic pass,
independent of any model or hand-authored plan, that decides which
import-declaration lines are hidden in every rendering regardless of plan
content. Authored plans may not explicitly target these rows.
`mandatoryImportRemovalPlan` `meat/imports.go:156-250`. See `imports.md` G1.

**Move-precedence extension** — an exact counterpart row of an
already-mandatory-hidden row becomes mandatory-hidden too, even across a
file-extension boundary that alone would not classify it as import content
— this is what lets a moved import block stay hidden on both sides.
`meat/moves.go:265-280`. See `imports.md` G3, `chunk.md` G25.

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
values in `tools.md` G1.

## Python (`python.md`)

**Suite owner / suite header** — a Python line ending in `:` that opens an
indented block (`def`, `class`, `if`, `for`, etc.); its indented body must
survive if the header is retained, and vice versa. **Structural anchor** —
the decorator or suite-header line itself, which folds/replacements must
never touch, only its interior. Full vocabulary (delimiter balance,
triple-quote parity, backslash continuation, reference guard) in
`python.md`.
