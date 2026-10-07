# Skill and CLI behavior audit

Reviewed 2026-10-07. Base commit: `fe29b3991e475d16429c350d5fcd3a070cd5a6c8`.
The review covers the existing uncommitted P1/skill work and corrections below.
Exact current source hashes, personal skill checks and executed check results
are recorded in [results.json](results.json). Regenerate after source changes:

```powershell
node analysis/skill-code-audit-2026-10-07/verify.ts
```

The verifier makes no live model call or personal installation/configuration
write. It runs offline tests, builds the CLI, checks project/installed skill
identity, and records the full gate. Its exit remains nonzero if the full gate
fails; failures are not converted to success.

## Result and the meaning of 1:1

The skill calls the same CLI implementation for source collection, evidence,
compiled output, provider selection and caching. It does not implement a second
rubric/compiler. A compiled request retains the actual CLI result. Regression
coverage demonstrates import removal through the real engine and byte-identical
compiled output through the CLI/cache path, without provider access.
Personal installations now contain a small launcher that reads the current
canonical skill before choosing commands. Changing canonical instructions
therefore does not leave a stale copied personal body.

An existing-session explanation remains agent-authored. It cannot be guaranteed
to make exactly the same semantic choices as an API model, and it has no
compiler guarantee. Automatic skill selection is also an agent decision.
This audit establishes tested routing/output contracts, not deterministic
interpretation of every possible user request.

## Confirmed findings and corrections

| Finding | Impact | Correction and evidence |
|---|---|---|
| Legacy Git capture inherited Node's 1 MiB buffer | Large committed/staged/worktree input failed before the documented packet or API engine path | Shared explicit 64 MiB capture bound in [main](../../src/cli/main.ts) and [snapshot](../../src/cli/snapshot.ts). [Regression](../../test/cli/skill-contract.test.ts) checks full original bytes, digest and final row above 1 MiB. |
| Child credential-name filtering was case-sensitive | Windows casing variants could reach the subscription child despite the documented cleanup | Case-insensitive [filter](../../src/cli/agent.ts), with mixed-case fake-env [regression](../../test/cli/agent.test.ts). This finding did not establish actual API fallback. |
| Recursive requests probed login before rejecting | A recursive review could report a missing CLI/login instead of the intended refusal | Reject before probing. [Regression](../../test/cli/agent.test.ts) uses an empty PATH and supplied stdin diff. |
| Skill said a compiled result always requires an API key | Incorrectly excluded configured endpoints, supported gateways and existing cached results | [Canonical skill](../../.claude/skills/meat/SKILL.md) delegates cache/provider preflight to the CLI and preserves its result/diagnostic. Actual cache/compiler behavior is tested in [contract cases](../../test/cli/skill-contract.test.ts). |
| Personal installation wrote through a directory junction | A personal meat directory linked to the canonical directory could append installation instructions to the source skill | Reject linked leaf directories/files and canonical directory aliases before writing. [Junction regression](../../test/skill-install.test.ts) verifies unchanged canonical bytes. |
| Windows show-me discovery files contained only link targets | Host loaders could not read YAML or instructions; existing discovery test failed | [Synchronization](../../scripts/install-meat-skill.ts) writes ordinary canonical copies for both skills. [Discovery cases](../../test/skill.test.ts) check usable content; the index now records regular file type `100644`. |
| Paging instructions omitted the repeated source requirement | A staged continuation without `-staged` selected HEAD and failed as changed evidence | Skill now requires the same source and page limit and gives a staged continuation example. [Observation cases](../../test/cli/observe.test.ts) exercise snapshot/query rejection and byte reconstruction. |
| Same-selector plan wording could imply execution identity | Observation omits legacy commit envelopes; a threshold input can therefore partition differently | Plans now expose `input_basis: observation_snapshot` and unassessed legacy equivalence. [Observe contract](../../specs/observe.md), help and skill state this boundary. |
| Binary filename containing ` b/` was split incorrectly | Inventory displayed the wrong old/new path for a legitimate unquoted Git header | Prefer the split with equal a/b filenames; rename/copy metadata still overrides differing names. [Regression](../../test/cli/observe.test.ts) retains exact raw evidence bytes. |
| Copied personal skill bodies could become stale | Canonical business/workflow instructions could change without reaching installed hosts | [Installer](../../scripts/install-meat-skill.ts) writes a launcher with canonical metadata and absolute canonical/CLI bindings. [Regression](../../test/skill-install.test.ts) changes the source instructions after installation and verifies the unchanged launcher reads the new version. |
| Windows could not spawn npm agent batch shims directly | Subscription login/review failed despite an installed CLI | Resolve PATH/PATHEXT and launch `.cmd`/`.bat` through `cmd.exe`. [Both agent cases](../../test/cli/agent.test.ts) preserve stdin/cwd, empty and quoted arguments, streaming and no API fallback using fake shims under a path with spaces and shell punctuation. |
| Git EOL conversion changed frozen input and output bytes | Byte offsets, compiler oracles and rubric surfaces failed on Windows | [.gitattributes](../../.gitattributes) disables text conversion for byte fixtures. All 123 affected fixture files match unchanged committed blobs; 110 checkout conversions were restored after preflight. [Checkout regression](../../test/fixture-checkout.test.ts) preserves LF, intentional CRLF, Unicode and invalid UTF-8 under `core.autocrlf=true`. |
| Generated ESM probes imported raw Windows drive paths | Merge/stdin tests failed before reaching the behavior being tested; an empty-output assertion could pass after a child failure | [Main](../../test/cli/main.test.ts) and [stdin](../../test/cli/stdin.test.ts) probes import file URLs; every stdin probe checks exit status. [Prompt fixtures](../../test/cli/prompt.test.ts) set a local EOL policy. |
| Null-device rendering coverage skipped Windows | The character-device/TTY boundary was untested on this host | [Rendering regression](../../test/cli/render.test.ts) opens `\\.\NUL` on Windows and verifies it is a character device before testing terminal classification. |
| Postbuild required a Unix `chmod` command | Windows setup depended on an extra shell utility beyond documented Node/Git prerequisites | [Build script](../../package.json) uses Node's filesystem API; the build gate passes on this Windows checkout. |

