# meat

Turn a large code diff into a smaller **reading diff** focused on consequential
changes. This is a local CLI, with no web server to start. TypeScript in `src/`
is the active implementation; the Go tree is the migration reference.

For the architecture, document authority and proposed improvements, start with
[system design](docs/system-design.md) and the [current roadmap](docs/roadmap.md).
The [agent workflow](docs/agent-workflow.md) describes commands available today.

## Start here

Requires Git and Node **22.18+**; Node 24 is recommended (`nvm use` if you use
nvm). The source CLI and tests use Node's built-in TypeScript support.
Go is not needed for normal use. Meat runs on Linux, macOS and Windows; the
test suite is checked on Linux and Windows. Set up once from this checkout:

```sh
npm ci
npm run setup
```

`setup` builds the CLI, links a `meat` command onto your PATH (`npm link`),
installs the meat skill for Codex and Claude Code, and finishes with
`meat -doctor`. The doctor lists which review workflows work on this machine
and how to fix the others. It asks installed agent CLIs for their login status
but makes no model call, reads no diff and prints environment variable names,
never values. Run it again after signing in or adding a key. To remove the
command, run `npm unlink -g meat`.

On Linux, `npm link` fails with `EACCES` when Node was installed system-wide.
Use a version manager such as nvm, or give npm a user prefix with
`npm config set prefix ~/.local` (with `~/.local/bin` on your PATH), then rerun
`npm run setup`. On Windows, npm creates `meat.cmd` and `meat.ps1`; PowerShell
runs the latter under the default `RemoteSigned` policy.

Without the link, use `node /path/to/meat/dist/cli/main.js` wherever this page
says `meat`, or `npm start --` inside this checkout. `meat -h` lists all flags.

## Review a change

Run meat from the repository you want reviewed. Pick the row that matches what
you already have:

