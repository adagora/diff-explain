# Inventory

What exists today, what each part does, and the coverage checklists stages 1 and
2 work through.

Measured at migration start (commit `f39f41d`).

## Sizing

| | Files | Lines |
|---|---:|---:|
| `meat/` source | 15 | 6,709 |
| `meat/` tests | 13 | 5,745 |
| `cmd/meat/` source | 8 | 718 |
| `cmd/meat/` tests | 4 | 711 |
| **Total Go** | **40** | **13,883** |

203 test functions. **Zero external dependencies** — `go.mod` declares only
`module meat.dev` and `go 1.24.13`, no `require` block. Everything is stdlib.

That matters: there is no third-party library whose TypeScript equivalent has to
be found and behaviorally matched. The entire dependency surface is Go's
standard library, and it maps to Node built-ins (see [`TARGET.md`](TARGET.md)).

## What meat does

Reads a unified diff, asks an LLM for an *edit plan* (remove / replace / fold
operations in original line coordinates), validates the plan, and mechanically
applies it to the immutable input. The model never authors output text — it only
selects what to hide. Diffs too large for one model context are split at
structural boundaries, abridged chunk by chunk, and merged.

```
                  cmd/meat                          meat
   ┌──────────────────────────────────┐   ┌─────────────────────────────┐
   git/stdin → readDiff → cacheKey ──────→ Abridge
                              │        │      ├─ validateSupportedDiff
                          cache hit?   │      ├─ fitsSingleRun? ──┐
                              │        │      │                   ├→ abridgeChunked (chunk.go)
                          renderResult ←──────┴─ abridgeOne ──────┘
                          renderJSON   │           │  agent loop, ≤24 turns
                          pager/color  │           ├→ Model.Generate (openai | anthropic)
   └──────────────────────────────────┘           ├→ toolbox: read_file, grep, preview_plan, submit
                                                  └→ compileEditPlan → reading diff
```

## Package `meat/` — the engine

Ordered by porting dependency (earlier files have fewer dependents).

| File | Lines | Role |
|---|---:|---|
| `model.go` | 82 | Provider-agnostic types: `Block`, `Message`, `Tool`, `Response`, `Model` interface. Flat structs, no type switches. |
| `provider.go` | 42 | `ResolveModel` fallback chain: explicit → `$MEAT_MODEL` → `DefaultModel`. No network, no credentials. |
| `gateway.go` | 73 | exe.dev managed-LLM-gateway discovery via `/exe.dev` marker file + reflection endpoint. |
| `diff.go` | 480 | **Foundation.** Parses a unified diff into an immutable line-oriented layout; classifies every physical line and tags file / hunk / language. Everything downstream consumes this and never re-parses. |
| `moves.go` | 480 | Exact source-evidenced move detection between change runs in different hunks. Whole-diff property. Its symmetry validators need `editplan.go`'s `planState` type — see the port-side `plan.ts` note below the table. |
| `imports.go` | 966 | The mandatory import-removal pass: multiline blocks, imports inside embedded source strings, move-precedence extension, Python suite placeholders. Compiler-owned; plans may not target these rows. Three of its functions also take `editplan.go`'s `planState`. **Its own `embeddedSourceLines` — part of the vector-tested core, not just those three — calls `python.go`'s triple-quote scanner**, so the TS port builds `python.ts` first (`imports.go` has no matching dependency on `python.go` in the other direction); this table keeps upstream Go order since Go itself has no such constraint — see `TODO.md`'s "Notes for future iterations" for the port-order swap. |
| `python.go` | 846 | Python-aware plan validators: hidden suite owners vs. orphaned bodies, delimiter and triple-quote balance, structural-token preservation. Conservative and text-level; rejects rather than guesses. Every validator here takes `editplan.go`'s `planState`. Has no dependency on `imports.go`. |
| `editplan.go` | 770 | **Core.** `compileEditPlan` validates a submitted plan (structure, elision projections, move symmetry, language rules) and renders the reading diff mechanically. Its own type-definition layer (`lineRange`, `planState`, `plannedReplacement`, `applyPlannedReplacements`, `leadingWhitespace`) is needed by the three rows above it, while its orchestrator calls into all three — a genuine circular dependency at the file level, ported around it (see below). |
| `elision.go` | 138 | `ElisionLine` — the "kept 12/240 changed lines in 3/7 files" manifest, counted locally, never model-reported. Depends on `editplan.go`'s `compileElisionProjection`, so it ports after `editplan.go` despite the smaller line count (stage 3 discovery — Go's package-internal call graph isn't ordering-constrained the way per-file TS modules are). |
| `chunk.go` | 1,086 | **Core.** Splits oversized diffs at file → hunk → sub-hunk boundaries into independently valid chunks; mirrors whole-diff analyses into each; merges results. |
| `rubric.go` | 357 | The system prompt, the protocol version, and `promptSurface()` + its SHA-256. |
| `tools.go` | 359 | The agent toolbox: `read_file`, `grep` (via `git grep`), `preview_plan`, `submit`, confined to the repo root and bounded at 16 KiB per result. |
| `meat.go` | 295 | `Abridge` entry point and the agent turn loop, with retention-nudge and fallback. |
| `anthropic.go` | 279 | Anthropic Messages implementation of `Model`, with retry. |
| `openai.go` | 456 | OpenAI Responses implementation, incl. streaming and opaque `provider_state` replay. |

