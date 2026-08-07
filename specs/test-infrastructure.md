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
  (`meat/rubric_e2e_test.go:157`), gated by `MEAT_E2E=1` — see the Live-LLM
  rubric e2e section below.

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

## Real-world differential sanity check (`meat/chunk_sanity_test.go`)

- **`CHUNK_SANITY_DIFF` is a *path* gate, not a boolean-style gate** — a
  different shape from `UPDATE_GOLDEN` and `MEAT_E2E` above. Its value
  isn't a flag toggling a fixed, checked-in fixture; it's a filesystem
  path to an arbitrary, developer-supplied unified-diff file, read via
  `os.ReadFile`. Unset (`""`) skips with `"set CHUNK_SANITY_DIFF to a
  large unified diff file"`. There is no checked-in fixture backing this
  test at all — it's meant for a developer's own large, possibly
  out-of-repo diff. A read failure or an invalid diff is `t.Fatal`, not a
  skip.
- **No write side effect** (unlike `UPDATE_GOLDEN`) and **no model/network
  call** (unlike `MEAT_E2E`) — every function this test drives is pure and
  hermetic once the file is read; it is opt-in only to avoid requiring a
  large fixture in the repo, not because it is costed or stochastic.
- **`retainedChangedRows`** (`meat/chunk_sanity_test.go:66-78`) is a
  distinct, stronger oracle from `chunk_test.go`'s `changedRowsOf`
  (`meat/chunk_test.go:1002-1012`, which returns every changed row
  unconditionally): it additionally applies the whole-diff mandatory-import
  mask and move-precedence extension to exclude rows that legitimately
  never survive compilation, and excludes synthesized `"..."` placeholder
  rows via `isFixedFoldLine`. A port's test suite needs this
  mask-and-move-aware, placeholder-aware oracle as a distinct helper —
  reusing a plain "all changed rows" helper would produce false failures
  on any fixture containing import churn or an emptied Python suite owner.

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

## Imports / moves pure-compile helpers

- **`mandatoryImportRemovalPlan` + `splitSourceLines` + `analyzeDiff`** —
  direct plan equality / JSON coordinates without going through
  `compileEditPlan` (`meat/imports_test.go:64-67,439`).
- **`detectedMovesInDiff(raw)` / `detectExactMoves(lines, layout)`** —
  pure detection entry points used by `moves_test.go` detection cases.
- **`exactMoveDiff` alias of `surfaceFixtureDiff`**
  (`meat/moves_test.go:10-12`, fixture body `meat/rubric.go:18-36`) —
  shared canonical cross-file move; keeps move tests aligned with the
  hashed prompt surface.
- **`deletedOnlyHunk(start, rows)` / `addedOnlyHunk(start, rows)`**
  (`meat/moves_test.go:111-127`) — synthetic hunk builders; added side
  always injects four leading spaces after `+`.
- **Inline multi-line unified-diff string fixtures** in both files
  (language-shape tables, Python import relocate suites, cross-language
  require move, etc.) — no golden files.
- **`encoding/json.Marshal` on plan ranges** — wire-shape pin for
  mandatory coordinates (`meat/imports_test.go:440-445`).
- **Tool-error inspection on corrective turns** — second-turn messages
  scanned for `tool_result` with `ToolError` and message substrings
  (`meat/moves_test.go:385-397,427-439`; also `imports_test.go:392-401`).

## Live-LLM rubric e2e harness (`meat/rubric_e2e_test.go`)

Opt-in, costed, stochastic. Default `go test` skips all three tests.

- **Env gate**: `MEAT_E2E` must equal `"1"` or every test skips with
  `set MEAT_E2E=1 to run the live-LLM rubric test`
  (`meat/rubric_e2e_test.go:22-23`, `:158-159`, `:304-305`).
- **Live model from env**: `NewModelFromEnv(ctx, "")` — empty model id so
  resolution uses `$MEAT_MODEL` then built-in default; skip soft-fail with
  `no LLM available: %v` if credentials/backend missing
  (`meat/rubric_e2e_test.go:26-29`, `meat/provider.go:29-36`).
- **Full agent path**: call production `Abridge`, not a scripted model or
  direct `compileEditPlan`.
- **Stochastic assertions**: substring presence/absence and upper-bound
  retention only; no golden SmartDiff bytes.
- **Fixture I/O (Python suite)**: read `testdata/python/<name>.diff` as
  UTF-8 string; fail hard if missing
  (`meat/rubric_e2e_test.go:255-258`). Same three fixtures as the hermetic
  golden suite.
- **Retention helpers**: `diffStats` + `retainedDiffStats` for changed-row
  % ceilings (`meat/rubric_e2e_test.go:286-294`, `meat/elision.go:36-53`).
  Ceiling check: `keptChanged*100 > rawChanged*maxRetention` (integer).
