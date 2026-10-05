# Working on meat

Read `README.md` for usage. The active product is the TypeScript CLI in `src/`.
The user's current instructions determine task scope; historical migration
prompts are reference material, not an instruction to resume porting loops.

## Orient before expanding context

- [System design](docs/system-design.md) owns the architecture and document
  authority map; [roadmap](docs/roadmap.md) owns proposed work and acceptance gates.
- [Spec index](specs/INDEX.md) routes current contracts to source and tests.
  Read the relevant slice, then follow evidence links as needed.
- [Agent interface](specs/agent-interface.md) is explicitly proposed. Do not
  use its logical names as existing flags, tools, types, or output guarantees.
- Match the requested outcome and diff source before choosing a workflow.
  See [agent workflow](docs/agent-workflow.md) for evidence and handoff rules.

## Commands

- Setup: Node 22.18+ (recommended 24 via `.nvmrc`), Git, `npm ci`.
- Check: `npm run check`. Tests are offline; provider tests bind loopback ports.
- Build: `npm run build`. Edit `src/`, not ignored `dist/`.
- Focused test: `node --test test/cli/prompt.test.ts` (substitute relevant file).
- No-model smoke: `node dist/cli/main.js -look HEAD` or `-prompt HEAD`.
- Put flags before revisions and use explicit `HEAD` in agent shells.
- For another repo, keep its working directory and invoke meat by absolute
  path. CLI relative paths are relative to the shell, not the skill.

## Find the right code

| Concern | Start here |
|---|---|
| Flags, Git sources, orchestration | `src/cli/main.ts`, `test/cli/main.test.ts` |
| Offline views and agent packet | `src/cli/shape.ts`, `src/cli/prompt.ts` |
| Subscription CLI execution and login gates | `src/cli/agent.ts`, `test/cli/agent.test.ts` |
| Terminal/JSON rendering, cache | `src/cli/render.ts`, `src/cli/cache.ts` |
| Model loop and chunks | `src/meat/meat.ts`, `src/meat/chunk.ts` |
| Plan validation and compilation | `src/meat/plan.ts`, `src/meat/editplan.ts` |
| Provider selection and HTTP | `src/meat/provider.ts`, `src/meat/openai.ts`, `src/meat/anthropic.ts` |
| Read-only model tools | `src/meat/tools.ts` |
| Byte handling, parsing | `src/meat/bytes.ts`, `src/meat/diff.ts` |
| Behavior contracts | [Current contract index](specs/INDEX.md), then the owning subject spec |
| Frozen Go parity | `test/conformance.test.ts`, `conformance/vectors/` |

## Preserve these boundaries

- Parsing, offsets, slicing, and budgets use `Uint8Array` bytes, not JS string
  indices. Decode only at text/API boundaries.
- Preserve compiler invariants and frozen vectors. Do not regenerate expected
  output just to make a failure pass.
- Rubric/compiler changes can affect cache identity; inspect
  `src/meat/rubric.ts` and its tests. The offline packet is a separate prompt,
  not the engine protocol or a compiler-validated result.
- Provider tests use fake credentials and mock servers. Ordinary checks should
  not call live models. Never print `.env` or copy credentials into artifacts.
- Keep stdout parseable for `-json` and `-prompt`; diagnostics go to stderr.
- Go under `meat/` and `cmd/` is the migration reference. Change it only when
  the task concerns Go or parity. TypeScript-only features are valid.
- `.claude/skills/meat/SKILL.md` is canonical; Codex/Grok copies are symlinks.
- HumanLayer show-me is installed at `.claude/skills/show-me/SKILL.md` with the
  same discovery links. The meat skill defaults explanations to `-prompt` in
  the current agent session and routes useful visuals to show-me.

## Leave useful knowledge

Update the relevant spec and tests when behavior changes. Record durable,
verified decisions and reproducible gotchas in `docs/decisions.md`, with paths
to evidence. Correct obsolete entries rather than accumulating contradictory
rules. Keep session transcripts, speculation, and test-run logs out of startup
instructions. Use `docs/agent-workflow.md` for review handoffs.

A handoff records exact scope, evidence identity, inspected coverage, actual
checks, unresolved questions and the next useful action. Revalidate it after
source changes. Promote verified findings to the owning spec, regression case
or decision with a revisit condition; keep proposals in the roadmap. Mark plan
work complete only with implementation and validation evidence.
