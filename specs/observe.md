# Offline observation contract

Status: current TypeScript behavior, P1 local surface. Snapshot-bound source
reads, aggregate execution controls, receipts and resume remain proposed.
Owners: [snapshot](../src/cli/snapshot.ts), [observation](../src/cli/observe.ts),
[CLI adapter](../src/cli/main.ts). Offline acceptance cases:
[snapshot tests](../test/cli/snapshot.test.ts),
[observation tests](../test/cli/observe.test.ts).

## Operations and compatibility

Flags precede the source. Select exactly one operation:

| Flag | Result |
|---|---|
| `-inventory` | Bounded inventory of captured original diff evidence |
| `-evidence id` | Original bytes for one parent inventory entry |
| `-plan` | Deterministic API partition forecast |
| `-capabilities` | Local schema, operation and control descriptions |

Inventory, evidence and planning accept a commit, two-dot or three-dot range,
`-staged`, `-w`, or stdin, with the existing source-selection rules. Use
explicit `HEAD` in agent shells. Capabilities accepts no source or pagination
options and does not read stdin, probe Git, executables, login or a gateway.

`-page-size n` controls inventory/plan entries: default 20, range 1–100.
`-max-bytes n` controls evidence bytes: default 8192, range 1–16384.
`-cursor token` continues the same operation, selection and page limit.
`-snapshot sha256` requires the collected snapshot to match that identity.
Evidence requires `-snapshot` from its parent inventory; inventory and plan
may also use it. These controls require their corresponding operation.

Observation rejects combinations with `-look`, `-prompt`, `-json`, `-agent`,
`-model`, or `-no-cache`. It performs no model dispatch, provider/gateway/auth
probe, or cache access. Legacy commands keep their collection, rendering,
packet, rubric/compiler and cache contracts. In particular a legacy single
commit still includes its existing `git show` envelope; new observation
collection emits a controlled tree-to-tree diff without a commit message.

Success writes one JSON document and newline to stdout. Its family is
`schema: "meat.observe"`, `version: 1`, with `kind` equal to `inventory`,
`evidence`, `execution_plan`, or `capabilities`. Runtime failure writes only
a diagnostic document to stderr and exits 1. Diagnostics use the same schema
and version, `kind: "diagnostic"`, a stable condition `code`,
`stage: "observation"`, and a bounded explanatory `message`. Flag parsing
errors retain exit 2 and the existing stderr usage behavior. Empty or
whitespace-only diff input is `empty_input`; it does not establish a review.

## Snapshot identity and source semantics

`input_digest` is SHA-256 of exact collected `Uint8Array` diff bytes. Snapshot
`id` is SHA-256 of the UTF-8 canonical JSON descriptor
`{version:1,input_digest,source,context}`. Canonical encoding recursively sorts
object keys, preserves array order, and uses JSON primitive encoding without
whitespace. Selector spelling and absolute repository location live only in
`observations`; neither participates in identity. Display observations are
bounded when emitted. The digest establishes byte identity, not authenticity.

Git provenance records the collection version, fixed config/options, path
filters, exclusions and source policy. Git output disables external diff,
textconv, color, relative paths and configured file ordering; fixes full index
IDs, binary patches, `a/` and `b/` prefixes, three context lines, Myers diff,
output indicators and a 50% rename threshold. Git stdout uses a 64 MiB local
buffer cap. Untracked files are excluded. The policy's exact values are
identity-bearing; changes require a collection compatibility decision.

| Source | Recorded identity and comparison |
|---|---|
| Commit | Resolve the commit once; compare its first parent's tree to its tree. A root uses an explicitly computed empty-tree hash. |
| Two-dot range | Resolve left/right commits once each; compare their trees. |
| Three-dot range | Resolve both commits; require one actual merge base; compare that base's tree to the right tree. Record the base and both endpoints. |
| Staged | Retain exact captured diff bytes against the resolved HEAD tree, or empty tree on an unborn branch; record base commit/tree and index-entry digest. |
| Worktree | Retain exact captured index-to-worktree diff bytes; record base commit/tree and index-entry digest. |
| Stdin | Retain exact bytes without Git or implicit cwd binding; repository and endpoints remain unknown. |

Committed sources expose `context.availability: "immutable_git"`,
`consistency: "immutable"`, and before/after tree IDs. All collection after
resolution uses object IDs, so later ref movement does not change those bytes.
Tree identities do not advertise snapshot-bound read/search tools or durable
retention of Git objects; those operations belong to P2.