- **Semicolon scan rules**: only `+` lines; exempt `for ` prefix; strip
  `//` comments before `;` check (`meat/rubric_e2e_test.go:349-363`).
- **Distinct from hermetic goldens**: `TestPythonGoldenCommits` remains the
  hard gate; this suite is optional smoke
  (`meat/rubric_e2e_test.go:150-156`, `meat/testdata/python/README.md:49-55`).
- **No named cost budget** in code — cost is controlled operationally by
  the opt-in env gate.

## Table-driven subtests (`meat/editplan_test.go`)

Grouped case names via `t.Run`, used for `RejectsInvalidFolds`
(`meat/editplan_test.go:357-388`), `RejectsInvalidRemovals` (495-514),
`RejectsOneSidedRenameOrCopyMetadata` (552-571), `RejectsOrphanedStructure`
(585-609), and `RejectsInvalidReplacements` (815-843). A port's harness
should preserve one assertion per named case so failures stay individually
diagnosable, rather than collapsing a table into one aggregate check.

## Gateway discovery harness (`meat/gateway_test.go`)

- **`withMarker(t)`** (`meat/gateway_test.go:14-23`) — injection seam for
  exe.dev-VM detection. Saves the package var `exeDevMarkerPath`, creates a
  real file (`t.TempDir()/exe.dev`) via `os.WriteFile`, points the var at it,
  restores on cleanup. Detection is by `os.Stat` success/failure only
  (`meat/gateway.go:29-31`), so a port's fake only needs presence/absence —
  content and mode are never asserted. The negative direction (three tests)
  skips this helper and points `exeDevMarkerPath` directly at a path inside a
  real, empty temp dir that is never written to.
- **`withReflection(t, body)`** (`meat/gateway_test.go:25-37`) — injection
  seam for the reflection HTTP call. Saves `reflectionIntegrationsURL`,
  starts a real `httptest.NewServer` that unconditionally responds `200 OK`
  with the literal `body` argument, points the var at the server's URL,
  restores and closes on cleanup. Every positive-discovery test composes
  `withMarker(t)` then `withReflection(t, body)`.
  Both seams are real (a temp file, a local HTTP server), not mocked
  interfaces around the calling function — a port's harness needs the same
  two overridable module-level values, or an equivalent real-file +
  real-local-HTTP-server capability.
