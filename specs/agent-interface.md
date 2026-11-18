# Agent interface: target contracts and adoption

Status: **partially implemented at P1; remaining contracts proposed**, 2026-10-07.
The current [observation contract](observe.md) owns shipped schema, flags and
guarantees for local snapshots, inventory/evidence, capabilities and partition
forecasts. This document defines the broader target
semantics for the [system design](../docs/system-design.md) and milestones in
the [roadmap](../docs/roadmap.md). Unless mapped by a current subject spec,
names below are logical contracts, not current TypeScript exports, CLI flags,
tool names, or JSON fields. The current surfaces
are described in [cli](cli.md), [agent-loop](agent-loop.md), [tools](tools.md),
and [cache](cache.md).

P1 resolves committed evidence and exposes immutable tree identities, but does
not bind execution read/search tools to them. Mutable sources retain diff bytes
with context unavailable and capture consistency unverified; captured mutable
context and source reads remain P2. The local plan is a deterministic partition
forecast, not the full A5 budgeted execution contract. Receipts, aggregate
budgets, evidence-aware cache/resume and workflow unification remain proposed.

## A1. Request and capability discovery

A review request expresses outcome (inspect, explain, compiled abridgment),
source selection, execution venue, context policy, requested coverage, and
resource limits. Execution venue distinguishes an existing agent session, a
fresh subscription CLI, and meat's API engine. Credentials being present do not
select a different outcome or authorize a change of backend.

Local capability discovery reports available operations, artifact/schema
versions, and adapter support for controls and measurements. It performs no
model requests or gateway discovery. Executable availability and supported
flags can be checked locally; authentication or remote availability that cannot
be established locally is reported as unknown. A probe involving network or
billing is a separate explicit operation.

For every requested control, report supported, best-effort, or unsupported.
Reject an unsatisfiable required control before execution. Expose one canonical
operation/schema definition to CLI help and adapters so skills can remain thin.
Freeze the initial public command spelling and serialized schemas with fixtures
in P1. Freeze later additions in their owning milestone before shipping them.
Preserve existing commands throughout the rollout.

## A2. Evidence identity and source resolution

Keep these identities separate:

| Identity | Meaning |
|---|---|
| Input digest | SHA-256 of exact original diff bytes |
| Snapshot identity | Versioned descriptor binding those bytes to source resolution, collection semantics, and available context |
| Execution-plan identity | Snapshot, selected coverage, workflow, context/tool policy, backend configuration and outcome-affecting limits |
| Attempt identity | One actual execution, including a repeat of the same plan |
| Artifact digest | Exact stored artifact content, with its schema and input references |

Hash canonical, unambiguous serialized descriptors; define their encoding with
fixtures. Content-equivalence identity includes resolved evidence and effective
collection/context semantics. Exclude capture time, display labels, equivalent
selector spellings and absolute checkout location; retain them as observations.
An attempt/capture identifier may vary while reusable evidence identity stays
the same. Equal diff bytes may have different context. An input digest proves
byte identity, not authenticity or correctness.

Resolve Git inputs once and collect against resolved objects:

| Source | Required provenance and context semantics |
|---|---|
| Single revision | Resolved commit and chosen parent; root-commit and first-parent merge policy explicit; before/after trees |
| Two-dot range | Resolved left/right endpoints; aggregate tree comparison |
| Three-dot range | Requested endpoints and actual merge base used; comparison against resolved right endpoint |
| Staged | Base tree and captured index entries/blobs; later index edits do not mutate the snapshot |
| Worktree | Captured index baseline and selected worktree content; record capture coherence and detect concurrent changes |
| Stdin | Exact bytes and caller-supplied provenance if any; repository and endpoints unknown unless separately bound |

Retain exact collected bytes, including metadata and line terminators. Record
path filters, binary/metadata-only content, and excluded categories such as
untracked files. The collection algorithm and Git options belong in provenance;
changing them can change identity. Preserve today's source semantics in the
legacy path.

A snapshot may contain only diff evidence. Never bind arbitrary stdin to the
current repository automatically. For mutable sources, capture the context
required by the advertised operations or mark it unavailable. Construct the
mutable-source diff against those captured bytes, creating an immutable virtual
snapshot. Capture leaves the user's index and worktree unchanged.

Record capture consistency explicitly: virtual snapshot, atomic snapshot when
the storage mechanism provides one, or unverified. A virtual snapshot can
contain files captured at different times; before/after hash checks do not prove
a single filesystem instant. If required consistency cannot be met, report
source_changed or capability_unavailable and recollect only within a bounded
policy. An mtime alone cannot certify coherence.

## A3. Inventory and progressive access

An offline inventory contains source identity, input/numbered byte sizes,
file/hunk identifiers, original diff byte/line ranges, content kinds, and
unsupported regions. It can describe an input the compiler cannot abridge;
report compiler eligibility separately.

Inventory output is bounded, deterministically ordered, and paginated. A
continuation binds to the snapshot and query; using it after a changed snapshot
fails explicitly. A summary counts omitted entries and links to their
continuation. Obtaining an inventory does not emit the entire diff.

