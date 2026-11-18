# Review policy

Apply this policy to reviews, audits and fix/review cycles. It defines columbo's
local process. It does not certify compliance with PACT or enforce a merge gate.

## Identify the code

For a commit review, record the full commit ID. For a branch review, record the
base and head IDs and the comparison used. For dirty working trees, identify the
diff by its SHA-256 when a packet is available and note new files outside it.
For an audit, record HEAD, dirty state and the directories included.

A finding belongs to the inspected snapshot. After edits, check its evidence
again. Previous green checks and reviewer conclusions do not establish the state
of changed code. If another process changes the snapshot during review, report
the interruption and reassess the affected paths.

## Inspect three areas

| Area | Questions |
|---|---|
| Implementation | What can fail? Inspect control flow, state, errors, security boundaries and effects. |
| Contract | Does behavior match the user's request, documented interfaces and compatibility promises? |
| Verification | Do relevant tests exercise the changed behavior and failure paths? Which checks actually ran? |

One agent can inspect these areas sequentially. Additional reviewers are optional
when authorized. Describe a review of your own changes as self-review. A different
vendor is independent only when it inspects the source and original diff itself.

## Write reproducible findings

Each finding needs an ID, priority, area, real path and line reference, triggering
condition, observed behavior, and consequence. Include a reproducer or failing
test when available. State missing context rather than asserting an uncertain
defect. Count each defect once, even when it affects several areas.

| Priority | Use for |
|---|---|
| P0 | A demonstrated route to severe compromise, irreversible loss, or broad service failure. |
| P1 | A concrete functional defect or broken required behavior. |
| P2 | A specific contract violation or regression risk supported by source or test evidence. |
| P3 | An optional improvement with a stated benefit. |

Style preferences do not become blockers without an applicable project rule.
columbo priorities are local; do not reinterpret externally reported priorities
without explaining the mapping. For previous findings, record fixed, still open,
out of scope, or disputed, with evidence for that disposition.

## Report the result

Lead with concrete findings and their effect. If none are found, say "No concrete
findings in the inspected scope" and name that scope. Report the reviewed snapshot,
paths traced or sampled, checks run with outcomes, checks not run, and unresolved
questions. Do not turn missing verification into a passing result.

A compiled reading diff is a selective reading aid. Inspect the original for
correctness, including imports and dependencies hidden by the compiler. Model
agreement and green local tests do not override failed CI for the reviewed commit.
Unknown or pending CI remains unverified. State separately whether a synthetic
merge commit was tested when discussing landing readiness.

Review completion does not authorize PR comments, pushes, approvals or merges.
Concurrent writers need separate workspaces and explicit coordination. Do not
overwrite, reset, stash, or fast-forward another session's work as a side effect
of review. Follow the target's established authorization and branch policies.
