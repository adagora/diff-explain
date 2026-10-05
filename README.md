# meat

Turn a large code diff into a smaller **reading diff** focused on consequential
changes. This is a local CLI, with no web server to start. TypeScript in `src/`
is the active implementation; the Go tree is the migration reference.

## Start here

Requires Git and Node **22.18+**; Node 24 is recommended (`nvm use` if you use
nvm). The source CLI and tests use Node's built-in TypeScript support.
Go is not needed for normal use.

```sh
npm ci
npm run build
node dist/cli/main.js -look HEAD
```

The last command runs locally without an API key. It prints line counts,
add/delete/context shape, and the original diff. `npm run demo` does the same
from source. `npm start -- -h` lists all flags.

## Pick the workflow

### Run the subscription CLI directly

Install Codex CLI and sign in with `codex login` using ChatGPT, then:

```sh
npm run review -- HEAD
# Equivalent built command:
node dist/cli/main.js -agent codex HEAD
```

This launches a fresh Codex review and prints the finished explanation in your
terminal. The installed show-me instructions are included automatically.
Use `-staged`, `-w`, or a revision range instead of `HEAD` for another scope.
For Claude Code, sign in using `claude auth login`, then run:

```sh
npm run review:claude -- HEAD
# node dist/cli/main.js -agent claude HEAD
```

Meat checks the CLI's subscription login before sending the diff. It removes
API credentials and provider-routing variables from the child environment and
never falls back to its API backend. Codex runs with a read-only sandbox and
without user configuration; Claude loads no user/project settings or MCP servers
and is limited to Read/Grep/Glob. Login storage stays with the agent CLI.
These fresh reviews use your subscription allowance and require network access.
The result is an agent-written explanation, not an engine-compiled reading diff.

Requires CLI versions supporting the flags in `src/cli/agent.ts` (Codex 0.153.4
was live-tested). Update older CLIs if they report an unsupported option. Grok
native subscription execution is not implemented; use its packet workflow below.
Plain `meat HEAD` still selects the original API abridger: use **`-agent codex`**
or **`npm run review`** for subscription execution.

### Use an already open agent session

**Subscription workflow is ready in this checkout.** In your current agent,
ask: **“Use meat and show-me to explain HEAD using my current session.”**
The meat skill runs `-prompt`, reads the result, and uses the installed show-me
skill for a useful visual. It does not require an API key or a separate service.
Codex can discover the new skill on your next turn; reopen a Claude Code session
if its skill list has not refreshed. This installation is project-local.

For a manual packet, run `npm run --silent packet -- HEAD > /tmp/meat-review.md`.

| Your goal | Command | Model access |
|---|---|---|
| Inspect the original diff and its shape | `npm start -- -look HEAD` | None |
| Explain changes with your existing agent | `node dist/cli/main.js -prompt HEAD > /tmp/meat-review.md` | Your agent's existing session |
| Produce a compiled, abridged reading diff | `npm start -- HEAD` | Provider API credentials or supported exe.dev gateway |
| Get the abridged result as JSON | `node dist/cli/main.js -json HEAD` | Same as abridging |

For the subscription workflow, ask Codex or Claude Code: **“Read
`/tmp/meat-review.md`, inspect relevant source, and explain the important changes
and review risks.”** For Grok chat, attach or paste the packet. `-prompt` does
not call an agent, use a login, or incur a model call itself. It exports the full
diff with review instructions, not an abridgment. The resulting explanation is
agent-authored and does not use meat's edit-plan compiler.

Use direct `node` commands when redirecting or piping: npm adds script banners
unless invoked with `--silent`.

## Choose the diff

Flags go **before** the revision. Use explicit `HEAD` in agent shells and CI;
with no source argument, redirected stdin may be selected instead.

```sh
node dist/cli/main.js -look HEAD           # latest commit
node dist/cli/main.js -look main...HEAD    # branch changes since merge base
node dist/cli/main.js -look -staged        # index
node dist/cli/main.js -look -w             # unstaged tracked files
git diff | node dist/cli/main.js -prompt  # stdin
```

Replace `-look` with `-prompt` to export a packet, or remove it to abridge.
`-staged` and `-w` cannot combine with each other or with a revision.
`-prompt` cannot combine with `-look` or `-json`.
Untracked files are not included by `git diff`. Empty input exits 1; it is not
a successful review. Help exits 0; invalid flags exit 2.

From another repository, use an **absolute CLI path** and keep the shell in the
repository being reviewed:

```sh
cd /path/to/your-repo
node /path/to/meat/dist/cli/main.js -prompt main...HEAD > /tmp/meat-review.md
```

## API abridging (optional)

The built-in providers read `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`XAI_API_KEY`. They do not read Codex/Claude Code/Grok subscription logins.
Choose an API model available to your account using `-model` or `MEAT_MODEL`:
`claude-*` routes to Anthropic, `grok-*` to xAI, and other IDs to OpenAI.
Set a Claude model explicitly when using an Anthropic key.

The CLI does **not** load `.env` automatically. To use a local `.env` containing
your provider key and `MEAT_MODEL`:

```sh
node --env-file=.env dist/cli/main.js HEAD
```

Abridging sends the diff and potentially requested surrounding source to the
selected provider. Large diffs are chunked; each chunk can require model calls.
Results are cached in `~/.meat`; `MEAT_CACHE=/some/path` relocates the cache and
`MEAT_CACHE=` disables it. `-no-cache` skips reads but still updates the cache.
Neither `-look` nor `-prompt` contacts providers or uses this cache.

## Is it worth using?

Use meat when large diffs recur and a repeatable, compiled reading diff saves
review time. It has a deterministic compiler and offline conformance fixtures,
but abridging remains selective: keep the original diff available for review.
For occasional explanations, your existing agent plus `-prompt` is a simpler
starting point. Try a few real changes before adding API automation.

HumanLayer's [show-me skill](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md)
is complementary: it guides an agent to explain concepts visually using compact
diagrams, code sketches, or HTML. It does not implement meat's compiler or Git
hosting integration. Use it for understanding architecture; use meat's abridger
to reduce diffs. It can visualize a packet or a meat result without adding a
runtime dependency here. It is installed locally under `.claude/skills/show-me/`,
with discovery links for Codex and Grok.

See [the agent workflow](docs/agent-workflow.md) for GitHub/GitLab use and durable
project knowledge. Codex discovers `AGENTS.md`; Claude Code loads it through
`CLAUDE.md`. The shared meat skill lives in `.claude/skills/meat/`, with links
from `.agents/skills/` and `.grok/skills/`. Grok skill discovery depends on your
client; plain chat can use the exported packet.

## Development

```sh
npm run check       # strict source type-check + tests and conformance vectors
npm run build       # distributable JavaScript, declarations, source maps
npm pack            # rebuilds before packaging; does not publish
```

Tests use local mock HTTP servers and need no live API keys. A sandbox must
allow loopback listeners for the full suite. See [AGENTS.md](AGENTS.md) for the
module map and invariants, and [decisions](docs/decisions.md) for maintained
knowledge. `TODO.md` and `migration/` retain historical porting context.
