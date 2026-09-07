# Review with Codex, Claude Code, or Grok

## Direct terminal review (subscription CLI)

`npm run review -- HEAD` now runs a fresh signed-in Codex process and prints its
answer. `npm run review:claude -- HEAD` uses Claude Code. From any repository,
use `node /path/to/meat/dist/cli/main.js -agent codex HEAD` (or `claude`).
Sign in first with `codex login` / `claude auth login`. Meat verifies subscription
auth, removes API environment overrides, includes the installed show-me skill,
and fails rather than switching to an API account. It forwards child output to
the terminal; Ctrl-C requests termination. A CLI failure exits 1.

These are fresh sessions using the CLI login, not continuations of an open
conversation. The packet workflow below remains useful inside an existing
session and for Grok. Do not recursively invoke `-agent` from a meat review.

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
There is no background process to turn on and no separate model login in meat.

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
