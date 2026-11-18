# Stage 2 loop — compress the implementation into specifications

> Archived migration prompt. Run only when the current task explicitly asks
> to revisit this historical stage. Present development starts with
> [AGENTS](../../AGENTS.md) and the [current roadmap](../../docs/roadmap.md).

Run this prompt repeatedly until the exit gate is met. One iteration does one
batch and stops.

**Do not start this stage until stage 1's exit gate is met.**

---

## Mission

Document **how** `meat` works, into the same `specs/` files stage 1 populated
with guarantees. Stage 1 said what the system promises; you say what it does to
keep those promises — in prose a TypeScript porter can build from, with
citations back to every claim.

You are **not** porting anything in this stage. No TypeScript. No edits to any
`.go` file.

## Read first (every iteration)

- `migration/SPEC-FORMAT.md` — the template and citation contract. Binding.
- `migration/HAZARDS.md` — **required.** Every mechanism you describe must be
  checked against this register, and applicable hazards cited by number.
- `migration/INVENTORY.md` — the stage 2 checklist, in dependency order.
- `specs/INDEX.md` and the existing `specs/*.md` — stage 1's guarantees are the
  vocabulary you write against.

## One iteration

1. Read `specs/INDEX.md`. Pick the next source file in **dependency order** from
   the stage 2 checklist. Order matters: `diff.go` is the foundation everything
   else consumes, and specs written later should reference earlier vocabulary
   rather than reinvent it.

2. Fan out **one subagent per source file**, up to 3 in parallel. Give each the
   brief below.

3. Integrate into `specs/<subject>.md` — filling **Mechanism**, **Invariants**,
   **Hazards**, and **Errors** alongside the guarantees already there.

4. **Reconcile.** For each existing guarantee in that spec, confirm the
   mechanism you documented actually delivers it. A mismatch is a finding: it
   means stage 1 misread a test, or the source has behavior the tests don't
   constrain. Record it under Open questions. Do not overwrite stage 1's text.

5. Update `specs/INDEX.md` and `specs/constants.md`. Append any new hazard to
   `migration/HAZARDS.md`.

6. Stop. Report what was covered and what is left.

## Subagent brief

> Study `<SOURCE FILE>` in full. Produce a specification fragment describing its
> **mechanism**, following `migration/SPEC-FORMAT.md` exactly.
>
> Read `migration/HAZARDS.md` before you start.
>
> Cover:
> - **What it is responsible for** and what depends on it.
> - **Algorithms**, as numbered prose steps precise enough to reimplement
>   without reading Go. Where the order of operations is load-bearing, say so
>   and say why.
> - **Data shapes**, described by meaning. "A record per physical line carrying
>   its text and its terminator" — not `type sourceLine struct`.
> - **Every decision boundary**: what makes a line an import, what makes two
>   runs a move, what makes a chunk boundary legal. These are where a port
>   silently diverges.
> - **Invariants**, with the consequence of breaking each.
> - **Errors**: every failure mode and its exact message text.
> - **Hazards**: which entries in `migration/HAZARDS.md` apply and at which
>   lines. Be specific — "H1 at `imports.go:112`, the byte-offset scan for the
>   block terminator", not "H1 applies".
> - **Ordering that Go leaves unspecified.** Unstable sorts with reachable ties,
>   map iteration, anything where Go's output is one of several legal ones. The
>   port must choose deliberately (H7, H13).
>
> Cite continuously — every non-obvious claim gets `file.go:line`. Verify each
> by opening the file.
>
> Also report:
> - **Cross-references** to guarantees already in `specs/`, by their G-numbers.
> - **Uncovered mechanism**: behavior no stage 1 guarantee constrains. This is
>   important — it is code the port could break with no test failing.
> - **Dead or unreachable code**, if any.
>
> Do not write TypeScript. Do not edit any `.go` file. Do not prescribe an
> implementation approach — that is stage 3's job against `migration/TARGET.md`.
>
> Return the fragment as markdown. Do not write files; the parent integrates.

## Special attention

Three files carry most of the risk. Budget extra iterations for them and do not
batch them with anything else.

**`meat/imports.go` (966 L)** — the mandatory import-removal pass. Multi-language
detection via 21 regexes (H3b: every `\s` differs between engines), multiline
blocks, imports inside embedded source strings, move-precedence extension,
Python suite placeholders. The regexes need a per-language table in the spec:
pattern, what it matches, what it deliberately does not.

**`meat/chunk.go` (1,086 L)** — splitting and merging. The file's own header
comment (`meat/chunk.go:1-27`) is an unusually complete design document,
including the costs chunking accepts. Extract those costs explicitly; they are
guarantees the port must not accidentally improve on or lose.

**`meat/editplan.go` (770 L)** — plan compilation. The elision-projection check
at `meat/editplan.go:555-632` builds a regex from model-authored text and is
the subject of H3a; specify what it *means* (literals in order, each gap
non-empty, anchored at both ends) rather than what it constructs, so the port
can implement the meaning safely.

## Exit gate

- Every file in the stage 2 checklist is ✅ in `specs/INDEX.md`.
- Every spec has populated Mechanism, Invariants, Hazards, and Errors sections.
- `specs/constants.md` is complete, every entry with a unit.
- Every hazard discovered is in `migration/HAZARDS.md`.
- **The read-aloud test:** someone who has never seen the Go source can read
  `specs/` and explain what `meat` does, how a diff becomes a reading diff, and
  where the sharp edges are. If they'd have to open a `.go` file to follow the
  main path, the specs are not done.

When all hold, stop and report readiness for stage 3.

## Rules

- **Never edit a `.go` file.**
- **One iteration, one batch.**
- **Verify citations.**
- **The source wins.** Where source and a stage 1 guarantee disagree, the source
  is the truth and the disagreement is a finding.
- **Describe, don't prescribe.** No "use a Map", no "this should be async".
- **Uncovered mechanism is the most valuable thing you can find.** Code that no
  test constrains is code the port can break silently. Flag all of it.
