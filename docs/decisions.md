# Maintained decisions

Keep each entry scoped: decision, reason, evidence, and when to revisit.
These are maintained project facts and rationale. Remaining proposed runtime
work belongs in the [roadmap](roadmap.md), with target clauses labelled proposed.
Last reviewed against local source and documentation: 2026-10-07.
This date is not a claim that tests or live provider checks ran.

## TypeScript is the working implementation

Decision: develop the CLI in `src/`; retain Go and frozen vectors as parity
evidence. Historical migration loops do not select current work.

Reason: `package.json` builds the TypeScript product; its tests and conformance
harness exercise that implementation.

Evidence: [package](../package.json), [tsconfig](../tsconfig.json),
[conformance harness](../test/conformance.test.ts).
Revisit if product ownership or compatibility policy changes.

## Use native TypeScript support consistently

Decision: require Node 22.18+; recommend Node 24 via `.nvmrc`. Source launch and
tests execute TypeScript directly with on-disk `.ts` import extensions; the
build rewrites relative extensions for distribution.

Reason: the original Node 20 migration target did not cover this workflow.
Evidence: [package](../package.json), [tsconfig](../tsconfig.json),
[Node selection](../.nvmrc), imports in [tests](../test/).
Revisit when changing runtime or adding a transpilation stage.

## Existing sessions and fresh subscription reviews are separate workflows

Decision: explanations default through the meat skill to `-prompt` in the
current session. Explicit fresh reviews use `-agent codex|claude`, which checks
subscription auth, removes API overrides and has no API fallback. Grok uses
the packet workflow.

Reason: exporting evidence and launching a new model session have different
costs and context. API credentials being present do not change explanation
intent.

Evidence: [packet](../src/cli/prompt.ts), [packet tests](../test/cli/prompt.test.ts),
[adapter](../src/cli/agent.ts), [adapter tests](../test/cli/agent.test.ts),
[canonical skill](../.claude/skills/meat/SKILL.md).
Historical validation record: Codex 0.153.4 completed a ChatGPT-login review on
2026-09-07. Claude's adapter was mock-tested; no live Claude review was recorded.
Revisit on external CLI auth/capability changes; that dated record does not
certify current external CLI compatibility.

## Compiler guarantees and review conclusions have different evidence

Decision: identify raw views, packets, compiled reading diffs and agent
explanations accurately. Retain a route to the original diff.

Reason: edit-plan compilation validates source-derived elisions and specified
structure. It does not prove semantic completeness or summary truth. Chunk
concatenation does not add global move-symmetry checks; the rubric's assumptions
about test success are not execution evidence.

Evidence: [compiler](../src/meat/editplan.ts), [chunk mapping](../src/meat/chunk.ts)
(`mapMovesToChunk`), [engine](../src/meat/meat.ts),
[rubric](../src/meat/rubric.ts), [packet](../src/cli/prompt.ts).
Revisit when validation or exposed provenance changes.

## Diff identity does not establish context identity

Decision: handoffs record diff identity and the source of surrounding evidence
separately. Revalidate findings that depend on changed context.

Reason: packets hash original diff bytes, while current engine read/search tools
use the live checkout. The legacy cache key includes rubric, model and diff text,
but excludes source context and provider routing. `-no-cache` refreshes reads
and still writes; `MEAT_CACHE=""` disables both.

Evidence: [packet](../src/cli/prompt.ts), [tools](../src/meat/tools.ts),
[cache](../src/cli/cache.ts), [cache tests](../test/cli/cache.test.ts).
P1 [observation](../specs/observe.md) now identifies committed tree context but
does not bind execution tools to it. Snapshot-bound reads and evidence-aware
reuse remain proposed in [agent interface](../specs/agent-interface.md).
Revisit when those execution contracts ship.

## Offline observation has a separate source and wire contract

