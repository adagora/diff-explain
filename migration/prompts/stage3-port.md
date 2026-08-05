# Stage 3 loop — port to TypeScript, one thing per iteration

Run this prompt repeatedly until the exit gate is met.

**Do not start until stage 2's exit gate is met and stage 0's vectors are
frozen** (`migration/CONFORMANCE.md`).

---

## Mission

Build the TypeScript `meat` from `specs/`, one item per iteration, against a
strict compiler and frozen conformance vectors.

## Read first (every iteration)

- `TODO.md` — the ledger. If it does not exist, go to **Phase A**.
- `migration/TARGET.md` — stack, layout, `tsconfig.json`, stdlib mapping, and
  the definition of done. Binding.
- `migration/HAZARDS.md` — check before porting any file it lists.
- `migration/CONFORMANCE.md` — what the vectors mean and the rules about them.
- The `specs/*.md` for the item you are working on.

## The specs are your source — and they have citations

Work from `specs/`. When a spec is ambiguous, incomplete, or silent on an edge
case you have hit, **follow its citations and read the Go**. That is what they
are for. `meat/chunk.go:895-908` is an invitation to open the file.

Reading the Go to resolve a question is correct and expected. Transliterating
the Go is not. Read it to learn *what must be true*, then write idiomatic
TypeScript that makes it true — against `migration/TARGET.md`, not against Go's
shape.

If the spec was wrong or thin, **fix the spec in the same iteration**. The next
item will need it too, and a spec that decays into a stale index of a Go tree
has lost its only advantage.

---

## Phase A — build `TODO.md` (first iteration only)

Read all of `specs/`, `migration/TARGET.md`, and `migration/INVENTORY.md`.
Produce `TODO.md`: every item needed for a complete port, in dependency order,
each small enough to finish in one iteration.

Order is fixed at the top and derived below:

1. **`src/meat/bytes.ts`** — the byte-slice layer (H1). Everything depends on
   it. It gets the most tests of anything in the port.
2. **Project scaffolding** — `package.json`, `tsconfig.json`, `testdata/` copied
   byte-for-byte from `meat/testdata/`, `conformance/vectors/` in place.
3. **`test/conformance.test.ts`** — the vector runner. Build it early and
   failing; it is the honest progress metric from here on.
4. Then the engine in dependency order: `model` → `provider` → `gateway` →
   `elision` → `diff` → `moves` → `imports` → `python` → `editplan` → `chunk` →
   `rubric` → `tools` → `meat` → `anthropic` → `openai`.
5. Then the CLI: `stdin` → `cache` → `render` → `main`.
6. Then packaging: shebang, `bin` wiring, `npx` smoke test.

`isatty_*.go` does not port (H11).

Each item states: what it delivers, which specs cover it, which conformance
vectors it should turn green, and which hazards apply.

Write `TODO.md`. Stop. Do not start porting in the same iteration.

---

## Phase B — one item per iteration

1. Read `TODO.md`. Pick **the single most important unblocked item** — normally
   the topmost. If something has become more important (a hazard discovered, a
   vector failing that should not be), take that instead and say why.

2. Read that item's specs end to end before writing code. Follow citations for
   anything unclear.

3. Check `migration/HAZARDS.md` for the file you are porting. If a hazard
   applies and you are about to write the obvious translation, stop and write
   the correct one.

4. Implement it. Port its tests alongside — a source item and its tests are one
   item, never two.

5. Verify **all four** conditions from `migration/TARGET.md`:
   - `tsc --noEmit` clean under the strict config. No `any`, no `!` outside
     `bytes.ts`, no `@ts-expect-error` without a cited reason.
   - `node --test` passes for the ported tests.
   - Every conformance vector this item touches passes.
   - Citations in the specs you touched still resolve.

6. Update `TODO.md`: tick the item, add anything you discovered. Append new
   hazards to `migration/HAZARDS.md`. Fix any spec that was wrong.

7. Stop. Report: item completed, vectors now passing (`n`/`total`), anything
   discovered, next item.

---

## Rules

- **One item per iteration.** The most important one. Finish it completely —
  compiler clean, tests passing, vectors green — before stopping. A half-ported
  file is worse than an unported one, because the next iteration cannot tell
  which parts are trustworthy.

- **Never edit a `.go` file.** The Go tree is the reference implementation until
  the port is done. (Stage 0's single additive dump test file is the only
  exception, and it is already written.)

- **Never regenerate a conformance vector or a golden file to make a test
  pass.** If the port disagrees with a vector, the port is wrong until proven
  otherwise *in writing*, in `migration/HAZARDS.md`, with the analysis.
  `UPDATE_GOLDEN=1` is forbidden for the duration.

- **Port the behavior, including its bugs.** If you find a genuine bug in the Go
  implementation, record it in `migration/HAZARDS.md` and **match it anyway**.
  Fixing behavior and porting behavior are separate projects; doing both at once
  means neither can be verified. Fix it afterward, in TypeScript, as its own
  change with its own test.

- **No new runtime dependencies.** Zero. `meat` has none today and the port
  keeps it that way (`migration/TARGET.md`).

- **Bytes, not strings, in the engine.** H1 is the hazard most likely to ship
  silently: every test fixture in the repo is ASCII, so a UTF-16 port passes the
  entire suite and corrupts any diff containing a non-ASCII character. If you
  are about to call `TextDecoder` inside `diff`, `chunk`, `editplan`, `imports`,
  `moves`, or `python`, you are about to introduce this bug.

- **The strict compiler is an oracle, not an obstacle.** A flag fighting you is
  usually telling you the Go code relied on something the spec did not record.
  Find out which, and write it down.

## Exit gate

- Every item in `TODO.md` is ticked.
- `tsc --noEmit` clean; `node --test` fully green.
- **Every conformance vector passes**, including the three Python goldens byte
  for byte and the `RubricHash` match.
- `npx meat` works end to end against a real repository, matching the Go binary
  on the deterministic surfaces (`migration/CONFORMANCE.md`).
- Differential run against `conformance/meat-go`: identical `-json` shape,
  elision manifest, cache keys, and chunk boundaries.
- Every spec's citations still resolve.

Then, and only then, propose retiring the Go tree — as a separate change, for a
human to decide.