**Port-side-only file, no Go source: `plan.ts`.** Discovered in stage 3 while
starting `moves.ts`: `editplan.go`'s own orchestrator (`compileEditPlan`)
calls into `moves.go`/`imports.go`/`python.go`, while those three need
`editplan.go`'s `planState`/`lineRange` types — a circular dependency at the
Go-file level that only matters once file boundaries become TypeScript
module boundaries (Go's single-package compilation doesn't care about file
order). Fixed by extracting `editplan.go`'s pure type-definition layer
(`lineRange`, `lineReplacement`, `lineFold`, `plannedReplacement`,
`plannedFold`, `planState`, `newPlanState`, `planState.represented`,
`applyPlannedReplacements`, `leadingWhitespace`) into `src/meat/plan.ts`,
built right after `diff.ts` — the same kind of deliberate, documented
exception `bytes.ts` already is to the one-to-one file mapping. See
`migration/TARGET.md`'s Layout section and `TODO.md` item 4e for the full
account.

## Package `cmd/meat/` — the CLI

| File | Lines | Role |
|---|---:|---|
| `isatty_{linux,bsd,unix,other}.go` | 41 | Build-tag family; TCGETS/TIOCGETA ioctl via `syscall`+`unsafe`. **Collapses to one line of Node.** |
| `stdin.go` | 22 | Piped-stdin detection and full read. |
| `cache.go` | 92 | `~/.meat` result cache; key = SHA-256 over diff text + model id + protocol hash. |
| `render.go` | 236 | Terminal rendering: git-config colors, pager selection, `-json` wire form. |
| `main.go` | 327 | Flag parsing, git revision resolution, orchestration. |

## Stage 1 checklist — test files

One subagent per file. Tick when its spec exists and its citations verify.

- [x] `meat/chunk_test.go` (1,559 L, 36 tests)
- [x] `meat/editplan_test.go` (923 L, 50 tests)
- [x] `meat/meat_test.go` (768 L, 29 tests)
- [x] `meat/imports_test.go` (447 L, 14 tests)
- [x] `meat/moves_test.go` (440 L, 11 tests)
- [x] `meat/rubric_e2e_test.go` (365 L, 3 tests) — costed/stochastic, opt-in
- [x] `meat/python_golden_test.go` (297 L, 1 test) — **the hard gate**
- [x] `meat/openai_test.go` (228 L, 4 tests)
- [x] `meat/anthropic_test.go` (214 L, 6 tests)
- [x] `meat/gateway_test.go` (210 L, 11 tests)
- [x] `meat/elision_test.go` (189 L, 11 tests)
- [x] `meat/chunk_sanity_test.go` (78 L, 1 test) — env-gated on `CHUNK_SANITY_DIFF`
- [x] `meat/resolvemodel_test.go` (27 L, 1 test)
- [x] `cmd/meat/readdiff_test.go` (262 L, 7 tests)
- [x] `cmd/meat/render_test.go` (211 L, 9 tests)
- [x] `cmd/meat/cache_test.go` (190 L, 8 tests)
- [x] `cmd/meat/install_test.go` (48 L, 1 test)

**Stage 1 checklist complete — all 17 test files processed (203 of 203
test functions).**

Start with `python_golden_test.go`: it is hermetic, locks exact snapshot bytes,
semantic anchors, move behavior, and absolute budgets, and it is the test the
port is ultimately graded against. Its rationale is already written up in
`meat/testdata/python/README.md` — read that before specifying it.

## Stage 2 checklist — source files

Port order is dependency order; spec order should match so later specs can
reference earlier vocabulary.

- [x] `meat/model.go`
- [x] `meat/provider.go`
- [x] `meat/gateway.go`
- [x] `meat/elision.go`
- [x] `meat/diff.go`
- [x] `meat/moves.go`
- [x] `meat/imports.go`
- [x] `meat/python.go`
- [x] `meat/editplan.go`
- [x] `meat/chunk.go`
- [x] `meat/rubric.go`
- [x] `meat/tools.go`
- [x] `meat/meat.go`
- [x] `meat/anthropic.go`
- [x] `meat/openai.go`
- [x] `cmd/meat/stdin.go`
- [x] `cmd/meat/isatty_*.go` (all four, one spec)
- [x] `cmd/meat/cache.go`
- [x] `cmd/meat/render.go`
- [x] `cmd/meat/main.go`

## External surface the port must preserve

**Environment variables.** `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `MEAT_MODEL`, `MEAT_CACHE` (empty
disables caching), `LESS`, plus two test-only gates: `UPDATE_GOLDEN`,
`CHUNK_SANITY_DIFF`.

**CLI.** `meat`, `meat <sha>`, `meat HEAD~3`, `meat <sha1>..<sha2>`,
`meat main...HEAD`, `meat -staged`, `meat -w`, `git show <sha> | meat`, plus
`-json` and `-model`. Exact flag set and usage text: `cmd/meat/main.go:6-46,89`.

**JSON wire form.** `Result` carries `json:"smart_diff"`, `"summary"`,
`"input_tokens"`, `"output_tokens"` (`meat/meat.go:94-105`), and `-json` adds
`"elision"` (`cmd/meat/render.go:16-19`). Snake_case, HTML escaping off. This is
consumed by CI bots — it is a compatibility contract, not an implementation
detail.

**Subprocesses.** `git config --get-colorbool`, `git config --get-color`,
`git var GIT_PAGER`, `sh -c <pager>` (`cmd/meat/render.go:179,190,206,220`);
`git` for revision reading (`cmd/meat/main.go:299`); `git grep` for the model's
grep tool (`meat/tools.go:188`, context-cancellable).

**Network.** `api.openai.com/v1/responses`, `api.anthropic.com`, and the exe.dev
gateway endpoints (`llm.int.exe.xyz`, `reflection.int.exe.xyz/integrations`).

## Not in scope

`analysis/` holds recorded evaluation runs (diffs, JSON, HTML viewers) and one
`verify.py`. It is data, not program. Do not port it; do not spec it.
