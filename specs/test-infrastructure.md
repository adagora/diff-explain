# Test infrastructure

Test harnesses and mechanics that need a port-side equivalent, distinct from
the production behavior the tests pin. One section per harness, named after
the Go test file that defines it.

## Python golden harness (`meat/python_golden_test.go`)

For each of three named fixtures (`django-526b1b414d8e`, `flask-c17f37939073`,
`pytest-b4e846616cbb`) under `meat/testdata/python/`, the test reads
`<base>.diff` (raw input) and `<base>.plan.json` (hand-authored edit plan,
JSON-decoded), compiles them with `compileEditPlan`, and compares the result
byte-for-byte against `<base>.golden.diff`. Rationale for each fixture's
budgets and semantic anchors is written up in
`meat/testdata/python/README.md`.

- **File reading**: `mustReadTestFile` (`meat/python_golden_test.go:290-297`)
  — read the file, fail loudly if missing. Nothing more to port here.
- **`UPDATE_GOLDEN` env var gate**: when `UPDATE_GOLDEN=1` is set, the test
  *writes* the compiled output to `<base>.golden.diff` (mode `0o644`)
  *before* comparing (`meat/python_golden_test.go:234-238`), so a run with
  the flag set always passes and rewrites the fixture. This is the only
  sanctioned way to regenerate `.golden.diff` files —
  `meat/testdata/python/README.md:39-47` and `migration/CONFORMANCE.md`
  both forbid regenerating them during the port itself. A port's harness
  needs the same write-then-compare gate, ideally behind an identically
  named env var for tooling parity.
- **Corpus accumulator**: an unexported struct
  (`meat/python_golden_test.go:157-160`) accumulates raw and visible metrics
  across the three subtests, checked once at the end against corpus-wide
  ceilings. A port's runner needs an equivalent cross-case accumulator, not
  per-case isolation.
- **`containsDetectedMove`** (`meat/python_golden_test.go:281-288`): linear
  search using value equality over `[]detectedMove`. A port needs an
  equivalent deep-equality check over `{removed: {start,end}, added:
  {start,end}}` pairs, order-independent.
- **`assertGoldenPlanLeavesImportsAutomatic`**
  (`meat/python_golden_test.go:253-279`): recomputes
  `mandatoryImportRemovalPlan` independently of the compile call and
  cross-checks the fixture's plan against it. This is fixture-validation
  logic, not production logic — but it must be ported alongside the test if
  the golden `.plan.json` files are to remain trustworthy inputs.
- **No scripted model, no HTTP stub, no injection seams** appear in this
  file — every input is a static fixture and `compileEditPlan` is a pure
  function of `(raw string, plan editPlan)`. This is what makes the test
  hermetic (no model call, no network, no wall-clock dependency).
- **Distinct from `TestRubric_PythonGoldenCommits`**
  (`meat/rubric_e2e_test.go:157`), gated by `MEAT_E2E=1`, which drives a real
  configured model against the same three commits with looser, calibrated
  assertions. That test is stochastic and costed, explicitly not part of the
  hermetic gate — its infrastructure needs (live model config, cost budget)
  are out of scope here and belong with `rubric_e2e_test.go`'s own spec
  fragment when processed.

## Agent-loop scripted model harness (`meat/meat_test.go`, reused throughout `chunk_test.go`)

The load-bearing test infrastructure for every non-hermetic test in the
suite — anything that drives `Abridge` end to end. See `agent-loop.md` for
the full guarantees this harness supports.

- **`Model` interface being faked**: one method, `Generate(ctx, system
  string, messages []Message, tools []Tool) (*Response, error)`
  (`meat/model.go:77-79`). A port's fake needs the same single-method
  surface.
- **`scriptedModel`** (`meat/meat_test.go:18-33`) — constructed from a fixed
  list of pre-baked `*Response` turns. `Generate` records the `tools` seen
  on the most recent call (`lastTools`) and appends a defensive copy of the
  full `messages` slice on every call to `seenMessages`, so
  `m.seenMessages[k]` is exactly what the model saw on its `(k+1)`-th call.
  `m.seen` counts total calls. Once scripted turns are exhausted, the fake
  **replays the last turn forever** rather than erroring — exploited by
  chunking tests where one scripted `submit` response must serve every
  chunk's call. No thread safety; determinism comes entirely from the fixed
  slice and single-goroutine use.
- **`toolUse(id, name string, input any) Block`** (`meat_test.go:67-70`) —
  JSON-marshals a domain struct (`readFileInput`, `grepInput`, `editPlan`,
  `submission`) into a `tool_use` block, so the fake never hand-writes JSON.
