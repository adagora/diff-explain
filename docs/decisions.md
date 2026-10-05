# Maintained decisions

Keep each entry scoped: decision, reason, evidence, and when to revisit.
These are maintained project facts and rationale. Proposed runtime work belongs
in the [roadmap](roadmap.md), with contracts labelled proposed.
Last reviewed against local source and documentation: 2026-10-05.
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
Snapshot-bound context and evidence-aware reuse remain proposed in
[agent interface](../specs/agent-interface.md). Revisit when they ship.

## Visual integration stays in the meat skill

Decision: the meat skill routes useful visual explanations to the installed
HumanLayer show-me skill, allowing visual guidance to evolve independently of
the CLI/compiler.

Evidence: [meat skill](../.claude/skills/meat/SKILL.md),
[show-me skill](../.claude/skills/show-me/SKILL.md).
The installation was recorded on 2026-09-07 from the upstream main branch.
Revisit when changing discovery or upstream integration; a visual explanation
retains its underlying evidence limits.

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
knowledge; runtime adoption is explicitly pending.

Evidence: [AGENTS](../AGENTS.md), [spec index](../specs/INDEX.md),
[workflow](agent-workflow.md), status labels in
[proposed contracts](../specs/agent-interface.md).
Revisit when a new workflow needs a different owner or a proposal ships.