Decision: opt-in inventory, raw evidence, capabilities and API partition
forecasts use `meat.observe` version 1. Legacy collection/output, rubric/compiler
identity and cache namespace remain unchanged. Observation is local and returns
before model, gateway, auth or cache work.

Reason: bounded navigation needs resolved provenance and exact original bytes
without changing existing packet or compiled-output expectations. Committed
observation compares resolved trees with controlled Git options and omits
commit-message envelopes. Collection policy participates in snapshot identity;
display selector and absolute checkout location do not.

Evidence: [collection](../src/cli/snapshot.ts), [artifacts](../src/cli/observe.ts),
[CLI routing](../src/cli/main.ts), [contract](../specs/observe.md),
[snapshot cases](../test/cli/snapshot.test.ts),
[observation cases](../test/cli/observe.test.ts). Scope: P1 observation only.
Revisit on changes to wire version, collection options, canonical descriptor,
compiler/rubric behavior, or integration with legacy execution/cache paths.

## Captured diff evidence does not advertise captured mutable context

Decision: staged/worktree snapshots retain exact diff bytes and bounded source
metadata, with context unavailable and consistency unverified. Compare HEAD,
index-entry digest and two diff captures, retry at most once, and reject a
persistent mismatch. Stdin remains unknown provenance without cwd binding.

Reason: matching before/after observations can detect a race but cannot prove
one atomic filesystem instant. A diff-only artifact does not provide captured
source files for read/search. Immutable committed tree IDs similarly do not
bind the legacy engine's live tools or guarantee object retention.

Evidence: [snapshot](../src/cli/snapshot.ts),
[mutable/race/no-side-effect cases](../test/cli/snapshot.test.ts),
[current contract](../specs/observe.md). Scope: P1 diff evidence; captured source
context and bound reads belong to P2. Revisit when adding a context adapter or
changing the consistency/retention mechanism.

## Evidence expansion requires its parent snapshot

Decision: `-evidence` requires `-snapshot`; IDs and continuations are interpreted
under that snapshot. Evidence pages carry exact bytes as base64, original
ranges and subset coverage. Continuations bind the operation/selection and
page limit as well as snapshot identity.

Reason: byte-coordinate IDs may recur in unrelated or changed diffs. Requiring
parent identity prevents silently selecting a different region, and base64
preserves CRLF, invalid UTF-8 and byte pages splitting a character. Pagination
checksum detects corruption but is not an authentication guarantee.

Evidence: [CLI validation](../src/cli/main.ts),
[expansion and cursors](../src/cli/observe.ts),
[identity/reconstruction/stale cases](../test/cli/observe.test.ts).
Revisit on selection schema, continuation or evidence encoding changes.

## Visual guidance is built in and portable

Decision: meat owns a short visual guidance text, used by the meat skill and
sent with `-agent` reviews: the smallest pseudocode, indented call tree,
before/after code sketch or Mermaid diagram that supports a point. It creates
no files and runs no opener command. The vendored HumanLayer show-me skill and
its Codex/Grok copies were removed on 2026-10-07 and are no longer shipped in
the npm package; users who want it install it from upstream.

Reason: show-me told agents to run `open file.html`, which exists only on
macOS (Windows has none; Debian/Ubuntu map `open` to `openvt`). `-agent` sent
all 3,424 bytes with every review and then overrode its HTML/browser parts for
terminal output. It needed three synchronized copies, which had broken Windows
discovery as symlink stubs, and it shipped third-party text without its own
license notice. The plain-text forms carry the useful part on every platform.

Evidence: [`visualGuidance`](../src/cli/agent.ts),
[agent packet case](../test/cli/agent.test.ts),
[skill portability case](../test/skill.test.ts),
[synchronization](../scripts/install-meat-skill.ts).
Revisit when agent hosts offer a portable way to display generated artifacts.

## Agent shell commands name their source

Decision: use explicit `HEAD` for the latest commit and put flags before the
revision.

Reason: no-argument execution examines stdin, which may be an empty pipe in an
agent shell. Flag parsing stops at the first positional argument.

