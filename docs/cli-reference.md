# columbo CLI reference

Turn a large code diff into a smaller **reading diff** focused on consequential
changes. This is a local CLI, with no web server to start. TypeScript in `src/`
is the active implementation. The upstream Go tree was removed; frozen
conformance vectors preserve its verified baseline.

For the Understand / Work / Review workflow, see [columbo Prime](../prime/README.md).
The `meat` command and Meat skill remain compatible. Examples use the direct
Node entry so they work without installing either bin name. `COLUMBO_MODEL` and
`COLUMBO_CACHE` override legacy `MEAT_MODEL` and `MEAT_CACHE`; the default cache
remains `~/.meat`.

## Start here

Requires Git and Node **22.18+**; Node 24 is recommended (`nvm use` if you use
nvm). The source CLI and tests use Node's built-in TypeScript support.

```sh
npm ci
npm run build
node dist/cli/main.js -look HEAD
```

The last command runs locally without an API key. It prints line counts,
add/delete/context shape, and the original diff. `npm run demo` does the same
from source. `npm start -- -h` lists all flags.

## Pick the workflow

### Discover the agent contract

```sh
node dist/cli/main.js capabilities --json
node dist/cli/main.js guide
```

columbo works with API keys and existing agent sessions. The API engine already
validates and compiles model edit plans. The portable bridge below lets an
existing Claude Code, Codex, or other agent use the same compiler offline.

### Compile a plan from any agent or model

```sh
node dist/cli/main.js packet HEAD > packet.json
# Have your agent read packet.json and write plan.json using data.plan_schema.
node dist/cli/main.js compile --packet packet.json --plan plan.json > result.json
```

The packet includes the exact diff, its SHA-256 and byte count, numbered original
lines, file-section coordinates, move hints, a JSON Schema, and a starting plan
template. Detailed selection policy is separate in `data.selection_rubric` so
the offline protocol stays concise. Ask your agent to read `data.instructions` and
`data.numbered_diff`, copy `data.plan_template`, and fill in its operations and
summary. Save one JSON object without Markdown fences. No second agent is needed.

`compile` uses the saved snapshot, so it also works outside the original Git
checkout. It checks the packet's integrity, compiler/rubric compatibility, plan
schema, and matching input hash before invoking the production compiler.
Repair rejected plans using `error.message` and `error.next_action`; keep the
original coordinates on every attempt. The command never edits your source.

Both commands default to JSON and accept `--json`. Replies have `schema_version`,
`command`, `ok`, `data`, and `error`. On failure `data` is null and `error` has
`kind`, `message`, and `next_action`. Exit codes remain 0 for success/help,
1 for runtime/validation failure, and 2 for usage errors. Always read the reply
even when the exit code is nonzero.

`packet` defaults to **HEAD**, including in agent shells. Choose `--staged`,
`--worktree` (or `-w`), a revision/range, or explicit `--stdin` for a pipe:

```sh
git diff | node dist/cli/main.js packet --stdin > packet.json
node dist/cli/main.js packet main...HEAD --json > packet.json
cat plan.json | node dist/cli/main.js compile --packet packet.json --plan -
```

New command options can follow revisions. Legacy flags still precede revisions.
Offline planning accepts at most 400 KiB of valid UTF-8 diff bytes per packet;
use narrower changes for larger packets. The API engine supports automatic
chunking through `node dist/cli/main.js abridge -json -model MODEL HEAD`.
`abridge` is an alias for the existing API workflow and preserves its JSON format.
To review a Git revision named `packet`, `compile`, `guide`, `capabilities`,
`help`, `prime`, or `abridge`, disambiguate it with `columbo -- <revision>`.

Compilation validates allowed transformations; it does **not** prove semantic
completeness or correctness, run tests, or capture surrounding repository source.
Imports are removed automatically. Keep the original diff for full review.
Packets contain your source code; their hashes detect mismatches, not authorship.
`-prompt` remains the simpler option for an ordinary prose explanation.

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

columbo checks the CLI's subscription login before sending the diff. It removes
API credentials and provider-routing variables from the child environment and
never falls back to its API backend. Codex runs with a read-only sandbox and
without user configuration; Claude loads no user/project settings or MCP servers
and is limited to Read/Grep/Glob. Login storage stays with the agent CLI.
These fresh reviews use your subscription allowance and require network access.
The result is an agent-written explanation, not an engine-compiled reading diff.

Requires CLI versions supporting the flags in `src/cli/agent.ts` (Codex 0.153.4
was live-tested). Update older CLIs if they report an unsupported option. Grok
native subscription execution is not implemented; use its packet workflow below.
Plain `columbo HEAD` still selects the original API abridger: use **`-agent codex`**
or **`npm run review`** for subscription execution.

### Use an already open agent session

**Subscription workflow is ready in this checkout.** In your current agent,
ask: **“Use columbo and show-me to explain HEAD using my current session.”**
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
agent-authored and does not use columbo's edit-plan compiler.

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

Use columbo when large diffs recur and a repeatable, compiled reading diff saves
review time. It has a deterministic compiler and offline conformance fixtures,
but abridging remains selective: keep the original diff available for review.
For occasional explanations, your existing agent plus `-prompt` is a simpler
starting point. Try a few real changes before adding API automation.

