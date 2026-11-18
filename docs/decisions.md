# Maintained decisions

Keep entries short: decision, reason, evidence, and when to revisit. These are
project facts, not a session journal. Last reviewed: 2026-11-18.

## `columbo` is the product; Meat remains the compatible compiler surface

The local npm package is `columbo-review`; the `columbo` and `meat` bins point
to the same CLI. The product was renamed from Thread, and before that Meat.
Public guidance uses columbo. Wire kinds (`meat.packet`, `meat.compiled`),
frozen compiler/rubric semantics, legacy diagnostic prefixes, `MEAT_*` engine
configuration and default `~/.meat` cache remain unchanged. At the CLI boundary
`COLUMBO_MODEL` and `COLUMBO_CACHE` override `THREAD_*`, then `MEAT_*`, even when
empty. Explicit model flags retain precedence. Workflow wire kinds use the
`columbo.` prefix; local records live under `columbo-state-v1`.
Evidence: `package.json`, `src/cli/brand.ts`, `test/cli/workflow.test.ts`.

Prime loads Understand, Work, Review, Audit or Converge instructions. Audit
covers a requested repository; Review covers a selected diff. The current agent
does the inspection. The loader reads the bootstrap, selected activity and shared
review policy where applicable, without network/model access,
checkout discovery or installation of hooks. Work includes a proportional review
checkpoint; packet compilation is conditional on its usefulness or user intent.
This supplies shared agent behavior without a scheduler, daemon or extra model
budget by default. Fixing findings uses Work with no default round cap; explicit user limits apply. Handoffs remain evidence-based and agent-authored.
PACT is optional and must follow the target's explicitly pinned policy. The
upstream Prime README is preserved under `prime/references/`; it is neither
auto-loaded nor included in the npm package.
Evidence: `prime/README.md`, `prime/activities/`, `src/cli/workflow.ts`.

The canonical workflow skill is `.claude/skills/columbo/SKILL.md`, discovered via
Codex/Grok symlinks. The old Meat skill remains for compatibility. Both skills,
show-me, Prime resources and CLI manuals ship in the package; installation of
that package alone does not register host skills in unrelated repositories.
Explicit `columbo setup` previews copies into Codex/Claude project discovery
directories; `--yes` applies them. Copies include an absolute runtime launcher
so agents need not inherit the user's PATH or mistake the target for the source
checkout. Matching and bundled skills are preserved; differing files and unsafe
symlink parents block writes. Files are created exclusively. A filesystem failure
during application can leave partial new files, reported for recovery. Existing
content is never force-overwritten and setup does not edit project instructions,
host settings or credentials. Revisit a managed upgrade mechanism only with
ownership/change detection and explicit user control over local modifications.
Evidence: `package.json`, `src/cli/setup.ts`, `test/cli/setup.test.ts`.

columbo's review policy uses PACT's process ideas in new local wording: identify
the snapshot, inspect implementation/contract/verification, substantiate findings,
and bound fix/review loops. Source commit `72c68ef77a941d2ac6ab4ae4b22319992ddd02e1`
reports contract v1.3.0 but has no license file and lists its license as TBD.
Upstream documents/scripts are not vendored. Source paths, hashes and differences
are recorded in `prime/provenance.json` and `prime/optional/pact.md`. The local
policy does not emit PACT markers or claim its merge gate is satisfied.

Project code receives no new inline, block or documentation comments. Explanations
belong in project documentation. Evidence: the explicit user rule in `AGENTS.md`.

## Any agent can submit a snapshot-bound plan to the existing compiler

`packet` exports an offline JSON snapshot with numbered diff, hash, compiler
identity, schema, and selection guidance. `compile` validates a matching plan
against that saved snapshot using the production submit/compiler pipeline.
This connects existing sessions or any model to compiled output without
requiring provider credentials in Meat. `abridge` remains an alias for the API
engine and preserves its existing JSON contract. The Markdown `-prompt` and
subscription `-agent` explanation paths remain separate and uncompiled.
Evidence: `src/cli/bridge.ts`, `src/cli/main.ts`, `test/cli/bridge.test.ts`.

New packet commands default to HEAD and require explicit `--stdin`, preventing
empty agent-shell pipes from selecting the wrong source. Packets currently cap
raw diffs at 400 KiB; API abridging still supports chunking. Revisit coordinated
multi-packet planning only with original-coordinate and cross-chunk move tests.
Raw JSON diff text uses a BOM-preserving decoder: the shared text decoder strips
an initial BOM, which would break byte count/hash round trips. Tests cover BOM,
CRLF, Unicode and missing final newlines without altering frozen byte semantics.

Git subprocess stderr is captured explicitly. Node's synchronous exec helper
otherwise echoes failed-command stderr even when the failure is caught; this
made successful piped API reviews outside Git print a misleading fatal message
during optional repository discovery. Evidence: `src/cli/main.ts` (`git`),
`test/cli/bridge.test.ts` (mock API abridge from the system temporary directory).