Evidence: [main](../src/cli/main.ts) (`parseFlags`, `readDiff`),
[CLI tests](../test/cli/main.test.ts).
Revisit if argument parsing or source selection changes.

## Documentation has one route from intent to evidence to planned work

Decision: [system design](system-design.md) owns relationships and the authority
map; subject specs own current contracts; [roadmap](roadmap.md) owns future
work; this file owns verified rationale. Startup instructions link to them.

Reason: current agents should reach the relevant layer without ingesting the
port ledger or confusing proposals with implemented interfaces. The target
design connects request, evidence, execution plan, receipt and maintained
knowledge; P1 adopts local observation and the remaining runtime contracts
stay explicitly proposed.

Evidence: [AGENTS](../AGENTS.md), [spec index](../specs/INDEX.md),
[workflow](agent-workflow.md), status labels in
[proposed contracts](../specs/agent-interface.md).
Revisit when a new workflow needs a different owner or a proposal ships.

## Personal CLI skills bind to the checkout and use the current session

Decision: a standalone meat skill explains changes through `-prompt` in the
current Codex/Claude session. Fresh subscription processes and compiled API
output require their explicitly requested workflows. Visual guidance is part
of the skill; no plugin package or native Grok launcher is supplied.

The personal installer writes a small launcher with canonical discovery metadata,
an absolute canonical-skill path and an absolute source-entry path to the host's
user skill directory. It reads current canonical instructions before choosing
commands, so a copied personal body cannot drift from the checkout's logic.
It keeps the reviewed repository as the
working directory and relies on the existing checkout and dependencies. Paths
are JSON data in the instructions rather than interpolated shell commands.
Moving the checkout or changing discovery metadata requires rerunning installation;
canonical instruction changes apply on the next use without reinstalling.
Tracked Codex/Grok project copies are synchronized from the canonical file,
avoiding stale instructions and Windows symlink requirements. Synchronization
replaces discovery file links themselves, and refuses linked
leaf directories or personal skill files rather than writing through them.

Evidence: [canonical skill](../.claude/skills/meat/SKILL.md),
[installer](../scripts/install-meat-skill.ts),
[offline cross-repository and synchronization cases](../test/skill-install.test.ts).
These changes do not alter compiler/rubric identity or API/cache behavior.
Revisit when adding package-based installation, plugin distribution, a different
CLI entry layout, or a verified Grok CLI subscription adapter.

## Skill routing delegates business rules to the CLI

Decision: compiled requests invoke the existing CLI and retain its result.
The skill does not copy the rubric or imitate import removal, move handling,
compiler validation, provider selection or cache preflight. Current-session
explanations remain a separate artifact with no compiler guarantee. Provider
access is needed only on a cache miss; configured endpoints and supported
gateways can work without an API key. Missing access is determined by the CLI,
not by a second key-only check in the skill.

Legacy and observation Git collection share a 64 MiB output cap so Git input
over Node's default 1 MiB can reach their respective workflows. Engine byte
budgets remain unchanged. Subscription child filtering matches environment
names case-insensitively, and recursion is rejected before CLI/login probes.

Evidence: [skill](../.claude/skills/meat/SKILL.md),
[cache orchestration](../src/cli/main.ts),
[cross-repository compiler/cache and large-packet checks](../test/cli/skill-contract.test.ts),
[subscription checks](../test/cli/agent.test.ts).
Revisit when workflow defaults, provider/cache contracts or collection limits
change. This alignment does not promise deterministic agent interpretation.

## Windows staging preserves the converted discovery file type

