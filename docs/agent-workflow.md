# Review and handoff with an agent

This is the workflow for the **current CLI**, including P1 offline observation
in [observe](../specs/observe.md). Snapshot-bound context tools, receipts and
resume remain proposed in [system design](system-design.md) and the
[roadmap](roadmap.md). Usage and installation details remain in
[README](../README.md).

## 1. Establish outcome, source and evidence

Choose the requested result before choosing a backend. Available credentials
alone do not determine intent.

| Requested outcome | Current operation | What it establishes |
|---|---|---|
| Identify exact scope and inspect bounded evidence | `-inventory`, then `-evidence id -snapshot sha256` | Snapshot identity, original ranges and selected raw bytes |
| Forecast API partitioning locally | `-plan` | Deterministic partitions and limitations; no dispatch |
| Discover local operations and bounds | `-capabilities` | Versioned supported/unsupported contract; no source or auth probe |
| Check which workflows this machine can run | `-doctor` | Human-readable readiness: PATH, skills, subscription login, API key names; no model call |
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
built entry, or `meat` after `npm run setup` linked it. Avoid rebuilding when a
working launch line already exists. To save output, use `-o file` rather than
shell redirection: it writes stdout's exact bytes and only after success.

For observation, record the snapshot ID, input digest and source descriptor.
Commit/range endpoints are resolved once, including the actual three-dot merge
base. Equivalent selector spellings and checkout locations do not change
snapshot identity. Staged/worktree snapshots retain captured diff bytes with
unavailable context and unverified consistency; they do not imply an atomic
repository instant. Stdin remains unbound to any repository. For legacy packet
reviews, resolve and record endpoints separately; the packet digest identifies
only captured diff bytes. Preserve evidence when a handoff needs it and
regenerate after edits.

Current engine tools read the live checkout. When historical/index context
matters, inspect the appropriate Git tree/blob explicitly and label the source
of additional evidence. Piped input may describe a different repository.
Do not infer correspondence from the shell's current directory.

## 2. Use the smallest sufficient workflow

For a large input, start with a bounded inventory:

```sh
node src/cli/main.ts -inventory -page-size 20 HEAD
node src/cli/main.ts -evidence h:123 -snapshot <snapshot-sha256> -max-bytes 8192 HEAD
node src/cli/main.ts -plan HEAD
```

Replace the example entry and snapshot with values from the parent inventory.
Follow `page.next` with `-cursor`, preserving source, operation, selection and
limit. Evidence is base64; concatenate decoded byte pages before text decoding,
since a page may split a UTF-8 character or line. Ranges describe original diff
bytes/lines with exclusive ends, separately from hunk old/new source positions.
The selected coverage does not establish parent review. Inspect exact-move
relationship entries and crossing IDs before treating a subset as independent.
Changed snapshots fail explicitly; capture a new inventory instead of carrying
old IDs into edited evidence. Mutable/stdin continuations must resupply the same
input because collection runs again on each invocation.

`-plan` applies the API partition policy to the captured observation snapshot
without reading cache metadata or dispatching a model. It does not assert the
same partitions for legacy execution of a Git selector, whose envelope may
differ. Read its context and coverage limits: execution still uses
live-checkout tools; model calls, tokens and cost are unknown. `-capabilities`
reports local supported controls without probing source, authentication or
remote services. These JSON operations are separate from full packet workflows.

For an explanation in this session, invoke `/meat HEAD` in Claude Code or
`$meat explain HEAD` in Codex. Natural language also works: “Use meat to explain
my staged changes.” To make the skill available in other repositories, run
`npm run skill:install -- all` from the meat checkout and open a new CLI session.
Choose `codex` or `claude` for a single host. The personal skill records the
absolute source entry and reads the canonical instructions on each use. Keep
the shell in the repository being reviewed; rerun the installer if the checkout
moves or its discovery metadata changes.

The canonical [meat skill](../.claude/skills/meat/SKILL.md) runs `-prompt` and
reads its output in the current session. When a visual helps, it adds the
smallest plain-text or Mermaid sketch. Packet creation needs no API key and launches no model. The skill
installer supports Codex and Claude Code; Grok discovery remains client-dependent.
No plugin package is required or shipped. The skill does not change the default
API behavior of a direct `meat HEAD` invocation.

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
auth, removes API environment overrides, includes meat's built-in visual
guidance, and has no API fallback. Login is managed by the external CLI
(`codex login` / `claude auth login`). Do not recursively launch `-agent`
inside a meat review; use its supplied packet. CLI failure exits 1. Ctrl-C
requests child termination. The current child review has no execution deadline.

For compiled output, invoke API abridging as described in README and preserve
the CLI result. The CLI resolves model/provider, cache and access: cache hits
need no provider access, and configured endpoints or supported gateways can
work without keys. If the CLI reports a missing prerequisite, retain the
requested compiled-output intent and report that diagnostic; a packet is a
different artifact. The skill must not recreate compiler rules. The engine has per-chunk limits,
but the CLI exposes no aggregate time/token/call cap.

## 3. Assess what the result supports

Start with the behavior change and cite concrete evidence. Distinguish observed
changes, inferred intent, and unresolved questions. A useful visual preserves
those distinctions and links to the same evidence as the prose.

| Evidence | Supported conclusion | Limit |
|---|---|---|
| Observation snapshot ID | Exact diff plus resolved source and collection/context policy | Mutable context unavailable; no bound execution tools or durable object retention |
| Inventory/evidence page | Ordered entries or exact selected original bytes | Complete delivery does not establish complete parent review |
| Local execution plan | Existing API partition forecast and omission counts | No execution, enforceable aggregate budget, semantic validation or known call/token/cost total |
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
- **Evidence:** observation snapshot/selection IDs or packet/raw input location
  and digest; context paths plus
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

Visual guidance is built into the meat skill and the `-agent` prompt and uses
portable text forms: pseudocode, call trees, code sketches and Mermaid.
Codex/Claude/Grok discovery copies and plain packet handoffs select the same
evidence workflow. Visuals inherit the explanation's
evidential limits.