Mutable collection compares index-entry hashes, HEAD identity and two diff
captures, with at most two attempts. A persistent mismatch is `source_changed`.
It uses optional-lock suppression and does not write trees or alter index or
worktree state. Captured evidence is retained independently of later edits.
This detects observed races; it cannot prove one atomic filesystem instant.
Mutable context is `unavailable`, consistency is `unverified`, before/after
context trees are null, and reason is `mutable_context_not_captured`. Stdin
uses the same unavailable/unverified context with `stdin_provenance_unknown`.
Captured mutable source-file context remains P2 work; P1 provides diff evidence.

## Inventory, coordinates and pagination

Inventory reports raw/numbered byte sizes, original line count, compiler
eligibility with a reason when ineligible, summary counts and ordered entries.
Unsupported or oversized compiler input can still receive an honest inventory
and raw evidence. Content classes are text, binary, metadata, combined and
envelope. Entries identify files (`f:`), hunks (`h:`), envelopes (`m:`) and
deterministic exact-move relationships (`v:`). IDs refer to original byte
positions and are interpreted only under their snapshot.

Original diff bytes are zero-based; original diff lines are one-based; all
range ends are exclusive. Hunk `source_lines` separately describes old/new
source-file starts and counts. File/hunk ranges can overlap because hunks are
children of file entries. Supported hunk ranges stop at the last classified
hunk line; trailing prose remains available through its file entry.
Paths are bounded display text and may be truncated;
unquoted same-path Git headers retain embedded spaces, including ` b/` text.
exact bytes remain expandable. Relationship entries contain removed/added
original ranges; they report deterministic exact matches, not inferred intent.

Inventory/plan pages expose `offset`, `total`, `omitted` and `next`. Entries
are deterministic and pagination reconstructs their ordered sequence.
Continuation tokens bind schema version, snapshot, query and offset, with a
checksum. A changed snapshot rejects continuation as `source_changed`; a
malformed token or changed query/page size is `invalid_request`. Checksums
detect corruption and do not provide authentication. Each invocation recollects
the source; mutable/stdin callers must resupply the same evidence to continue.

Evidence returns exact original bytes as `encoding: "base64"`, `data`, and a
page byte range. Pages may split UTF-8 code points or lines; concatenate decoded
bytes to reconstruct the selection before decoding text. Line ranges describe
intersecting original lines, including partial lines. Selection metadata names
the parent snapshot, selected range and excluded parent bytes, with coverage
limited to that selection. A complete page sequence establishes byte delivery,
not complete review of the parent. Exact-move relationships crossing a selection
are counted; up to 20 IDs are returned, with omitted count and parent inventory
as the discovery route for the rest.

## Deterministic planning and capabilities

Planning applies the existing API engine's partition policy to the collected
observation snapshot, with byte/numbered
sizes, passthrough partitions, original line spans, synthetic lines, mandatory
import/exact-move omission counts and cross-partition relationship counts. Each
partition emits at most 32 origin spans; omitted details are explicitly
unavailable pending P3 witnesses. Planning eligibility can fail when inventory
eligibility succeeds, for example an indivisible oversized hunk.
Its `input_basis` is `observation_snapshot` and
`legacy_selector_execution_equivalence` is `not_assessed`. A plan does not
forecast legacy execution of the same Git selector: a legacy commit envelope
can change input size and partition boundaries.

`plan_id` binds version, snapshot, API workflow, live context policy,
rubric/compiler protocol hash, partition policy version and per-partition
byte budget. It is a local partition forecast identity, not the full proposed
A5 execution-plan identity. Execution still uses live-checkout read/search
tools; a plan does not bind those tools to snapshot trees. Cache eligibility
is unassessed and no cache metadata is read. Forecast model runs count eligible
non-passthrough partitions; model calls, tokens and cost remain unknown.
Aggregate execution controls, semantic validation and cross-partition move
validation are unsupported or not performed. No operation is dispatched.
An intersecting exact move is counted as crossing when both complete sides
cannot map contiguously into that partition, using the compiler's move mapper.

Capabilities reports the supported observation operations, schema version and
page bounds. Adapter availability/authentication and current-session usage stay
unprobed or unknown. Snapshot context tools, aggregate deadline/call controls,
hard token/money caps and resume are explicitly unsupported. P2–P7 remain
proposals in the [roadmap](../docs/roadmap.md).
