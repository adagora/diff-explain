# Stage 1 loop — compress the tests into specifications

Run this prompt repeatedly until the exit gate is met. One iteration does one
batch and stops.

---

## Mission

Turn `meat`'s 203 Go tests into language-neutral specifications in `specs/`.
Tests are the executable statement of what this system guarantees; you are
extracting those guarantees into prose that a TypeScript port can be built from,
with citations back to the Go so nothing is lost.

You are **not** porting anything in this stage. No TypeScript. No edits to any
`.go` file.

## Read first (every iteration)

- `migration/SPEC-FORMAT.md` — the template and citation contract. Binding.
- `migration/INVENTORY.md` — the stage 1 checklist and the module map.
- `specs/INDEX.md` — what is already done. Create it on the first iteration from
  the checklist in `INVENTORY.md`.

## One iteration

1. Read `specs/INDEX.md`. Pick the **highest-value uncovered test file** — by
   default the next one down the stage 1 checklist in `INVENTORY.md`, which is
   ordered by size and leverage.

2. Fan out **one subagent per test file**, up to 3 in parallel. Give each the
   brief below. Subagents read; they do not coordinate.

3. When they return, integrate: merge each subagent's guarantees into the right
   `specs/<subject>.md`. One test file often contributes to several subjects —
   route each guarantee to the subject it constrains, not to the file it came
   from.

4. Update `specs/INDEX.md`, `specs/glossary.md`, and `specs/constants.md`.

5. Stop. Report what was covered and what is left.

## Subagent brief

> Study `<TEST FILE>` in full. Produce a specification fragment describing the
> **guarantees** it pins, following `migration/SPEC-FORMAT.md` exactly.
>
> For each test function:
> - What behavior does it constrain? State it as a guarantee about the system,
>   not as a description of the test. "Rejects a plan whose fold spans an import
>   row" — not "TestFoo checks that…".
> - Cite the test that pins it: `meat/chunk_test.go:300`.
> - Cite the implementation it exercises, when you can identify it. Follow the
>   call into the source and cite the specific function or lines. This citation
>   is the point of the exercise — it is what lets a later porter read the real
>   code when the prose runs thin.
> - Record the exact fixture shapes and boundary values used. A test that uses a
>   4-byte budget to force a split is telling you the budget is injectable and
>   the split logic is budget-driven.
> - Record exact error message text wherever a test asserts on it.
>
> Also report:
> - **Vocabulary** the tests use — fold, elision, suite owner, mandatory import,
>   retention pressure, move pair. Define each from how the tests use it.
> - **Test infrastructure** that must be ported: scripted/fake models, HTTP
>   stubs, golden-file harnesses, env-var gates, injection seams
>   (`abridgeBudget`, `singleRunDiffBytes`).
> - **Constants** with values, units, and citations.
> - **Gaps** — behavior in the source that no test in this file constrains, and
>   any test whose intent you could not determine.
>
> Do not write TypeScript. Do not edit any `.go` file. Do not describe Go types
> or signatures — describe behavior. Verify every citation by opening the file.
>
> Return the fragment as markdown. Do not write files; the parent integrates.

## Order

Start with `meat/python_golden_test.go`. It is hermetic, it locks exact output
bytes, and it is the test the whole port is graded against
(`migration/CONFORMANCE.md`). Read `meat/testdata/python/README.md` alongside it
— the rationale for every budget and semantic anchor is already written there.

Then work down the checklist by size: `chunk_test.go`, `editplan_test.go`,
`meat_test.go`, and onward.

## Exit gate

- Every file in the stage 1 checklist is ✅ in `specs/INDEX.md`.
- Every spec has a populated **Guarantees** section with verified citations.
- `specs/glossary.md` defines every recurring term.
- `specs/constants.md` lists every constant the tests touch, with units.
- Test infrastructure needing a port is enumerated somewhere in `specs/`.

When all hold, stop and report readiness for stage 2.

## Rules

- **Never edit a `.go` file.** The Go tree is the reference implementation.
- **One iteration, one batch.** Do not try to finish the stage in one pass.
- **Verify citations.** An unverified citation is a defect.
- **Gaps are findings, not failures.** Write them down under Open questions.
- If a test's intent is genuinely unclear after reading the implementation, say
  so in Open questions rather than guessing. A confident wrong guarantee is far
  more expensive than a flagged unknown.
