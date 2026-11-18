# columbo with Codex, Claude Code, or another agent

## Start with Prime

Use `columbo prime` to load the local bootstrap, or `columbo prime understand`,
`columbo prime work`, and `columbo prime review` for a selected activity. Append
`--json` to read `data.instructions` in the versioned envelope. In this checkout
replace `columbo` with `node src/cli/main.ts`; from another repository use the
absolute built CLI path. Loading guidance makes no model call and does not run
checks, edit the target, or install hooks.

Use `columbo prime audit` for repository-wide investigation. It guides the agent
through an architecture map, important execution paths, findings and a coverage
record. Implementation and fixing findings both use Work, with no default round
cap. `columbo prime converge` remains a compatibility entry that loads Work.
Review, Audit and Converge load the shared
review policy. None of these commands scans code or executes a loop by itself.
`columbo packet HEAD` and API abridging still consume selected diffs; they do not
upload a whole repository as a new analysis mode.

Ask the current agent: “Use columbo to implement this request, then review the
consequential changes before finishing.” The Work activity includes that review
checkpoint. Small edits use direct diff inspection; compiled reading views are
optional when they help. Source evidence, actual checks, and material uncertainty
are the deliverable. API calls and additional agent sessions remain explicit.

The canonical columbo skill is `.claude/skills/columbo/SKILL.md`, linked into
Codex/Grok discovery roots. The Meat skill and command remain compatible.
The npm package ships skills and workflow documents but does not install them
into other projects' host discovery directories automatically. Run `columbo setup
--project /path/to/project --agent both` for a preview, then add `--yes` to install
the skills for Codex and Claude Code. Setup uses copies and absolute CLI launch
paths, preserves existing content, and makes no model call. The repository
folder may still be named meat; paths below refer to this existing checkout.

## Status and next-session prompts

Ask “Where are we? What needs my attention?” for verified progress, remaining
work, blockers and decisions. This does not stop the implementation task.

Ask for a next-session prompt when a handoff is useful. The agent returns one
copyable prompt with repository and snapshot, goal and constraints, changed files,
actual checks, findings, decisions, outstanding ideas and the next action. Agreed
work, proposals and deferred ideas remain distinct. The next session reads the
complete project rules and README and verifies the current state before relying
on earlier evidence. No separate handoff file or goal is created automatically.

## Portable compiled output (current agent or any model)

Run `columbo capabilities --json` for the live contract, or `columbo guide` for a
copyable workflow. In this checkout, replace `columbo` with
`node src/cli/main.ts`; from another repository, use the absolute built CLI path.

```sh
columbo packet main...HEAD > packet.json
# Read data.instructions and numbered_diff. Write plan.json using plan_schema.
columbo compile --packet packet.json --plan plan.json > result.json
```

An agent can do all three steps inside its current session. No provider API is
called by packet or compile. For an automatic API-key model/tool loop, use
`columbo abridge -json -model MODEL main...HEAD`; it retains the existing API JSON
format. Provider credentials stay with the selected access path.

The JSON packet is a saved diff snapshot, not a request to reread mutable HEAD.
Compilation works without the checkout and refuses mismatched hashes, changed
numbering, incompatible compiler identity, or invalid plans. Repair only the
plan on validation errors. Generate a new packet and plan when the diff changes.
`packet` defaults to HEAD; pipes require `--stdin`. New command options can follow
the revision; legacy flags must precede it.

The resulting reading diff is compiler-validated, but omissions are still
model-selected. It is not evidence of semantic completeness, test execution,
or full review coverage. Imports are always removed. Preserve the original diff
and record surrounding source and actual verification separately in handoffs.
The offline bridge caps raw UTF-8 diffs at 400 KiB; narrow the scope or explicitly
use the API engine's chunking. File/stream JSON artifacts are capped at 16 MiB.

## Direct terminal review (subscription CLI)

`npm run review -- HEAD` now runs a fresh signed-in Codex process and prints its
answer. `npm run review:claude -- HEAD` uses Claude Code. From any repository,
use `node /path/to/meat/dist/cli/main.js -agent codex HEAD` (or `claude`).
Sign in first with `codex login` / `claude auth login`. columbo verifies subscription
auth, removes API environment overrides, includes the installed show-me skill,
and fails rather than switching to an API account. It forwards child output to
the terminal; Ctrl-C requests termination. A CLI failure exits 1.

These are fresh sessions using the CLI login, not continuations of an open
conversation. The packet workflow below remains useful inside an existing
session and for Grok. Do not recursively invoke `-agent` from a columbo review.

Start with one agent implementing a change. Use a fresh session for independent
review when useful. Give it the actual source/range and test evidence, not just
an implementation summary.

## Subscription-first handoff

In this checkout, the shared meat skill defaults explanation requests to the
subscription workflow. Tell your signed-in agent:

> Use meat and show-me to explain HEAD using my current session.

For unstaged tracked edits, substitute “my unstaged changes” for `HEAD`; for a
PR/MR, provide its actual range, such as `origin/main...HEAD`. The agent runs
`-prompt` and reads it directly, then applies show-me to explain the evidence.
There is no background process to turn on and no separate model login in columbo.

Codex: mention `$meat` and `$show-me`, or use the sentence above. Claude Code:
invoke `/meat` with the request, or use the same sentence. New Codex skills are
available on the next turn; start a new Claude Code session if discovery is
stale. Grok clients with project skill support can use the same files; Grok
web chat still needs the packet pasted or attached.

Manual export from this checkout:

```sh
npm run --silent packet -- HEAD > /tmp/meat-review.md
```

From the repository being reviewed (substitute your meat checkout path):

```sh
node /path/to/meat/dist/cli/main.js -prompt -w > /tmp/meat-review.md
```

Ask your current agent:

> Read /tmp/meat-review.md and relevant surrounding source. Explain the behavior
> change, show a small flow diagram if it helps, and identify concrete risks with
> file references. Distinguish tests actually run from suggested checks.

With Grok chat, attach/paste the file; without repository access it can only
assess supplied evidence. A large packet may exceed the client's context:
select a narrower range or file groups rather than silently truncating.
`-prompt` does not reduce diff size or invoke the engine's tools.

## GitHub and GitLab

Meat reads local Git data and piped diffs. No hosting connector is necessary.
After fetching relevant refs using your normal workflow, review the same
merge-base comparison your PR/MR uses; substitute its actual target branch:

```sh
node /path/to/meat/dist/cli/main.js -prompt origin/main...HEAD > /tmp/meat-review.md
```

For pipelines, use target and source SHAs supplied by your hosting system.
Ensure both commits and their merge base are present in shallow checkouts.
Generate the packet as an artifact for a human or authorized agent to read.
Posting comments, approving, and merging remain separate host operations.
Meat does not change GitHub/GitLab credentials or remote settings.

## Installed show-me integration

The [upstream skill](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md)
guides visual explanations. It is useful alongside the packet, especially for
architecture and before/after flow. Its upstream skill is installed unchanged
in `.claude/skills/show-me/SKILL.md`; `.agents/skills/show-me/SKILL.md` and
`.grok/skills/show-me/SKILL.md` link to it. The meat skill explicitly routes
visual explanations to this sibling skill. This is an agent integration, not
a new API backend. Plain chat can follow the packet's diagram guidance without
skill discovery. The same visual skill can also explain a compiled API result
when API abridging was explicitly requested.

## Useful handoff evidence

Include the review scope (base/head SHAs or staged/worktree), intended behavior,
affected paths, commands actually run and their outcomes, and open decisions.
The packet hash identifies its input snapshot; regenerate after edits. Keep
durable decisions in `docs/decisions.md` and contracts in `specs/`, rather than
growing competing sets of project instructions.


## Resume from explicit local evidence

When the user wants durable task state, record intent and evidence using
`columbo record --file RECORD.json` (contract: `columbo help record-schema`). Read
`columbo status --json` or `columbo status --task ID` on resumption. Status does not
create a task or grant permission to resume work; use the current user request.
Inspect `needs_recheck` evidence before relying on it. Unchanged supporting files
only establish matching bytes, and reported checks remain assertions. Record
omissions in `limits`. Decision answers record attributed judgment, not host
approval. Competing successors require reconciliation rather than last-writer-wins.
See the CLI reference for complete JSON examples and local storage boundaries.
