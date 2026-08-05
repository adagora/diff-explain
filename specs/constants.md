# Constants

Every named limit in the codebase: value, unit, citation, and what happens at
the boundary. Units are the point — a port that gets a unit wrong produces a
plausible binary that fails only on large or slow inputs.

| Name | Value | Unit | Citation | At the boundary | Exercised by |
|---|---|---|---|---|---|
| `minMoveSubstantiveRows` | `3` | rows | `meat/moves.go:12` | Below this, a candidate move is not reported | Indirectly — `python_golden_test.go`'s pytest move clears it, but no boundary-value case is tested |
| `minMoveNonspaceBytes` | `48` | bytes (H1) | `meat/moves.go:13` | Below this, a candidate move is not reported | Indirectly, same as above |
| `maxMoveHints` | `12` | count | `meat/moves.go:14` | Cap on candidate moves considered; `formatMovePairs` appends `"and N more"` past this cap | `meat_test.go`'s `TestSurfaceFixturesCoverBothMoveBranches` forces &gt;12 moves to exercise the overflow phrasing (see `rubric.md` G5); no fixture in `python_golden_test.go` or `chunk_test.go` approaches it |
| `maxReplacementBytes` | `4 << 10` (4,096) | bytes (H1) | `meat/editplan.go:21` | `replace` operation rejected | Bounds the replace-validation table in `editplan.md` G23; not exercised at its exact boundary value |
| `maxSummaryBytes` | `500` | bytes (H1) | `meat/editplan.go:22` | Summary rejected | Generic rules (emptiness, forbidden characters) exercised by `editplan.md` G39; the specific over-500-bytes branch is not directly pinned (see `editplan.md` Open questions) |
| `maxChunks` | `32` | count | `meat/chunk.go:50` | Splitting refuses with `"diff splits into more than %d chunks — try a narrower range (...)"` | `chunk.md` G27 (gross pathological blowup refused); the exact 32/33 boundary is untested |
| `maxTotalDiffBytes` | `4 << 20` (4,194,304) | bytes (H1) | `meat/chunk.go:42` | `Abridge` returns a hard error before any model call, `meat/meat.go:122-124` | `chunk.md` G43 |
| `maxDiffBytes` | `400 << 10` (409,600) | bytes (H1) | `meat/meat.go:51` | Diffs over this are split into chunks; production default for `singleRunDiffBytes` | `chunk.md` G44 (sizing basis) |
| `singleRunDiffBytes` (`var`, defaults to `maxDiffBytes`) | test-shrunk in every chunking test | bytes (H1) | `meat/meat.go:55` | Per-run byte budget checked by `fitsSingleRun` | Test-injectable seam via `setSingleRunBudget` (`meat/chunk_test.go:13-18`) — every chunking test in `chunk.md` depends on it |
| `defaultMaxTurns` | `24` | turns (model round-trips) | `meat/meat.go:36` | Applies per run (whole diff or one chunk), not per whole abridgement | Overridden via `Request.MaxTurns` in `agent-loop.md` G13 |
| `defaultBudget` | `4 * time.Minute` | ns (wall-clock) | `meat/meat.go:40` | Same per-run scoping as `defaultMaxTurns` | Not directly exercised; tests use the shrunk `abridgeBudget` var instead |
| `abridgeBudget` (`var`, defaults to `defaultBudget`) | shrunk to `20ms` in test | ns (wall-clock) | `meat/meat.go:44` | Internal per-run deadline; expiry triggers the fallback-vs-cancellation distinction | `agent-loop.md` G11, seam at `meat/meat_test.go:292-294` |
| `maxToolOutput` | `16 * 1024` (16,384) | bytes | `meat/tools.go:19` | Every tool result (including `submit`'s validation-error text) is truncated to this cap with a `"truncated"` marker appended | `tools.md` G9 |

## Fixture-pinned values (not system limits)

The python golden corpus pins exact fixture sizes and output ceilings — these
are golden-test assertions, not named constants in the source, so they live
in `editplan.md` G1/G6-G8 rather than here. See `meat/python_golden_test.go:27-34`
for the raw constants (`pythonCorpusRawChanged` etc.) if porting the harness
itself.