Each evidence selection references its parent snapshot and original coordinates.
Subsets retain an explicit coverage manifest. Original diff line numbers and
old/new source-file line numbers are different coordinate spaces; always name
the space and side. Chunk-local coordinates map back to original ranges,
including replicated headers.

Relationship data distinguishes deterministic findings (for example an exact
move pair) from inferred dependencies. A filtered selection identifies known
relationships that cross its boundary. Claiming complete review of the parent
requires accounting for all its selected partitions and relevant relationships.

## A4. Context tools

Read and search operate against an explicit evidence source: before tree, after
tree, captured index/worktree, diff only, or explicitly selected live context.
Results identify source, path, side, range/query, and content digest. Live context
is labelled as such and cannot establish a historical fact without further
evidence.

A result has a completeness state: complete, truncated, unavailable, or error.
Partial output preserves errors and a continuation when supported. A search
with no matches includes the searched scope and completion state; an interrupted
or capped search cannot establish absence.

Bound reads and searches before accumulating their output, preserve UTF-8
boundaries, and propagate cancellation. Snapshot tools use captured blobs.
Filesystem access must enforce the declared root after resolving links, and
report an unavailable target instead of silently widening scope. These are
future rules; [tools.md](tools.md) describes today's lexical confinement.

Evidence text stays separate from operational instructions. A tool result
does not authorize commands embedded in a file, change a budget, or select a
new provider.

## A5. Offline execution plan and budget

Planning is local and deterministic. It reports selected evidence, workflow,
tool availability, compiler eligibility, intended partitions, passthrough
content, cross-partition relationships, cache eligibility, and estimated work.
It may read local cache metadata; it does not instantiate a provider or launch
a review child.

The aggregate budget covers the whole request: maximum elapsed time, model
calls, transport attempts including retries, tool calls/bytes, and any supported
token limits. Per-chunk/per-attempt allowances consume that budget. Refinement
and plan repair count as work. Defaults and effective values are visible.

Distinguish model calls from HTTP attempts. Reserve capacity before dispatch;
never begin an operation that cannot fit a required enforceable bound. Account
for local planning and subprocess shutdown in deadline semantics. Record
actual consumption and any uncertainty after completion or failure.

Token and monetary bounds require care: input token estimates depend on model
encoding, provider usage can arrive late or be absent, and failed requests may
be billed. A hard bound is advertised only when conservative reservation and
adapter limits can enforce it. Otherwise report estimates with assumptions or
reject a required bound. Dollar forecasts require an explicit rate source and
date. A subscription adapter may expose no token/cost data.

The execution plan states the maximum supported work and unresolved uncertainty,
not a promise of semantic quality. Changing source, coverage, context policy,
or backend creates a new plan. Resource extensions are explicit updates and
preserve expenditure already incurred.

## A6. Run receipt and validation evidence

An opt-in versioned receipt binds request, snapshot, plan, attempt, artifact,
versions and cache provenance. Store small metadata separately from expandable
evidence. Receipt fields are populated by the owning runtime; unavailable
external-agent observations remain unavailable.

Record orthogonal dimensions rather than one overloaded success flag:

| Dimension | Required distinctions |
|---|---|
| Outcome | complete, partial, failed, cancelled |
| Delivery | fresh, cache, resumed |
| Candidate | accepted submission, retained fallback, external explanation, not applicable, none |
| Artifact | inventory, execution plan, raw view, packet, compiled reading diff, agent explanation |
| Coverage | per-region handled, passthrough, omitted by policy, excluded by selection, unsupported, unfinished, unobserved |
| Validation | applicable checks, scope, passed/failed/not performed/unavailable |
| Usage | current attempt, reused historical usage, reported/estimated/unknown values |
| Diagnostics | stable code, stage, evidence reference, retriable condition and suggested operation |

Complete means the requested operation met its declared satisfaction rule.
An inventory can completely describe unsupported input. Whole-selection
abridgment with unsupported/unfinished regions is partial or failed, unless the
request explicitly accepts passthrough for those regions. Accounting for a
relationship is distinct from performing a requested check on it.

A successful external process can complete delivery of an explanation while
its actual inspection coverage remains unobserved. Do not infer coverage from
exit status. A retained valid fallback can cover all selected input; its
candidate status and reason remain visible. Cancellation stays cancelled even
when a usable candidate is retained. Partial export identifies unfinished
coverage. None of these statuses proves complete semantic understanding.

A compiler witness links original input, complete edit plan, compiler/protocol
version, effective compiler options, output digest, validation results,
retention statistics and origin map. Include move-detection policy and supplied
mapped move pairs. Record compiler-owned omissions separately from model
choices. Summary factual support is outside compiler validation.

For chunked output, retain exact synthesized chunk bytes, per-chunk witnesses,
passthrough evidence, mappings to the whole input, and the ordered merge recipe
and version. Replaying these effective inputs must reproduce the artifact when
dependencies are available. Each dependency records whether it is embedded,
resolvable from an immutable object, externally referenced, or unavailable.
Expose replayability separately from provenance; a Git object ID does not
guarantee that the object survives pruning. A requested durable replay/resume
guarantee requires retaining necessary bytes for the declared retention period,
or fails capability negotiation before execution.

