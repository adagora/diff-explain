# meat: Go → TypeScript migration

This directory is the preparation kit for porting `meat` from Go to TypeScript.
It contains no TypeScript. Its job is to make the port a mechanical exercise by
first turning the Go codebase into language-neutral specifications, then
executing against those specifications one step at a time.

Read this file first, then [`INVENTORY.md`](INVENTORY.md) for what exists today.

---

## The method

The port runs as three sequential loops. Each loop repeats a single prompt until
its exit gate is met.

| Stage | Loop reads | Loop writes | Exit gate |
|---|---|---|---|
| **0. Freeze** ✅ | the Go build | `conformance/vectors/*` | oracles reproducible offline — **done, 111 vectors** |
| **1. Test specs** | `meat/*_test.go`, `cmd/meat/*_test.go` | `specs/*.md` (behavior) | all 17 test files covered |
| **2. Source specs** | `meat/*.go`, `cmd/meat/*.go` | `specs/*.md` (mechanism) | all 23 source files covered |
| **3. Port** | `specs/*.md` | `src/**/*.ts`, `TODO.md` | strict build clean, all vectors pass |

The load-bearing idea is **citations**. Every claim in a specification carries a
`file.go:line` pointer back to the Go implementation. In stage 3 the porting
agent works from the specification — but when a spec is ambiguous, the citation
lets it open the original and read the real code. The specs decouple *intent*
from *Go*, while the citations preserve a path back to ground truth. Neither
half works alone: uncited specs strand the agent when prose runs out, and raw
Go strands it in another language's idioms.

Stages 1 and 2 are what make stage 3 cheap. Do not skip them. Do not start
writing TypeScript during them.

### Why the two spec stages are separate

Stage 1 documents **what the system guarantees** — extracted from tests, which
are the executable statement of intent. Stage 2 documents **how the system
achieves it** — extracted from source. Running them separately (tests first)
means stage 2's specs get written against an already-established vocabulary of
guarantees, and any mechanism in `src` that no test constrains is visible as a
gap rather than being silently canonized as a requirement.

---

## Stage 0 — Freeze the oracles (do this first)

`meat` is unusually well-equipped for a cross-language port because two of its
correctness properties are language-neutral and byte-exact:

1. **Golden fixtures.** `meat/testdata/python/` holds three real upstream
   commits as `.diff` → `.plan.json` → `.golden.diff`. Compiling a plan against
   a diff is a pure, deterministic, hermetic function, and the golden is exact
   output bytes. The TypeScript port must reproduce those bytes.
2. **The frozen prompt surface.** `promptSurface()` renders every branch of the
   model-visible instruction text and SHA-256s it (`meat/rubric.go:62,176`).
   Every string a model can see is a named constant precisely so this hash can
   cover it. The port must produce an identical hash — which proves the entire
   prompt surface survived byte-for-byte.

Neither depends on Go. Capture them before touching anything else, and the port
acquires a pass/fail signal that no amount of spec drift can fake.

See [`CONFORMANCE.md`](CONFORMANCE.md) for the exact procedure and for the
additional vectors to record while the Go build is still the reference.

## Runbook

Stage 0 is **already done** — 111 vectors are checked in under
`conformance/vectors/`. Verify them any time:

```sh
go test ./...                                  # 203 tests, must stay green
DUMP_VECTORS=/tmp/v go test ./meat -run TestDumpConformanceVectors
diff -r conformance/vectors /tmp/v && echo "vectors reproducible"
```

Stages 1–3 are Ralph loops: the same prompt, run until its exit gate is met.
Each iteration reads its own progress ledger (`specs/INDEX.md`, then `TODO.md`),
does one batch, and stops.

**In-session** — recommended. Self-paced, and you can watch and interrupt:

```
/loop Follow migration/prompts/stage1-tests.md. Do exactly one iteration, then stop.
```