- **`t.Setenv(..., "")` blanking** — every credential-resolution test blanks
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`,
  `OPENAI_BASE_URL`, `MEAT_MODEL` before exercising a fallback path, so
  ambient host-environment credentials can't leak in and mask a bug in the
  "no explicit credentials" branch.
- No test in this file passes a non-nil `*http.Client` to
  `discoverExeGatewayBase`; only the "build a default 5s-timeout client"
  branch is exercised.

## Anthropic HTTP-stub harness (`meat/anthropic_test.go`)

- **`antServer(t, handler) (*AnthropicModel, *int32)`** (`meat/anthropic_test.go:16-33`)
  — the sole harness for every test in this file. Shrinks the package-level
  `retryBaseDelay` var to `time.Millisecond` for the test (the only
  injection seam in `anthropic.go`; there is no seam for `maxAttempts`, a
  true `const`, so retry-count tests depend on the real production ceiling).
  Spins up a real `httptest.Server` wrapping the caller's `http.HandlerFunc`;
  every call increments a shared `int32` via `atomic.AddInt32` before
  delegating to the handler, giving the handler closure a live view of "which
  attempt is this" so it can script per-attempt responses (branching on
  `atomic.LoadInt32(calls)`, not a consumed-in-order list like
  `scriptedModel`). Returns an `*AnthropicModel` with `APIKey`, `BaseURL`,
  and `HTTPC` all explicitly set to the stub — so the model's own defaulting
  logic for those three fields is never exercised by any test built on this
  harness.
- **`okBody(stopReason string) []byte`** (`meat/anthropic_test.go:35-42`) —
  canned success body: one text block, the given `stop_reason`, fixed
  `usage:{input_tokens:10,output_tokens:5}`.
  A port needs: a real local HTTP server (not an interface fake), a
  mutable/injectable backoff-base seam, and a per-call counter visible
  inside the handler closure. Every handler in this file decodes the real
  request JSON and asserts on its shape (not just HTTP status/timing) — the
  wire format itself is part of what's pinned. No fake `Model` and no env-var
  gate appear anywhere in this file; the network boundary itself is the seam.

## OpenAI SSE-stub harness (`meat/openai_test.go`)

- **`writeOpenAIEvent(w, event)`** (`meat/openai_test.go:14-20`) — marshals
  any Go value to JSON and writes it as one SSE `data: <json>\n\n` frame.
  Every stub in this file goes through this helper — no other stream-framing
  path is exercised.
- **`openAICompleted(id, inputTokens, outputTokens)`** (`meat/openai_test.go:22-35`)
  — builds a `response.completed` event whose `response.output` is *always*
  the empty array, forcing (and proving) that `Generate` gets its content
  exclusively from `output_item.done` events, never from the completed
  snapshot.
- **`outputItemDone(index, item)`** (`meat/openai_test.go:37-43`) — builds
  one `response.output_item.done` event wrapping an arbitrary item map at a
  given index — the only channel through which output content reaches any
  test in this file.
- **Per-call branching via `atomic.Int32`** (`meat/openai_test.go:47,50,156`)
  — one `httptest.HandlerFunc` handles both calls of the end-to-end test,
  branching on an atomic call counter to assert different request shapes and
  return different streamed fixtures per call.
- Every test uses a real `httptest.NewServer` + `srv.Client()`, never a fake
  `RoundTripper`. No test in this file exercises `NewOpenAIFromEnv`,
  credential/gateway resolution (that's exclusively `gateway_test.go`'s
  job), or the shared retry loop's OpenAI-flavored error path (no stub here
  ever returns a retryable status).

## Render harness (`cmd/meat/render_test.go`)

- **Real subprocess for exactly one test, faked for the rest.** Only
  `TestGitWantsColorHonorsConfig` shells out to a real `git` binary,
  self-skipping via `t.Skipf` if `git` isn't on `PATH`. It overrides git's
  config resolution without touching the real user/repo gitconfig, using
  git's own `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`
  environment-variable mechanism (`t.Setenv`) to inject a synthetic
  `color.diff` value that takes precedence over any real `~/.gitconfig`.
  This differs from `editplan_test.go`'s real-git tests (which need git's
  *ordinary* behavior on real repo content) — here the point is overriding
  git's *config resolution* specifically. A port shelling out to git for
  config needs an equivalent "inject one config key without a real config
  file" seam, or must fake the subprocess boundary directly.
- **Most tests avoid the subprocess on purpose.** The file's own header
  comment states the intent: a hand-built `diffPalette` fakes git-resolved
  colors without shelling out, so colorization logic (`colorizeDiffLine`,
  `palette(false)`) is tested deterministically. `diffColor` itself (which
  would call `git config --get-color`) is never invoked by most tests.
- **One incidental, unguarded subprocess call.** `TestFormatBodyEmptyDiff`'s
  colored-palette case triggers a real `git config --get-color
  color.diff.commit yellow` call whenever git happens to be on `PATH` —
  with no availability guard — because commit-color is recomputed live
  whenever the palette is non-zero. The test's assertion is insensitive to
  whether that call succeeds, fails, or is slow, since the string it checks
  for is written on an unrelated, uncolored branch regardless.
- **`TestIsTerminalRegularFileAndDevNull`** self-skips via `t.Skipf` if
  `/dev/null` can't be opened — a portability guard, not a git dependency.

## Cache/run harness (`cmd/meat/cache_test.go`)

- **Real temp directories, not a faked filesystem.** `t.TempDir()` is used
  directly as the cache directory throughout; there is no in-memory
  filesystem abstraction — every store/load test hits a real, isolated
  directory on disk.
- **`newOpts(t, diff, model, compute) (*runOpts, *int, *bytes.Buffer)`** —
  the shared harness for every `run()`-level test. Builds a `runOpts` wired
  to: a fresh `t.TempDir()` as the cache dir; a fixed rubric string; a
  `compute` wrapper that increments a `calls` counter (returned by pointer,
  so callers can assert call counts) before delegating to the test's own
  closure; a `render` field that formats the result via the real
  `formatBody`/`palette(false)` (reusing `render.go` production code, not a
  fake) into a shared buffer; and `stderr` pointed at that same buffer — so
  the cache-hit/miss notice and the rendered body land in one combined
  string that tests substring-match against.
- **No `HOME` override appears in this file** — `TestCacheDirEnvOverride`
  only sets `MEAT_CACHE` to a path or to `""`; it never unsets the variable
  to reach `cacheDir`'s `os.UserHomeDir()`-based default branch.
- **`t.Setenv("MEAT_CACHE", ...)`** is the sole env-mutation mechanism in
  this file.

## Real git subprocess dependency (`meat/editplan_test.go`)

`TestAbridge_AcceptsGitFormatPatch` (`meat/editplan_test.go:636-707`) shells
out to `git format-patch -1 --stdout`; `TestApplyEditPlan_GitHunkLinesThatResembleFileHeaders`
(`meat/editplan_test.go:709-764`) shells out to `git diff --no-index` and
explicitly skips (`t.Skipf`) if `git` isn't on `PATH`. A port needs either a
real git binary in its test environment or pre-captured fixture output for
both commands — the exact byte-for-byte format-patch output (headers, mail
signature, commit-prose lines that look like diff/rename metadata) is
load-bearing for the test.