## Workflow alignment

| User outcome | Skill dispatch | CLI/business rule checked |
|---|---|---|
| Explain a commit or range here | Absolute CLI entry plus `-prompt` and requested selector | Original diff digest/full input; current session supplies interpretation; historical context is labeled |
| Inspect staged or worktree changes | `-look`, or bounded observation with `-staged`/`-w` | Index and worktree remain distinct; untracked files are excluded; flags precede revisions |
| Inspect oversized evidence | `-inventory` then snapshot-bound `-evidence` with repeated source/limit/cursor | Ordered pages, exact reconstructed bytes, stale-source rejection and subset coverage |
| Produce compiled output | Ordinary CLI, optionally `-json`; preserve requested model/cache flags | Actual engine/compiler and CLI cache; no separate key-only preflight or manual abridgment |
| Fresh subscription review | Explicit `-agent codex` or `-agent claude` | Login gate, filtered environment, no API fallback, early recursion rejection |
| Grok explanation | Exported packet/client-dependent discovery | No native Grok subscription launcher is claimed |

## Coverage and actual checks

Three independent initial passes reviewed CLI/auth/provider boundaries,
installation/discovery, and realistic skill usage. The usage pass selected
workflows from the skill before inspecting implementation. An additional
independent pass rechecked the corrected skill. The root reviewed observation,
snapshot, packet, cache and engine/compiler boundaries and integrated offline
regressions. No agent changed unrelated user work or called a live model.
Two additional independent passes fixed Windows agent launch and portable CLI
probes. The root rechecked those changes, canonical launcher behavior, frozen
byte identities, checkout preservation and Git discovery modes.

Initial forward testing used a temporary repository with distinct parent,
HEAD, index and worktree values. Commit explanation selected parent-to-HEAD;
staged inspection selected HEAD-to-index and excluded unstaged/untracked data.
For 1,892,425 staged observation bytes, three inventory pages enumerated
26 files/26 hunks; ten evidence pages reconstructed one 75,688-byte file.
That was evidence delivery for one file, not a full semantic review of the
large parent. Exact moves were absent in that fixture; separate observation
regressions cover their relationships.

Executed checks and counts are in [results.json](results.json): all **51 focused
checks passed** (44 skill/evidence/checkout cases and seven auth/launch cases);
`npm run build` passed; `npm run check` type-checked source and reported
**900 tests, 900 passed, zero failures and zero skips**. The unchanged-HEAD
baseline previously reproduced 69 Windows failures. Discovery synchronization,
batch-shim launching, portable probes and preserved fixture bytes resolve the
reported Windows failures. Frozen expected output was not changed or regenerated.

Existing personal Codex and Claude meat installations were refreshed to the
canonical-reading launcher. Their absolute entry remains this checkout's source
CLI. Canonical instruction updates apply directly; reinstall after moving the
checkout or changing discovery metadata. Open a new CLI session to load the
updated launcher. Grok discovery remains client-dependent. No live subscription
execution or complete model-based semantic parity test was performed.

The earlier independent post-correction pass used canonical skill SHA-256
`8941eba21cc13e9fc9f2ffcd6514f5192406f600854746459112658ff8a2464c`.
It rechecked commit versus staged/worktree scope, a 2,513,176-byte packet,
six inventory pages over 2,512,696 captured staged bytes/eight files, and
exact cached compiler output. OpenAI/Anthropic/xAI provider constructors all
accepted configured endpoints with empty keys and sent zero requests.
Changing the index or switching sources rejected continuation as `source_changed`;
changing page limits produced `invalid_request`. The pass did not authenticate
an endpoint or semantically review the entire large fixture.
The final launcher wording changed after that pass; its current hash and
bindings are recorded in `results.json`, and its live-reference behavior is
covered by the installation regression.

## Git file types and handoff

The index now records both former show-me links as ordinary `100644` Markdown.
This conversion used a per-command override:

```powershell
git -c core.symlinks=true add -- .agents/skills/show-me/SKILL.md .grok/skills/show-me/SKILL.md
```

`git diff --cached --raw` reports `120000 -> 100644` for those two files. Only
those discovery conversions are staged; no commit was created and no
repository/global Git configuration was changed. Frozen fixture index metadata
was refreshed after verifying index/HEAD blob equality; no fixture content is
staged or changed. The remaining implementation, docs and regression changes
are in the working tree. Review the complete working tree together before
committing, and rerun the verifier after any source changes.
