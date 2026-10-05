# Roadmap: agent-visible evidence and control

Status: documentation foundation complete; runtime milestones P1-P7 proposed.
Updated 2026-10-05. This is the current design plan. Historical port checkboxes
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
| P1 Observe | P0 | Identify exact input and inspect a bounded inventory without a model | Proposed; first implementation slice |
| P2 Bind context | P1 | Inspect the source version that belongs to the change | Proposed |
| P3 Explain execution | P1, P2 | Inspect result coverage, provenance and validation evidence | Proposed |
| P4 Bound execution | P3 | Control total work and distinguish failure, cancellation and fallback | Proposed |
| P5 Reuse and resume | P2-P4 | Reuse valid evidence and completed work with explicit validity rules | Proposed |
| P6 Unify workflows | P1-P5 | Use the same concepts through CLI, packets and skills | Proposed |
| P7 Evaluate and promote learning | Baseline at P1; compare after each milestone | Demonstrate improved review quality/resource use and retain verified lessons | Proposed |

Independent pure helpers can be developed together when a task warrants it.
Dependencies express required semantics, not permission for autonomous work
outside the user's requested scope.

## P1. Offline identity, inventory and planning surface

Problem: a label and full diff do not provide an inexpensive, stable entry
point. Existing packet hashing helps identify bytes but omits resolved source
and bounded navigation. First vertical slice: one explicit committed revision,
a versioned bounded inventory, raw input digest and original-coordinate evidence
expansion, with legacy behavior covered. Then complete the remaining sources
and gates below before marking P1 complete.

Build the request/snapshot descriptor and deterministic inventory first, with
an opt-in machine format. Resolve commit/range objects once; explicitly label
context availability for mutable and stdin sources. Include original-coordinate
file/hunk references, raw/numbered sizes, compiler eligibility, and pagination.
Add local capability discovery and the deterministic portion of execution
planning. Freeze command spelling, schema encoding, versioning and failure
output as part of this slice.

Owners: [main](../src/cli/main.ts), [prompt](../src/cli/prompt.ts),
[shape](../src/cli/shape.ts), [diff](../src/meat/diff.ts),
[chunk](../src/meat/chunk.ts). Contract: A1-A3 and local portion of A5.

Gate: offline fixtures cover commit, root/merge commit, both range forms,
staged, worktree and stdin. A ref changing after resolution cannot change
collected evidence. Unknown provenance stays unknown. Unicode/line terminators
preserve identity. Large inventory pages have bounded output and reconstruct
one ordered selection; stale continuations fail. No provider/gateway/auth
network call occurs. Unsupported input can still receive an honest inventory.
Legacy commands retain their contracts.

## P2. Snapshot-bound source and tools

Problem: reading today's checkout can invalidate reasoning about an older
revision, index, or piped diff.

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
discovery links and routing useful visuals through show-me. Make the credential
step explicitly API-only and preserve requested compiled-output intent when
credentials are missing. Use the smallest sufficient operation first and stop
when evidence meets the requested outcome.

Owners: CLI entry/prompt/agent/render and canonical skill.
Contract: A1, A3, A6, A9; [workflow](agent-workflow.md).

Gate: current-session, fresh subscription, offline inspection and compiled API
scenarios select the requested outcome without implicit backend switching.
No recursive fresh-agent review occurs. Mock children demonstrate supported
capabilities, useful incompatibility diagnostics and honest unknown usage.
Legacy full packets stay available. New packet subsets reconcile to parent
coverage; an explanation never acquires compiler guarantees from its wrapper.

## P7. Evaluate usefulness and promote verified lessons

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
| New command names, schema wire shape and encoding | Opt-in; preserve legacy output | P1 implementation merge |
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
