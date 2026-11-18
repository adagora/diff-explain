---
name: meat
description: "Abridge a unified diff into a reading diff with meat, inspect its shape offline, or export a review packet for an existing agent. Use when the user asks for meat or needs a large commit, range, staged, or unstaged diff reduced or explained."
license: Apache-2.0
---

# meat

This is columbo's compatibility skill for the existing Meat diff commands.
For the Understand / Work / Review workflow, use the sibling
[columbo skill](../columbo/SKILL.md) and `columbo prime`. The `meat` bin remains an
alias; existing diff formats and compiler rules are unchanged.

Run this repo's meat CLI on the user's actual diff. Choose compiled abridging,
offline inspection, or an agent explanation according to their intent. Do not
present an agent-authored explanation as meat's compiled reading diff.

For this project's subscription workflow, default explanation/review requests
to `-prompt`, even if provider keys happen to be present. Run the command and
read its output within the current agent session; the user does not need to
export a file or start another agent. Explicit requests for compiled abridging,
JSON, or offline inspection still select those modes.

For a request to run a fresh subscription CLI review, use
`node src/cli/main.ts -agent codex HEAD` or `-agent claude HEAD`, substituting
the requested source. These launch the external agent and print its answer.
They check subscription login and never fall back to the API backend. Inside
an already-running meat review (`MEAT_AGENT_ACTIVE=1`), read the supplied packet
directly instead. `npm run review` launches Codex; `npm run packet` exports only.

For a visual explanation, read the installed sibling
[show-me skill](../show-me/SKILL.md) and apply it to the evidence from meat.
When reached through a discovery symlink, resolve the canonical skill path
first. Use the smallest useful view; do not force a diagram onto a trivial edit.

## 1. Resolve the launch line

From this checkout, use Node 22.18+ (recommended 24) on the CLI entry:

- Source: `node src/cli/main.ts`
- Built (after `npm run build`): `node dist/cli/main.js`

For an installed npm package, use `meat` on PATH. Discover supported commands
with `meat capabilities --json` and the workflow with `meat guide`; do not assume
the source checkout exists. The npm package includes this skill and show-me.

Run in the git repo whose diff the user asked about. For another repo, resolve
the meat checkout first and use its absolute CLI path. Relative paths below
assume this checkout. If building is needed, run `npm ci && npm run build` here.

**Done when** `node src/cli/main.ts -h` (or the `dist` equivalent) exits 0 and prints usage, or you already have a working launch line from this checkout.

## 2. Pick exactly one diff source

- HEAD / most recent commit / none named: `node src/cli/main.ts HEAD`
- A `<revision>` (sha, `HEAD~3`, a branch): `node src/cli/main.ts <revision>`
- A `<range>` (`sha1..sha2`, `main...HEAD`): `node src/cli/main.ts <range>`
- Staged / index: `node src/cli/main.ts -staged`
- Unstaged / working tree: `node src/cli/main.ts -w`
- Piped unified diff (stdin): `git show <sha> | node src/cli/main.ts` or `git diff | node src/cli/main.ts`

`-staged` and `-w` cannot combine with each other or with a revision/range.
Flags precede the revision. Explicit `HEAD` avoids empty-stdin selection in
agent shells. Untracked files are absent from `git diff`.

**Done when** exactly one source above is selected.

## 3. Pick the mode

- **Abridge** (default): meat calls a model and prints a reading diff. Needs `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `XAI_API_KEY` (set `MEAT_MODEL` when the default model is not the one you want).
- **Look** (`-look`): shape, color, length, then the unified-diff text. No model, no API key. Use this when there is no key, or the user asked to look at the diff without abridging.
- **Agent explanation** (`-prompt`): export the full diff with review instructions
  for the current agent to read. Prefer this when the user wants an explanation
  using an existing Codex, Claude Code, or Grok session. No API key or login is
  read by meat. Cannot combine with `-look` or `-json`.
- **JSON** (`-json`): machine-readable output on stdout. Add it when the caller needs to parse the result.

Subscription logins are not provider API keys. The CLI does not auto-load `.env`;
use `node --env-file=.env` only when API abridging with that file is intended.
Do not print credentials. See `README.md` for provider selection.

**Done when** the selected mode matches the requested outcome and available
credentials. An offline packet is not a substitute for requested compiled output.

## 4. Run meat

Execute the launch line with the source from step 2 and the mode from step 3.

Use direct `node` commands for redirected output; npm script banners can pollute
packets or JSON. Empty input is an error, not evidence of a completed review.

**Done when** meat printed the selected output or a clear failure. If abridging
cannot run, explain why; an offline mode can still help if it meets user intent.

## 5. Return meat's output

For abridge/look/JSON, return or link the output, retaining useful diagnostics.
For `-prompt`, read the packet and explain the consequential changes with source
references, inspecting surrounding code when available. Report actual test
evidence separately from suggested checks. Apply the installed show-me skill
when a visual helps. The explanation is agent-authored, not compiled meat
output. For handoffs, see `docs/agent-workflow.md`.

**Done when** the user has the requested output or explanation, with its scope
and any limitations clear.

## 6. Compile a reading diff in the current agent (when requested)

For compiled output using the current agent, run `meat packet HEAD` (or the
resolved Node launch line plus `packet`) and read its JSON reply. Use the actual
requested revision/range, `--staged`, `--worktree`, or explicit `--stdin`.
`packet` defaults to HEAD even in agent shells; options may follow the revision.
It makes no model call. Save the reply unchanged as packet.json in a suitable
artifact directory. Read `data.instructions`, `data.numbered_diff`, move hints,
and `data.plan_schema`. Write one JSON plan using `data.plan_template`, with
the exact input hash and original diff line coordinates. Do not invent source.

Run `meat compile --packet packet.json --plan plan.json`. On rejection, inspect
`error.kind`, `error.message`, and `error.next_action`, then repair the plan and
retry against the same snapshot. Do not relabel an old plan with another hash.
Return `data.smart_diff`, summary, statistics, and the original input identity.
Compilation proves transformation validity, not semantic completeness, correctness,
or test execution. The full original diff remains necessary for correctness
review; imports are omitted automatically. Source context is not snapshotted.

API-key abridging remains available via `meat abridge -json -model MODEL HEAD`
or the legacy invocation. It drives the model/tool/compile loop automatically.
Keep API access explicit and separate from subscription login. Never print keys.
Offline packets have a 400 KiB UTF-8 input cap; narrow the scope instead of
silently truncating. New commands use a JSON envelope; legacy API JSON is unchanged.

**Done when** compilation succeeded for the requested snapshot, or the user has
the precise rejection and an honest account of what could not be compiled.