Swap in `stage2-source.md` and `stage3-port.md` as each gate is met.

**Unattended** — the classic Ralph, for long overnight runs:

```sh
while :; do
  cat migration/prompts/stage1-tests.md | claude -p --dangerously-skip-permissions
done
```

Run this in a container or worktree, not on your only checkout: it grants the
agent unprompted tool access, and the loop only stops when you stop it. Watch
the first two or three iterations by hand before leaving it alone.

**Between stages, check the gate yourself.** The loop will claim it is done.
Read `specs/INDEX.md`, spot-check five citations, and apply the read-aloud test
in the stage 2 prompt before advancing.

### Gates

**Before stage 2** — every test file ✅ in `specs/INDEX.md`; every spec has
Guarantees with verified citations; `glossary.md` and `constants.md` exist.

**Before stage 3** — every source file ✅; every spec has Mechanism, Invariants,
Hazards, and Errors; `constants.md` complete with units; `specs/` explains what
`meat` does without needing the Go source open.

**Done** — `tsc --noEmit` clean, `node --test` green, all 111 vectors passing
including the three goldens byte-for-byte and the `RubricHash` match, and a
differential run against `conformance/meat-go` agreeing on every deterministic
surface.

The target stack, the strict `tsconfig.json`, the module layout, and the
Go-stdlib→Node dependency map are in [`TARGET.md`](TARGET.md).

---

## The decisions already made

**Runtime: Node ≥ 20, distributed as an npm package (`npx meat`).** This drops
the single-binary install that `go install meat.dev/cmd/meat@latest` provides
today — an accepted regression, revisitable later with a packaging step. Node 20
is the floor because the port relies on stable `node:test`, `AbortSignal.timeout()`,
and built-in `fetch`.

**Byte semantics: `Uint8Array` core, strings only at the edges.** This is the
single most consequential decision in the port and the one most likely to be
quietly violated. Go strings are UTF-8 byte sequences: `len(s)`, `s[i]`, and
`s[a:b]` are all **byte**-indexed. JavaScript strings are UTF-16 code units.
`meat` slices diff text by byte offset in hundreds of places, budgets in bytes
(`maxDiffBytes = 400 << 10`), and calls `utf8.RuneStart`/`RuneLen`/`ValidString`
directly. Porting that to JS strings would produce code that passes every ASCII
test and corrupts every diff containing a non-ASCII identifier, comment, or
string literal.

So: the diff engine (`diff`, `chunk`, `editplan`, `imports`, `moves`, `python`)
operates on `Uint8Array`. Decoding to `string` happens only at the CLI boundary
and the model-API boundary. See [`HAZARDS.md`](HAZARDS.md) §1 — that document is
required reading for stages 2 and 3, and its hazards must be cited by name in
the specs wherever they apply.

---

## Rules for every stage

- **Never edit the Go source.** It is the reference implementation for the
  duration of the port. If a spec and the Go code disagree, the Go code wins and
  the spec is wrong.
- **One thing per loop iteration.** The most important thing. Finish it.
- **A citation you did not verify is a bug.** Line numbers drift; check them.
- **Record surprises.** Anything the Go code does that the specs would not have
  predicted goes in [`HAZARDS.md`](HAZARDS.md), not in a comment that gets lost.

## Files here

| File | Purpose |
|---|---|
| [`INVENTORY.md`](INVENTORY.md) | Module map, sizing, per-file coverage checklists |
| [`HAZARDS.md`](HAZARDS.md) | Go→TS semantic gap register — the risk list |
| [`TARGET.md`](TARGET.md) | Target stack, strict tsconfig, layout, stdlib mapping |
| [`CONFORMANCE.md`](CONFORMANCE.md) | Oracles: what to freeze and how to check it |
| [`SPEC-FORMAT.md`](SPEC-FORMAT.md) | Spec document template and citation contract |
| [`prompts/`](prompts/) | The three Ralph loop prompts |
