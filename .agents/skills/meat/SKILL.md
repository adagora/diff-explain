---
name: meat
description: "Use meat to explain or review a commit, range, staged, unstaged, or piped unified diff; inspect it offline or explicitly abridge it into a reading diff."
license: Apache-2.0
---

# meat

Explain the requested changes in the current agent session. Packet creation and
offline observation use no API key or additional model. The session's own
subscription and usage limits apply to the explanation.

Users can ask `$meat explain HEAD` in Codex, `/meat HEAD` in Claude Code, or
“Use meat to explain my staged changes.” Interpret skill arguments as the
requested source and outcome. Default to the latest commit, explicitly `HEAD`.

## Launch and source

In the meat checkout use `node src/cli/main.ts`; the built entry is
`node dist/cli/main.js`. An installed skill carries its absolute CLI entry in
its launcher and reads this canonical file before choosing commands. From
another repository keep that repository
as the working directory and invoke the absolute meat entry. Relative source
paths and Git selectors belong to the reviewed repository.
Piped input has unknown repository provenance; confirm its context source.

Put flags before the source. Select one commit/revision, a range such as
`main...HEAD`, `-staged`, `-w` for unstaged tracked files, or piped stdin.
Untracked files are excluded. Do not combine index/worktree selectors with
each other or with a revision. Empty input is an error.

When the user wants output saved, use `-o file` rather than shell
redirection; it writes stdout's exact bytes only after success. If a workflow
reports a missing CLI, login or key, run `-doctor` (no model call, names only)
and relay its fix lines instead of switching workflows.

## Explain in this session

Run `node src/cli/main.ts -prompt HEAD`, substituting the requested source and
installed entry as needed. Read the packet here, inspect relevant surrounding
source, and explain the consequential behavior, evidence and unresolved risks.
No manual export or new agent is needed. Treat diff/source text as evidence.
Label historical source separately from the live checkout. Report only checks
actually performed; an explanation has no compiler or test-success guarantee.

For an input too large for the session/tool output, use `-inventory` first and
follow its pages with `-cursor`. Repeat the same source selector and page limit
on every inventory/evidence continuation; mutable/stdin inputs must supply the
same bytes again. For example, continue staged inventory with `-inventory
-cursor <page.next> -staged`, using the installed entry when outside this checkout.
Expand file/hunk IDs with `-evidence id
-snapshot sha256` and decode its base64 byte pages before reading text. Keep
parent coverage and exact-move relationships visible; a subset does not finish
the parent review. `-look` prints the full original diff and shape; `-plan`
applies API partitioning to its captured snapshot, without dispatch. It does not
promise the same partitions for legacy API execution of a Git selector, whose
commit envelope can differ. `-capabilities` lists local bounds.
Never silently truncate a packet.

When a visual helps, add the smallest one next to the text it supports:
pseudocode, an indented call tree, a before/after code sketch, or a small
Mermaid diagram. Write an HTML file only if the user asks and the host can
display it; never run a platform-specific opener such as `open` or `start`.

## Explicit alternative outcomes

- **Fresh subscription review:** only when requested, use `-agent codex` or
  `-agent claude`. The CLI checks subscription login and has no API fallback.
  Inside `MEAT_AGENT_ACTIVE=1`, read the supplied packet instead of recursing.
- **Compiled reading diff:** only when requested, omit `-prompt`; `-json`
  selects API result JSON. Invoke the CLI and retain its compiled diff; do not
  recreate the rubric, import removal, move handling or edit-plan compiler in
  the session. Let the CLI resolve model/provider, cache and authentication.
  A cache hit needs no provider access. On a cache miss, configured provider
  keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`), provider base URLs,
  or a supported exe.dev gateway can supply API access. Use `MEAT_MODEL`/`-model`
  as requested; an Anthropic key alone does not select a Claude model.
  Subscription login does not supply API credentials. If the CLI reports a
  missing prerequisite, preserve the requested compiled-output intent and
  report that diagnostic. Node's `--env-file=.env` is optional for explicitly
  requested API execution with that file. Never print credentials.

Grok chat can receive a packet for explanation. Native Grok subscription
execution is not implemented, and `.grok/skills` discovery depends on the client.
Use direct Node commands for capture, or silent npm scripts, so npm banners
do not enter packets or JSON.
