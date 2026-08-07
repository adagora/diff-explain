# Constants

Every named limit in the codebase: value, unit, citation, and what happens at
the boundary. Units are the point — a port that gets a unit wrong produces a
plausible binary that fails only on large or slow inputs.

| Name | Value | Unit | Citation | At the boundary | Exercised by |
|---|---|---|---|---|---|
| `minMoveSubstantiveRows` | `3` | rows | `meat/moves.go:12` | Below this, a candidate move is not reported | `moves_test.go` G12 “tiny coincidence” (2 rows) yields no move; all positive detections use ≥3 substantive rows. Not isolated from the nonspace-byte gate on the tiny fixture. |
| `minMoveNonspaceBytes` | `48` | bytes (H1) | `meat/moves.go:13` | Below this, a candidate move is not reported | Same tiny fixture fails both gates at once; no fixture sits just under/over 48 nonspace bytes while clearing the row gate |
| `maxMoveHints` | `12` | count | `meat/moves.go:14` | Cap on candidate moves considered; `formatMovePairs` appends `"and N more"` past this cap | `meat_test.go`'s `TestSurfaceFixturesCoverBothMoveBranches` forces >12 moves to exercise the overflow phrasing (see `rubric.md` G5); `moves_test.go` never approaches it |
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
| Retention pressure floors | `rawChanged ≥ 40`, `visibleChanged ≥ 20`, and (`visible ≥ 80` or `visible*100 ≥ raw*45`) | changed rows | `meat/tools.go:248-252` | Triggers one refinement turn after identity submit | `imports.md` G21 (50× `+call();` + import drives high retention) |
| Django live retention ceiling | `80` | % of changed rows (integer: fail if `kept*100 > raw*80`) | `meat/rubric_e2e_test.go:182` | Live e2e only (`MEAT_E2E=1`) | `rubric.md` G11 |
| Flask live retention ceiling | `90` | % of changed rows | `meat/rubric_e2e_test.go:211` | Live e2e only | `rubric.md` G11 |
| pytest live retention ceiling | `90` | % of changed rows | `meat/rubric_e2e_test.go:230` | Live e2e only | `rubric.md` G11 |
| `MEAT_E2E` gate | `"1"` to run | env string equality | `meat/rubric_e2e_test.go:22` | Any other value → skip all live rubric e2e tests | `rubric.md` G7 |
| Gateway HTTP client timeout | `5` | seconds | `meat/gateway.go:33` | Default `*http.Client` used whenever `discoverExeGatewayBase` is called with a nil client | `providers.md` — present in every call in `gateway_test.go`, but never actually triggered (see Open questions) |
| Gateway discovery context timeout | `5` | seconds | `meat/gateway.go:36` | Wraps the caller's `ctx` independently of the client timeout above; discovery aborts (returns `""`) if the reflection request doesn't complete in time | `providers.md` — same as above, never triggered |
| `DefaultModel` | `= DefaultOpenAIModel` (`"gpt-5.6-sol"`) | model id string | `meat/provider.go:10` | Used when `ResolveModel` has neither an explicit arg nor `$MEAT_MODEL` | `providers.md` G1, `meat/resolvemodel_test.go:21-26` |
| `DefaultAnthropicModel` | `"claude-opus-4-8"` | model id string | `meat/anthropic.go:17` | Used when `AnthropicModel.Model` is empty | `providers.md` G7-G8 |
| `maxOutputTokens` (Anthropic) | `16384` | tokens (per-turn output cap) | `meat/anthropic.go:31` | Sent as `max_tokens` on every request; a response that still stops at this cap is a hard error, not a truncated success | `providers.md` G14-G15 |
| `maxAttempts` (shared retry loop, both providers) | `4` | count (1 initial + up to 3 retries) | `meat/anthropic.go:172` | Loop bound in `postJSONWithRetry`; exhausting it surfaces the last error wrapped as `"after %d attempts: %w"` | `providers.md` G13 |
| `retryBaseDelay` (`var`, defaults to `1s`) | test-shrunk to `1ms` in `anthropic_test.go` | duration (wall-clock; doubled per retry attempt) | `meat/anthropic.go:176` | Attempt *n*'s wait is `retryBaseDelay << (n-1)` | `providers.md` G11, G13 |
| `DefaultOpenAIModel` | `"gpt-5.6-sol"` | model id string | `meat/openai.go:17` | Used when `OpenAIModel.Model` is empty | `providers.md` G16-G17, G19 |
| `DefaultReasoningEffort` | `"medium"` | enum string (thinking level) | `meat/openai.go:21` | Used when `OpenAIModel.ReasoningEffort` is empty | `providers.md` G16-G17, G19 |
| `maxOpenAIOutputTokens` | `32768` | tokens (hidden reasoning + visible output combined) | `meat/openai.go:25` | Sent as a hard request cap on every call; also echoed into the incomplete-response error message | `providers.md` G19, G25 |

## Fixture-pinned values (not system limits)

The python golden corpus pins exact fixture sizes and output ceilings — these
are golden-test assertions, not named constants in the source, so they live
in `editplan.md` G1/G6-G8 rather than here. See `meat/python_golden_test.go:27-34`
for the raw constants (`pythonCorpusRawChanged` etc.) if porting the harness
itself.
