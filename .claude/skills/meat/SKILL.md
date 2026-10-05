---
name: meat
description: "Abridge a unified diff into a reading diff with meat, inspect its shape offline, or export a review packet for an existing agent. Use when the user asks for meat or needs a large commit, range, staged, or unstaged diff reduced or explained."
license: Apache-2.0
---

# meat

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

## 4. Supply a credential when the environment has none

meat reads its key from the environment and does NOT load a `.env` itself. If an abridge fails with `no OpenAI credentials` (or the Anthropic/xAI equivalent) and this checkout has a `.env`, let node load it — same argv, one extra flag before the script path:

```
node --env-file=.env src/cli/main.ts <same args>
node --env-file=.env dist/cli/main.js <same args>
```

That file is also where `MEAT_MODEL` is pinned, so this route picks up the intended model too. Never print the key or echo the file.

**Done when** the run has a credential from the environment or from `--env-file`, or `-look` was chosen because no key is obtainable.

## 5. Run meat

Execute the launch line with the source from step 2 and the mode from step 3.

Use direct `node` commands for redirected output; npm script banners can pollute
packets or JSON. Empty input is an error, not evidence of a completed review.

**Done when** meat printed the selected output or a clear failure. If abridging
cannot run, explain why; an offline mode can still help if it meets user intent.

## 6. Return meat's output

For abridge/look/JSON, return or link the output, retaining useful diagnostics.
For `-prompt`, read the packet and explain the consequential changes with source
references, inspecting surrounding code when available. Report actual test
evidence separately from suggested checks. Apply the installed show-me skill
when a visual helps. The explanation is agent-authored, not compiled meat
output. For handoffs, see `docs/agent-workflow.md`.

**Done when** the user has the requested output or explanation, with its scope
and any limitations clear.