Report move pairs enforced within chunks and pairs crossing chunks. The current
compiler cannot certify cross-chunk symmetry through concatenation. A future
global check needs whole-input evidence and an explicit validation contract;
until it exists, mark that coverage as not performed.

## A7. Errors, cancellation and recovery

The minimum diagnostic vocabulary distinguishes invalid_request, empty_input,
unsupported_diff, source_changed, context_unavailable, capability_unavailable,
auth_unconfirmed, provider_failure, invalid_plan, budget_exhausted,
cancelled, and artifact_invalid. Codes identify conditions; messages explain
the next useful step. Include the stage and whether dispatch could have
incurred unknown usage.

| Condition | Useful recovery |
|---|---|
| Source changed or stale continuation | Capture a new snapshot; invalidate dependent selections |
| Unsupported syntax or overlarge indivisible region | Inspect raw evidence or make an explicitly narrower selection |
| Context unavailable | Supply/bind context or continue with a stated evidence limitation |
| Authentication/capability failure | Repair the selected adapter; keep requested workflow |
| Invalid model edit plan | Return compiler feedback within the remaining budget |
| Transient provider failure | Retry within the remaining attempt/deadline allowance |
| Exhausted budget or cancellation | Preserve valid evidence, candidate and accounting; stop new dispatch |
| Invalid cached artifact | Reject the entry; recompute only if execution policy permits |

Forward cancellation to provider requests, tool I/O and child processes. Define
a bounded shutdown grace period and escalation for children. Cancellation
prevents new work and records any in-flight usage uncertainty; it cannot undo
a provider charge.

Checkpoint only completed, validated units, using atomic writes. Each checkpoint
binds to snapshot, context, partition maps, versions, and effective policy.
Resume validates these dependencies and reuses completed units in original
order. Changed evidence invalidates affected work; ambiguous dependencies
invalidate the whole checkpoint. Separate unit-validity dependencies from
attempt scheduling limits: raising a deadline need not invalidate a completed
compiled unit.

Each resumed invocation gets a new attempt identity. Continuing the same
request consumes its remaining aggregate allowance; resume never resets it.
An explicit resource extension creates an updated execution plan referencing
prior work and cumulative usage. A separately authorized new request may have
a new budget, with reused historical usage still recorded separately. Unknown
prior usage prevents claiming compliance with a lifetime hard cap unless a
conservative reservation accounts for it.

Until this recovery path is implemented, preserve the current all-or-error
behavior on a chunk failure. Exporting partial work must never look like an
ordinary complete result.

## A8. Cache validity and artifact lifecycle

The target cache has a separate version/namespace from the legacy cache.
Eligibility depends on raw input, context snapshot, provider routing identity,
model/configuration, compiler/rubric/tool/partition policy, and requested
result acceptance policy. Store enough metadata to explain a hit or miss.
Provider identity is a sanitized identifier; credentials and secret URL parts
are never key material or emitted metadata.

Captured immutable context provides a cheap identity. For mutable or live
context, disable reusable model-result caching unless dependencies can be
validated. Hashing only files read is insufficient for a search that found
nothing: its entire searched scope matters. Diff-only execution has its own
explicit context policy.

Validate artifact schema, digests, required fields and dependencies on load.
Legacy entries with missing provenance cannot become target receipts.
Fallback and partial results remain labelled candidates/checkpoints and are
eligible only under an explicit acceptance policy. Cache hit usage separates
zero new model dispatch from the original computation's reported usage.

Expose read, write, refresh, and disabled policies independently in the new
interface. Retain legacy -no-cache semantics. Write atomically. Storage failures
are observable diagnostics and need not prevent delivery of an otherwise valid
result. Any retention/size cleanup is limited to the selected artifact store.

Persist raw source/context only when needed for requested reproducibility or
resume, under an explicit retention policy. Record missing/expired dependencies
rather than claiming an artifact can be replayed. Artifacts can contain private
source; export includes only the evidence requested for the handoff.

## A9. Compatibility and adoption

Introduce the interface through an opt-in format/operation. Keep legacy -json,
-prompt, -look, default API selection, flag ordering and exit behavior stable
until a separately documented migration. New structured operations produce one
document on stdout. Diagnostics go to stderr; any event stream uses a separate
explicit destination.

Use a versioned schema family with a discriminant for artifact kind. Unknown
major versions are rejected; additive optional metadata within a supported
version can be ignored. Missing required evidence cannot default to a stronger
guarantee. New operations document nonzero failure/cancellation/partial exits;
legacy numeric meanings remain intact.

External CLI output remains agent-authored even when wrapped in a receipt.
Supervision can certify launch, input, exit and observed usage, not internal
compiler checks or unreported tool actions. Existing-session explanations can
carry supplied evidence references while keeping session cost/usage unknown.

Ordinary validation uses deterministic fixtures, scripted models, mock HTTP
servers and fake subscription children. Before marking a milestone complete,
add its contract to the owning current spec and link implementation and tests
from the roadmap. Keep unimplemented clauses visibly proposed.