- **`assistant(content ...Block) *Response`** (`meat_test.go:72-74`) — wraps
  blocks into a `*Response` with **fixed** `InputTokens: 100, OutputTokens:
  20` per turn — every scripted turn contributes exactly 100/20 tokens,
  which is how token-accumulation assertions are satisfied without exact-sum
  checks.
- **`textBlock(s string) Block`** (`meat/model.go:82`, production code
  reused as a test helper) — builds a text-only block for "prose, no tool
  call" turns.
- **`deadlineFallbackModel`** (`meat_test.go:35-48`) and
  **`callerCancelFallbackModel`** (`meat_test.go:50-65`) — two
  purpose-built fakes distinguishing an internal per-run deadline (the
  second blocks on `<-ctx.Done()` then returns `ctx.Err()`) from
  caller-driven cancellation (the second variant also cancels a captured
  outer `cancel func()` before blocking). Both are essential to port: they
  prove `Abridge` must react differently to the two, via a second context
  captured before the per-run timeout wrap.
- **`modelFunc`** (`meat/chunk_test.go:20-25`) — a bare `func(ctx)
  (*Response, error)` adapter to `Model`, used only to inject a raw
  `ctx.Err()` and test error-chain preservation (`errors.Is`/`Unwrap`)
  without scripting turns.
- **`gitRepo`** (`meat_test.go:76-102`) — creates a real throwaway git
  repository under `t.TempDir()` (`git init -q`, fixed `user.email`/
  `user.name`, writes a `map[string]string` of files, `git add -A && git
  commit -qm init`). Exists because the `grep` tool shells out to real `git
  grep` and needs committed content to search — there is no git-independent
  fake for this tool anywhere in the suite. A port must either shell out to
  real git in its test harness too, or fake the `grep` tool's git dependency
  explicitly.

## Chunking test helpers (`meat/chunk_test.go`)

- **`setSingleRunBudget(t, budget) func()`** (`meat/chunk_test.go:13-18`) —
  shrinks the package-level `singleRunDiffBytes` var and returns a restore
  closure; the seam that lets every chunking test force real splits without
  400KB fixtures. See `constants.md`.
- **`fileSection(name, n) string`** (`meat/chunk_test.go:28-35`) — builds one
  synthetic file section with a single hunk of `n` added rows, the cheap
  multi-file fixture generator used across most end-to-end chunking tests.
- **`requireValidChunks(t, chunks, budget)`** (`meat/chunk_test.go:39-52`) —
  the structural harness used by nearly every splitting test: asserts every
  chunk's raw text *and* its numbered-diff form fit the budget, and that
  every chunk independently passes `validateSupportedDiff`.
- **`chunkBodyRows(text) []string`** (`meat/chunk_test.go:57-67`) — strips
  synthesized/replicated structure and returns only hunk-source rows, so
  tests can compare content across a split without caring about headers.
- **`changedRowsOf(diff) []string` / `slicesEqual`**
  (`meat/chunk_test.go:1002-1024`) — extracts only changed (`+`/`-`) rows;
  used to compare chunked vs. whole-diff-compiled output where context rows
  may differ but changed rows must not.
- **Reference-oracle pattern**: several chunking tests call
  `compileEditPlan`/`detectedMovesInDiff` directly (not through a wrapper)
  to establish "what whole-diff compilation/detection does" before checking
  the chunked path reproduces it — e.g. `chunk_test.go:727,778,881,969,1079,1136,1140,1199`.
  A port's test suite needs the same oracle-comparison pattern, not just
  fixed expected-output fixtures, since the point is cross-checking two code
  paths agree.

## Table-driven subtests (`meat/editplan_test.go`)

Grouped case names via `t.Run`, used for `RejectsInvalidFolds`
(`meat/editplan_test.go:357-388`), `RejectsInvalidRemovals` (495-514),
`RejectsOneSidedRenameOrCopyMetadata` (552-571), `RejectsOrphanedStructure`
(585-609), and `RejectsInvalidReplacements` (815-843). A port's harness
should preserve one assertion per named case so failures stay individually
diagnosable, rather than collapsing a table into one aggregate check.

## Real git subprocess dependency (`meat/editplan_test.go`)

`TestAbridge_AcceptsGitFormatPatch` (`meat/editplan_test.go:636-707`) shells
out to `git format-patch -1 --stdout`; `TestApplyEditPlan_GitHunkLinesThatResembleFileHeaders`
(`meat/editplan_test.go:709-764`) shells out to `git diff --no-index` and
explicitly skips (`t.Skipf`) if `git` isn't on `PATH`. A port needs either a
real git binary in its test environment or pre-captured fixture output for
both commands — the exact byte-for-byte format-patch output (headers, mail
signature, commit-prose lines that look like diff/rename metadata) is
load-bearing for the test.
