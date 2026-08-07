# Coverage ledger

The progress ledger for stages 1 and 2. Each stage's exit gate is this table
fully ticked in its column.

**Stage 1** fills the Guarantees section of each spec, from tests.
**Stage 2** fills Mechanism / Invariants / Hazards / Errors, from source.

Legend: ⬜ not started · 🟡 partial · ✅ done

## Engine — `meat/`

| Go source | Go tests | Spec | S1 | S2 |
|---|---|---|:--:|:--:|
| `model.go` | — | `model.md` | ⬜ | ✅ |
| `provider.go` | `resolvemodel_test.go` | `providers.md` | ✅ | ✅ |
| `gateway.go` | `gateway_test.go` | `providers.md` | ✅ | ✅ |
| `elision.go` | `elision_test.go` | `elision.md` | ✅ | ✅ |
| `diff.go` | `chunk_test.go` (layout use) | `diff.md` | 🟡 | ✅ |
| `moves.go` | `moves_test.go` | `moves.md` | ✅ | ✅ |
| `imports.go` | `imports_test.go` | `imports.md` | ✅ | ⬜ |
| `python.go` | `editplan_test.go` (Python cases) | `python.md` | ✅ | ⬜ |
| `editplan.go` | `editplan_test.go`, `python_golden_test.go` | `editplan.md` | ✅ | ⬜ |
| `chunk.go` | `chunk_test.go`, `chunk_sanity_test.go` | `chunk.md` | ✅ | ⬜ |
| `rubric.go` | `meat_test.go`, `rubric_e2e_test.go` | `rubric.md` | ✅ | ⬜ |
| `tools.go` | `meat_test.go` | `tools.md` | ✅ | ⬜ |
| `meat.go` | `meat_test.go` | `agent-loop.md` | ✅ | ⬜ |
| `anthropic.go` | `anthropic_test.go` | `providers.md` | ✅ | ⬜ |
| `openai.go` | `openai_test.go` | `providers.md` | ✅ | ⬜ |

## CLI — `cmd/meat/`

| Go source | Go tests | Spec | S1 | S2 |
|---|---|---|:--:|:--:|
| `stdin.go` | `readdiff_test.go` | `cli.md` | ✅ | ⬜ |
| `isatty_*.go` (4 files) | — | `cli.md` | ⬜ | ⬜ |
| `cache.go` | `cache_test.go` | `cache.md` | ✅ | ⬜ |
| `render.go` | `render_test.go` | `render.md` | ✅ | ⬜ |
| `main.go` | `readdiff_test.go`, `install_test.go` | `cli.md` | ✅ | ⬜ |

`isatty_*.go` is specified but **not ported** — Node's `tty.isatty` replaces the
whole build-tag family (hazard H11). The spec records that as an intentional
divergence.

## Cross-cutting

| Document | Written by | Status |
|---|---|:--:|
| `glossary.md` | stage 1, extended by stage 2 | ✅ |
| `constants.md` | stage 1, completed by stage 2 | ✅ |
| `test-infrastructure.md` | stage 1, extended by stage 2 | ✅ |

## Test files → specs

One test file often contributes guarantees to several specs. Route each
guarantee to the subject it constrains, not to the file it came from.

| Test file | Tests | Contributes to | Done |
|---|---:|---|:--:|
| `meat/chunk_test.go` | 36 | `chunk.md`, `diff.md`, `imports.md`, `moves.md`, `python.md`, `agent-loop.md` | ✅ |
| `meat/editplan_test.go` | 50 | `editplan.md`, `python.md`, `diff.md`, `elision.md` | ✅ |
| `meat/meat_test.go` | 29 | `agent-loop.md`, `rubric.md`, `tools.md`, `chunk.md`, `diff.md`, `editplan.md` | ✅ |
| `meat/imports_test.go` | 14 | `imports.md` | ✅ |
| `meat/moves_test.go` | 11 | `moves.md` | ✅ |
| `meat/gateway_test.go` | 11 | `providers.md` | ✅ |
| `meat/elision_test.go` | 11 | `elision.md` | ✅ |
| `meat/render_test.go` → `cmd/meat/` | 9 | `render.md` | ✅ |
| `cmd/meat/cache_test.go` | 8 | `cache.md` | ✅ |
| `cmd/meat/readdiff_test.go` | 7 | `cli.md` | ✅ |
| `meat/anthropic_test.go` | 6 | `providers.md` | ✅ |
| `meat/openai_test.go` | 4 | `providers.md` | ✅ |
| `meat/rubric_e2e_test.go` | 3 | `rubric.md` (costed, opt-in, stochastic) | ✅ |
| `meat/python_golden_test.go` | 1 | `editplan.md`, `python.md`, `imports.md`, `moves.md` — **the hard gate** | ✅ |
| `meat/chunk_sanity_test.go` | 1 | `chunk.md` (env-gated on `CHUNK_SANITY_DIFF`) | ✅ |
| `meat/resolvemodel_test.go` | 1 | `providers.md` | ✅ |
| `cmd/meat/install_test.go` | 1 | `cli.md` | ✅ |

203 tests total. **17 of 17 test files processed (203 of 203 test
functions). Stage 1's test-file checklist is complete.**