HumanLayer's [show-me skill](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md)
is complementary: it guides an agent to explain concepts visually using compact
diagrams, code sketches, or HTML. It does not implement columbo's compiler or Git
hosting integration. Use it for understanding architecture; use columbo's abridger
to reduce diffs. It can visualize a packet or a meat result without adding a
runtime dependency here. It is installed locally under `.claude/skills/show-me/`,
with discovery links for Codex and Grok.

See [the agent workflow](agent-workflow.md) for GitHub/GitLab use and durable
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
allow loopback listeners for the full suite. See [AGENTS.md](../AGENTS.md) for the
module map and invariants, and [decisions](decisions.md) for maintained
knowledge. `TODO.md` and `migration/` retain historical porting context.

## Local intent, evidence, and decisions

`columbo status --json` inspects the current Git working tree without writing
state or calling a model. It reports HEAD (null before the first commit), branch
(null for detached HEAD), Git porcelain-v1 status, recorded tasks, supporting-file
freshness, unresolved decisions, and conflicting decision successors. Use
`--task ID` to select one recorded task. The default summary omits evidence claim
text and superseded decision history, reports omission counts, and supplies an
argument-array `detail_command`. Add `--details` to retrieve those records. Git
status covers the whole repository. Supporting files are hashed once per status
call even when several records reference them.
No task is inferred from the conversation or automatically made active.

These commands are also available without `--json`; their output always uses the
existing JSON envelope. State lives in `git rev-parse --git-path columbo-state-v1`,
which keeps linked worktrees separate and artifacts outside ordinary diffs. It
is local to the checkout, is not pushed with commits, and contains the canonical
repository path. Moving the checkout requires deliberate record migration; a
repository-path mismatch fails visibly instead of reusing evidence silently.

Record an intent explicitly from a JSON file:

```sh
cat > /tmp/columbo-intent.json <<'JSON'
{
  "kind": "intent",
  "id": "retry-fix",
  "actor": "current-agent",
  "goal": "Stop retrying validation failures",
  "criteria": ["Validation failures return immediately", "Transient failures respect the retry limit"]
}
JSON
columbo record --file /tmp/columbo-intent.json
columbo snapshot --file src/importer.ts --file test/importer.test.ts > /tmp/columbo-sources.json
```

Replace the source paths with real files in the target repository. Snapshot paths
are repository-root-relative even from a subdirectory. The snapshot contains
canonical relative paths and SHA-256 hashes, not file contents. Inspect those
files, then copy `data.sources` into an evidence record:

```json
{
  "kind": "evidence",
  "id": "retry-inspection",
  "actor": "current-agent",
  "task": "retry-fix",
  "claim": "Validation failures bypass the retry loop",
  "basis": "source",
  "sources": [{"path": "src/importer.ts", "sha256": "COPY_THE_EXACT_SNAPSHOT_HASH_HERE"}],
  "limits": ["Caller behavior has not been inspected"]
}
```

Save valid JSON with actual snapshot hashes, then run `columbo record --file FILE`.
The command rejects a source that changed since the snapshot. Never copy a new
hash onto an old conclusion without reinspecting the evidence. Basis is `source`,
`inference`, or `reported_check`. Every basis is an attributed assertion:
`verified_by_columbo` is false. columbo does not run checks or authenticate actors.
A reported passing test is not an execution receipt.

`status` compares the recorded files to current bytes. It reports
`supporting_inputs_unchanged` or `needs_recheck`, with each file marked unchanged,
changed, or unavailable. An unrelated file change does not invalidate the selected
hashes. Dependencies outside the recorded sources, toolchain, configuration,
environment, and tests may still invalidate the conclusion. Record relevant
supporting inputs and disclose omissions. Freshness is not semantic verification.

Record a human decision request as:

```json
{
  "kind": "decision",
  "id": "retry-deadline",
  "actor": "current-agent",
  "task": "retry-fix",
  "question": "Must retries preserve the existing response deadline?",
  "answer": null
}
```

Resolve it with a new decision record, a new ID, a nonempty `answer`, and
`"supersedes": "retry-deadline"`. Keep the same task. Actor labels should accurately
describe who reported the answer; they are not authenticated human approvals.
Answers never grant execution permissions. Multiple successors are exposed as
conflicts rather than resolved by last-writer-wins. This first version preserves
conflicting branches for human inspection; it has no automatic conflict merger.

IDs are immutable and unique within the worktree. Repeating the same record is
idempotent; different content under the same ID fails. Atomic publication prevents
readers from seeing partially written records. Unknown fields, unsafe IDs,
unsupported schemas, corrupt state, missing references, and symlinked sources
are rejected. Source files are limited to 16 MiB, snapshots/evidence to 100 paths,
record input to 1 MiB, and the store to 1000 records. At that limit, archive a
completed store as a whole; do not remove referenced intents individually.
No automatic pruning, completion claim, task scheduler, or agent continuation is
installed. Read `columbo help record-schema` for the input contract or
`columbo record-schema --json` for a machine-readable schema and additional semantic
constraints. The schema is available without Git or a state store. File observations
are not an atomic repository snapshot; concurrent edits require reinspection.
