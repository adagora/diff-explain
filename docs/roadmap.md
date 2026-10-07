# Roadmap: agent-visible evidence and control

Status: P1 local observation surface delivered with offline acceptance evidence.
P2–P7 remain proposed; the P7 local baseline is available. U1 first-run
usability delivered. Updated 2026-10-07.
This is the current design plan. Historical port checkboxes
in [TODO](../TODO.md) do not select the next task.

Read [system design](system-design.md) for purpose and ownership, then the
relevant clause of [agent interface](../specs/agent-interface.md). This plan
does not authorize live model spending, change current CLI defaults, or claim
that a proposed feature already exists.

## Delivery rules

Ship small vertical increments that let an agent make a better decision using
less repeated work. Implement the smallest complete path through a milestone
before broadening it to other adapters. Keep the byte/compiler core independent.

Each implementation change includes the relevant current spec, meaningful
offline acceptance cases, evidence links, and any protocol/cache compatibility
decision. Frozen Go vectors remain unchanged; new behavior gets separately
versioned cases. Document source-observed behavior separately from test-backed
guarantees. A plan checkbox is completed only after its deliverable and gate.

| Milestone | Dependency | Agent-visible outcome | Status |
|---|---|---|---|
| P0 Orientation | None | One authority map, current workflow, bounded plan and learning rules | Complete: documents in this change |
| P1 Observe | P0 | Identify exact input and inspect a bounded inventory without a model | Delivered local surface; focused gates/build pass, full-suite Windows baseline limits below |
| P2 Bind context | P1 | Inspect the source version that belongs to the change | Proposed |
| P3 Explain execution | P1, P2 | Inspect result coverage, provenance and validation evidence | Proposed |
| P4 Bound execution | P3 | Control total work and distinguish failure, cancellation and fallback | Proposed |
| P5 Reuse and resume | P2-P4 | Reuse valid evidence and completed work with explicit validity rules | Proposed |
| P6 Unify workflows | P1-P5 | Use the same concepts through CLI, packets and skills | Proposed |
| P7 Evaluate and promote learning | Baseline at P1; compare after each milestone | Demonstrate improved review quality/resource use and retain verified lessons | Local byte baseline delivered; broader evaluation proposed |
| U1 First-run usability | None | A person sets up once and picks a review workflow without reading the docs | Delivered: offline gates below |

Independent pure helpers can be developed together when a task warrants it.
Dependencies express required semantics, not permission for autonomous work
outside the user's requested scope.

## P1. Offline identity, inventory and planning surface

Delivered local surface: `-inventory`, `-evidence id`, `-plan` and
`-capabilities`, with `meat.observe` version 1 JSON, bounded pages,
snapshot-required evidence expansion and stale continuation rejection.
Snapshots identify raw bytes, resolved committed objects and collection policy;
file/hunk/envelope entries retain original coordinates and deterministic exact
move relationships. Planning forecasts the existing API partitions without
dispatch, cache access or claimed call/token/cost bounds. Legacy paths retain
their contracts. Current spelling and wire encoding are owned by
[observe](../specs/observe.md).

Committed before/after tree identities are available. Mutable sources retain
captured diff bytes with context explicitly unavailable and consistency
unverified; stdin provenance remains unknown. P1 does not implement captured
mutable source-file context, snapshot-bound read/search tools, or the full A2/A5
target contracts. Those dependencies remain in P2 and P4.

Owners: [snapshot](../src/cli/snapshot.ts), [observe](../src/cli/observe.ts),
[main](../src/cli/main.ts), [diff](../src/meat/diff.ts),
[chunk](../src/meat/chunk.ts). Target clauses: local portions of A1–A3 and A5.
Implementation evidence: [snapshot cases](../test/cli/snapshot.test.ts),
[observation cases](../test/cli/observe.test.ts).

Validation: `npm run build` and all 13 snapshot plus 16 observation cases pass.
The full suite on this Windows checkout retains 67 baseline failures: shell-stub
ENOENT, stdin/merge probes and CRLF-converted frozen fixtures. Unchanged HEAD
reproduced 69 failures in an isolated checkout; synchronizing stale meat copies
removed one and repairing show-me discovery removed another. This is
local P1 acceptance evidence, not a globally green full-suite claim. Revalidate
the full gate in an environment preserving fixture bytes and executable/link
semantics; expected conformance output must not be regenerated to mask it.