Decision: project discovery copies are ordinary synchronized Markdown recorded
as regular Git mode `100644`. Conversion from former `120000` links in a
Windows checkout uses a per-command `core.symlinks=true` override when adding
the files, so Git updates the type as well as the contents. The two show-me
copies this was first applied to were removed on 2026-10-07 (see
[built-in visual guidance](#visual-guidance-is-built-in-and-portable)); the
rule still applies to meat copies.

Reason: overwriting a flattened link with Markdown fixes discovery locally,
but plain staging under `core.symlinks=false` can preserve symlink mode and
commit Markdown as the link target. A per-command override preserves local
configuration and unrelated index state. No staging is performed by skill sync.

Evidence: [synchronization](../scripts/install-meat-skill.ts),
[valid discovery contents](../test/skill.test.ts),
[audit and reproduction](../analysis/skill-code-audit-2026-10-07/REPORT.md).
Revisit after the type conversion is committed or discovery layout changes.

## Windows launch and frozen byte fixtures use native portable paths

Decision: subscription login and review resolve Windows PATH/PATHEXT entries.
Native executables run directly; npm batch shims use `cmd.exe` with arguments
escaped for both the shell and shim forwarding. Regression fixtures validate
Codex configuration quotes, Claude's empty settings argument and MCP JSON,
stdin, reviewed cwd, streaming, failed login and child failure.
Build permission changes use Node's filesystem API, with no separate Unix
`chmod` executable requirement.

Conformance vectors and diff corpus inputs use `-text` Git attributes to
preserve their committed bytes, including intentional CRLF and invalid UTF-8.
Tests read raw fixtures without normalization. Checkout-induced CRLF bytes
were restored only after proving the difference was newline conversion from
unchanged committed blobs; no expected result was regenerated. A new checkout
test explicitly enables `core.autocrlf=true` and checks committed and checked-out
bytes. Generated ESM test probes import file URLs and assert child exit status
before interpreting output; temporary Git fixtures set their own EOL policy.
Terminal detection tests open the actual Windows `\\.\NUL` device and assert
character-device status, preserving the Unix `/dev/null` case elsewhere.

Evidence: [agent adapter](../src/cli/agent.ts),
[agent regressions](../test/cli/agent.test.ts), [build script](../package.json),
[attributes](../.gitattributes), [checkout regression](../test/fixture-checkout.test.ts),
[stdin probes](../test/cli/stdin.test.ts),
[fixture identities](../analysis/skill-code-audit-2026-10-07/fixture-check.json).
Revisit when launcher arguments, supported host platforms or fixture paths change.

## First-run usability adds guidance without changing Go-baseline contracts

Decision: help, recovery hints, `-o`, `-doctor`, quiet `-agent` and
`npm run setup` are TypeScript-only additions. Go-baseline error messages and
exit codes stay unchanged; hints are extra `hint:` lines printed only after a
failure. Bare `meat HEAD` remains API abridging. Verb subcommands were not added
because a positional such as `look` can be a valid ref; the failure hint covers
that mistake instead. Flag errors point to `meat -h` rather than dumping usage.

`-o` exists because shell redirection is not byte-safe on Windows PowerShell
5.1: on 2026-10-07, `-prompt HEAD >` produced 95,595 bytes (UTF-8 BOM, 1,673
LF→CRLF) where cmd produced the original 93,919. `-o` writes stdout's exact
bytes through a temporary file renamed after success. Fresh-agent stderr is
captured because Codex echoes the whole packet there; failures print its last
64 KiB. `-doctor` reuses the `-agent` login probe with API variables removed,
reads no diff, probes no model/provider/gateway, and reports variable names only.
Git subprocess stderr is captured as Go's `.Output()` did, so errors print once.

Evidence: [usability cases](../test/cli/usability.test.ts),
[agent cases](../test/cli/agent.test.ts), [doctor](../src/cli/doctor.ts),
[CLI contract](../specs/cli.md#first-run-usability).
An `npm install -g --prefix <scratch>` of this checkout produced working
`meat.cmd` and `meat.ps1` wrappers on Windows (PowerShell RemoteSigned policy).
Revisit when meat ships as a published package or plugin, when Go error-text
parity is no longer required, or when agent CLIs change their stderr output.
