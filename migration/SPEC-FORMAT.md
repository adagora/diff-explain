# Spec format and the citation contract

How stages 1 and 2 write to `specs/`. Stage 3 reads nothing else.

## The contract

A specification is a **language-neutral description of behavior**, where every
non-obvious claim carries a **citation** back to the Go implementation.

The two halves do different jobs:

- **The prose** is what stage 3 works from. It must make sense to someone who
  has never read Go, and it must not smuggle in Go idioms. "Returns a slice of
  `sourceLine`" is a leak. "Yields one record per physical line, each carrying
  its text and its line terminator" is a spec.
- **The citation** is the escape hatch. When the prose runs out — an edge case
  it didn't anticipate, an ordering it left implicit — stage 3 opens the cited
  lines and reads the real thing. Citations are what let the specs be *lossy*
  without being *wrong*.

Without citations, specs strand the porter the moment prose gets thin. Without
prose, the specs are just Go and the port inherits Go's shape. Both, or neither.

## Citation syntax

```
`meat/editplan.go:354`          one line
`meat/chunk.go:895-908`         a range
`meat/imports.go:742`           a declaration
```

Rules:

1. **Verify every citation.** Open the file, confirm the line says what the
   claim says. An unverified citation is worse than none — it sends stage 3
   somewhere misleading and costs more than it saves.
2. **Cite at the claim**, inline, not in a footer. The point is that a reader
   hitting an ambiguity has the pointer right there.
3. **Cite the smallest range that proves the claim.** `chunk.go` is not a
   citation. `chunk.go:895-908` is.
4. **Cite tests for guarantees, source for mechanism.** A guarantee is real
   because a test pins it; a mechanism is real because the code does it.
5. **Prefer function-level ranges over exact lines for long-lived claims** —
   they survive edits better. Use exact lines for constants and one-liners.

## File layout

One spec per subject; subjects mirror Go source files.

```
specs/
  INDEX.md        coverage table — the loops' progress ledger
  glossary.md     shared vocabulary, defined once
  constants.md    every named limit: value, unit, citation
  diff.md  chunk.md  editplan.md  imports.md  moves.md  python.md
  elision.md  rubric.md  tools.md  agent-loop.md  model.md
  providers.md  cli.md  cache.md  render.md
```

**Both stages write to the same file.** Stage 1 fills the guarantee sections
from tests; stage 2 fills the mechanism sections from source. Stage 2 must
reconcile with what stage 1 already wrote — if the source contradicts a
guarantee, that is a finding, and it goes in "Open questions" rather than being
silently overwritten.

One test file may contribute guarantees to several specs; that is expected.
`meat_test.go` touches `agent-loop.md`, `rubric.md`, and `chunk.md`.

## Template

````markdown
# <subject>

> Status: stage 1 ✅ | stage 2 ⬜
> Go sources: `meat/diff.go`
> Go tests: `meat/chunk_test.go` (splitting), `meat/editplan_test.go` (layout use)

## Purpose

Two or three sentences. What this subject is responsible for and what depends on
it. No Go.

## Vocabulary

Terms this spec introduces, or a pointer to `glossary.md`. Define a term once,
in one place, and link to it everywhere else.

## Guarantees            ← stage 1, cited to tests

Numbered, each independently checkable, each with the test that pins it.

G1. A physical line's classification never changes after parsing; downstream
    stages read the layout and never re-parse the diff text.
    — `meat/diff.go:1-8`, pinned by `meat/chunk_test.go:300` (import blocks are
    never severed across a cut).

G2. …

## Mechanism             ← stage 2, cited to source

How it works, in enough detail to reimplement. Algorithms as prose or numbered
steps. Data shapes described by their meaning, not their Go types.

Splitting proceeds in three escalating attempts `meat/chunk.go:6-8`:
1. Between file sections, if any single file fits the budget.
2. Between hunks of one oversized file.
3. Between synthesized sub-hunks of one oversized hunk, as a last resort.

A chunk continuing a split file replicates that file's metadata block; a chunk
beginning mid-hunk receives a synthesized `@@` header whose counts match exactly
the lines it carries `meat/chunk.go:9-11`.

## Invariants

Things that must hold and are easy to break. State the consequence of breaking
each.

- A chunk boundary never falls inside a string literal or between a
  no-newline marker and its line `meat/chunk.go:18-19`.

## Hazards

Hazards from `migration/HAZARDS.md` that apply here, by number, with the
specific sites.

- **H1** (byte offsets): budgets are byte budgets — `maxDiffBytes`
  `meat/meat.go:51`, `maxTotalDiffBytes` `meat/chunk.go:42`.
- **H7** (sort stability): `meat/moves.go:118` — comparator ties are reachable;
  see the ordering written out under Mechanism.

## Errors

Every failure mode and its exact message, since tests assert on message text.

- Oversized total diff: `meat: diff is %dMB, over the %dMB limit — try a
  narrower range (…)` `meat/meat.go:123`.

## Open questions

Anything genuinely unresolved. Not a place for "I didn't look" — a place for
"the source and the tests disagree", or "this ordering is unspecified in Go and
the port must choose". Empty is a valid and good state.
````

## `constants.md`

A single table of every named limit in the codebase — value, unit, citation, and
what happens at the boundary. Units are the point: `maxDiffBytes` is **bytes**
(H1), `defaultMaxTurns` is **model round-trips**, `defaultBudget` is **wall-clock
time in nanoseconds** (H6). A port that gets a unit wrong produces a plausible
binary that fails only on large or slow inputs.

| Name | Value | Unit | Citation | At the boundary |
|---|---|---|---|---|
| `maxDiffBytes` | `400 << 10` | bytes | `meat/meat.go:51` | Split into chunks |
| `maxTotalDiffBytes` | `4 << 20` | bytes | `meat/chunk.go:42` | Hard error |
| `maxChunks` | `32` | count | `meat/chunk.go:50` | … |
| `defaultMaxTurns` | `24` | turns | `meat/meat.go:36` | … |
| `defaultBudget` | `4 * time.Minute` | ns | `meat/meat.go:40` | … |

Include the test-injection seams — `abridgeBudget` and `singleRunDiffBytes` are
`var`, not `const`, precisely so tests can shrink them (`meat/meat.go:44,55`).
The port needs equivalent seams or those tests cannot be ported.

## `INDEX.md`

The loops' progress ledger. One row per Go file.

| Go file | Spec | Stage 1 | Stage 2 | Notes |
|---|---|---|---|---|
| `meat/diff.go` | `diff.md` | ✅ | ✅ | |
| `meat/chunk.go` | `chunk.md` | ✅ | ⬜ | |

A stage's exit gate is this table, fully ticked.

## Anti-patterns

Each of these has sunk a port before.

**Transliterated Go.** If the spec says "returns `(*Result, error)`", stage 3
writes Go in TypeScript. Say what it produces and how it fails.

**Uncited assertions.** "Chunks are merged carefully" tells stage 3 nothing and
gives it nowhere to look.

**Whole-file citations.** `see meat/chunk.go` is a 1,086-line homework
assignment, not a citation.

**Implementation instructions.** "Use a Map here" is stage 3's decision, made
against [`TARGET.md`](TARGET.md). Specs describe the destination, not the route.

**Copying comments verbatim.** The Go doc comments are excellent and you should
read all of them — but a spec that restates them adds nothing and inherits their
Go framing. Extract the *behavior* they describe.

**Silent gaps.** A guarantee no test covers, or a mechanism the specs can't
explain, is a finding. Write it under Open questions. A spec that looks complete
and isn't is the one failure mode that survives all the way to stage 3.