Gate: offline fixtures cover commit, root/merge commit, both range forms,
staged, worktree and stdin. A ref changing after resolution cannot change
collected evidence. Unknown provenance stays unknown. Unicode/line terminators
preserve identity. Large inventory pages have bounded output and reconstruct
one ordered selection; stale continuations fail. No provider/gateway/auth
network call occurs. Unsupported input can still receive an honest inventory.
Legacy commands retain their contracts.

Compatibility decision: observation is separate from legacy `-json`/`-prompt`
and does not alter compiler/rubric identity or the legacy cache namespace. See
[scoped decisions](decisions.md#offline-observation-has-a-separate-source-and-wire-contract).

## U1. First-run usability

Problem (reality check, 2026-10-07): every feature worked, but reaching one
required the README. `meat` was not on PATH, bare `meat HEAD` failed without an
API key and named no alternative, a flag after the revision produced only
"too many arguments", help listed `-prompt`/`-agent` only among flags,
PowerShell redirection altered packet bytes, and `-agent` echoed the agent's
whole log including the packet.

Delivered: `npm run setup` (build, `npm link`, both skills, doctor);
`meat -doctor`; help that leads with no-key workflows; failure hints for
misplaced flags, workflow words and missing credentials; `-o file` for exact
output bytes; quiet `-agent` with `-verbose`; captured Git stderr; README
quick start organized by what the user already has. Contract and divergences
from the Go baseline: [CLI first-run usability](../specs/cli.md#first-run-usability).
Rationale: [decision](decisions.md#first-run-usability-adds-guidance-without-changing-go-baseline-contracts).

Gate: offline [usability](../test/cli/usability.test.ts) and
[agent](../test/cli/agent.test.ts) cases cover flag validation, help ordering,
each hint with unchanged Go text and exit codes, `-o` byte equality and no file
on failure, doctor readiness without printing a credential value, and hidden,
verbose and failure agent logs. Windows `npm` bin wrappers were exercised in a
scratch prefix. No live model or subscription review is part of the gate.
Validation 2026-10-07: `npm run check` passed 909 of 909 tests and
`npm run build` passed on Windows 11 (Node 22.23) and on Linux in a
`node:22.18-bookworm-slim` container (the minimum supported Node) using a copy
of the same working tree with fresh dependencies. On Linux the built CLI ran
`-doctor`, `-look`, `-prompt -o` (bytes equal to stdout) and a global
`npm install -g --prefix` bin link. The Linux smoke test found that
`meat -look HEAD | head` crashed with an unhandled `EPIPE`; that is fixed and
covered by a regression case.

Not included: verb subcommands, shell completion, a published npm package or
plugin, and native Grok execution. A user's own `npm link` remains a manual,
reversible step (`npm unlink -g meat`).

## P2. Snapshot-bound source and tools

Problem: reading today's checkout can invalidate reasoning about an older
revision, index, or piped diff.

P1 supplies immutable Git tree identities and honest diff-only mutable/stdin
context labels. P2 must add bound reads/search and captured mutable context;
the presence of an observation snapshot alone does not satisfy this milestone.

Provide a context adapter with explicit before/after/captured/live policies.
Begin with immutable Git trees, then captured index/worktree evidence. Reads
and search return provenance, completeness and continuation metadata. Keep
negative-search evidence tied to the searched scope. Bound I/O and make tool
operations cancellable; define filesystem-link behavior. Bind the adapter to
the selected snapshot without changing the deterministic compiler.

Owners: source collection and [tools](../src/meat/tools.ts). Contract: A2-A4.
Any changed model-visible tool schema or feedback requires rubric/protocol
review and separate compatibility treatment.

Gate: the same historical review reads identical context from different
checkouts; changed index/worktree content is captured or rejected explicitly;
stdin cannot silently inherit an unrelated repo. Mutable diffs match captured
bytes, capture consistency is labelled without implying atomic filesystem
capture, and the user's index/worktree are unchanged. Truncation, empty search,
failed search with partial stdout, unavailable blob and escaping link are
distinct. Ordinary checks use temporary repos and local files.

## P3. Receipts, compiler witnesses and coverage

Problem: current Result loses the plan, fallback state, chunk coverage and
validation evidence, so a consumer cannot assess the returned artifact.

Introduce the opt-in receipt envelope and compiler witness. Preserve exact
original-coordinate mappings through chunking/merge. Account for every selected
region, compiler-owned omissions, passthrough sections and unperformed
cross-chunk checks. Distinguish current vs historic usage and unknown values.
Expose structured events only through an explicit destination. Start with API
engine evidence; external explanations report only observable adapter facts.

Owners: [meat](../src/meat/meat.ts), [editplan](../src/meat/editplan.ts),
[chunk](../src/meat/chunk.ts), [render](../src/cli/render.ts).
Contract: A6, A7 diagnostic vocabulary, A9.

Gate: scripted scenarios distinguish ordinary submission, retained fallback,
caller cancellation and later-chunk failure. Embedded replay fixtures reproduce
compiled bytes, including split hunks and mapped moves that differ from local
move detection. Missing dependencies make replayability explicit. External
process success can coexist with unobserved inspection coverage. Coverage
reconciles to the input despite replicated
headers and passthrough pieces; cross-chunk moves are explicitly unenforced.
Receipt fields cannot imply factual summary validation or passing tests.
Legacy JSON fixtures stay byte compatible.

## P4. Aggregate budget and failure controller

Problem: per-chunk limits, transport retries and external processes can consume
more work than an agent can infer or control from the CLI.

Add one whole-request resource controller, connect CLI cancellation, and pass
remaining allowances through chunks, calls, retries and tool I/O. Add execution
and shutdown deadlines for fresh-agent supervision. Declare adapter capability
limits; distinguish conservative reservations, estimates and unavailable usage.
Finalize the budget portion of offline planning and stable recovery diagnostics.

Owners: [main](../src/cli/main.ts), [engine](../src/meat/meat.ts),
[provider transport](../src/meat/anthropic.ts), [agent](../src/cli/agent.ts).
Contract: A5, A7. Reuse current provider behavior only within the new aggregate
attempt/deadline policy.

Gate: fake clocks/scripted models/mock servers demonstrate that retries,
refinement and later chunks cannot reset total allowances. Cancellation stops
new dispatch and bounds child shutdown. Failed requests report unknown usage
when appropriate. Unsupported hard token/money caps fail before dispatch.
Planning never promises subscription usage that the adapter cannot observe.

## P5. Evidence-aware cache and resumable artifacts

Problem: the existing key omits context and routing, while a later chunk
failure discards useful completed work.

Introduce a separate versioned artifact store and key namespace using the P2/P3
evidence contracts. Expose cache policy and reasons for hits/misses. Validate
stored metadata and digests. Persist completed chunk witnesses atomically;
resume only when snapshot, context, partition maps and outcome policy match.
Distinguish unit-validity dependencies from attempt-only scheduling limits.
Resume preserves the original request's remaining allowance unless explicitly
extended; report new plus cumulative usage and unknown expenditure. Report
partial results explicitly.
Implement retention/size controls before making persistent source snapshots
the default.

Owners: [cache](../src/cli/cache.ts), [main](../src/cli/main.ts),
[engine](../src/meat/meat.ts). Contract: A7-A8.

Gate: identical diff bytes with changed context or provider routing do not
produce an unsound hit. New matches invalidate a previously empty search's
reuse. Legacy field-incomplete entries cannot become provenance-bearing
results. Failure after several chunks permits an exact, validated resume
without redoing them. Corruption, expired dependencies and incompatible
versions produce useful diagnostics. Cleanup stays within its configured
store; current cache disable/refresh behavior remains covered separately.

## P6. Thin CLI, packet and skill adapters

Problem: each review venue teaches its own partial model of scope and success.

Route new workflows through shared capability/request/artifact definitions.
Offer bounded packet selection with parent coverage references and explicit
context limitations. Explanations cite input artifacts and observed evidence.
Update the canonical [meat skill](../.claude/skills/meat/SKILL.md), preserving
discovery paths and keeping visual guidance built in and portable. Make the credential
step explicitly API-only and preserve requested compiled-output intent when
credentials are missing. Use the smallest sufficient operation first and stop
when evidence meets the requested outcome.

Delivered independently: the current-session skill defaults to offline packets,
uses bounded observation for oversized input, and separates explicit fresh-agent
and compiled-output requests. `npm run skill:install -- all` installs portable
Codex/Claude personal skills bound to this checkout, and `npm run skill:sync`
updates project discovery copies. [Installation tests](../test/skill-install.test.ts)
verify offline invocation from another repository. This does not complete P6's
shared request/result or bounded packet contracts.
The [skill/code audit](../analysis/skill-code-audit-2026-10-07/REPORT.md) records
behavioral alignment checks and corrected provider/cache, paging and discovery
instructions; it does not assert deterministic agent interpretation.

Owners: CLI entry/prompt/agent/render and canonical skill.
Contract: A1, A3, A6, A9; [workflow](agent-workflow.md).

Gate: current-session, fresh subscription, offline inspection and compiled API
scenarios select the requested outcome without implicit backend switching.
No recursive fresh-agent review occurs. Mock children demonstrate supported
capabilities, useful incompatibility diagnostics and honest unknown usage.
Legacy full packets stay available. New packet subsets reconcile to parent
coverage; an explanation never acquires compiler guarantees from its wrapper.

## P7. Evaluate usefulness and promote verified lessons

The reproducible local byte baseline is delivered in
[scripts/observe-baseline.ts](../scripts/observe-baseline.ts), run with
`npm run observe:baseline`. Its synthetic input fixes 120 files with 20 changed
declarations each and verifies ordered inventory reconstruction and exact
selected-file byte reconstruction without model dispatch.

| Measurement | Bytes or count |
|---|---:|
| Raw input bytes | 106840 |
| Numbered input bytes | 133240 |
| Legacy full packet bytes | 107829 |
| First inventory page bytes (default 20 entries) | 6064 |
| Total inventory entries / pages | 240 / 12 |
| Expanded first-file bytes | 886 |
| Model calls | 0 |

Elapsed time and semantic review quality are not measured. The first page is
orientation, not coverage equivalent to the full packet; these counts do not
establish review-quality gains or model-cost savings. Broader P7 evaluation
and comparisons remain proposed.

Start a reproducible baseline during P1. Reuse current deterministic fixtures
and add cases only for new contracts. Evaluate after each delivered milestone;
correct the plan when evidence shows a cheaper solution.

Measure the outcomes in [system design](system-design.md): orientation cost,
evidence expansion, calls/attempts/bytes/time, coverage, stale-evidence
detection, recovery reuse, consequential facts and unsupported claims. Fix
input revisions, rubric/compiler versions, workflow and model settings when
comparing. Keep estimates and unavailable measurements explicit. Live model
comparisons require explicit scope and spending authorization.

Gate: publish a reproducible comparison against the baseline, including
regressions and limitations; avoid unsupported percentage-savings claims.
Promote repeated verified findings into focused fixtures, subject contracts or
[decisions](decisions.md), each with evidence and revisit conditions. This
maintenance is performed through ordinary review; no automatic rubric mutation
or unbounded background learning is part of the plan.

## Decisions to close in the owning milestone

| Choice | Current direction | Must be settled before |
|---|---|---|
| New command names, schema wire shape and encoding | Settled for P1 in [observe](../specs/observe.md); preserve legacy output | Revisit on observation schema/collection changes |
| Mutable context capture granularity | Capture declared search scope; mark unavailable context honestly | P2 exposing each context policy |
| Global cross-chunk validation | Initially report unperformed checks; assess paired partitioning/global validation with fixtures | Any claim of whole-input move symmetry |
| Hard token/cost enforcement | Advertise only adapters with conservative enforceable reservations | P4 exposing a hard cap |
| Persistence defaults and retention limits | Local, explicit, bounded; required evidence survives only by declared policy | P5 enabling persistent snapshots |
| Native CLI capability/version matrix | Detect supported operations and keep unknown observations explicit | P6 adapter rollout |

A new implementer takes the smallest requested unblocked slice, links the
relevant contract clause, and records completion evidence here. Update current
usage/specs only for features actually shipped. Amend or supersede design
clauses that changed during implementation so agents encounter one maintained
answer.
