# Review and handoff with an agent

This is the workflow for the **current CLI**. Proposed inventory, snapshot,
receipt and resume operations are described in
[system design](system-design.md) and the [roadmap](roadmap.md); they are not
available commands. Usage and installation details remain in
[README](../README.md).

## 1. Establish outcome, source and evidence

Choose the requested result before choosing a backend. Available credentials
alone do not determine intent.

| Requested outcome | Current operation | What it establishes |
|---|---|---|
| Inspect shape and original diff | `-look` | Local counts/shape and full input |
| Explain within the open agent session | `-prompt`, then read it | Full input packet; agent supplies interpretation |
| Run a fresh subscription review | `-agent codex` or `-agent claude` | External CLI explanation |
| Produce a compiled reading diff | API abridging, optionally `-json` | Validated source-derived elisions and specified compiler invariants |

Use explicit `HEAD` for the latest commit, a named range for branch changes,
`-staged` for the index, or `-w` for unstaged tracked changes. Flags go before
the revision. Staged/worktree selectors cannot combine with a revision.
Untracked files are excluded. Empty input is an error, not a finished review.

Run from the repository being reviewed. In this checkout the source entry is
`node src/cli/main.ts`; elsewhere use an absolute path to meat's source or
built entry. Avoid rebuilding when a working launch line already exists.

For a committed review, resolve the endpoints (for example `git rev-parse HEAD`)
and record the actual commit/range used. For a three-dot comparison, retain the
merge base as well. Staged/worktree scopes are mutable: the packet's SHA-256
identifies captured diff bytes, not an atomic repository snapshot. Preserve the
input when a handoff needs it, and regenerate after edits.

Current engine tools read the live checkout. When historical/index context
matters, inspect the appropriate Git tree/blob explicitly and label the source
of additional evidence. Piped input may describe a different repository.
Do not infer correspondence from the shell's current directory.

## 2. Use the smallest sufficient workflow

For an explanation in this session, ask:

> Use meat and show-me to explain HEAD using my current session.

The canonical [meat skill](../.claude/skills/meat/SKILL.md) runs `-prompt` and
reads its output in the current session. It uses the installed show-me guidance
when a visual helps. Packet creation needs no API key and launches no model.

Manual packet generation in this checkout:

```sh
node src/cli/main.ts -prompt HEAD
```

Save output to a chosen local file only when a handoff or reuse needs it. Use
direct Node commands for redirection, or `npm run --silent packet -- HEAD`;
ordinary npm script banners can contaminate an artifact.

Both `-look` and `-prompt` emit the full diff. Running look immediately before
prompt repeats that payload. If a packet already provides enough evidence,
read it directly. Expand context only for questions that could change the
conclusion: callers, types, tests, configuration, or before/after behavior.

For a large diff, select a meaningful narrower range or explicit path groups
with Git, keeping a parent file/coverage list. A filtered packet is a subset of
the review. Account for all groups and inspect relationships crossing them.
Never silently truncate an oversized packet or claim the parent review is
complete after inspecting only a subset. Grok chat can use a pasted/attached
packet, with unavailable repository context stated.

For a fresh terminal review:

```sh
npm run review -- HEAD
npm run review:claude -- HEAD
```

These start separate signed-in Codex/Claude processes. Meat checks subscription
auth, removes API environment overrides, includes the installed show-me
instructions, and has no API fallback. Login is managed by the external CLI
(`codex login` / `claude auth login`). Do not recursively launch `-agent`
inside a meat review; use its supplied packet. CLI failure exits 1. Ctrl-C
requests child termination. The current child review has no execution deadline.

For compiled output, use API abridging as described in README. Missing API
credentials mean the compiled result is unavailable until that prerequisite
is met; a packet is a different artifact. The engine has per-chunk limits,
but the CLI exposes no aggregate time/token/call cap.

## 3. Assess what the result supports

Start with the behavior change and cite concrete evidence. Distinguish observed
changes, inferred intent, and unresolved questions. A useful visual preserves
those distinctions and links to the same evidence as the prose.

| Evidence | Supported conclusion | Limit |
|---|---|---|
| Packet digest | Input byte identity | No identity for surrounding checkout context |
| Successful edit-plan compilation | Source-derived output under implemented rules | No proof of semantic completeness, summary accuracy, or passing tests |
| Reading diff | Selected changes to read | Imports and other content may be omitted; it is not an applicable patch |
| Chunked compiled result | Per-chunk checks and merged output | Cross-chunk move symmetry is not globally validated |
| Existing API JSON | Diff, summary, returned usage, optional elision | No fallback/coverage/provenance envelope |
| Cache hit | A stored result matched the existing key | Context/routing are absent from that key; tokens describe historic work |
| External-agent answer | An explanation of supplied/inspected evidence | Meat has not compiled or independently validated its reasoning |

Use the original diff to resolve a consequential omission. Report checks
actually performed with command, scope and result; proposed checks remain
proposals. Compiler success and rubric assumptions never establish test success.
If source changed, identify which findings need revalidation.

For a changed context or provider route, `-no-cache` recomputes API output and
still stores it. `MEAT_CACHE=""` disables cache reads and writes. A cached result
alone cannot verify today's source.

## 4. Leave a compact, resumable handoff

Include only information another session needs to continue:

- **Intent and scope:** requested outcome, repository, resolved endpoints or
  mutable source, filters and excluded categories.
- **Evidence:** packet/raw input location and digest; context paths plus
  revision or live-checkout identity; regenerate when those change.
- **Findings:** supported behavior/risk with references; inference labelled.
- **Coverage and limits:** inspected paths/partitions, remaining groups,
  unavailable context, compiler/agent provenance.
- **Verification:** commands actually run, input revision and outcomes.
- **Next action:** the smallest operation that would resolve the remaining
  material question, with any prerequisite or budget limitation.

A new session first verifies the handoff's evidence identity, then continues
from its remaining question. Reuse valid artifacts; stale ones are historical
evidence. Current meat has no structured checkpoint/resume interface, so this
handoff is an agent practice.

## 5. Promote durable knowledge

Use [decisions](decisions.md) for a stable choice or reproducible gotcha:
decision, reason, evidence, scope and when to revisit. Put behavior contracts
in the relevant spec and planned changes in the roadmap. When a behavior fix
needs regression coverage, retain a minimal deterministic reproduction.

Verify a finding before promoting it. Update an obsolete entry in place or
mark it superseded with a link; avoid accumulating contradictory instructions.
Revisit entries when their owning code, protocol or assumptions change.
Keep transient run details in the handoff, and keep startup instructions focused
on navigation and invariants.

## Hosting and visual integration

GitHub/GitLab reviews use local Git data after fetching the relevant refs through
the normal workflow. Review the actual target/source comparison, such as
`origin/main...HEAD`; pipelines should use supplied SHAs and ensure the
merge base is available in shallow checkouts. Posting, approving and merging
are separate authorized host operations.

HumanLayer's installed [show-me skill](../.claude/skills/show-me/SKILL.md) guides
visual explanation. Integration lives in the meat skill; upstream visual
guidance stays independent. Codex/Claude/Grok discovery links and plain packet
handoffs select the same evidence workflow. Visuals inherit the explanation's
evidential limits.
