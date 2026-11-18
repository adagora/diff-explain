# columbo Prime

columbo helps an agent investigate a repository, implement a request, and review
changes. Prime loads the instructions for the selected activity. The current
agent performs the work using its existing tools and model access.

## One entry point

Tell your agent: **Use columbo to <desired outcome>.** Add a scope or specialist
skill when useful; the agent selects the activity. You do not need to choose a
CLI command. For example:

> Use columbo to audit the CLI for usability. Use codebase-audit if available.

> Use columbo to add checkpoint recovery. Use the LangGraph skills I provide.

For a fresh session without skill discovery, say:

> Read prime/README.md in the columbo checkout, then use columbo to <outcome>.

When loading this page from a URL, resolve relative links against that same
revision. Read the selected activity and its review policy directly if no local
CLI is available. Instruction-only use supports investigation and work with the
agent's tools; packet compilation requires a working columbo installation.
Do not claim to have installed columbo merely by reading this page.

## Optional specialist guidance

Project rules remain in the target project's AGENTS.md or equivalent. Add stable
project-specific skill paths and version pins there when they should persist.
For one task, name the skill or provide its path or URL in the request. Read only
its relevant instructions and references. Installed skills, local files and
user-provided remote sources are supported by the agent's available tools;
Prime itself does not fetch or install them.

Use specialist guidance when requested or materially relevant to the task.
LangChain or LangGraph guidance is optional, not a default dependency. Resolve
remote references from the supplied source, respect project version pins, and
record the source/revision used in the handoff. Do not invent unavailable skill
contents. If required guidance cannot be read, explain what is missing and
continue only work that does not depend on it.

Specialist instructions supplement the selected activity under the host's
instruction hierarchy and the user's scope. They do not silently authorize
issue creation, installations, external writes, extra agents or a new workflow.

## Start implementing

> Use columbo to implement <change>.

The normal path is [Work](activities/work.md): understand the project, implement,
verify and review. Fixing findings uses this same path. For a substantial review,
read the shared [review policy](review-policy.md) and [Review](activities/review.md).

For an explanation alone, use [Understand](activities/understand.md). Explicit
change reviews use Review; repository investigations use [Audit](activities/audit.md).
Neither read-only request implies implementation. You do not need to learn modes.

The agent loads `columbo prime work --json` for implementation or fixes,
`columbo prime review --json` for a change review, or `columbo prime audit --json`
for a repository audit. `prime understand` remains available for explanations;
`prime converge` is a compatibility entry for fixing findings through Work.
Without an installed command use an absolute path to `dist/cli/main.js`; in this
checkout use `node src/cli/main.ts`. Read `data.instructions` from JSON output.

Packets and abridging take diffs, not whole source trees. `packet HEAD` and
`abridge HEAD` select the latest commit, not the entire repository.

## Bootstrap for the current agent

1. Establish the user's goal, repository and scope. Read its root instructions,
   complete README and applicable nested instructions. Read the complete root
   AGENTS.md when present, including portions beyond any truncated tool output. Follow the host's instruction
   hierarchy and the target's rules, including restrictions on code comments.
2. Select the activity from the request. Read its returned instructions and use
   source evidence to do the task. For a focused fix, trace the relevant path;
   reserve a repository-wide audit for requests that need it.
3. Use the current session by default. Provider keys being present do not request
   an API call. Use API abridging or a fresh subscription process only when the
   user asks for that access path. Respect any runner's tool/test restrictions.
4. For small changes, inspect the original diff directly. Generate a compiled
   reading diff when repetition or complexity makes it useful, or when requested.
   Review correctness against original source, including omitted imports.
5. Finish with source references, actual check results, findings and coverage
   limits. Compilation validates permitted text transformations; it does not
   establish correctness or semantic completeness.

`prime` alone prints this bootstrap. Load only the relevant activity. A loading
command does not inspect Git, run tests, invoke models, install hooks or edit
project files. If the user only asks to load the workflow, confirm readiness.
If they request work, carry out that work rather than merely confirming readiness.

## During implementation

Ask **“Where are we? What needs my attention?”** at any point. Report what works
with evidence, remaining work and blockers, decisions needing the user's judgment,
and consequential changes worth inspecting. Answer a status request without
abandoning the active task. Keep this in the conversation; no separate progress
file or reading diff is required after every edit.

For explicitly requested persistent work, use the host's native goal feature
when available. columbo supplies the work and review criteria; the host controls
continuation. See [Work](activities/work.md#continuation-and-completion).

## Show the behavior

Ask “Show me the behavior as a statechart” or “Show what changes when this fails
or gets cancelled.” Use a statechart when requested or useful for understanding
stateful behavior, within the current implementation, explanation or review.
Read [statechart guidance](optional/statecharts.md) only when needed. Resolve
this resource relative to the columbo installation's prime directory (or the same
URL revision), not the target repository's working directory.

Label charts Proposed, Implementation-traced or Model-checked according to their
evidence. Show important failures and recovery, source references, assumptions
and omissions. A diagram alone is not verification. No new activity, model
checker or renderer is required. Keep original source and diffs available.

## Starting the next session

A handoff is optional: produce it when requested or when work must move sessions.
For “give me the perfect prompt to start the next session”, return one copyable,
self-contained prompt populated with the actual state, not placeholders:

- Repository path, goal, acceptance criteria and constraints.
- Read the complete root AGENTS.md and README.md and applicable nested rules;
  load columbo and only the specialist guidance needed, with paths or source pins.
- Branch/HEAD and dirty or untracked work; preserve existing changes and verify
  the snapshot before trusting previous checks or findings.
- Implemented behavior, relevant files, actual checks and results, open findings,
  blockers and decisions with their rationale.
- Outstanding ideas, explicitly separated into agreed work, proposals and
  deferred items. Preserve useful ideas without turning them into authorization.
- The next concrete action, unresolved questions and any user-defined limits.

Include enough evidence to resume without the previous conversation. Do not
promise lossless memory or claim full understanding. The next agent should
revalidate stale evidence and continue the agreed scope rather than restart.
Do not create a handoff file or activate a native goal unless requested.

## Sources and optional policies

The review policy uses ideas from PACT in locally written instructions. The
inspected commit and file hashes are recorded in [provenance.json](provenance.json).
For full PACT adoption, read [the optional policy](optional/pact.md) and the
project's pinned contract. Loading columbo does not adopt that merge gate.

Load framework guidance when the target uses it and the task needs it. Show-me
can help explain a flow with a small diagram. Neither requires a default upstream
fetch. Earlier Prime research remains in `prime/references/` in this checkout;
that archive is not loaded by Prime or included in the npm package.