Packet identity covers the diff, not surrounding source, semantic coverage,
authorship, or test execution. Compilation is a constrained transformation, not
a correctness review. Keep the original diff. The npm artifact includes the
canonical Meat skill alongside show-me; host discovery installation is separate.

## TypeScript is the working implementation

`package.json` builds `src/` into `dist/`; tests exercise TypeScript plus 111
frozen Go conformance vectors. The Go tree and migration ledgers remain useful
references. Consult them selectively rather than restarting historical loops.
Evidence: `tsconfig.json`, `test/conformance.test.ts`, `migration/CONFORMANCE.md`.

## Use native TypeScript support consistently

The minimum is Node 22.18; `.nvmrc` selects Node 24. Source launch and tests both
execute `.ts` files directly. The previous Node 20 claim did not cover this
workflow. Evidence: `package.json`, imports in `test/`, and
[Node's TypeScript documentation](https://nodejs.org/api/typescript.html).
Revisit if adding a separate test transpilation stage or changing runtimes.

## Existing subscriptions use a portable review packet

`-prompt` exports instructions, a source label, byte count, SHA-256, and the full
diff without model or cache access. The existing agent session explains it.
This remains useful for an existing session. Following the request for direct
terminal execution, `-agent codex|claude` now launches a fresh CLI review.
It checks subscription login and removes API overrides, with no API fallback.
Grok remains packet-only until its login mode can be reliably verified.
Evidence: `src/cli/prompt.ts`, `test/cli/prompt.test.ts`.

Native adapter evidence: `src/cli/agent.ts`, `test/cli/agent.test.ts`.
Codex 0.153.4 completed a live HEAD review using its confirmed ChatGPT login on
2026-09-07. Claude's adapter is mock-tested; a live subscription review has not
been verified. `npm run review` launches Codex; `npm run packet` only exports.

## Visual explanations and compiled reading diffs have different guarantees

The engine validates model edit plans and compiles a reading diff. Packets and
optional show-me explanations do not carry those compiler guarantees. Retain
the original diff and label results accurately.
Evidence: `src/meat/editplan.ts`, `src/meat/meat.ts`, `src/cli/prompt.ts`.

The HumanLayer show-me skill is now installed unchanged in
`.claude/skills/show-me/`, linked into the Codex/Grok project roots. Integration
logic stays in the meat skill, so upstream visual guidance can be updated
independently. Default agent explanations use the current session even when
API credentials exist; compiled abridging remains an explicit alternative.
Source: https://github.com/humanlayer/skills/tree/main/plugins/show-me/skills/show-me
Installed: 2026-09-07 via the skill-installer (main branch snapshot).

## Agent shell commands name their diff source

Use explicit `HEAD` for the latest commit. No-argument execution inspects stdin;
an agent process can receive an empty pipe instead of a terminal. Flags precede
the revision because parsing stops at the first positional argument.
Evidence: `src/cli/main.ts` (`parseFlags`, `readDiff`), `test/cli/main.test.ts`.

## Workflow composition and continuation

columbo's user-facing entry is “Use columbo to <outcome>”. Optional skills are
agent-loaded guidance, not a plugin registry or automatic remote import system.
Audit uses domain-specific questions with evidence and coverage rather than
checklist compliance as proof. Native host goals can continue authorized work,
while Work retains review criteria and explicit user limits. No host goal is
created by loading instructions. Startup reads complete root rules and README,
then investigates architecture and task-relevant paths. Status stays conversational;
requested handoffs preserve agreed work separately from optional ideas. Evidence: `prime/README.md`,
`prime/activities/audit.md`, `prime/activities/converge.md`,
`.claude/skills/columbo/SKILL.md`, `test/cli/workflow.test.ts`.

## Statecharts explain behavior within existing work

Optional statecharts complement reading diffs and do not add an activity or
verification dependency. Evidence labels separate intent, traced implementation
and actual model-checking results. Charts keep consequential failures visible
and disclose abstractions; formal results remain bounded by the checked model.
The guide ships under the existing optional-resource allowlist and is read on
demand, including from a columbo installation outside the target repository.
Evidence: `prime/optional/statecharts.md`, `prime/README.md`,
`.claude/skills/columbo/SKILL.md`, `test/cli/workflow.test.ts`.


## Explicit local records preserve intent without certifying conclusions

Status, snapshot and record add an offline layer in worktree-local Git metadata.
Intent and attributed evidence/decisions are immutable, separately typed records.
Source hashes detect changed supporting bytes; they do not prove semantic validity,
test execution or actor identity. Decision answers do not grant authorization.
No active task is inferred, and reading status never initializes state. Atomic
exclusive publication preserves history across competing writers; competing
answers are surfaced rather than selected by write order. The first version has
no automated check runner, cross-checkout migration, or conflict merger.
Evidence: `src/cli/state.ts`, `test/cli/state.test.ts`, `docs/cli-reference.md`.
Revisit automatic retention and richer execution receipts only with explicit
provenance and invalidation contracts.
