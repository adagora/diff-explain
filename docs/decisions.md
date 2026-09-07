# Maintained decisions

Keep entries short: decision, reason, evidence, and when to revisit. These are
project facts, not a session journal. Last reviewed: 2026-09-07.

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
