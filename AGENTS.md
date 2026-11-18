# Working on columbo (formerly Thread and Meat)

Read `README.md` for usage. The active product is the TypeScript CLI in `src/`.
The user's current instructions determine task scope; historical migration
prompts are reference material, not an instruction to resume porting loops.
The agent workflow lives in `prime/README.md` and `prime/activities/`. Load only
the activity relevant to the user request with `node src/cli/main.ts prime`.
Prime prints instructions for the current agent; it is not a scheduler or hook.

## Orient before expanding context

- [System design](docs/system-design.md) owns the architecture and document
  authority map; [roadmap](docs/roadmap.md) owns proposed work and acceptance gates.
- [Spec index](specs/INDEX.md) routes current contracts to source and tests.
  Read the relevant slice, then follow evidence links as needed.
- [Agent interface](specs/agent-interface.md) maps P1 adoption and labels the
  remaining targets proposed. [Observe](specs/observe.md) owns shipped flags
  and schema; do not treat unmapped logical names as existing operations.
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
| Workflow subcommands, Prime loading, skill setup | `src/cli/bridge.ts`, `src/cli/workflow.ts`, `src/cli/setup.ts` |
| Local intent, evidence and decision records | `src/cli/state.ts`, `test/cli/state.test.ts` |
| Product naming and environment aliases | `src/cli/brand.ts`, `test/cli/workflow.test.ts` |
| Snapshot identity, bounded inventory and offline plan | `src/cli/snapshot.ts`, `src/cli/observe.ts` |
| Subscription CLI execution and login gates | `src/cli/agent.ts`, `test/cli/agent.test.ts` |
| Setup readiness, `-o`, help and recovery hints | `src/cli/doctor.ts`, `src/cli/main.ts`, `test/cli/usability.test.ts` |
| Terminal/JSON rendering, cache | `src/cli/render.ts`, `src/cli/cache.ts` |
| Model loop and chunks | `src/meat/meat.ts`, `src/meat/chunk.ts` |
| Plan validation and compilation | `src/meat/plan.ts`, `src/meat/editplan.ts` |
| Provider selection and HTTP | `src/meat/provider.ts`, `src/meat/openai.ts`, `src/meat/anthropic.ts` |
| Read-only model tools | `src/meat/tools.ts` |
| Byte handling, parsing | `src/meat/bytes.ts`, `src/meat/diff.ts` |
| Behavior contracts | [Current contract index](specs/INDEX.md), then the owning subject spec |
| Frozen conformance vectors | `test/conformance.test.ts`, `conformance/vectors/` |

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
- The upstream Go sources were removed. `conformance/vectors/` is the frozen
  oracle; do not claim parity or behavior the vectors and tests do not cover.
- `.claude/skills/meat/SKILL.md` is canonical; synchronize the tracked
  Codex/Grok discovery copies with `npm run skill:sync` after editing it.
- The meat skill defaults explanations to `-prompt` in the current agent
  session. Visual guidance is built into the skill and the `-agent` prompt
  (`visualGuidance` in `src/cli/agent.ts`); keep it plain text or Mermaid, with
  no platform-specific commands, so it works on Linux, macOS and Windows.
- Discovery copies use regular Git file mode `100644`; preserve that type when
  changing skills. See decisions for conversion from former Windows link stubs.
- `.claude/skills/columbo/SKILL.md` is the canonical workflow skill; the Codex,
  Grok and Claude discovery copies are regular files with identical bytes.
  `.claude/skills/meat/SKILL.md` remains the canonical diff skill.
- The package is `columbo-review`, with `columbo` as the preferred bin and
  compatible `meat`. Preserve `meat.packet` / `meat.compiled` wire kinds, the
  engine protocol, `MEAT_*` variables and default `~/.meat` cache.
  `COLUMBO_MODEL` and `COLUMBO_CACHE` override `THREAD_*`, then `MEAT_*`, at the
  CLI boundary, including empty values.
- Workflow wire kinds use the `columbo.` prefix, and local records live under
  Git metadata in `columbo-state-v1`. Records are attributed claims, never
  verification; keep `verified_by_columbo:false` honest and never rewrite a hash
  to make stale evidence look fresh.
- Prime guidance is packaged text, not a hook, model call, or scheduler.

## Code style

- Do not comment code: no inline, block, or doc comments. Put explanations in
  `docs/` or the owning spec instead. License/derivation headers are the only
  exception. Existing comments are legacy; leave them unless the task rewrites
  that code.

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