| You have | Run | You get |
|---|---|---|
| Claude Code or Codex open | `/meat HEAD` in Claude Code, `$meat explain HEAD` in Codex | The open session explains the change |
| A Codex or Claude subscription | `meat -agent codex HEAD` or `meat -agent claude HEAD` | A fresh read-only review in your terminal |
| Another agent or chat, such as Grok | `meat -prompt -o review.md HEAD` | A review packet to attach or paste |
| Nothing set up yet | `meat -look HEAD` | The change's shape, size and full diff, offline |
| An API key | `meat HEAD` | A compiled, abridged reading diff ([API abridging](#api-abridging-optional)) |

Only the last row needs an API key. Run without one, meat says so and lists the
commands that need none for the same change.

### Use an already open agent session

In Claude Code type **`/meat HEAD`**; in Codex type **`$meat explain HEAD`**. You
can also ask “Use meat to explain my staged changes.” The skill collects a
packet and explains it in your current session, using that session's
subscription allowance. Packet creation needs no API key and launches no
additional agent. When a visual helps, the skill adds a small call tree, code
sketch or diagram.

`npm run setup` installs the skill. To install only the skill, run
`npm run skill:install -- all`, or `codex` or `claude` instead of `all`. The
installer writes a personal skill to `~/.agents/skills/meat/` and/or
`~/.claude/skills/meat/`, binding it to this checkout's absolute source entry.
The personal launcher reads the canonical skill on each use, so instruction
updates apply without reinstalling. Keep the checkout and its dependencies
available; rerun after moving it or changing discovery metadata. Open a new CLI
session, then invoke meat from the repository you want reviewed. This installer
runs from the source checkout, not an npm package installation.
The installer refuses linked personal meat directories/files to avoid altering
their targets. Use a regular personal skill directory.

A plugin can distribute a skill with other components. This repository ships
the standalone skill and installer; it does not yet ship a plugin package.

### Run a fresh subscription review

Sign in once with `codex login` (using ChatGPT) or `claude auth login`, then:

```sh
meat -agent codex HEAD
meat -agent claude main...HEAD
```

Inside this checkout, `npm run review -- HEAD` and `npm run review:claude -- HEAD`
do the same. This launches a fresh review and prints the finished explanation in
your terminal, with a small call tree, code sketch or diagram where one helps.
While it runs, meat shows the elapsed time and hides the agent's own log, which
includes its session header and the echoed packet. Add `-verbose` to stream
that log; if the review fails, meat prints the end of it. `-o review.md` saves
the explanation instead of printing it.

Meat checks the CLI's subscription login before sending the diff. It removes
API credentials and provider-routing variables from the child environment and
never falls back to its API backend. Codex runs with a read-only sandbox and
without user configuration; Claude loads no user/project settings or MCP servers
and is limited to Read/Grep/Glob. Login storage stays with the agent CLI.
These fresh reviews use your subscription allowance and require network access.
The result is an agent-written explanation, not an engine-compiled reading diff.

Requires CLI versions supporting the flags in `src/cli/agent.ts` (Codex 0.153.4
was live-tested). Update older CLIs if they report an unsupported option. Grok
native subscription execution is not implemented; use the packet instead.
Plain `meat HEAD` still selects the original API abridger: use **`-agent codex`**
for subscription execution.

### Give the packet to another agent

`-prompt` exports the full diff with review instructions:

```sh
meat -prompt -o review.md HEAD
```

Then ask the agent: **“Read `review.md`, inspect relevant source, and explain
the important changes and review risks.”** For Grok chat, attach or paste the
file. `-prompt` does not call an agent, use a login, or incur a model call
itself. It exports the full diff with review instructions, not an abridgment.
The resulting explanation is agent-authored and does not use meat's edit-plan
compiler. A relative `-o` path lands in the current directory, which is usually
the reviewed repository; write it elsewhere if you don't want it there.

Prefer `-o` to shell redirection. Windows PowerShell 5.1's `>` adds a byte-order
mark and converts line endings, and `npm run` prints banners unless invoked
with `--silent`. `-o` writes exactly the bytes stdout would carry, only after
the command succeeds. It works with every output: `-look`, `-json`, the
abridged diff, observation JSON and `-agent`.

## Choose the diff

Flags go **before** the revision. If one comes after, meat stops and shows the
corrected command. Use explicit `HEAD` in agent shells and CI; with no source
argument, redirected stdin may be selected instead.

```sh
meat -look HEAD           # latest commit
meat -look main...HEAD    # branch changes since merge base
meat -look -staged        # index
meat -look -w             # unstaged tracked files
git diff | meat -prompt   # stdin
```

Replace `-look` with `-prompt` to export a packet, or remove it to abridge.
`-staged` and `-w` cannot combine with each other or with a revision.
`-prompt` cannot combine with `-look` or `-json`.

For bounded offline inspection, use the versioned observation commands:

```sh
meat -inventory -page-size 20 HEAD
meat -evidence h:123 -snapshot <snapshot-sha256> -max-bytes 8192 HEAD
meat -plan HEAD
meat -capabilities
```

Choose an actual entry ID and snapshot SHA-256 from the inventory before
expanding evidence. `-cursor <page.next>` continues the same source, operation
and page limit; changed evidence is rejected. Inventory and plan optionally
accept `-snapshot` too. Flags precede the revision. Inventory/plan pages default
to 20 entries (maximum 100); evidence pages default to 8192 bytes (maximum
16384). Each success writes one `meat.observe` version 1 JSON document. Evidence
uses base64 to preserve exact raw bytes, with original diff ranges whose ends
are exclusive. Runtime diagnostics go to stderr and exit 1; flag errors exit 2.

These commands make no model, login, gateway or cache call. Capabilities probes
no source. Committed snapshots resolve objects once and identify before/after
trees; their controlled diff omits commit messages. Mutable inputs retain diff
bytes with unavailable context and unverified consistency; stdin provenance
stays unknown. Snapshot-bound context tools remain future work. Planning applies
API partitioning to the captured observation bytes, with unknown model calls,
tokens and cost. It does not promise the same partitions for legacy execution of
the same Git selector, whose commit envelope can differ; current
execution tools still read the live checkout. Observation flags cannot combine
with legacy output, agent, model or cache flags. See the
[observation contract](specs/observe.md) for source identity and pagination.
Untracked files are not included by `git diff`. Empty input exits 1; it is not
a successful review. Help exits 0; flag parsing errors exit 2. Source-selection
conflicts and other runtime failures exit 1.

From another repository without `npm run setup`, use an **absolute CLI path** and
keep the shell in the repository being reviewed:

```sh
cd /path/to/your-repo
node /path/to/meat/dist/cli/main.js -prompt -o review.md main...HEAD
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
Engine limits apply per chunk; the CLI currently exposes no aggregate time,
call or token budget. Results do not identify fallback or chunk validation
coverage. Repository tools read the current checkout, even for historical or
staged inputs; inspect the appropriate revision when that difference matters.

Results are cached in `~/.meat`; `MEAT_CACHE=/some/path` relocates the cache and
`MEAT_CACHE=` disables it. `-no-cache` skips reads but still updates the cache.
Neither `-look` nor `-prompt` contacts providers or uses this cache. Its key
covers rubric/compiler protocol, model and diff text, but excludes surrounding
source and provider routing. Use `-no-cache` to recompute when those have changed.
Cached token totals describe the original computation.

## Is it worth using?

Use meat when large diffs recur and a repeatable, compiled reading diff saves
review time. It has a deterministic compiler and offline conformance fixtures,
but abridging remains selective: keep the original diff available for review.
For occasional explanations, your existing agent plus `-prompt` is a simpler
starting point. Try a few real changes before adding API automation.

Visual explanations are built in. The meat skill and `-agent` reviews add the
smallest useful pseudocode, call tree, before/after sketch or Mermaid diagram,
using no platform-specific commands, so they behave the same on Linux, macOS
and Windows. A separate visual skill, such as HumanLayer's
[show-me](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md),
can be installed from its upstream source; meat neither bundles nor requires it.

See [the agent workflow](docs/agent-workflow.md) for GitHub/GitLab use and durable
project knowledge. Codex discovers `AGENTS.md`; Claude Code loads it through
`CLAUDE.md`. The canonical meat skill lives in `.claude/skills/meat/`; synchronize
the tracked `.agents/skills/` and `.grok/skills/` copies with `npm run skill:sync`
after editing it. Grok skill discovery depends on your client; plain chat can
use the exported packet. The installer supports Codex and Claude Code.

## Development

```sh
npm run check       # strict source type-check + tests and conformance vectors
npm run build       # distributable JavaScript, declarations, source maps
npm pack            # rebuilds before packaging; does not publish
```

Tests use local mock HTTP servers and need no live API keys. A sandbox must
allow loopback listeners for the full suite. See [AGENTS.md](AGENTS.md) for the
module map and invariants, and [decisions](docs/decisions.md) for maintained
knowledge. [The roadmap](docs/roadmap.md) owns proposed work.
Git attributes preserve the raw bytes of conformance fixtures and corpus diffs
across checkouts, including Windows with `core.autocrlf=true`.
`TODO.md` and `migration/` retain historical porting context.
