# Stage 3 TODO — TypeScript port ledger

The progress ledger for stage 3 (`migration/prompts/stage3-port.md`). Order
below is **fixed** — do not reorder items, only tick them off top to bottom,
taking "the most important unblocked item" per the loop's Phase B rule 1.

**Definition of done**, per item (`migration/TARGET.md` "Definition of
done" + `migration/CONFORMANCE.md`): (1) `tsc --noEmit` clean under the
strict config — no `any`, no `!` outside `bytes.ts`, no `@ts-expect-error`
without a cited reason; (2) its ported `node:test` tests pass; (3) every
conformance vector it touches passes, with zero regression in vectors that
were already green; (4) its spec's citations still resolve, and any hazard
it hits is recorded in `migration/HAZARDS.md` if not already there. One item
per iteration; finish it completely (compiler clean, tests passing, vectors
green, TODO/HAZARDS updated) before ticking it and stopping — a half-ported
file is worse than an unported one.

`cmd/meat/isatty_*.go` gets **no port item anywhere in this list** — H11
collapses the whole four-file build-tag family into `node:tty`'s
`tty.isatty(fd)`, consumed inside item 5c (`render.ts`) and 5d (`main.ts`).
If you go looking for where it went, this is it.

---

## 1. `src/meat/bytes.ts` — the byte-slice layer (H1)

- [x] **bytes.ts**

**Delivers**: the engine's byte-slice primitives, operating on
`Uint8Array` per H1's engine-wide decision (diff/chunk/editplan/imports/
moves/python take and return bytes; decode to `string` happens only at the
CLI and model-API boundaries). At minimum, per `migration/TARGET.md`'s
`noUncheckedIndexedAccess` section: `at(b, i): number` throwing
`RangeError` on out-of-bounds (Go's panic semantics), `slice`, `indexOf`,
`equals`, `hasPrefix`, `splitLines` (the `splitSourceLines` primitive —
see `specs/diff.md` Algorithm 1: no phantom trailing line, `\r\n` vs `\n`
terminator detection), `concat`, and a Go-matching `trimSpace` (Go's
`unicode.IsSpace` includes U+0085/NEL, excludes U+FEFF — the *opposite* of
JS `.trim()`; do not call `.trim()` anywhere in the port — H14, cited at
~14 call sites across the codebase, catalogued in `migration/HAZARDS.md`).
Also needs: a rune-boundary walker matching `utf8.RuneStart` (used by
`tools.ts`'s `truncateForTool`, H1), and small Unicode-property helpers
matching Go's `unicode.IsLetter`/`IsNumber`/`IsControl`/`IsSpace` (H2 —
`/\p{L}/u`, `/\p{N}/u`, `/\p{Cc}/u`, not ASCII-range approximations) since
`moves.ts` and `editplan.ts` both need genuine Unicode-property tests, not
just byte ops. UTF-8 encode/decode boundary helpers (`TextEncoder`/
`TextDecoder`) belong here too, since every downstream file needs the
CLI/model boundary crossing done consistently in one place.

**Specs**: no dedicated spec (it's new — H1's prescribed utility layer).
Cross-reference `specs/diff.md` Algorithm 1 (`splitSourceLines`) and every
spec's own Hazards section for H1/H2/H14 call sites this layer must serve.

**Vectors**: none directly (no vector directory targets `bytes.ts`) — it's
exercised transitively by every vector below once `diff.ts` etc. depend on
it. Gets the most `node:test` unit tests of anything in the port (per
stage3-port.md's own framing) since it has no diff.go analogue to test
against — write tests for byte/UTF-8/rune-boundary edge cases directly.

**Hazards**: H1 (foundational — this file *is* the H1 decision made
concrete), H2 (Unicode-property helpers), H14 (Go-matching `trimSpace`).

---

## 2. Project scaffolding

- [x] **package.json** — per `migration/TARGET.md`: `"type": "module"`,
  `engines.node >= 20`, `bin.meat -> ./dist/cli/main.js`, `files: ["dist"]`,
  scripts `build`/`test`/`check`, zero runtime `dependencies`,
  `devDependencies` limited to `typescript`/`@types/node`.
- [x] **tsconfig.json** — copy `migration/TARGET.md`'s config verbatim:
  `target: ES2022`, `module`/`moduleResolution: NodeNext`, full `strict`
  family, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, etc.
- [x] **testdata/** — copy `meat/testdata/` byte-for-byte into `testdata/`
  at the repo root (10 files: 3×`.diff`/`.plan.json`/`.golden.diff` for
  django/flask/pytest, plus `README.md`). Do not touch a byte — these are
  the oracle for item 4i (`editplan.ts`)'s hard gate. Verify byte-identity
  after copy (`diff -r` or checksum), not just a file-count match.
- [x] **conformance/vectors/** — already exists at the repo root, frozen by
  stage 0 (111 files: `cache-key/`, `diff-layout/`, `elision/`,
  `fits-single-run/`, `imports/`, `json-wire/`, `moves/`, `numbered/`,
  `openai-request/`, `plan-compile/`, `prompt-surface.txt`,
  `protocol-version.txt`, `rubric-hash.txt`, `source-lines/`, `split/`,
  `validate/`, plus `conformance/meat-go` the reference binary). Nothing to
  build here — just confirm it's still in place and untouched before
  wiring item 3's runner at it.

**Specs**: `migration/TARGET.md` (binding), `migration/CONFORMANCE.md`.

**Vectors**: N/A (this item makes the vectors reachable, doesn't turn any
green itself).

**Hazards**: none directly — this is pure setup.

---

## 3. `test/conformance.test.ts` — the vector runner

- [x] **conformance.test.ts**

**Delivers**: a `node:test` file that walks `conformance/vectors/` and
asserts each vector's actual output against its expected output, with **no
knowledge of what any vector means** — it just checks bytes
(`migration/CONFORMANCE.md`: "It has no knowledge of what any vector
means; it just checks bytes"). Build it early and **failing** — every
assertion will fail until the corresponding item below is ported; the
passing count is the port's honest progress metric from here on
(`migration/CONFORMANCE.md`'s "Sequencing note"). Needs per-vector-shape
handling: `plan-compile/` (3 golden files, byte-exact), `rubric-hash.txt`/
`prompt-surface.txt`/`protocol-version.txt` (bare text files), the
directory-shaped vectors (`diff-layout/`, `source-lines/`, `numbered/`,
`moves/`, `imports/`, `split/`, `fits-single-run/`, `validate/`,
`elision/`) each holding one JSON file per input fixture, `openai-request/`
and `cache-key/` and `json-wire/` (single JSON files). Inspect a few actual
files under `conformance/vectors/` before writing the runner to confirm
the exact per-vector JSON shape — don't guess it from the catalogue table
alone.

**Specs**: `migration/CONFORMANCE.md` (binding — "Vector catalogue" table
and "The TypeScript side" section), `migration/SPEC-FORMAT.md` for general
citation conventions.

**Vectors**: this item doesn't turn any vector green — it's the harness
that will report every other item's vectors from here on.

**Hazards**: none directly, but get the comparison byte-exact (no string
normalization before comparing `plan-compile/`'s golden bytes) or every
later item's vector pass is meaningless — see H4/H1 generally on why
byte-exactness matters everywhere in this codebase.

---

## 4. The engine, in dependency order

### 4a. `src/meat/model.ts`

- [x] **model.ts**

**Delivers**: the vocabulary every other engine file is written against —
`Role` ("user"/"assistant", unvalidated at the type level per
`specs/model.md`'s Open questions), `Message` (role + ordered `Block[]`),
`Block` (discriminated by a `Type` string — `"text"`, `"tool_use"`,
`"tool_result"`, `"provider_state"` — carrying only the fields meaningful
for that type; the other fields are present-but-meaningless at their zero
value in Go, which the port should instead model as a proper discriminated
union, not a flat all-fields-present struct), `Tool` (name/description/
`InputSchema` as opaque raw JSON), `Response` (ordered blocks + per-call
token counts, no stop-reason carried through), and the one-method `Model`
interface (`generate(signal, system, messages, tools): Promise<Response>`).
`Provider`/`ProviderData` is an overlay usable on *any* block type, not a
fifth kind — presence is a length check (`len(ProviderData) > 0`), not a
nilness check; port so `null`/absent and empty are treated identically.
The implicit "non-null `Response` on success" contract (`specs/model.md`
Invariants) needs an explicit check in the port since TS won't enforce it
structurally the way Go's caller-side assumption did.

**Specs**: `specs/model.md` (no G-numbered guarantees — stage 1 left them
empty since there's no `model_test.go`; the Mechanism section is the
source of truth here, cross-checked against `specs/agent-loop.md` G4/G6-G8
and `specs/providers.md` G10-G27 for how the shapes are actually used).

**Vectors**: none dedicated — exercised indirectly by everything downstream.

**Hazards**: H4 (`Block.ToolInput`, `Block.ProviderData`, `Tool.InputSchema`
are all `RawMessage`-equivalent — port as an opaque `Uint8Array`/string
wrapper, never parsed), H15 (three distinct nil/zero-value situations —
zero-valued `Block`, `nil` `Content`/`tools` treated as empty, the
non-null-`Response`-on-success contract), H6 (declares the cancellation
parameter but implements nothing — H6 belongs to the implementers), H9 not
applicable (the one place presence is tested is a length check already),
H1/H2/H3 not applicable (no string indexing/iteration/regex in this file).

**As built**: `Block` is a discriminated union (`TextBlock | ToolUseBlock |
ToolResultBlock | ProviderStateBlock`) on `.type`, with `provider`/
`providerData` factored into a separate `ProviderOverlay` interface every
variant extends — so a `tool_use` block can carry both its normalized
fields *and* the opaque overlay simultaneously, matching
`meat/openai.go:328-340`'s actual behavior (tested explicitly in
`test/meat/model.test.ts`). `Role` became a two-value literal union
(`"user" | "assistant"`) rather than an unconstrained `string`, a
deliberate narrowing beyond Go's type since nothing in the codebase ever
produces a third value — flagged here in case a real need for one shows up
later. **The H15 non-null-`Response`-on-success item resolved better than
predicted**: `Model.generate` returns `Promise<Response>` and is expected
to *reject* on failure rather than ever resolving with something null-like,
so the invalid "succeeded with no response" state is structurally
unrepresentable — no explicit runtime check needed after all.

---

### 4b. `src/meat/provider.ts`

- [x] **provider.ts**

**Delivers**: two pure, I/O-free (beyond one env read) decisions —
`resolveModel(model, fallback)`: explicit model string wins; else
`$MEAT_MODEL`; else the fallback — and `isAnthropicModel(id)`: strip one
leading `"anthropic/"` (on a *local copy*, never mutating the caller's
string — an id of `"anthropic/claude-sonnet-4-6"` must reach the wire with
its prefix *intact*, since only the classification check sees the stripped
copy), then test `startsWith("claude-")`. `resolveModel` is reused
directly by both provider constructors (item 4o/4p) with their own
backend-specific fallbacks, not reimplemented per provider — the port
should share the one function.

**Specs**: `specs/providers.md` G1-G2, Mechanism "Model resolution &
backend dispatch".

**Vectors**: none dedicated.

**Hazards**: H1 (checked, not applicable — ASCII-prefix compare agrees
under byte or UTF-16 indexing), H6 (accepts/forwards a cancellation signal
but never consults it — applies only to the constructors it dispatches to).

**As built — scope narrowed, deliberately**: ported `resolveModel`/
`ResolveModel`/`isAnthropicModel` only. Go's `provider.go` also has
`DefaultModel = DefaultOpenAIModel` (a re-export from `openai.go:17`, not
yet ported) and `NewModelFromEnv` (constructs a real `AnthropicModel` or
`OpenAIModel` — needs both item 4o and 4p). Neither can be built correctly
yet: a static import of a not-yet-existing module would break `tsc` for the
whole `src/` tree, not just this file. Resolution: `DefaultModel` is
temporarily a literal `"gpt-5.6-sol"` in `provider.ts` with a comment
flagging it must become a re-export once `openai.ts` exists.
**`NewModelFromEnv` itself is deferred** — grep confirms its only caller in
the whole Go tree is `cmd/meat/main.go:130` (nothing in `meat.go` calls it
internally), so nothing is blocked by deferring it. **Add `NewModelFromEnv`
to `provider.ts` as part of item 4p's iteration** (openai.ts is last of the
two providers in the fixed order, so both dependencies will exist by
then) — replace the literal `DefaultModel` with a real re-export at the
same time.

---

### 4c. `src/meat/gateway.ts`

- [x] **gateway.ts**

**Delivers**: `discoverExeGatewayBase(signal, httpClientOpts)`, the exe.dev
managed-gateway discovery both providers fall back to. Exact sequence
(`specs/providers.md` Mechanism "exe.dev managed gateway discovery"): (1)
stat the marker path first — **must** precede any network attempt, so
every off-exe.dev invocation costs one filesystem stat and nothing else;
(2) build a request-scoped client with a 5s timeout if none supplied; (3)
derive a *second*, independent 5s timeout composed with the caller's
signal; (4) GET the reflection endpoint, any transport failure → `""`; (5)
require exactly HTTP 200; (6) decode JSON, absent/unknown fields ignored;
(7) scan integrations in **server-returned array order** (not sorted, not
deduped) for the first `type === "llm"` with non-empty name; (8) build
`https://<name>.int.exe.xyz` or `.team.exe.xyz` if `team === true`. Every
failure path — of any of the seven kinds above — converges on the same
`""` signal, no side channel, no logging; both provider constructors
uniformly treat `""` as "fall through." Two overridable module-level
values (`exeDevMarkerPath`, `reflectionIntegrationsURL`) are the test
seams — the port needs equivalent injectable seams, not hardcoded
constants.

**Specs**: `specs/providers.md` G3-G6, Mechanism "exe.dev managed gateway
discovery".

**Vectors**: none dedicated (network-dependent, no pure-function vector).

**Hazards**: H6 (two independent timeouts compose — the 5s
`AbortSignal.timeout` derived-context pattern *and* a second, client-level
5s timeout; a port needs both, either alone is not equivalent), H15
(`team` field: absent JSON key and explicit `false` must read identically
— test with `undefined` treated as `false`), adjacent-to-H12 (the
reflection response body has no explicit size limit — bounded only by the
5s timeouts, not bytes; flag but don't necessarily add a cap Go doesn't
have).

**As built**: `discoverExeGatewayBase(signal: AbortSignal, httpClientOpts?:
GatewayHttpClientOpts): Promise<string>`, never throws. The two timeouts
are both realized as `AbortSignal.timeout(...)` members of one
`AbortSignal.any([signal, AbortSignal.timeout(5_000), AbortSignal.timeout(clientTimeoutMs)])`
passed to `fetch` — `clientTimeoutMs` defaults to 5000 and is overridable via
`httpClientOpts.timeoutMs`, standing in for Go's caller-supplied `*http.Client`
(both current call sites pass nothing, so the two timeouts coincide in
practice; the seam exists for a caller that someday doesn't). The module-level
test seams became one exported `const gatewayConfig = { exeDevMarkerPath,
reflectionIntegrationsURL }` object with mutable fields, **not** `export let`
bindings — an importing test module cannot reassign a live `export let`
binding (TS rejects it: "Cannot assign to 'x' because it is an import"), but
it can mutate an exported object's properties. This is a new, general pattern
for every future overridable-`var` test seam in the port (`meat.ts`'s
`abridgeBudget`/single-run-byte overrides will need the same shape) — see H17
in `migration/HAZARDS.md`. JSON decoding is hand-validated (`parseIntegrations`)
rather than a bare `as` cast, since Go's `json.Decoder.Decode` treats a
known field with the wrong JSON type (e.g. `"name": 42`) as total decode
failure, not silent coercion or a partial success — an untyped cast would
either crash or silently misbehave on that input instead of returning `""`.
Tests cover all nine algorithm steps from the spec Mechanism section plus a
`globalThis.fetch` spy proving the marker-absent path never reaches the
network, and an explicit `AbortController.abort()` case proving caller
cancellation resolves to `""` rather than rejecting.

---

### 4d. `src/meat/diff.ts`

- [x] **diff.ts**

**Delivers**: **Foundation** — everything downstream reads this and never
re-parses. `splitSourceLines(text)`: split into physical lines + their
exact terminator (`""`/`"\n"`/`"\r\n"`), with the load-bearing
no-phantom-trailing-line guarantee (empty input → zero lines; text with no
trailing newline gets exactly as many lines as there are line bodies,
never one extra). `validateSupportedDiffLines`: the combined-diff
pre-pass (rejects `diff --cc`/`diff --combined`/`@@@` — this runs
*before*, and is the *only* thing that runs, combined-diff gating;
`analyzeDiff` itself performs none). `analyzeDiff(lines)`: the big state
machine classifying every physical line into one of 11 `diffLineKind`
values (header, index, rename/copy from/to, mail signature, old/new file,
hunk header, hunk context/change, no-newline) plus per-line file id, hunk
id, and source language — with several load-bearing decision boundaries
(hunk-header recognition, hunk-source-vs-trailing-file-header
disambiguation via remaining old/new counts, the `+++` line's out-of-band
per-iteration stamping). `numberedDiff(diff)`: the `N|` gutter form,
relying on the no-phantom-line guarantee for its own no-phantom-gutter
guarantee. Language tagging (`diffHeaderLanguage`/`fileMarkerLanguage`/
`pathLanguage`) — a fixed suffix table, double-derived (git-header then
`---`/`+++` pair) but provably non-conflicting in practice.

**Specs**: `specs/diff.md` G1-G5, Mechanism Algorithms 1-7 in full (this is
the single most-depended-on file in the engine — read it end to end, not
just skimmed).

**Vectors**: `diff-layout/` (`analyzeDiff`), `source-lines/`
(`splitSourceLines`), `numbered/` (`numberedDiff`), `validate/`
(`validateSupportedDiff`/`validateSupportedDiffLines`).

**Hazards**: H1 (named explicitly by `migration/HAZARDS.md` as a
concentration point — `splitSourceLines` is the very first byte-consuming
operation in the whole pipeline; represent `sourceLine.text` so every
downstream byte budget measures true UTF-8 bytes, not `.length`), H14
(`fileMarkerLanguage`'s `TrimSpace` before tab-cut), unregistered-but-noted
(`strings.Fields`-equivalent splits on a third, distinct whitespace
definition — only matters for non-ASCII whitespace inside a hunk header,
which real git output doesn't produce). H2/H3/H7/H13 not applicable (no
rune iteration, no regex, no sort, no map, no concurrency in this file).

**As built**: `SourceLine`/`splitSourceLines` are direct aliases of
`bytes.ts`'s `Line`/`splitLines` (already built there against this exact
citation — `diff.ts` never re-implements the split). `DiffLineKind` and
`SourceLanguage` are string-literal unions (`enum` is banned by
`tsconfig.json`), using the exact snake_case names
`meat/conformance_dump_test.go`'s `diffLineKindNames`/`sourceLanguageNames`
maps assign for the vectors (`"hunk_change"`, `"old_file"`, etc.) — not
Go's PascalCase identifiers — since the vectors, not the Go source, are
what the port is graded against. `DiffLayout`'s fields are camelCase
(`fileId`, `hunkId`, `markerOwner`, `languages` — plural, unlike Go's
singular `language`) matching `test/conformance.test.ts`'s
already-written-in-Phase-A field names exactly (that file's own header
calls its shapes "provisional... adjust to match what was actually built,"
but every field name it guessed for this module turned out right, so
nothing there needed changing). `layout.problems` is `string[]`, not
`Error[]` — Go's own `[]error` here holds only plain `fmt.Errorf` leaves,
never `%w`-wrapped, so extracting `.Error()` text once (as the dump test's
own `problems = append(problems, p.Error())` already does) is lossless and
matches the conformance harness's `assert.deepEqual` against a `string[]`
vector directly. `joinEditPlanErrors` (Go: `editplan.go:531-539`) is built
*here*, not deferred to `editplan.ts` — it's `diff.ts`'s own
`validateSupportedDiff` that needs it first (a real forward dependency, the
same shape as elision.ts's — see item 4j), and `diff.ts` is the
earliest-in-order of its six Go call sites (`diff`, `chunk`, `editplan`
×3, `moves`, `python`), so nothing downstream is blocked: `chunk.ts`/
`editplan.ts`/`moves.ts`/`python.ts` will import it from `./diff.ts` when
built. `containingHunk` returns a named `{ start, end }` object, not a
positional tuple — Go callers destructure positionally with `_` for the
unused half; a named object reads better at each future call site
(`imports.ts`/`python.ts`) than a tuple would.

**Discovered — new tsconfig options, not a Go/TS semantic hazard**: this is
the first file with an intra-`src/meat/` import, and it broke `node --test`
even though `tsc --noEmit` was clean — see the "Import-extension gotcha"
note (Notes for future iterations, below) and `migration/TARGET.md`'s
tsconfig section for the fix (`allowImportingTsExtensions` +
`rewriteRelativeImportExtensions`, TS 5.7+). Every future file's relative
imports need the literal `.ts` extension, not `.js`.

---

### 4e. `src/meat/plan.ts` — **NEW, no direct Go source**

- [x] **plan.ts**

**Delivers**: the plan-compilation vocabulary shared by `moves.ts`,
`imports.ts`, `python.ts`, and `editplan.ts`, extracted from
`editplan.go`'s type-definition layer (`meat/editplan.go:20-122`).
**Discovered while starting `moves.ts`**: `editplan.go`'s own orchestrator
(`compileEditPlan`/`compileEditPlanMoves`) calls into `moves.go`/
`imports.go`/`python.go`, while those three files need `editplan.go`'s
`planState`/`lineRange` types (`validateMoveSymmetry`'s `compressionAt`
reads `planState.hidden`/`.folded`/`.folds` directly; every validator in
`python.go` takes a `state planState`/`*planState` parameter; `imports.go`'s
three plan-state-aware functions do too). That is a genuine circular
dependency at the Go-file level — Go's single-package compilation doesn't
care about file order, but a per-file TypeScript module graph does, and
there is no valid linear ordering of `{moves, imports, python, editplan}`
as four monolithic files. Verified by direct grep across every non-test
`.go` file, not inferred from the specs. Fixed the same way `bytes.ts`
already breaks an analogous cycle for the byte-slice layer: a small,
deliberate, documented exception to `migration/TARGET.md`'s "Go packages
map one-to-one" layout rule. Contains: `LineRange` (`{startLine, endLine}`,
1-based inclusive — Go: `lineRange`), `LineReplacement`, `LineFold`,
`PlannedReplacement` (`LineReplacement` + `planIndex`/`start`/`end`),
`PlannedFold` (`LineFold` + `planIndex`/`marker`/`indent`/`eol`),
`PlanState` (`hidden`/`folded`/`foldAt`/`folds`), `newPlanState(lines)`,
`planStateRepresented(state, line)` (Go: `planState.represented` method),
`applyPlannedReplacements(body, edits)` (right-to-left splice; caller must
pre-sort `edits` ascending by `.start` — this function does not sort, same
as Go), `leadingWhitespace(s)` (the shared primitive H16 already flagged as
underlying *both* incompatible indentation-width conventions used by
`imports.ts`/`python.ts`/`editplan.ts`/`moves.ts`).
`editplan.ts` (built later, in its now-corrected slot) keeps everything
else `editplan.go` has: `compileEditPlan`/`compileEditPlanMoves` itself,
`prepareFold`, `validateSummary`, `validateSingleLineText`, the
elision-projection compiler, `commonPrefix`, and so on — this file is
*only* the shared vocabulary, never orchestration logic.

**Specs**: none dedicated (this file has no corresponding Go source).
Cross-reference `specs/editplan.md`'s Mechanism section (these types are
documented there as part of `editplan.go`) and `specs/moves.md`/
`imports.md`/`python.md`'s Hazards sections (H15, H16) for how each field
is consumed downstream.

**Vectors**: none directly — exercised transitively once `moves.ts`/
`imports.ts`/`python.ts`/`editplan.ts` depend on it.

**Hazards**: H15 (`plannedFold.marker` uses Go's zero byte `0` as an
explicit "unset" sentinel — ported as `'+' | '-' | ' ' | null`, never a
falsy check; this hazard note *moves here from `editplan.ts`'s original
entry*, since this file now defines the type), H16 (`leadingWhitespace`
does no width interpretation of its own — callers choose raw-byte-count vs.
tab-expanded-column width on top of it; the two conventions are not
interchangeable, see `migration/HAZARDS.md` H16), H1 (`LineReplacement.old`/
`.new` and every splice offset are bytes, never a decoded string).

**As built**: `PlanState`'s three parallel arrays plus `PlannedFold`/
`PlannedReplacement` are plain mutable structures (not `readonly`), mirroring
Go's mutable slices — `editplan.ts`'s orchestrator will mutate `state.hidden`/
`.folded`/`.folds` in place exactly as `compileEditPlanMoves` does. JSON
wire-format field names (`start_line`/`end_line`, the shape the model
actually submits via `preview_plan`/`submit` tool calls) are **not** this
file's concern — `LineRange`'s `startLine`/`endLine` are the internal
runtime representation only; whichever file parses the model's raw tool-call
JSON (`editplan.ts`, when it builds `editPlan`/`submission`) owns the
snake_case-to-camelCase mapping at that boundary.

**Addendum (while starting `python.ts`)**: added `isIdentifierStart`/
`isIdentifierContinue` (Go: `meat/editplan.go:472-478`) — tiny, pure,
dependency-free ASCII byte-class checks that `python.go`'s
`simpleAssignedReference`/`containsIdentifier` need, and that `imports.go`'s
`isImportOnlyFramingRow` will need too (item 4h). Same rationale as the
rest of this file: shared editplan.go primitives with real forward
consumers, extracted once rather than duplicated per file.

---

### 4f. `src/meat/moves.ts`

- [x] **moves.ts**

**Delivers**: exact, source-evidenced move detection — `detectExactMoves`:
normalize every hunk-source line (marker+leading-indent stripped body,
tab-expanded indent, substantive flag), bucket by normalized text
(occurrences with **exactly 2** entries of opposite polarity form
anchors), extend each anchor bidirectionally under one fixed
per-candidate indent offset, gate by two size thresholds
(`minMoveSubstantiveRows=3`, `minMoveNonspaceBytes=48`), then drop any
pair whose removed or added range overlaps another candidate's. Plus:
`validateMoveSymmetry` (every aligned row pair must have *identical*
5-valued compression state — kept/removed/fold-start/fold-middle/
fold-end — not just the coarser 3-valued kind), `validateMoveReplacementSymmetry`
(local-elision symmetry on kept rows only), `applyMandatoryMovePrecedence`
(one-pass OR-propagate of the mandatory-import mask across move
counterparts — no fixpoint needed since moves are pairwise
non-overlapping by construction), and `formatMovePairs` (the
`-a..b ↔ +c..d` prompt/feedback rendering, capped at `maxMoveHints=12`
with an "and N more" overflow).

**Specs**: `specs/moves.md` (the whole file — 920 lines, dense; G1-G21+
cover detection, symmetry, replacement symmetry, precedence, formatting).

**Vectors**: `moves/` (`detectedMovesInDiff`).

**Hazards**: H1 (`minMoveNonspaceBytes=48` measured as a sum of
individually-measured UTF-8 byte lengths *after* several byte-oriented
transforms — reproduce the exact transform sequence, don't decode to a JS
string and use `.length`), H2 (three sites: the letter-or-number
substantive scan, the non-space byte-length scan — Go's Unicode-space test
is a full-property test, not JS `\s` — and `indentationColumns`'
tab-expansion; also note the trailing-trim in `normalizeMoveLine` is
deliberately **ASCII-literal-only**, a *different* whitespace definition
from the Unicode-space scan two functions later — don't unify them), H7
(both sort sites are live-but-provably-inconsequential — read
`specs/moves.md`'s Hazards section for the actual proof before assuming
you need a tiebreak; the candidate-sort tie is caught by the ambiguity
filter regardless of sort order), H8 (safe — the one arithmetic op,
modulo-8 in `indentationColumns`, is non-negative-only).

**As built**: `DetectedMove`/`MoveLineInfo` etc. import `LineRange`/
`PlanState`/`PlannedReplacement`/`applyPlannedReplacements`/
`leadingWhitespace` from `./plan.ts` and `SourceLine`/`DiffLayout`/
`isHunkSource`/`splitSourceLines`/`analyzeDiff`/`joinEditPlanErrors` from
`./diff.ts` — no forward references remain. `moveCompression`'s 5 values
and `moveCompressionKind`'s 3 are string-literal unions (`"kept" |
"removed" | "fold_start" | "fold_middle" | "fold_end"`, etc.), matching the
project's `enum`-ban convention. `validateMoveSymmetry`/
`validateMoveReplacementSymmetry` throw (H5) rather than returning an
error value, joining multiple problems via `diff.ts`'s
`joinEditPlanErrors`. Go's map-keyed dedup (`map[detectedMove]struct{}`,
`map[moveAlignment]detectedMove`) became `Map<string, DetectedMove>` keyed
by a composite string built from the same fields Go's struct-equality key
used — insertion order differs from Go's randomized map order, but both
the anchor list and the candidate list are explicitly sorted immediately
after (matching Go), and H7's proof (both ties are either unreachable or
always caught by the ambiguity filter) means the final result is
order-independent regardless. Occurrence bucketing needed a `Uint8Array`
map key with byte-exact (not Unicode-normalized) equality; added a small
private `byteKey` helper (Latin-1-style 1:1 byte↔code-unit mapping, used
only for hashing, never for text semantics) rather than risking a UTF-8
decode throwing on invalid sequences mid-detection.

**Discovered — generalized, not moves.ts-specific**: `bytes.ts` gained
`arrayAt<T>(arr, i): T`, the non-byte-array equivalent of `at`/`slice`, and
`diff.ts` was retrofitted to use it instead of a private `need` helper —
see "Notes for future iterations" below. Also fixed a real bug in
`test/conformance.test.ts`'s "provisional" `moves/` vector comparison: it
called `.map` unconditionally on the vector JSON, but Go's nil
`[]detectedMove` marshals as JSON `null` (H9) for 3 of the 9 corpus
entries, which crashed rather than comparing against an empty list.

---

### 4g. `src/meat/python.ts`

- [x] **python.ts**

**Moved here from 4h** (swapped with `imports.ts`) — discovered while
starting `imports.ts`: `imports.go`'s `embeddedSourceLines`, called from
the *vector-tested core* of `mandatoryImportRemovalPlan` (not just the
three deferred plan-state functions), calls `python.go`'s
`scanPythonTripleLine`/`pythonTripleState`/`pythonTripleNone` to detect
Python/Java triple-quoted regions. `imports.go`'s three later
plan-state-aware functions need more of `python.go` still
(`trimPythonCode`, `isPythonSuiteHeaderStart`, `pythonSuiteHeaderEnd`,
`hasPythonBodyAfter`, `pythonTripleStateBeforeLine`). Verified `python.go`
has **zero** dependency on `imports.go` in the other direction (grep for
every `imports.go` symbol name across `python.go`: no hits) — a clean
one-directional forward reference, unlike the moves/imports/python ↔
editplan circular case that needed `plan.ts`. A straight swap resolves it;
see "Notes for future iterations" for the full account.

**Delivers**: Python-aware plan validators layered on top of
language-agnostic `editplan.ts` structural rules — conservative,
text-level (recognize fixed syntactic signatures, never actually parse
Python; reject on doubt). Core machinery: a 3-state triple-quote state
machine (`scanPythonTripleLine`/`pythonTripleStateBeforeLine`, byte-scan
priority: inside-triple → close-search; else `#` short-circuits the whole
line; else a `'''`/`"""` prefix opens; else an ordinary quote consumes
with backslash-escape skipping — note a `"""` *inside* an ordinary
`'...'`-quoted string is walked as content, never inspected, which is
deliberate and tested). Four validators run in a specific, non-file-order
sequence dictated by `editplan.ts`'s pipeline (see item 4i's Mechanism
§0): `validateHiddenPythonOwners`, `validateHiddenPythonBoundaries`,
`validateHiddenReferences` (a hidden simple-assignment target can't be
hidden while another retained line in the file still references it),
`validatePythonSuiteSkeleton`. Plus: delimiter-balance tracking
(`pythonDelimiters`, independent per bracket kind, clamped non-negative to
survive leading context that closed a bracket above the hunk),
backslash-continuation detection, and boundary-token preservation
(`changesPythonBoundaryTokens` — a replacement must not change the count
of `(`/`)`/`[`/`]`/`{`/`}`/`'''`/`"""`).

**Specs**: `specs/python.md` (1201 lines — the longest single spec; read
in full, especially §0's exact pipeline-ordering table since
`editplan.ts` depends on this file being called in a very specific
sequence with two *different* state objects — raw `state` vs. the
deep-copied `pythonValidationState`).

**Vectors**: none dedicated — exercised indirectly through
`plan-compile/`'s three Python golden fixtures (this is the hard gate;
`python.ts` bugs will surface there, not in a dedicated vector). **Now
also exercised transitively by `imports/`'s vectors** (item 4h), since
`embeddedSourceLines` calls into this file's triple-quote scanner for
every hunk.

**Hazards**: H1 (pervasive and exclusive — zero rune-range loops anywhere
in this file; port every scan as a direct byte-index port with no
adjustment — including the backslash-escape `i+=2` skip, which is
correct *because* it's byte-oriented, not despite it — do not "fix" it
into a rune-aware skip), H2 confirmed **not applicable** (contrast
`editplan.ts`/`moves.ts`, where it's real), H14 (six `TrimSpace` sites,
none currently fixture-exercised at the U+0085/U+FEFF boundary but all
need the explicit Go-matching trim helper from item 1), H15 (the
`state: *planState` nil/non-nil distinction on three helper functions is
two semantically-distinct meaningful states, not an optional value — port
as `PlanState | null`, not an optional parameter; `PlanState` itself
imports from `./plan.ts`, item 4e), H16 (five specific raw-byte-count
indentation sites, re-verified against current line numbers in the spec —
consistent with `imports.ts`/`editplan.ts`, built on `plan.ts`'s shared
`leadingWhitespace`).

**As built**: entirely byte-oriented (`Uint8Array` throughout) with **no
regex** — unlike `imports.ts` next, every Go string operation here
(`strings.Index`/`HasPrefix`/`HasSuffix`/`TrimSpace`/`Split`/`IndexByte`)
has a direct byte-level equivalent already in `bytes.ts`, so H1 needed no
compromise. Go's `*pythonTripleState` out-parameter (mutated through a
pointer by `scanPythonTripleLine` and `pythonDelimiterBalanceWithState`,
threaded across dozens of hand-written loops) became a small mutable
`PythonTripleStateRef { value }` wrapper rather than bundling an updated
state into each function's return — deliberately closer to a 1:1 Go port
than a "return the new state" functional style would be, given how many
call sites thread this state and how easy a forgotten-reassignment bug
would be to introduce across that many sites. `pythonSuiteHeaderEnd`'s Go
`(int, bool)` return became `number | null` (`null` = Go's `(0, false)`).
`isPythonSuiteOwner` (Go: `meat/python.go:787-790`) was **not** ported —
confirmed dead code (grep the whole Go repo: only its own definition
matches, no production or test call site), and the spec's own Open
questions section explicitly sanctions dropping it. Two more `editplan.go`
primitives this file needs (`isIdentifierStart`/`isIdentifierContinue`)
were added to `plan.ts` rather than duplicated — see that item's addendum.

---

### 4h. `src/meat/imports.ts`

- [x] **imports.ts**

**Delivers**: the mandatory (compiler-owned) import-removal mask —
`mandatoryImportRemovalPlan(lines, layout)`, a pure function of the
parsed diff with no plan-state dependency for its *initial* computation.
Per hunk, per side (`-` then `+`): build the side's line sequence,
classify it via a per-language import-statement-end scanner (18 regexes
across Go/Python/JavaScript/Rust/C/Java — see the per-language table
below), expand whole import-only Python guard suites, fill blank gaps
between hidden runs. Recombine sides: `-`/`+` markers use their own side's
verdict; context (` `) hides only when **both** sides independently agree
— this asymmetric-vs-symmetric split is what lets a unilateral import
change hide on its own side while shared context needs consensus. Then:
full-hunk collapse (an entire hunk hides if every non-import change row is
"framing"), no-newline-marker propagation via `markerOwner`, and full-file
collapse. Three later functions take a `*planState` because they run
*after* a plan is merged: `addMandatoryPythonSuitePlaceholders`,
`stateWithMandatoryImportsRepresented`, `completeMandatoryImportFraming` —
port these as part of this file even though they're plan-state-aware,
since they're `imports.go`'s own functions, called from `editplan.ts`
(item 4i) at specific pipeline points. `PlanState` and `planStateRepresented`
import from `./plan.ts` (item 4e); `python.ts` (item 4g, now built first —
see its entry) supplies the triple-quote scanner `embeddedSourceLines`
needs and the suite/body helpers the three deferred functions need.

**Specs**: `specs/imports.md` (987 lines — the full per-language regex
table under Mechanism is required reading, not skimmable; also
`migration/HAZARDS.md`'s "Special attention" section calls this file out
by name for budgeting extra iterations).

**Vectors**: `imports/` (`mandatoryImportRemovalPlan`).

**Hazards**: H1 (named concentration point — every classification decision
indexes raw bytes; ASCII-anchored throughout, so position-safe under a
consistent byte scheme), H3b (**the single largest `\s` concentration in
the codebase** — 18 patterns at ~742-762 in the Go source, every `\s`
token means `[\t\n\f\r ]`, not JS's wider `\s` — rewrite every one
explicitly when porting each regex), H3a not applicable (no pattern here
is assembled from untrusted text — every regex is compiled once,
module-level), H3c inert (the one capturing regex's match never feeds
further byte-offset arithmetic), H2 not applicable (zero rune iteration
in this file — contrast `moves.ts`), H7/H13 not applicable (no sort, and
its two maps are only ever key-looked-up, never ranged over), H16
(raw-byte-count indentation convention, consistent with `python.ts` and
`editplan.ts`, distinct from `moves.ts`'s tab-expanded columns — do not
unify).

**As built**: the source file (`src/meat/imports.ts`) was already written and
`tsc --noEmit` clean going into this iteration, but had no test file and
wasn't ticked — finishing it this iteration meant verifying it, not writing
it from scratch. Verification: every one of the 18 regexes
(`meat/imports.go:742-762`) was diffed character-by-character against its
`RE_*` counterpart, confirming each `\s`→`[\t\n\f\r ]` rewrite (H3b) and each
`(?s)`→`s`-flag translation is exact; the per-language statement-end
scanners, the embedded-source state machine, and the two Python
plan-state-aware functions' control flow were hand-traced against
`meat/imports.go` line-for-line. `test/meat/imports.test.ts` ports every
pure-function guarantee from `meat/imports_test.go` that doesn't require
`editplan.ts` (G7-G16, G22 — 24 tests): since every ported Go test compiles
against `editPlan{}` (no model edits), `mandatoryImportRemovalPlan`'s hidden
mask alone determines `compiled.smartDiff`'s content, so each Go
`want`/`unwanted` substring check translates losslessly to "the physical
line containing this substring is/isn't hidden." G17-G21 (merge with model
plans, `preview_plan`/`submit`, refinement fallback) need `editplan.ts`/
`tools.ts`/`meat.ts` and are deferred to those items' own test files. The
three plan-state-aware functions (`addMandatoryPythonSuitePlaceholders`,
`stateWithMandatoryImportsRepresented`, `completeMandatoryImportFraming`) have
no Go test coverage at all (`specs/imports.md`'s own Open questions call two
of them "untested directly") — added 6 hand-built direct unit tests derived
from Algorithms 8-10's Mechanism description instead of a fixture port,
seeding `PlanState` the way the real pipeline does (mask seeds
`planState.hidden` before any model op runs). All 38 new tests passed on the
first run with zero fixes needed to `imports.ts` itself — the implementation
was correct as found.

**Conformance harness bug fixed, not in `imports.ts`**: 5 of 9 `imports/`
vectors (`*.live`/`*.original`, the corpus entries with no mandatory
imports) were failing with `Cannot read properties of null (reading 'map')`
— the same H9 (`nil` slice → JSON `null`) bug item 4f already found and
fixed for the `moves/` describe block, but not yet applied to `imports/`'s.
Fixed identically in `test/conformance.test.ts`'s `imports/` block: `?? []`
on the vector read. All 9 `imports/` vectors pass now.

---

### 4i. `src/meat/editplan.ts` — **Core**

- [x] **editplan.ts**

**Delivers**: `compileEditPlan` — the compiler from a proposed edit plan to
the rendered reading diff. This is the file the port is ultimately graded
against (the Python golden vectors are byte-exact against its output).
`LineRange`/`LineReplacement`/`LineFold`/`PlannedReplacement`/`PlannedFold`/
`PlanState`/`newPlanState`/`planStateRepresented`/`applyPlannedReplacements`/
`leadingWhitespace` are **not** built here — they moved to `plan.ts` (item
4e) when starting `moves.ts` revealed this file's orchestrator and its own
type layer have a circular dependency at the file level (see item 4e's
entry and "Notes for future iterations"); import them from `./plan.ts`
rather than redefining them. What's left for *this* file: the actual
`compileEditPlan`/`compileEditPlanMoves` orchestrator (the 12-step
pipeline — `specs/editplan.md` §0: parse + layout, move-set resolution,
mandatory-import computation, `planState` init seeded from the mandatory
mask, remove-range application, fold prep/application, **Gate A** (only if
removals+folds valid: placeholder synthesis, move symmetry, all 4 Python
validators), replace validation (always runs, ungated), **Gate B**
(move-replacement symmetry — the *most* conservatively gated check,
requires zero problems so far), **Gate C** (triple-quote parity, delimiter
balance, backslash continuations, import framing completion,
retained-structure validation), aggregate-and-fail, render loop,
`computePlanStats`), plus `prepareFold`, `validateSummary`,
`validateSingleLineText`, `uniqueSubstringIndex`, `commonPrefix`, and the
elision-projection compiler (`compileElisionProjection`/
`isElisionProjection`/`isComposedElisionProjection`/
`matchesElisionProjection` — **H3a's central site**, port as a literal
two-pointer scan per the spec's "Equivalence argument for the port," not as
a regex, ever; `elision.ts`, item 4j, depends on this). Get the three
gates' exact conditions right — an invalid remove/fold suppresses nearly
the entire rest of the file's validation surface (see the
"Cost/completeness consequence of Gate A" note in the spec).

**Specs**: `specs/editplan.md` (733 lines, all of it — this is the core
file; every §-numbered Mechanism section matters, especially §0 the
pipeline order, §1 the elision-projection equivalence argument, §7 the
fold-before-hidden render-order invariant).

**Vectors**: `plan-compile/` — **the hard gate**, byte-exact against the
three checked-in golden files (django/flask/pytest, 6,685/5,037/2,615
bytes respectively per `meat/testdata/python/README.md`). This is the
vector every other engine item's correctness ultimately feeds into.

**Hazards**: H1 (saturates the file — every offset/range/budget is
byte-indexed; the *only* rune-iterating constructs are `leadingWhitespace`
(ASCII-safe), the elision-projection tokenizer's `new`-string walk, and
`validateSingleLineText`'s control-character scan), H2 (the tokenizer's
`new`-string side is genuinely rune-aware — must recognize `…` U+2026 and
count codepoints; the `old`-matching side is byte-wise, never
rune-decoded — port asymmetrically, matching this exactly), H3a (central
— see above), H5 (`%w`-wrapped replace errors — verified unreachable via
`errors.Is`/`errors.As` in practice, consumed as message text only, but
port the wrap chain anyway for fidelity), H7 (live-but-provably-caught —
sort ties on replacement-overlap always get caught by the adjacent-pair
check regardless of sort stability; which `planIndex` a tied pair *names*
in its error message may differ from Go, don't test-pin that), H9 (not
meaningfully applicable — nil vs. empty `Remove`/`Replace`/`Fold` iterate
identically), H13 (a second application site beyond `openai.ts` — the
`replacements` map, ranged over for the overlap check; if 2+ *different*
physical lines each have their own overlap problem, their relative error
order is unspecified in Go and untested — a deterministic port producing
a fixed order is fine, not a correctness risk), H15 (`plannedFold.marker`
uses Go's zero-byte `0` as an explicit "unset" sentinel — port with an
explicit `'+' | '-' | ' ' | null`, not a falsy check), H16 (fold-indent
computation via `commonPrefix` — raw-byte-count convention; a single
mismatched leading byte across fold lines silently truncates the common
indent to empty, not merely a width-interpretation difference — this is a
real, silent behavior to preserve, not fix).

**As built**: the wire-facing `EditPlan`/`Submission`/`EditPlanReplacement`
types carry `replace[].old`/`.new` as plain JS `string` (the JSON-decoded
shape `test/conformance.test.ts`'s `plan-compile` runner and a future
`tools.ts` both hand in) — converted to `Uint8Array` via `encodeUTF8` at the
exact point of use inside `compileEditPlanMoves`, never earlier and never
decoded back. This is distinct from `plan.ts`'s `LineReplacement`, which is
the already-byte-converted internal shape `plannedReplacement` embeds; only
`remove`/`fold` reuse `plan.ts`'s `LineRange`/`LineFold` directly, since
those are numeric-only and need no boundary conversion. `smartDiff` is
`Uint8Array` (H1), not a string — the three `plan-compile` conformance
vectors (django/flask/pytest) pass byte-for-byte (`conformance/vectors/
plan-compile/`), and `test/meat/editplan.test.ts` ports all 48 of
`editplan_test.go`'s 50 Go tests that don't require a not-yet-built module.
The two deferred: `TestAbridge_AcceptsGitFormatPatch` needs `Abridge`/
`scriptedModel` (item 4n `meat.ts`) and `TestApplyEditPlan_
GitHunkLinesThatResembleFileHeaders` needs `ElisionLine` (item 4j
`elision.ts`) plus a real `git diff --no-index` subprocess — port each
alongside its dependency, not here. `TestNumberedDiff` was already ported in
`diff.test.ts` (item 4d) since `numberedDiff` lives in `diff.ts`; not
re-ported. The elision-projection matcher (`compileElisionProjection`/
`matchElisionLiterals`) is the literal two-pointer scan H3a mandates — zero
regex construction anywhere in this file, verified by the 9-case
`isElisionProjection` table (including the `"...…"` adjacent-placeholder
rejection and the four-dot-run-is-literal-not-wildcard case) plus the golden
vectors, which exercise it transitively on real model-shaped `old`/`new`
pairs. `isComposedElisionProjection` is ported and exported but — as the
spec's Open Questions already flag — has zero call sites, matching Go
exactly (dead code kept for fidelity, not wired to anything).

---

### 4j. `src/meat/elision.ts`

- [x] **elision.ts**

**Delivers**: `ElisionLine(raw, abridged)` — the one-line "kept X/Y changed
lines in A/B files" manifest, computed by aligning the abridged diff back
onto raw physical-line positions. Two counting algorithms:
`diffStats(diff)` (denominator: count `diffLineHunkChange` and
`diffLineHeader` kinds) and `retainedDiffStats(raw, abridged)` (numerator:
walk kept lines left-to-right, matching each via an **exact** lookup
— a forward-built, by-construction-sorted index — or a **projection**
match via the shared elision-projection compiler in non-strict mode,
never re-matching an already-consumed raw position; fixed-fold lines
short-circuit entirely, crediting one row without alignment). Format
selection is a 4-branch decision tree in `specs/elision.md` Mechanism
"`ElisionLine`'s format selection" — get the exact branch order right
(steps 1-2 run unconditionally before the early-return check). Note: this
file's alignment key deliberately omits the line terminator (CRLF vs LF is
cosmetic for matching purposes).

**Moved here from its original slot (4d, then briefly 4i before `plan.ts`
was inserted ahead of it)** — depends on `editplan.ts`'s (item 4i)
`compileElisionProjection`, so it cannot build until that file exists. See
"Notes for future iterations" for the discovery. `diff.ts`/`plan.ts`/
`moves.ts`/`imports.ts`/`python.ts`/`editplan.ts` do not depend on
`elision.ts`, so nothing was blocked by deferring it this far.

**Specs**: `specs/elision.md` G1-G13 (13 guarantees, dense — read every one;
the alignment algorithm's edge cases, esp. G6/G8's "forward-only, leftmost
wins" and G9's performance guard, are easy to get subtly wrong), Mechanism
in full.

**Vectors**: `elision/` (`ElisionLine`, exported).

**Hazards**: H1 (byte-marker indexing at fixed offsets 0/1 — ASCII-safe,
port directly onto the byte buffer, don't decode to string first), H2
(boundary only — calls into `editplan.ts`'s elision-projection compiler,
which is genuinely rune-aware), H3a/c (boundary — same compiler call,
H3a's catastrophic-backtracking risk applies here too since this file's
own scan is bounded but each candidate needs a full pattern-match test),
H7 (`sort.SearchInts` equivalent needed — a binary search over an
index list that is sorted *only by construction*, never validated —
preserve the single-ascending-forward-pass construction order, not just
the binary search itself), H14 (two `TrimSpace` sites: "elided all" vs.
kept-count branch selection, and fixed-fold-line detection).

**As built**: `ElisionLine(raw: Uint8Array, abridged: Uint8Array): string` —
bytes in (H1, matching how every upstream `diff.ts`/`editplan.ts` function
already takes `Uint8Array`), plain `string` out, since the manifest is
always pure-ASCII template text built from decimal counts, with no further
byte-level processing downstream. `diffStats`/`retainedDiffStats`/
`readingLineKey`/`nextReadingLineAtOrAfter`/`containsElisionPlaceholder`/
`isFixedFoldLine` all stay module-private, matching Go's unexported surface
and this codebase's established convention (`editplan.ts`'s `validateSummary`
is the precedent) of testing private helpers only indirectly through the
public entry point — `TestElisionLine_FileHeadersNotCounted`'s direct
`diffStats(rawTwoFiles) == (5, 2)` check is ported as an equivalent identity
check (`ElisionLine(rawTwoFiles, rawTwoFiles) === "kept 5/5 changed lines in
2/2 files"`), since a wrong `diffStats` count would fail that assertion too.
`compileElisionProjection` and `matchElisionLiterals` were **exported from
`editplan.ts`** (both were module-private until now) since Go's
`elision.go:86` calls `compileElisionProjection` directly — not through
`isElisionProjection`/`isComposedElisionProjection` — compiling it once per
kept line and reusing the compiled literals across every candidate raw line
in the bounded scan; calling the existing exported wrappers instead would
have recompiled the pattern once per *candidate row*, silently reintroducing
the O(n²) recompilation cost G9's scalability guard exists to rule out. The
binary search (`nextReadingLineAtOrAfter`) is hand-written (no JS stdlib
equivalent to `sort.SearchInts`, per H7's register entry). All three
`elision/` conformance vectors pass byte-for-byte, and
`test/meat/elision.test.ts` ports all 11 of `elision_test.go`'s tests
(G9's scalability guard runs unconditionally — no Go `testing.Short()`
equivalent gate — and completed in ~60ms locally, comfortably inside the
2-second ceiling). The other Go test this item was blocking,
`TestApplyEditPlan_GitHunkLinesThatResembleFileHeaders` (deferred at item
4i for exactly this dependency), is now ported into `editplan.test.ts`,
skipping itself via `t.skip()` if `git` isn't on `PATH` (mirroring Go's
`exec.LookPath` skip) rather than failing the suite in a minimal
environment.

---

### 4k. `src/meat/chunk.ts` — **Core**

- [x] **chunk.ts**

**Delivers**: `splitDiffForAbridging` + `abridgeChunked` — splitting an
oversized diff at file → hunk → sub-hunk boundaries, each chunk abridged
independently, then merged. Read `specs/chunk.md` §1 first (the Go
source's own header comment, quoted in full in the spec) — it states the
exact design costs the port must preserve, not fix: judgment locality is
real and accepted (the model reasons over one chunk at a time; cross-chunk
Python reference validation and move enforcement are real, documented
gaps, not bugs). Setup computes three whole-diff analyses **once**, before
any cut, never re-derived per chunk: the mandatory mask (+move-precedence
extension), string-interior/no-newline tracking (a cut must never land
inside), and moves (per-chunk runs skip move *detection* entirely — the
splitter maps the whole-diff move set into each chunk's own coordinates
for enforcement only). Splitting is a three-level escalation (file
section → hunk run → synthesized sub-hunk segment), each tried only when
the previous level couldn't avoid a cut. `unitEnd`'s atomic-unit
boundary — no-newline/inString absorption plus Python-owner absorption
(recursing through nested decorator→def→if chains, stopping at the first
non-owner body row) — is the mechanism that keeps a cut from landing
mid-string-literal or mid-suite-header. `mapMovesToChunk` translates
whole-diff move coordinates into chunk-local coordinates, rejecting
(dropping enforcement for) any move whose sides aren't both contiguous
within the same chunk.

**Specs**: `specs/chunk.md` (894 lines — the longest, densest Mechanism
section of any engine file; read all 15 numbered subsections, not just a
skim — `migration/HAZARDS.md`'s "Special attention" section calls this
file out for the same reason).

**Vectors**: `split/` (`splitDiffForAbridging` @ 2/4/8/16 KiB budgets —
small budgets force real splits), `fits-single-run/` (`fitsSingleRun`).

**Hazards**: H1 (all budgeting arithmetic is byte-length-based — prefix
sum arrays exist specifically to keep the splitter linear, not quadratic;
a port that rescans a span's bytes per candidate cut point is a real
algorithmic regression, not just a style choice), H5 (`chunkError` — a
pure label-splice, never a new message; `Unwrap` alone must suffice for
both `errors.Is`-equivalent and `errors.As`-equivalent lookups), H6 (the
same `ctx`/signal threads through every sequential per-chunk run — a
cancellation aborts whichever chunk is running and blocks any subsequent
chunk from starting), H15 (`sectionID`/`origins`'s `-1` sentinel — port
with an explicit tagged union or `number | null`, `-1` is truthy in JS
and a careless falsy check will misbehave), H7/H8/H13 confirmed **not
applicable** (zero sort calls, zero division operators, and all three
maps in this file are key-lookup-only, never ranged over — contrast
`editplan.ts`'s genuine H13 finding).

**As built — scope split, discovered while starting this item**:
`abridgeChunked` calls `abridgeOne`/`Model`/`Request`/`Result`/
`runOptions`, none of which exist yet (`meat.ts` is item 4n, still ahead in
the ledger) — the same forward-dependency shape `elision.ts` (item 4j) and
`plan.ts` (item 4e) already hit. Unlike those two, the fix here isn't a
reorder or an extraction: `splitDiffForAbridging` and every pure helper it
needs (`fitsSingleRun`, the whole `chunkBuilder` machinery, `stringInteriorMask`,
`splitSection`, `splitHunk`, `unitStats`/`appendUnit`, `placeholderRow`,
`pythonOwnerLine`/`emitsPythonBody`, `synthHunkHeader`/`gapAdjustedStart`,
`parseHunkHeaderForSplit`/`parseHunkStart`) have **zero** dependency on
`meat.ts` at all — confirmed by grep: they only call into `diff.ts`,
`plan.ts`, `imports.ts`, `moves.ts`, and `python.ts`, every one already
built. Only `abridgeChunked` itself needs `abridgeOne`. So this item ports
everything **except** `abridgeChunked` — and, since they have no test
coverage independent of it (every `TestAbridge_Chunked*` Go test and
`TestRequestStaysPositionalCompatible` need a scripted-model harness),
`mapMovesToChunk`, `chunkError`, `firstLineText`, `pieceContainsLine`, and
`stripReplicatedMeta` move to `meat.ts` too, alongside their one caller —
item 4n's own entry has been updated to say so. This is a **narrower**
split than elision.ts's: nothing here was reordered in the ledger, and
nothing was extracted into a new file — nearly the entire Go file ports
now; nothing in this codebase treats `chunk.ts` as "done" until 4n's slice
lands too, but the vector-tested and independently-unit-tested surface
(everything `split/`/`fits-single-run/` and `TestSplitDiff_*`/
`TestFitsSingleRun` exercise) is complete and green today.

`DiffChunk.sectionId`/`.origins` entries stay plain `number` with a `-1`
sentinel (never `number | null`), matching `plan.ts`'s existing
`folded`/`foldAt` precedent for the identical H15 shape — every comparison
is `>= 0`/`=== -1`, never a bare truthy check, so the JS-vs-Go
truthiness gap H15 warns about never gets a chance to bite. Two small
Go-private helpers were **exported for reuse**, following the
`compileElisionProjection` precedent from item 4j: `diff.ts`'s `fields`
and `parseGoInt` (needed by `parseHunkStart`, which is chunk.go's own,
deliberately separate hunk-header parser — not a reuse of
`parseHunkCounts`, which the spec's Mechanism §11 confirms is a distinct
function with distinct fallback semantics) and `imports.ts`'s
`countCodeBackticks` (needed by `stringScanState.scan`'s Go/JS backtick
toggle, so the splitter's cut-avoidance mask never disagrees with
`embeddedSourceLines`'s own backtick tracking). `synthHunkHeader` returns
`Uint8Array`, not a plain string — a hunk's trailing heading text (e.g. a
function signature) is arbitrary diff content and can contain non-ASCII
bytes, and the header's byte length feeds directly into `splitHunk`'s
fits-check (H1). All 16 `TestSplitDiff_*` Go tests plus `TestFitsSingleRun`
are ported in full to `test/meat/chunk.test.ts`; three of those Go tests
are two-part (a `splitDiffForAbridging`-only structural half plus an
`Abridge`-based end-to-end half) and port only their structural half here,
with the end-to-end half's deferral noted inline and in the test file's own
header comment: `TestSplitDiff_ImportBlockNeverSeveredOrLeaked` (G10 ported,
G11 deferred), `TestSplitDiff_InterleavedSideStringInteriorAtomic` (deferred:
the changed-row match against a real agent-loop run), `TestSplitDiff_
PythonContinuationsAtomic` (G39 ported, G40's in-chunk rejection deferred).

---

### 4l. `src/meat/rubric.ts`

- [x] **rubric.ts** (partial — see "As built"; remainder owned by item 4n)

**Delivers**: the system prompt literal and the protocol version —
`abridgeProtocolVersion`/`systemPrompt`, the two pieces of this file with
zero dependency on anything not yet built. `promptSurface()`/`RubricHash()`
— the complete, enumerable, hashable model-visible surface — are specified
here but **built as part of item 4n** (see "As built"). For the record,
`promptSurface()` concatenates a fixed sequence of 10 fragment groups
(protocol version, system prompt, 4 user-prompt renderings covering the
moves/tools branches, the nudge text, every tool's schema text for both
toolbox configurations, an overflow-phrasing rendering, plan-feedback
strings for both pressure phrasings, and two oversize-preview/submit
round-trips) through the **real** production builders — never a separate
manifest — joined by a single `0x00` separator byte (none before the first
fragment, none trailing). `RubricHash()` = first 8 bytes of SHA-256 over
the UTF-8 bytes of that surface, hex-encoded. The three internal
self-checks (fixture plan round-trips) fail via **throw**, not a returned
error/rejection — since `RubricHash()` runs unconditionally on every CLI
invocation's cache-key path, a broken fixture must crash the whole CLI in
the port too, not log a warning.

**Specs**: `specs/rubric.md` G1-G12, Mechanism in full (the exact fragment
order and separator convention is what G6's pinned hash depends on —
get the byte-for-byte sequence right, including which fields are
deliberately excluded from the surface, e.g. plan-rejection error text).

**Vectors**: `rubric-hash.txt` (`RubricHash`), `prompt-surface.txt`
(`promptSurface`) — both deferred to item 4n, since both need
`promptSurface()`. `protocol-version.txt` (`abridgeProtocolVersion`) is
green today. Matching `rubric-hash.txt` is still the single highest-value
conformance check in the project (per `migration/CONFORMANCE.md`) once 4n
lands: it certifies the entire model-visible surface survived
byte-for-byte.

**Hazards**: H1 (critical — `RubricHash` hashes the UTF-8 byte encoding of
the surface; feed SHA-256 true UTF-8 bytes, not a UTF-16-derived view, or
digests diverge on any non-ASCII fragment), H4 (each tool's JSON schema
enters the hash as literal source bytes, never re-serialized — a port
that parses and re-stringifies `InputSchema` before hashing will reorder
keys/whitespace and break hash comparability), H8 (one integer division,
`maxToolOutput / 8` — divides evenly today but must still truncate, not
float-divide), H7/H13 confirmed not applicable (every loop ranges a slice
literal or int counter, never a map). **New hazard found while starting
this item, not yet in `migration/HAZARDS.md`**: Go's raw string literal
(backtick-delimited) performs **zero** escape processing — every backslash
in `systemPrompt`'s source text is literal. A JS/TS template literal DOES
process backslash escapes. `systemPrompt` has exactly one line containing
backslashes (a worked example showing the Python string literals `"a\\nb"`
and `"a\nb"` as prose, `meat/rubric.go:294`) — a naive copy-paste produces
a *different*, silently-wrong string (one backslash where Go has two; an
actual newline byte where Go has a literal backslash+`n`). Ported by
byte-for-byte comparison against the Go source at build time (see "As
built"), not by eyeballing the diff. Registered as **H18** in
`migration/HAZARDS.md` (Go raw string vs. JS template literal escape
semantics) — check it before porting any other file with a raw-string
literal containing a backslash.

**As built — scope split, discovered while starting this item**:
`promptSurface()` renders the model-visible surface through the **real**
production builders (per its own doc comment, `meat/rubric.go:52-55`) —
meaning it calls `buildUserPrompt`/`Request`/`runOptions`/`noToolCallNudge`
(`meat.ts`, item 4n — none of which exist yet) **and**
`toolbox`/`previewPlan`/`submit`/`planFeedback`/`truncateForTool`/
`compiledPlan`/`planStats` (`tools.ts`, item 4m — also not yet built). This
is a genuine two-way dependency, sharper than `elision.ts` (item 4j) or
`chunk.ts` (item 4k) hit: `meat.ts` itself needs `systemPrompt` from *this*
file (`abridgeOne` passes it to `model.Generate`, `meat/meat.go:167`), so
`rubric.ts` cannot simply be reordered after `meat.ts` either — confirmed
by grepping every cross-reference between `rubric.go`/`meat.go`/`tools.go`:
`tools.go` has zero dependency on `rubric.go` in either direction (so
`tools.ts`, item 4m, is unaffected and fully buildable on its own), but
`rubric.go`↔`meat.go` is a real cycle. The only content with zero
dependency in either direction is `abridgeProtocolVersion` and
`systemPrompt` — ported now, unblocking `meat.ts`.
`promptSurface()`/`RubricHash()` and their canonical fixtures
(`surfaceFixtureDiff`, `surfaceFixtureNoMoveDiff`, `surfaceOverflowDiff`,
`surfaceOversizeDiff`) will be **added to this same file** as part of item
4n, once both `tools.ts` and `meat.ts`'s own pieces exist within that
iteration — mirroring exactly how `chunk.ts`'s `abridgeChunked` moved to
item 4n last iteration. Item 4n's own entry has been updated to say so.
Whether the addition needs a genuine circular `rubric.ts` ↔ `meat.ts`
import (both cross-references are inside function bodies invoked long
after module evaluation, which Node's ESM live-binding semantics should
tolerate — `systemPrompt` is a plain literal with no import-derived
computation, and `promptSurface()` isn't called until `RubricHash()` is,
well after both modules finish loading) or needs its own `plan.ts`-style
extraction is an **open question for item 4n to resolve** — it cannot be
tested either way until `meat.ts` exists to import from.
`test/meat/rubric.test.ts` ports the `systemPrompt`-only slice of
`TestPromptSurfaceStaysFrozen` (the G1 banned-vocabulary scan and G2's
required-guidance check, both evaluated against the bare constant); the
full frozen-surface scan (user prompt, tool descriptions, nudge,
plan-feedback) and `TestRubricHashPinned` (G4-G6) are deferred to item 4n
alongside `promptSurface()` itself. `systemPrompt` was verified
byte-for-byte identical to `meat/rubric.go`'s raw string content via a
throwaway comparison script (extract the Go source's literal backtick
span, import the built TS module, compare — not committed, same
throwaway-verification approach `bytes.ts`'s item used for Unicode
tables) — this is how the H17 backslash bug above was caught and fixed
before this item was ticked.

---

### 4m. `src/meat/tools.ts`

- [x] **tools.ts**

**Delivers**: the agent's toolbox — `read_file`, `grep` (via `git grep`
subprocess), `preview_plan`, `submit` — confined to the repo root, capped
at `maxToolOutput=16384` bytes per result. Tool advertisement: 2 tools
(`preview_plan`, `submit`) if `root === ""`, else 4 (prepend `read_file`,
`grep`). Path confinement (`resolveInRoot`) — **H10, port verbatim**: a
six-step exact sequence (clean → reject-if-absolute → resolve root →
resolve candidate under the *unresolved* root → require exact-match-or-
prefix-with-separator → return) that deliberately does **not** resolve
symlinks; do not "improve" this with `fs.realpath`, it changes the
security properties. `grep`'s confinement check discards its own resolved
return value — the *unresolved* string is what actually reaches `git` as
a pathspec argument; git resolves it relative to `cwd`. `preview_plan`/
`submit` both use strict decoding (reject unknown fields, reject a second
trailing JSON value) unlike `read_file`/`grep`'s lenient decode. `submit`
gates on `submitSeen` *before* decoding — a second attempt never even
parses its payload. `truncateForTool` — walk back from byte offset
16384 to the nearest UTF-8 rune boundary (H1), never a character-count
truncation; applied selectively, not to every returned string (most fixed
-shape errors are self-bounded and skip it).

**Specs**: `specs/tools.md` (596 lines — read in full; the per-tool
validation-order tables under Mechanism are exact and must be preserved
step-for-step since they determine which error a malformed call gets).

**Vectors**: none dedicated (tool dispatch isn't a pure function reachable
from a fixture — no Go entry point in the catalogue targets it directly).

**Hazards**: H1 (`maxToolOutput` truncation is a byte-offset cut walked
back to a rune boundary — `.slice()` on a UTF-16 string is both the wrong
unit and can still split a codepoint), H6 (scoped to exactly one call
site — the `git grep` subprocess; `readFile`/`previewPlan`/`submit` have
no cancellation path at all, don't wire one in speculatively), H10
(central site — port the six-step algorithm exactly, see above), H12
(`capLines`'s 1 MiB-per-line scanner cap is a documented **exception** to
H12's general "exceeding a cap is an error" framing — here it's silent
truncation with no marker, `sc.Err()` is never checked in Go; reproducing
Node's natural silent-truncation behavior here is *correct*, don't add an
error path Go doesn't have), H14 (`grep`'s empty-pattern check trims via
Go's set, not `.trim()`), H8 (`percent := visibleChanged*100/rawChanged`
truncates toward zero in `planFeedback`).

**As built**: confirmed fully self-contained before starting (grepped
every cross-reference between `rubric.go`/`meat.go`/`tools.go`, per item
4l's "As built" note) — zero dependency on `rubric.ts` or `meat.ts` in
either direction, so this item hit none of the forward-dependency issues
items 4j/4k/4l did. `Toolbox` is a plain mutable-state interface + free
functions taking it as the first argument (`newToolbox`, `tools`, `run`,
`readFile`, `grep`, `previewPlan`, `submit`, `retentionPressure`,
`planFeedback`, `truncateForTool`, `clearSubmission`), matching this
codebase's function-over-class convention (`chunk.ts`'s `ChunkBuilderState`
is the direct precedent) rather than Go's pointer-receiver methods.
`readFile`/`grep` are `async` (Node's `fs/promises`/`child_process`
naturally are); `previewPlan`/`submit` stay synchronous — no `Promise`
anywhere in their bodies — deliberately reinforcing H6's exact claim that
cancellation never reaches them; `run()` is `async` and uniformly
`await`s all four branches (awaiting an already-resolved value is a
no-op in JS, so this costs nothing and keeps the dispatcher's return type
uniform). The strict/lenient decode split (G6/G7/G8) is hand-written —
JS has no `encoding/json`-with-`DisallowUnknownFields` equivalent — but
one Go mechanic came free: `JSON.parse` already rejects any trailing
non-whitespace content after one complete value (verified: both `{"a":1}
extra` and `{"a":1}{"b":2}` throw `SyntaxError`, while `{"a":1}   ` parses
fine), so `decodeStrict`'s second-decode-for-trailing-values trick needed
no port at all — the "multiple JSON values" case is subsumed by ordinary
JSON syntax error handling, confirmed untested by name in Go anyway (only
`"unknown field"` is asserted, G7). `readFile`'s file content and `grep`'s
`git` stdout use a **lenient** (`{fatal: false}`) UTF-8 decode — a
deliberate, narrow exception to this codebase's otherwise-fatal
`decodeUTF8` (bytes.ts) — since Go's `string(data)` does zero UTF-8
validation and a JS `string` cannot represent an arbitrary invalid byte
sequence anyway; documented inline at the point of use, not registered as
a new hazard since it doesn't change any test-observable behavior (no
fixture exercises non-UTF-8 file content, per specs/tools.md's own Open
questions) and the two file-reading/subprocess-output call sites are the
only place it applies. `capLines`' 1 MiB-per-physical-line `bufio.Scanner`
cap (H12) is ported byte-for-byte as its own scan (bytes.ts's `splitLines`
has no such per-line cap, so it could not be reused here) — silent
truncation, no marker, no error, matching Go exactly. All four JSON
schema strings (`preview_plan`, `submit`, `read_file`, `grep`) and
`feedbackPressureHigh` were verified byte-for-byte identical to
`meat/tools.go`'s source via a throwaway extraction/comparison script
(same approach item 4l's `systemPrompt` used) — these matter now only for
`TestSubmitToolUsesEditPlanSchema`'s substring checks, but will matter
byte-exactly once item 4n's deferred `promptSurface()`/`RubricHash()`
hash them. `feedbackPressureHigh`/`feedbackPressureOK` are exported
specifically for that future use (the spec explicitly says
`feedbackPressureHigh`'s text "is a frozen surface consumed by rubric.md's
prompt-hash guarantees — quoted verbatim... not reproduced twice").
`test/meat/tools.test.ts` ports every toolbox-touching Go test that
constructs a `toolbox` directly rather than via `Abridge`/`scriptedModel`
(G1-G2, G5-G9; `TestToolboxGrepAndPathConfinement` needed a real git repo
fixture — ported with the same git-availability `t.skip()` guard as
`editplan.test.ts`'s git-subprocess test) — every other toolbox test in
`meat_test.go` needs `Abridge` and is deferred to item 4n. Also added
direct tests with no Go precedent (this codebase's established
convention, per `bytes.ts`'s own item): `truncateForTool`'s rune-boundary
correctness on a genuinely multi-byte string, `readFile`'s success path
(flagged as an untested-even-in-Go gap in specs/tools.md's Open
questions), and `clearSubmission`.

---

### 4n. `src/meat/meat.ts` — the `Abridge` entry point + agent loop

- [x] **meat.ts**

**Delivers**: `Abridge(signal, model, req)` — the package's one entry
point. Top-level dispatch (fixed gate order, every rejection precedes any
model call): null-model check, empty-diff short-circuit (`"No
changes."`, not an error), oversize check (`maxTotalDiffBytes=4MiB`),
`validateSupportedDiff`, single-run-vs-chunked decision via
`fitsSingleRun`. `abridgeOne`'s per-run turn loop (fixed 9-step order per
iteration, every step's ordering is load-bearing — see
`specs/agent-loop.md` §3): model call, error handling (fallback-vs-error
distinguished by checking the **caller's** un-derived signal, never the
run's own budget-derived one — this is what separates "our own deadline
expired" from "the caller cancelled us"), token accumulation, message
append, tool dispatch, submission/refinement/nudge/continue branching.
The refinement mechanism is a single branch (`canRefine`, 4 conjuncts,
all required) inside step 7, not a separate code path — offered at most
once per run via a latched flag. The fallback mechanism captures
`SmartDiff`/`Summary` frozen at draft-submission time but token counts
stay live, overwritten with the true cumulative total at every read site
— a returned fallback's token counts reflect real spend beyond the draft
turn even though its diff content doesn't.

**Also delivers `abridgeChunked` and its private helpers** (`mapMovesToChunk`,
`chunkError`, `firstLineText`, `pieceContainsLine`, `stripReplicatedMeta`) —
moved here from item 4k (`chunk.ts`) when that item discovered
`abridgeChunked` needs `abridgeOne`/`Model`/`Request`/`Result`/`runOptions`,
none of which exist before this item. `chunk.ts` already delivers
`splitDiffForAbridging`/`fitsSingleRun` and every pure splitting helper
`abridgeChunked` calls (`DiffChunk`, `maxTotalDiffBytes`); this item imports
those and adds the merge step on top — see item 4k's "As built" note for
the full dependency trace. Port every `TestAbridge_Chunked*` Go test
(`meat/chunk_test.go`) and `TestRequestStaysPositionalCompatible` alongside
this slice, plus the deferred second halves of `TestSplitDiff_
ImportBlockNeverSeveredOrLeaked`, `TestSplitDiff_
InterleavedSideStringInteriorAtomic`, and `TestSplitDiff_
PythonContinuationsAtomic` (see `test/meat/chunk.test.ts`'s header comment).

**Also delivers `promptSurface()`/`RubricHash()`** — added to
`src/meat/rubric.ts` (item 4l), not a new file, once `tools.ts` (item 4m)
and this item's own `buildUserPrompt`/`Request`/`runOptions`/
`noToolCallNudge` all exist. `rubric.ts` already delivers
`abridgeProtocolVersion`/`systemPrompt` (everything with zero forward
dependency); see item 4l's "As built" note for the full two-way-dependency
trace and the open question this item must resolve first: whether
`rubric.ts` importing from `meat.ts` (for `buildUserPrompt`/etc.) while
`meat.ts` imports `systemPrompt` from `rubric.ts` works as a genuine
circular ES module import (both usages are function-body-only, well after
module evaluation — plausible but unverified) or needs its own
`plan.ts`-style extraction. Port `surfaceFixtureDiff`/
`surfaceFixtureNoMoveDiff`/`surfaceOverflowDiff`/`surfaceOversizeDiff`
(the canonical fixtures) alongside. **Check H18** (`migration/HAZARDS.md`)
if either fixture-builder or `promptSurface()` itself embeds a raw string
with a backslash. Port the full `TestPromptSurfaceStaysFrozen`
(G1/G2 — `test/meat/rubric.test.ts` already has the `systemPrompt`-only
slice; extend it, don't duplicate it) and `TestRubricHashPinned` (G4-G6 —
note the pinned hex value `441f5e6e28ad3add` is a Go-string-bytes artifact,
almost certainly **not** reproducible by the port; pin the port's own
value instead, per `specs/rubric.md`'s own Open questions). Once this
lands, `rubric-hash.txt`/`prompt-surface.txt` (item 4l's deferred vectors)
should turn green.

**Specs**: `specs/agent-loop.md` (731 lines — G1-G15+, the full turn-loop
Mechanism section is the port's actual control-flow spec; get every
numbered step's order right, several are marked load-bearing (†) in the
spec for a reason), `specs/chunk.md` §13-14 (`abridgeChunked`/
`mapMovesToChunk` Mechanism) and G11/G14-G26/G28/G30/G32-G34/G37-G38/G40/
G43-G46 for the chunking-merge guarantees this slice owns, `specs/rubric.md`
G1-G6 and Mechanism's "`promptSurface()`: what gets hashed, in what order"
section for the fragment-sequence this slice owns.

**Vectors**: none dedicated for the agent loop itself (not a pure function
— no Go entry point in the catalogue targets `Abridge` directly; exercised
end-to-end only via a scripted-model test harness, see item 3's sibling
test work and `specs/test-infrastructure.md`'s "Agent-loop scripted model
harness" section for what the port's own fake `Model` needs to support:
`scriptedModel`, `deadlineFallbackModel`/`callerCancelFallbackModel`
distinguishing internal-deadline vs. caller-cancellation, `modelFunc`).
`rubric-hash.txt`/`prompt-surface.txt` (deferred from item 4l) do apply to
the `promptSurface()`/`RubricHash()` slice this item also delivers.

**Hazards**: H1 (byte-based emptiness/oversize checks — a UTF-16
`.length`/`.trim()` port misjudges both for non-ASCII diffs; the
`%dMB`-truncation in the oversize error must be an exact byte→MiB
truncation via right-shift-equivalent, not rounding), H5 (two sites must
distinguish caller-cancelled from budget-expired — needs two
independently observable abort signals in the port, not one signal
checked twice; **also** `chunkError` inherited from item 4k — a pure
label-splice, `Unwrap`-only error chain, see `specs/chunk.md` §12), H15
(inherited from item 4k: `chunk.sectionId` — plain `number`, `-1`
sentinel, never a bare truthy check — matters again here since
`abridgeChunked` branches on it for metadata dedup), H6 (`defaultMaxTurns`/`defaultBudget` and the
budget/single-run-byte test-injection seams need equivalent overridable
values in the port, not hardcoded constants, or the deadline/fallback
tests can't be ported; the derived-timeout-composed-with-parent pattern
needs `AbortSignal.any` or equivalent), H14 (the empty-diff
`TrimSpace` check — Go-matching trim, not `.trim()`), H15
(`tb.submittedPlan != null` guard is currently-always-true-in-practice
but structurally load-bearing — keep an explicit null check even though a
TS type system might make it look unreachable).

**As built**: found substantially complete on disk at the start of this
iteration — `meat.ts` (Abridge/abridgeOne/runTurnLoop/abridgeChunked/
buildUserPrompt/describeToolCall), `rubric.ts`'s `promptSurface()`/
`RubricHash()` addition, and `chunk.ts`'s five moved-here-then-back helpers
were all present and line-for-line verified against `meat/meat.go` and
`meat/chunk.go:915-1086` in this iteration, not rewritten — an earlier
iteration evidently did the implementation work but stopped before ticking
the item or finishing the test port. `abridgeChunked`'s merge logic
(`appendPiece`'s missing-final-newline handling, `emittedMeta`/
`stripReplicatedMeta` dedup gated on the metadata having actually surfaced,
`mapMovesToChunk`'s contiguous-both-sides requirement) matches
`meat/chunk.go:915-1001` exactly. `RubricHash()`/`promptSurface()` already
matched the frozen vectors byte-for-byte (`rubric-hash.txt`'s pinned
`441f5e6e28ad3add`, `prompt-surface.txt`) before this iteration touched
anything — strong independent confirmation the whole model-visible surface
(system prompt, all four user-prompt branches, both toolbox configurations,
the nudge, both plan-feedback pressure branches, both oversize preview/
submit round-trips) survived the port byte-exact.

Three real gaps found and fixed this iteration: (1) `rubric.ts` had an
unused `type Request` import left over from an earlier draft, failing
`tsc --noEmit` under `noUnusedLocals` — removed. (2) `test/meat/rubric.test.ts`
was still item 4l's placeholder (systemPrompt-only slice of G1/G2, explicit
comments deferring the rest to "item 4n" which had by then landed in
`rubric.ts` without the test file being updated to match) — replaced with a
full port of `TestPromptSurfaceStaysFrozen` (all surfaces: systemPrompt,
3 userPrompt branches, both toolbox tool sets, nudge, 3 planFeedback
branches — not just systemPrompt), `TestBuildUserPromptNumbersOriginalDiff`,
`TestRubricHash`, `TestSurfaceFixturesCoverBothMoveBranches`, and
`TestRubricHashPinned` (6 new `node:test` cases, all passing including the
pinned-hash assertion). (3) `TestSurfaceFixturesCoverBothMoveBranches` needs
direct access to `surfaceOverflowDiff()`, which was Go-private and
unexported in the TS port (same-package Go tests need no export; a separate
TS test module does) — exported it, following the precedent `promptSurface`
itself and the two `surfaceFixture*` fixtures already set for this exact
reason.

Full-suite verification after the fixes: `tsc --noEmit` clean; `node --test`
701 tests, 691 pass, 10 fail — every failure independently confirmed to be
`ERR_MODULE_NOT_FOUND`/expected-missing-dependency on `src/meat/openai.ts`
(item 4p, `openai-request/replay`) or `src/cli/cache.ts`/`src/cli/render.ts`
(items 5b/5c, `cache-key/*` and `json-wire/*`) — zero regressions, zero
new failures anywhere already-ported. `test/meat/meat.test.ts` covers all
17 `Abridge`-specific tests from `meat/meat_test.go` (toolbox-only tests
like `TestRetentionPressure`/`TestToolboxGrepAndPathConfinement` were
already ported in `tools.test.ts`, item 4m) plus the previously-deferred
`TestAbridge_AcceptsGitFormatPatch` (`meat/editplan_test.go:636-677`,
flagged as blocked-on-this-item back at item 4i) and a `Request`-shape
test standing in for `TestRequestStaysPositionalCompatible` (ported as a
field-set assertion, not literal positional construction — TS has no
positional-struct-literal analogue, and `chunk.ts`'s test file already
documents deferring this exact test here). `test/meat/chunk.test.ts`
separately covers all 18 `TestAbridge_Chunked*` tests plus the three
`TestSplitDiff_*` tests' previously-deferred `Abridge`-based second halves
(21 tests in its own "Abridge (chunked)" describe block, all passing).
H19 (`AbortSignal.timeout()`'s unref'd timer breaking
`TestAbridge_InternalDeadlineReturnsValidFallback`) was already registered
in `migration/HAZARDS.md` with a citation to this file's `timeoutSignal`
helper — no new hazard found this iteration beyond what's already recorded.

---

### 4o. `src/meat/anthropic.ts`

- [x] **anthropic.ts**

**Delivers**: `AnthropicModel` implementing `Model` — credential
resolution (explicit key wins outright over gateway discovery; gateway
fallback uses the fixed placeholder `"implicit"` API key so the edge
gateway has something to substitute), Messages-API wire translation
(`toAntMessages`/`toAntTools`, in-order, no sort/map), and the shared
retry loop (`postJSONWithRetry` — also used by `openai.ts`, port it once
and share it). Retry specifics: `maxAttempts=4` (1 initial + 3 retries),
exponential backoff doubling `retryBaseDelay` per attempt, `retryableStatus`
= 408/429/any ≥500 (covers Anthropic's non-standard 529); a context-done
check during backoff or after a transport failure returns the bare
context error immediately, bypassing retry; a non-retryable status
returns immediately **on any attempt including the last**, with no
`"after N attempts"` wrapper — only a retryable failure on the *final*
attempt gets that wrapper. `stop_reason === "max_tokens"` is a **hard
error**, not a usable truncated result, even on HTTP 200 — a reply cut off
mid-tool-call JSON must never be silently returned or cached.
`MaxTokens` is always the fixed constant 16384, never derived from
conversation size. URL building trims **every** trailing slash then
unconditionally appends `/v1/messages` (contrast `openai.ts`'s
conditional-avoid-doubling `/v1` logic — do not share one URL builder
between the two providers, the algorithms genuinely differ).

**Specs**: `specs/providers.md` G7-G15, Mechanism "Anthropic Messages wire
translation and retry" (the retry loop's exact step order — backoff,
build request, execute, read body, status branch — matters for
distinguishing which errors get the `"after N attempts"` wrapper).

**Vectors**: none dedicated (network-dependent — exercised via a real
local HTTP-stub test harness per `specs/test-infrastructure.md`'s
"Anthropic HTTP-stub harness" section, not a pure-function vector).

**Hazards**: H4 (`antBlock.Input`/`antTool.InputSchema` — byte-for-byte
preservation via plain assignment, **no** `json.Valid` check on either
side unlike `openai.ts`'s explicit validate+clone pair; a
`"provider_state"` block has no translation case at all here — silently
dropped, not a deliberate portable no-op, don't assume it's safe to
formalize), H9 (`antMessage.Content` has **no** omitempty and can
genuinely marshal as `null` for an all-unrecognized-block-type message —
a real, reachable H9 instance, not a near-miss; `IsError` omits the key
when false, never sends `false` explicitly), H5 (context-cancellation
check inspects the signal object directly, not by unwrapping the fetch
error — mirror this exactly, and note only some of this file's errors are
`%w`-wrapped, others are opaque leaves — a port's cause-walker must
distinguish the two), H6 (`ctx`/signal honored at two independent points
— the backoff timer *and* the request itself; plus a second,
client-level 2-minute timeout independent of the signal — a port needs
both wired, not just one), H14 (the per-attempt error's body-trim uses
Go's set, not `.trim()`), adjacent-to-H12 (response body read has no
explicit size cap, unlike `openai.ts`'s bounded SSE scanner — flag but
this file does no streaming, so it's a parity note, not an action item).

**As built**: `AnthropicModel` is a plain, mutable, embedder-constructible
interface (mirroring Go's exported struct) that satisfies `Model` directly
via a self-referencing `generate` closure attached at construction time —
the same shape `test/meat/meat.test.ts`'s `newScriptedModel` already
established for a `Model` implementation in this codebase, chosen over a
class per the project's function-over-class convention (`tools.ts`'s
`Toolbox` precedent). `newAnthropicModel(opts)` mirrors `&AnthropicModel{...}`
direct construction; `NewAnthropicFromEnv(signal, model)` mirrors the Go
constructor exactly (G7-G9). Go's `*http.Client` parameter (only its
2-minute default timeout actually matters to a port, `fetch` having no
persistent client object) became `clientTimeoutMs?: number` — `undefined`
defaults to 2 minutes (mirrors `HTTPC == nil`), an explicit `0` means no
timeout (mirrors a supplied client with a zero-value `Timeout`, exactly what
the HTTP-stub test harness's `srv.Client()` is) — same pattern
`gateway.ts`'s `GatewayHttpClientOpts` already set. Discovered while
building this: Go's `http.Client.Timeout` re-arms **fresh on every
`client.Do()` call**, i.e. every retry attempt, not once for the whole
`postJSONWithRetry` loop — a port composing one timeout signal for the
entire loop would be a real behavioral divergence (a slow-but-recovering
sequence of attempts could spuriously time out under one shared budget where
Go's per-attempt budget would not). Ported as a fresh
`AbortSignal.any([signal, perAttemptTimeoutSignal])` inside the loop body,
`cancel()`d after every attempt.

**H19 applied proactively**: H19's own "Affects" line already named this
file as a likely next hazard site — the per-attempt client timeout above
uses a ref'd `setTimeout` + explicit `cancel()` (duplicated locally, not
imported from `meat.ts` — a provider file has no business depending on the
orchestrator), never `AbortSignal.timeout()`, even though no test in this
file's Go source happens to exercise a hung connection that would expose
the bug directly (unlike `meat.ts`'s `TestAbridge_InternalDeadlineReturnsValidFallback`,
which did).

**A genuinely new problem, not previously solved anywhere in the port
(H4's incoming direction)**: `tool_use.input` arrives as embedded raw JSON
(an object/array), not a JSON-encoded string — Go's `json.Unmarshal` routes
it into a `json.RawMessage` field without ever parsing it, which JS's
`JSON.parse` has no equivalent for (parsing the whole response necessarily
parses every nested field, `RawMessage` ones included, silently reformatting
them — numbers, whitespace, duplicate-key collapse — before this file ever
sees the bytes Anthropic actually sent). Solved with a small hand-written
scanner (`scanJSONValueEnd`/`rawObjectField`/`rawArrayElements`) that tracks
only bracket/quote nesting to locate a field's raw span in the *original*
response text, used alongside a normal `JSON.parse` for every other,
safe-to-reformat field (`type`/`text`/`id`/`name`/`stop_reason`/`usage`/
`error`). Verified directly (no Go precedent — new port-only machinery) in
`test/meat/anthropic.test.ts` against a decimal that `JSON.parse`→`stringify`
would renormalize (`1.50`→`1.5`), an integer exceeding `2^53`, and duplicate
object keys — all three survive byte-for-byte. The **outgoing** direction
(H4's already-documented splice pattern) needed the same rigor for a
different reason: `antReq` can't be built with one `JSON.stringify` call
since a replayed `tool_use.input`/tool `input_schema` are pre-serialized
fragments that must be spliced as literal text, so `buildAntRequestBody`
hand-assembles the wire JSON via string concatenation rather than
serializing a plain object. Registered as an addendum to H4 in
`migration/HAZARDS.md`, since `openai.ts` (item 4p) will need the same
scanner for the *simpler* whole-array-element-capture case
(`blocksFromOpenAIItem`'s raw-item clone) even though its own
`function_call.arguments` field is the *other* `RawMessage` shape (a
JSON-encoded string, which a plain `JSON.parse` already reproduces
losslessly with no scanning needed).

`test/meat/anthropic.test.ts` ports all 6 `anthropic_test.go` tests
(`TestAbridge_AnthropicEditPlanEndToEnd` G10, `TestGenerate_RetriesTransient`
G11, `TestGenerate_NoRetryOnBadRequest` G12, `TestGenerate_GivesUpAfterMaxAttempts`
G13, `TestGenerate_MaxTokensStopIsAnError` G14, `TestGenerate_SendsMaxOutputTokens`
G15) plus the three Anthropic-specific credential tests from
`gateway_test.go` (`TestNewAnthropicFromEnv_PrefersExplicitKey`/
`FallsBackToGateway`/`NoCredentials`, G7-G9 — the gateway-discovery-only
tests in that Go file stay in `gateway.test.ts`, item 4c, per that file's
own header comment) plus 4 direct H4/H9 tests described above. `postJSONWithRetry`,
`retryConfig`, and `maxAttempts` are exported for `openai.ts` (item 4p) to
share, per this item's own "port it once" instruction — confirmed unblocked:
grepped `meat/openai.go` for its own use of `postJSONWithRetry` ahead of
building that file, nothing about the shared function's signature needs to
change to accommodate it (SSE vs. plain-JSON dispatch happens entirely on
the caller side, over the same raw `Uint8Array` this function already
returns).

---

### 4p. `src/meat/openai.ts`

- [x] **openai.ts**

**Delivers**: `OpenAIModel` implementing `Model` — credential resolution
(notable asymmetry with Anthropic: the gateway-fallback path sends **no**
placeholder API key at all, not even a stand-in — no `Authorization`
header is sent, which is deliberate, not a bug to "fix" by inventing a
placeholder), Responses-API request construction (fixed shape: streaming
always on, server storage always off, `max_output_tokens=32768` always,
`include: ["reasoning.encrypted_content"]` always — none of these four are
caller-configurable), and response decoding, which is the file's hardest
part: dispatch on first non-whitespace byte (`{` → plain JSON; else → SSE
stream). SSE consumption: `response.output_item.done` events buffer into
an `output_index → bytes` map (later events at the same index silently
overwrite — no duplicate-detection error); `completed`/`incomplete`/
`failed` are all equally terminal, last-one-wins on the snapshot; an
`"error"`-typed event takes priority over a captured terminal snapshot
even if one also arrived. After the stream ends: only if the item map is
non-empty, sort indices ascending and **rebuild** `final.output` from them
— this is a conditional override, not an unconditional discard of the
terminal event's own output field. The opaque-replay short-circuit
(`block.provider === "openai" && block.providerData.length > 0`) is
checked **before** the type switch, for *any* block type including a
freshly-authored-looking `"text"` reply — this is what makes a prior
OpenAI assistant turn replay as its raw wire item on the next request
rather than being re-encoded from normalized fields, and it's the only
mechanism that can losslessly replay a `"reasoning"` block (which carries
no normalized fields at all).

**Specs**: `specs/providers.md` G16-G27, Mechanism "OpenAI Responses wire
protocol and streaming" (the longest single Mechanism block in
`providers.md` — read all of it, especially the SSE consumption state
machine and the opaque-replay decision boundary).

**Vectors**: `openai-request/` (`toOpenAIInput`) — note this vector's
"fixture's odd spacing and `1.0` are deliberate" per
`migration/CONFORMANCE.md`: a `JSON.parse`→`stringify` round-trip
normalizes them and **fails** this vector — the request body must be
built with a serializer that splices pre-serialized raw fragments, not a
single `JSON.stringify` call over a fully-parsed object (H4).

**Hazards**: H4 (critical — the highest-consequence mechanism in the
whole port: `ProviderData` capture clones the entire raw output item
without ever parsing it for `"reasoning"` items; `arguments`/`ToolInput`
is a JSON-encoded **string** field, a different serialization shape from
the raw-embedded schema fields — the "never parse this" rule applies to
it in string form, not as embeddable raw JSON directly; any
parse→stringify round-trip anywhere on this path corrupts the
cryptographic binding of encrypted reasoning items), H6 (two-timeout
pattern again — `ctx`/signal plus a 5-minute client-level default; a
cancellation landing *during* the full-body SSE read is not distinguished
from an ordinary transient failure at that call site, matters more here
than for `anthropic.ts` since this file's responses are routinely large
slow streams), H12 (bufio.Scanner-equivalent buffer: 64 KiB initial, 16
MiB hard max per SSE line — a Node stream port has no such cap by default
and must impose one explicitly, since exceeding it is a genuine,
documented error path here, not silent truncation like `tools.ts`'s
`capLines`), H13 (keep the explicit sort-by-index before rebuilding
`output` even though a JS `Map` would already preserve insertion order —
insertion order is SSE arrival order, not provably identical to ascending
`output_index` order; the sort is the actual contract), adjacent-to-H9
(the outgoing `input` array has no `omitempty`-equivalent guard and the
local accumulator starts as Go-`nil` — untested/near-unreachable in
practice since every real call produces ≥1 item, but a JS array
literal would diverge from Go's `null` on this exact unexercised corner
if it ever became reachable).

**As built**: `OpenAIModel` follows `anthropic.ts`'s established shape
exactly — a plain, mutable, embedder-constructible interface satisfying
`Model` via a self-referencing `generate` closure, `newOpenAIModel(opts)`
for direct construction, `NewOpenAIFromEnv` mirroring the Go constructor
(G16-G18, including the documented asymmetry with Anthropic: the
gateway-fallback branch sends **no** placeholder API key at all — verified
by a direct test asserting no `authorization` header is set). Reused rather
than duplicated from `anthropic.ts`: `postJSONWithRetry`/`retryConfig` (the
"port once, share it" instruction from item 4o), and — new for this
item — `rawObjectField`/`rawArrayElements` (item 4o's own raw-JSON-scanner,
exported from that file on its *second* concrete need, matching this
codebase's established "extract on second use" precedent, `bytes.ts`'s
`arrayAt` being the original case). `toOpenAIInput` is exported (the
`openai-request/replay` conformance vector calls it directly) and passes
byte-exact against the frozen vector, including the fixture's deliberately
odd spacing and `1.0` that a `JSON.parse`→`stringify` round trip would
normalize and fail on.

**The SSE decode needed the raw scanner in a new shape**: unlike
`anthropic.ts`'s single nested-field extraction (`tool_use.input` inside one
object), this file needs *whole-array-element* capture at two different
structural depths — `resp.output[]` (top-level JSON) or, inside an SSE
stream, each terminal event's nested `response.output[]`, plus each
`output_item.done` event's own `item`/`response` fields. Solved by reusing
`rawObjectField`/`rawArrayElements` as-is (no new scanner logic needed) and
adding one `parseResponseSnapshot` function that parses one `openAIResp`
-shaped raw text — reused for both the plain-JSON top-level body and an SSE
terminal event's `response` field, mirroring how Go reuses the single
`openAIResp` struct for both. A real, Go-faithful distinction surfaced here:
`item`'s Go type is `json.RawMessage` (byte-length presence check — a
literal `"item":null` counts as "present"), while `response`'s Go type is
`*openAIResp` (pointer-nil presence check — `"response":null` is genuinely
absent) — ported as two different presence rules (`item !== undefined` vs.
`responseText !== undefined && responseText !== "null"`), not unified,
since Go itself doesn't unify them.

**H4 asymmetry confirmed, not assumed**: this file's own `arguments` field
(`function_call.arguments`) is a JSON-**string** field (double-encoded —
the string's *content* happens to be JSON text, but the wire value itself
is an ordinary JSON string), unlike Anthropic's `tool_use.input` (embedded
raw JSON, an object/array directly). A plain `JSON.parse` of the response
already extracts a JSON string field losslessly (no reformatting risk,
since string escape-decoding is deterministic and nothing gets
re-serialized) — so `blocksFromOpenAIItem`'s `function_call` branch needed
no raw-scanner involvement at all, only `anthropic.ts`'s embedded-object
shape did. Verified directly (H12/H4/H13, no Go precedent — new port-only
mechanics) in `test/meat/openai.test.ts`: a reasoning item's duplicate key
and reformattable decimal survive an SSE round trip byte-for-byte; output
items reassemble in ascending index order even when two events arrive
out-of-order on the wire; a >16 MiB single SSE line is a hard error, not a
silent truncation.

**Genuine ES-module circular-import hazard found and fixed, not assumed
safe by analogy to item 4n's `rubric.ts`<->`meat.ts` cycle**: completing the
"Follow-up owed to item 4b" below required `provider.ts` to import
`DefaultOpenAIModel` from this file at module top level
(`export const DefaultModel = DefaultOpenAIModel`), while this file imports
`resolveModel` back from `provider.ts` — a real cycle, but *not* safe the
way item 4n's was, since a top-level `const` read (unlike a function-body
reference) is evaluated during module loading itself, and which side of the
cycle initializes first depends on load order. Registered as **H20** in
`migration/HAZARDS.md` with the full mechanism and fix (turn `DefaultModel`
into a zero-argument function) — verified empirically by running
`provider.test.ts` as its own entry point (a different load order than
reaching `provider.ts` via `anthropic.test.ts`/`openai.test.ts` first).

**Follow-up owed to item 4b, completed this iteration**: `provider.ts`'s
`DefaultModel` is now a real re-export (via the `DefaultModel()` function
above, not a duplicated literal) and `NewModelFromEnv(signal, model)` is
built (dispatches via `isAnthropicModel` to `NewAnthropicFromEnv`/
`NewOpenAIFromEnv`, G17) — both landed in `provider.ts` itself, not here,
since that's their Go home. `test/meat/provider.test.ts` gained the two
`TestNewModelFromEnv_*` tests from `meat/gateway_test.go` (moved there from
this file's own test file, since `NewModelFromEnv` is `provider.ts`'s own
function) plus a fix to the pre-existing `DefaultModel` reference (now
called as `DefaultModel()`). `NewModelFromEnv`'s only caller in the whole Go
tree is `cmd/meat/main.go:130` (item 5d) — nothing else was blocked by this
landing here rather than earlier.

`test/meat/openai.test.ts` ports all 4 Go tests from `openai_test.go`
(`TestAbridge_OpenAIEditPlanEndToEndPreservesReasoning`,
`TestOpenAIGenerate_StreamingText`, `TestOpenAIGenerate_IncompleteIsError`,
`TestOpenAIResponsesURL` — the last needed exporting the previously-private
`openAIResponsesURL`, same rationale as `anthropic.ts`'s own precedent for
exporting Go-private functions with a dedicated same-package Go test) plus
the two OpenAI-specific credential tests from `gateway_test.go`
(`TestNewOpenAIFromEnv_PrefersExplicitKey`/`NoCredentials` — the
gateway-discovery-only tests in that Go file stay in `gateway.test.ts`, item
4c) plus 12 direct tests (H4/H12/H13 SSE mechanics, `toOpenAIInput`'s
opaque-replay boundary) with no Go precedent.

---

## 5. The CLI

### 5a. `src/cli/stdin.ts`

- [x] **stdin.ts**

**Delivers**: `stdinIsPiped()` — a coarse file-mode check
(`!process.stdin.isTTY`, per H11 — **not** the same mechanism as
`isatty`, see item 5c/5d's hazard note: `/dev/null` is classified
*oppositely* by the two mechanisms in Go, and the port must preserve that
asymmetry, not unify them into one check) — and `readAllStdin()`: read
stdin to completion with **no size cap** (matches Go's `io.ReadAll`
exactly; H1 — the port must decide deliberately whether to bound this,
since Go doesn't).

**Specs**: `specs/cli.md` Mechanism "`stdinIsPiped` vs. `isatty`/
`isTerminal`" section (H11).

**Vectors**: none dedicated.

**Hazards**: H11 (the two-mechanisms-disagree-on-`/dev/null` point above
— this is the load-bearing detail of this whole file), H1 (no size cap,
by design — matching Go, not a gap to fix), H12 (no bounded-buffer
scanner used here, unlike `tools.ts`'s `git grep` capture).

**As built**: `stdinIsPiped` ended up as `!fstatSync(0).isCharacterDevice()`
inside a `try`/`catch` returning `false` on stat failure — **not**
`process.stdin.isTTY` as this item's own "Delivers" line above predicted.
`process.stdin.isTTY` answers "is fd 0 a tty" (closer to the *other*
mechanism, `isatty`), while Go's `stdinIsPiped` asks "is fd 0 a character
device at all" via `os.Stdin.Stat()` — a plain `fs.fstatSync(0)` matches
that literally, and keeps the two Node call sites (this one, and item
5c/5d's future `tty.isatty(fd)`) visibly distinct instead of both
resembling `.isTTY` checks that happen to differ by negation. Confirmed
by spawning a child process with `stdio: ["ignore", ...]` (Node opens
`/dev/null` for an ignored fd, a character device) vs. `stdio: ["pipe",
...]` with piped input: the former reports not-piped, the latter piped —
preserving the H11 asymmetry this item flagged, verified empirically
rather than assumed. `readAllStdin` is `for await (const chunk of
process.stdin)` collecting into `Buffer.concat`, no cap. Both functions
are untestable in-process (they read the real fd 0 the test runner
itself owns), so `test/cli/stdin.test.ts` is new coverage against the
source per specs/cli.md's Open questions note that Go has none either —
it spawns tiny generated probe scripts as children with chosen `stdio`
wiring rather than mocking `node:fs`.

---

### 5b. `src/cli/cache.ts`

- [x] **cache.ts**

**Delivers**: the `~/.meat` result cache — `cacheDir()` (three-way
precedence: `MEAT_CACHE` present-in-environment-at-all — including
present-and-empty — wins verbatim over the home-directory default; the
port must use a presence check like Node's `process.env` `in`/`hasOwnProperty`,
never `value ?? default` or `value || default`, or "set to empty" silently
collapses into "unset" and reintroduces a default directory when the
sanctioned disable value was passed), `cacheKey(diff, model, rubric)`
(SHA-256 over `rubric + 0x00 + model + 0x00 + diff`, in that
call-order-defying field order — write order is rubric/model/diff, not
the parameter order), `cacheLoad`/`cacheStore`. Every failure mode in both
read and write collapses to a bare miss/no-op — **zero** error strings,
zero throws, absorbed silently (a permission-denied cache dir is
indistinguishable from an empty one, by design). Write path is
atomic-by-rename: marshal → temp file in the same directory → write →
close → rename onto the final path, deleting the temp file on any
failure at any step, so a concurrent reader never sees a half-written
file — this is a filesystem property, not a lock; preserve the exact
step sequence, not just the end state.

**Specs**: `specs/cache.md` G1-G8, Mechanism in full (the "ok vs. value"
env-var distinction and the atomic-rename write sequence are the two
easiest things to get subtly wrong here).

**Vectors**: `cache-key/` (`cacheKey`).

**Hazards**: H1 (`cacheKey` hashes UTF-8 bytes of `rubric`/`model`/`diff` —
feed SHA-256 true UTF-8 bytes, mostly matters through the `diff` field
since model/rubric are ASCII in practice), H15 (`cacheLoad` decodes into
a zero-valued result — Go's lenient decode treats a syntactically-valid-
but-incomplete JSON object as a **hit** with zero-valued missing fields,
not corrupt; a strict/schema-validating JSON parser in the port would
diverge here — use a lenient decode to match), H4/H9 confirmed not
applicable (`Result` has no RawMessage or slice/map fields).

**As built**: `cacheKey` uses `Hash.update(str, "utf8")` directly rather
than routing through `bytes.ts`'s `encodeUTF8` — Node's default string
encoding for `.update` already reinterprets the JS string as UTF-8 bytes,
the same move Go's `[]byte(s)` makes, and this matches the precedent
already set by `rubric.ts`'s `RubricHash`; verified against a
hand-computed `Buffer`-based SHA-256 for a multibyte diff in
`cache.test.ts`. `cacheLoad`/`cacheStore` do cross the `Uint8Array` (bytes)
↔ JSON-string boundary at this file, since the ported `Result.smartDiff`
is `Uint8Array` (item 4n) but Go's `Result.SmartDiff` is a plain string
serialized as a JSON string field — `decodeUTF8`/`encodeUTF8` do that
conversion here, at the cache's on-disk-JSON boundary, matching H1's
"decode to string only at the CLI/model-API boundary" rule (this cache
file *is* one such boundary). `cacheLoad`'s lenient decode goes one step
further than the spec's own note: a JSON top-level of `null` is also
treated as a hit at the all-zero value, matching a documented (but
Go-test-uncovered) quirk of `encoding/json` — unmarshaling `null` into a
non-pointer destination is a no-op, not an error — cited in the file
header and covered by a new test since neither Go nor the spec's Open
questions previously called it out. `cacheStore`'s temp-file step
(`os.CreateTemp`'s Go equivalent) is a single `fs.open(path, "wx")` with a
12-byte random hex suffix and no retry-on-collision loop: Go's own
`cache.go` doesn't inspect error kinds anywhere either — every failure at
every step is an unconditional bare return — so a single attempt matches
that spirit exactly; the collision probability with 96 bits of randomness
is negligible enough that adding retry logic would be defending against a
scenario Go's own code doesn't defend against.

---

### 5c. `src/cli/render.ts`

- [x] **render.ts**

**Delivers**: turns a `Result` into what the user sees — colorized/plain
terminal output or `-json`. `renderJSON`: HTML-escaping **off**
(`JSON.stringify` already matches this by default — never add escaping
"for safety"), only the `elision` field carries omit-when-empty semantics,
the other four `Result` fields always serialize their key including
falsy values (H9 — get this backwards and a CI-bot JSON consumer either
loses expected keys or gains an unexpected `elision: ""`). Color decision:
one boolean, computed once, gating everything downstream —
`tty = isatty-equivalent(stdout)`, then `color = tty && gitWantsColor(tty)`
— the `&&` short-circuit means a non-tty writer **never** shells out to
git at all, even under `color.diff=always`; this is the single most
important short-circuit to preserve (an always-ask-git port adds a
subprocess call to every piped invocation and can diverge from Go on a
pipe). Subprocess failures fail **closed** (no color), never open.
`isDiffMeta` must be checked before the generic `+`/`-` prefix tests in
per-line colorization, or `+++`/`---` file headers get miscolored as
added/removed content. Pager: one `git var GIT_PAGER` call takes git's
resolved answer verbatim (git itself walks `GIT_PAGER`→`core.pager`→
`$PAGER`→`less`, the port does not reimplement that chain); the resolved
pager string is handed to a shell as one command line (`sh -c <pager>`),
never tokenized — `$PAGER` values legitimately contain arguments and
pipes.

**Specs**: `specs/render.md` G1-G16+ Mechanism in full.

**Vectors**: `json-wire/` (`renderJSON`).

**Hazards**: H4 (`SetEscapeHTML(false)`-equivalent — matches
`JSON.stringify`'s default automatically, but state this explicitly so a
future change doesn't "helpfully" add escaping), H9 (central site — see
Delivers above; the exact omitempty table is in the spec's Data Shapes
section), H12 (four subprocess call sites: `git config --get-colorbool`,
`git config --get-color` ×4 slots, `sh -c <pager>`, `git var GIT_PAGER` —
all use captured-output except the pager, which streams live to the
process's own stdout/stderr, not the `w` writer `renderResult` received),
H14 (the "no meaningful change" placeholder's emptiness check uses Go's
trim set), H1/H2/H3/H6/H7/H10/H11/H13/H15/H16 confirmed not applicable to
this file specifically (H11's `isatty` call happens via item 5d's
`tty.isatty`, consumed here but not implemented here).

**As built**: `renderJSON(res: Result, elision: string): string` **returns**
the encoded text instead of Go's `renderJSON(w io.Writer, ...)` writing to a
caller-supplied writer — `test/conformance.test.ts`'s already-committed
`json-wire/` block was already written calling it exactly this way
(`toTextVal(mod.renderJSON(c.result, c.elision))`, no writer argument), and a
pure function is simpler to vector-test besides; the conformance block's
`result` fixtures were fixed from a provisional plain-`string` `smartDiff`
to `encodeUTF8(...)` `Uint8Array` to match `Result`'s real shape (H1) while
here. `renderResult(w: Writer, res: Result, elision: string): void` keeps
Go's writer-taking shape — it is genuinely side-effecting (may shell out to
a pager, may write to `process.stdout` directly inside `page`, falls back to
`w` on pager failure only) and has no vector to answer to, so no
simplification applied there. `Writer` is a new, minimal interface (`{ fd?:
number; write(text: string): void }`) standing in for Go's `io.Writer`
narrowed to `*os.File`: `isTerminal(w)` checks `typeof w.fd === "number" &&
isatty(w.fd)` (H11 — `node:tty`'s built-in `isatty` needs no hand-porting,
unlike Go's `isatty_*.go` build-tag family) — anything lacking a numeric
`fd` (an in-memory test buffer) is unconditionally non-terminal, matching
G6, and `process.stdout`/`process.stderr` satisfy `Writer` structurally with
no adapter once item 5d wires them in. All four subprocess call sites
(`gitWantsColor`, `diffColor`, `gitPager`, the pager invocation in `page`)
use synchronous `execFileSync`, not the async `execFile`-plus-Promise
pattern `tools.ts`'s `runGit` established — deliberate, not an
inconsistency: Go's render.go has no goroutines and nothing here accepts an
`AbortSignal` (H6 confirmed not applicable), so a sync call is the more
direct port and keeps every function in this file callable without `await`,
matching how `render_test.go`'s own tests call `formatBody`/
`colorizeDiffLine`/`gitWantsColor`/`renderResult` synchronously. `page`'s
non-`cat` branch runs `execFileSync("sh", ["-c", pager], { input: text,
stdio: ["pipe", "inherit", "inherit"], ...envOverride })` — `stdio[1]`/`[2]`
`"inherit"` wires the pager's stdout/stderr to the process's own, matching
`cmd.Stdout = os.Stdout` exactly; `envOverride` is `{}` (child inherits
`process.env` unmodified, matching `cmd.Env` staying `nil`) unless `LESS` is
unset, in which case it's `{ env: { ...process.env, LESS: "FRX" } }`. The
diff-blank check (`trimSpace(res.smartDiff).length === 0`, H14) runs
directly on the raw byte-level `smartDiff` via `bytes.ts`'s audited
`trimSpace`, skipping Go's intermediate `TrimRight(diff, "\n")` step
entirely — provably equivalent, since `TrimRight(s, "\n")` only removes a
suffix that Unicode-whitespace `TrimSpace` would remove anyway, so
`TrimSpace(TrimRight(s, "\n")) == TrimSpace(s)` always; this also means
`formatBody` only decodes `smartDiff` to a string once, on the non-blank
path that actually needs to split/colorize lines. `goTrimSpaceString`
(encode → `bytes.ts` `trimSpace` → decode) covers the two remaining
`TrimSpace` sites on captured git stdout (`gitWantsColor`, `gitPager`) —
neither is on `migration/HAZARDS.md`'s H14 catalogue (git's own stdout
there is verified ASCII-only), but they route through the Go-matching
helper rather than `.trim()` anyway, per item 1's blanket rule. All 9
`render_test.go` tests ported to `test/cli/render.test.ts` (28 sub-tests
counting the table-driven ones), plus the pre-existing `json-wire/` vector
block (3/3) — all green; full suite 787/787, conformance 119/119.

---

### 5d. `src/cli/main.ts`

- [x] **main.ts**

**Delivers**: flag parsing (`-model`, `-no-cache`, `-staged`, `-w`,
`-json` — reproduce Go's `flag` package's exact accepted grammar: `-json`/
`--json` both work, `-model=x` and `-model x` both work, stops at the
first non-flag argument; `parseArgs`'s defaults differ on single-dash long
options and positional handling, so this needs deliberate, tested
handling, not a default `parseArgs` call), diff-source resolution
(`readDiff` — a strict, non-backtracking sequence: staged+worktree
conflict → flag+positional conflict → staged alone → worktree alone → too
many args → single positional (revision vs. range via a bare
`.includes("..")` substring test, misclassifies nothing since both `A..B`
and `A...B` contain `..`) → piped stdin → default `git show HEAD`),
`git()` subprocess wrapping (captures only stdout, treats non-zero exit as
error, extracts stderr into the error message), `gitRoot()`, the `run()`
cache-aware orchestration (cache lookup with model+rubric hash resolved
*unconditionally* before the hit/miss decision, since the key needs them;
on miss, compute → unconditional write-through → render, printing the
`"cached (sha ...)"` or `"tokens in=X out=Y"` notices), and — per H11 —
the `isatty_*.go` replacement: `node:tty`'s `tty.isatty(fd)` used for the
interactivity check that gates progress-line updates (**both** stdout and
stderr must be terminals, and it's unconditionally disabled under
`-json`).

**Specs**: `specs/cli.md` (636 lines — read in full; the flag-conflict
check ordering in `readDiff`, and the `main()`/`run()` orchestration
sequence in Mechanism, are both exact-order-matters specs).

**Vectors**: none dedicated (this is the orchestration layer — no pure
function here is vector-covered; correctness is proven by the eventual
`npx meat` end-to-end smoke test in item 6 and the differential run
against `conformance/meat-go` from the exit gate).

**Hazards**: H11 (central — the `isatty_*.go` build-tag family does not
port; `tty.isatty(fd)` replaces it. Separately, `stdinIsPiped`'s own
mechanism is *not* the same replacement — see item 5a's hazard note on
the `/dev/null` asymmetry, which this file's `main()` also depends on via
its interactivity check), H12 (`git()`'s stdout-only capture + stderr
extraction is the concrete instance of the general
`exec.Command(...).Output()` pattern; `readAllStdin` has no size cap,
unlike this file's other subprocess reads), H1 (two raw-byte-
reinterpretation boundaries — `git()`'s stdout and stdin's read — must
carry arbitrary bytes through with zero decoding/validation; read as
`Buffer`/`Uint8Array` at this exact boundary, not as decoded text, until
it's handed to the engine), H6 (does *not* bite here the way it does in
`meat.ts`/`chunk.ts` — Go passes a bare, no-timeout root context; Ctrl-C
relies entirely on default `SIGINT` process termination, no graceful-abort
path — don't add cancellation wiring Go doesn't have), H14 (the CLI's own
independent empty-diff check, `TrimSpace(diff) === ""` before ever calling
the engine — a *second*, earlier check than `meat.ts`'s own, both must use
the Go-matching trim from item 1).

**As built**: `parseFlags(argv): ParseFlagsResult` is a new, hand-rolled
reimplementation of Go's `flag` package algorithm (`flag.go`'s `parseOne`,
not `node:util`'s `parseArgs` — see file-header note), returning a
discriminated `{kind: "ok"|"help"|"error"}` rather than mutating globals or
calling `process.exit` itself, so it's directly testable; `main()` is the
only thing that translates `"help"`/`"error"` into the exit-0/exit-2
convention (and prints `usage`, matching Go's `f.usage()` being called from
*both* the help path and `failf`'s error path — confirmed by reading
`flag.go` directly, not just this file's own spec, since specs/cli.md's own
Open questions flag flag-parsing as wholly untested territory). `readDiff`
throws instead of returning Go's third `error` value; the discarded
error-path `source` value is behavior-equivalent since no Go caller ever
reads it on that path (verified by reading `main.go` itself, not assumed).
`diff` stays `Uint8Array` end to end in this file (H1) — `git()`'s stdout
and `readAllStdin`'s bytes flow into `Abridge`'s `Request.unifiedDiff` and
`ElisionLine`'s `raw` parameter with zero decode/re-encode; the **one**
decode happens inside `run()`, immediately before `cacheKey` (`cache.ts`'s
own already-shipped `(diff: string, ...)` signature from item 5b, not
revisited here). `git()` distinguishes Go's `*exec.ExitError` case (real
non-zero exit → format `"git <args>: <stderr>"`, stderr Go-trimmed via a
local `goTrimSpaceString`, H14) from every other failure (spawn error, e.g.
git missing from `PATH` → rethrown unwrapped) via `execFileSync`'s thrown
error's `typeof e.status === "number"` — verified empirically (a probe
script, not committed) that Node sets `status: null` for a spawn failure
(`code: "ENOENT"`) vs. a real numeric exit code for a completed process,
mirroring Go's own `ee, ok := err.(*exec.ExitError)` type-switch exactly.
Four subprocess call sites (`git`, and transitively `gitShow`/`gitRoot`)
use synchronous `execFileSync`, matching `render.ts`'s established
precedent (item 5c) for the same reason: no `AbortSignal` reaches any of
them (H6 confirmed not applicable, same as `render.go`). `run()`'s elapsed
-time notice uses a new `formatElapsed(ms)` reproducing Go's
`time.Duration.String()` restricted to the actual input domain
`.Round(100ms)` always produces (non-negative, 100ms-granularity) — exact
ns/µs precision and negative durations are out of scope, matching this
being wholly untested, user-facing text in Go too (Open questions).
`fatal`'s message-prefixing rule was split into an exported pure
`fatalMessage(msg): string` specifically so the documented "prefixes
'meat:' exactly once" Invariant is directly testable without invoking
`process.exit` — `fatal` itself is a thin wrapper. `main()`'s own
entry-point guard (`fileURLToPath(import.meta.url) === process.argv[1]`)
keeps `main()` from running when the module is merely imported (by
`node --test`, in particular) — verified this doesn't fire under
`node --test`'s own import mechanism. **Discovered mid-item**: `node
--test`'s own fd 0 is neither a character device nor a real pipe (an
internal socket the test runner uses) — calling `readDiff([], false,
false)` in-process hangs forever on `readAllStdin()` waiting for an EOF
that never comes. `test/cli/stdin.test.ts` (item 5a) had already
documented this exact class of problem for `stdinIsPiped`/`readAllStdin`
directly and established the fix (spawn a child process with controlled
`stdio`); the one port test that reaches this branch
(`TestReadDiffMergeCommit`) now does the same via a spawned probe script,
every other `readDiff` call in the test file returns before reaching that
check so needed no such treatment. All 7 `readdiff_test.go` tests plus the
3 `run`/`runOpts` tests deferred from `cache_test.go` (item 5b) ported to
`test/cli/main.test.ts`, plus new direct coverage for `isRevRange`'s
untested boundary case, `git()`'s own H12 error formatting, `parseFlags`
(11 sub-tests), and `fatalMessage` — 25 tests, all green; full suite
812/812, conformance 119/119 (unchanged — no vector targets this file).
Manually smoke-tested the real CLI end to end (not just `node --test`,
since `main()` itself has zero Go test coverage to port from): `-h`
prints usage and exits 0; an unknown flag exits 2 with the error + usage;
`-staged -w` exits 1 with the mutual-exclusion message; a real invocation
against this repo's own HEAD resolves the diff and fails cleanly on
missing credentials (proving `readDiff`/the empty-diff check/`gitRoot`/the
`compute` closure wiring all work before ever reaching the network); and a
hand-seeded cache entry (via `MEAT_CACHE`) round-trips correctly through
both plain and `-json` rendering on a real cache hit. `install_test.go`
(G8) remains deferred to item 6 (Packaging) — npm's `bin`/`name` split is
the equivalent property, not a Go-test port.

---

## 6. Packaging

- [x] **Shebang preservation** — `dist/cli/main.js` needs
  `#!/usr/bin/env node` preserved through the `tsc` build (verify `tsc`
  doesn't strip it; if it does, a small build-step patch is needed) and
  the executable bit set on publish.
- [x] **`bin` wiring** — confirm `package.json`'s `bin.meat` (set in item
  2) actually resolves and executes after `npm link`/`npm pack`.
- [x] **`npx meat` smoke test** — run the packaged CLI end-to-end against
  a real repository and confirm it produces output matching the Go binary
  on the deterministic surfaces (per `migration/CONFORMANCE.md`'s
  "Differential testing during stage 3" section: `-json` output shape,
  elision manifest, cache keys, chunk boundaries — using
  `conformance/meat-go` as the reference binary for the comparison).

**Specs**: `migration/TARGET.md` "`package.json`" section,
`migration/CONFORMANCE.md` "Differential testing during stage 3".

**Vectors**: none directly — this is where the stage 3 exit gate's
"`npx meat` works end to end... matching the Go binary" criterion gets
verified for the first time as a whole system, not a unit.

**Hazards**: none new — this item is integration, not new logic. If
anything surfaces here it's almost certainly a symptom of an earlier
item's hazard being mishandled, not a new hazard class.

**As built**: `package.json` was missing `version` entirely — `npm pack`/
`npm publish` refuse to run without one, a gap invisible until this item
actually packed a tarball for the first time. Added `"version": "0.1.0"`
and fixed `migration/TARGET.md`'s own package.json snippet to match (it
was the source of the omission). `dist/cli/main.js`'s shebang needed
*adding to the source* (`src/cli/main.ts`'s literal first line) — it was
never there in the first place (items 5c/5d never had reason to add one) —
and, once added, `tsc` preserves a source hashbang through to emitted `.js`
automatically, no config or build-step patch needed, confirmed by
inspecting `dist/cli/main.js` after a real build. The executable bit,
however, *is* stripped/never set by `tsc` — confirmed empirically (a fresh
build produces `-rw-r--r--`) — so a `"postbuild": "chmod +x
dist/cli/main.js"` script (npm's implicit pre/post-script convention) was
added; `TARGET.md`'s snippet updated to match.

**Bug found and fixed via the `bin`-wiring check**: verified `bin.meat`
end-to-end not with `npm link` (which would mutate the *user's real global
npm state*, avoided here) but by `npm pack` + `npm install --prefix
<scratch-dir> --global <tarball>`, sandboxing the "global" install to a
throwaway directory — this reproduces npm's real symlink-creation
mechanics (`bin/meat -> lib/node_modules/meat/dist/cli/main.js`) with zero
side effects on the host system. Running `bin/meat -h` through that real
symlink silently printed **nothing** and exited 0 — a real bug: `main.ts`'s
entry-point guard (`fileURLToPath(import.meta.url) === process.argv[1]`)
compared a symlink-resolved path (`import.meta.url`, which Node resolves
through symlinks by default) against the *unresolved* invoked path
(`process.argv[1]`, which stays as the symlink itself) — they never match
under `bin` wiring, so `main()` silently never ran. Fixed by
`realpathSync`-ing `process.argv[1]` before comparing (`isMainModule()`,
wrapped in try/catch since a nonexistent path would throw). This would
have been **the single most severe possible bug to ship** — the packaged
CLI doing nothing at all, no error, exit 0 — and was only caught because
this item's own checklist insisted on verifying `bin` wiring for real
rather than trusting `node --test`/`node src/cli/main.ts` (both of which
worked fine and gave no signal of the problem, since neither invokes
through a symlink). Added a regression test
(`test/cli/main.test.ts`: "main() runs when invoked through a symlink")
that creates a real symlink to `main.ts` and spawns it, reproducing the
shape without needing a real npm install — 26/26 in that file now, full
suite 813/813.

**Differential test against `conformance/meat-go`**: seeded one shared
`MEAT_CACHE` directory (via the TS `cacheStore`) with a hand-built `Result`
under the key both binaries would independently derive
(`cacheKey(diff, ResolveModel(""), RubricHash())` for this repo's own real
~435KB HEAD diff, ~5,526 changed lines) — letting *both* the Go reference
binary and the built `dist/cli/main.js` serve the same cache hit with zero
LLM credentials needed. Result: **byte-for-byte identical** `-json` output,
byte-for-byte identical plain-rendered output, and identical cache-hit
status line (`meat: cached (sha 39d802341e37)`) on both binaries — meaning
`cacheKey`, `RubricHash`, `ResolveModel`'s default resolution, `readDiff`'s
`git show HEAD` diff bytes, `renderJSON`, `formatBody`/`renderResult`, and
`ElisionLine` (a real, large, non-fixture diff — not just the `elision/`
vector corpus) all agree with Go exactly, end to end through the packaged
binary. Chunk boundaries were **not** exercised by this specific
differential run (435KB is under `maxTotalDiffBytes`=4MB, so chunking
never triggers) — already covered extensively by `chunk.ts`'s own unit
tests and the `plan-compile`/vector-derived coverage from item 4k, not
re-proven here. Also spot-checked `-h` (usage text), an unknown flag (exit
2), and `-staged -w` (exit 1, mutual-exclusion message) through the real
installed `bin/meat`.

**Stage 3 exit gate — self-assessment against `migration/prompts/stage3
-port.md`'s own criteria**: every `TODO.md` item is ticked; `tsc --noEmit`
clean; `node --test` 813/813; every conformance vector passes (119/119,
unchanged by this item — none target packaging); `npx meat` (simulated via
the sandboxed global install above) works end to end against a real
repository, matching the Go binary on every deterministic surface checked;
citations in every spec touched this iteration (`migration/TARGET.md`)
still resolve. Retiring the Go tree is a separate, human decision per the
loop's own closing instruction — not proposed here, just noted as the
next possible step.

---

## Notes for future iterations

- **`imports.ts` and `python.ts` swapped (old 4g/4h → new 4g/4h reversed)**
  while starting `imports.ts`. `imports.go`'s `embeddedSourceLines` —
  called from the *vector-tested core* of `mandatoryImportRemovalPlan`, not
  just the three deferred plan-state functions — calls `python.go`'s
  `scanPythonTripleLine`/`pythonTripleState`/`pythonTripleNone` to detect
  Python/Java triple-quoted regions before classifying a side's lines as
  import scaffolding. The three plan-state-aware functions
  (`addMandatoryPythonSuitePlaceholders` etc.) need more of `python.go`
  still. Verified the dependency is one-directional by grepping every
  `imports.go` symbol name against `python.go`: zero hits — unlike the
  moves/imports/python ↔ editplan circular case that forced `plan.ts` into
  existence, this one is a plain forward reference with a clean fix: swap
  the two files' order. `python.ts` is now item 4g, `imports.ts` is 4h.
  `migration/INVENTORY.md`'s Go-file table order was **not** touched by
  this swap — it still lists `imports.go` before `python.go`, matching
  upstream Go source order, since Go doesn't have this constraint; only the
  TypeScript port's `TODO.md` build order changed. If `INVENTORY.md` is
  ever read as prescribing port order beyond what its own "ordered by
  porting dependency" claim already covers, note this specific divergence.
- **`bytes.ts` gained `arrayAt<T>(arr, i): T`** while starting `moves.ts`:
  `diff.ts` had already needed a private `need<T>(value, index, length)`
  helper for `noUncheckedIndexedAccess`-safe access into non-byte arrays
  (`SourceLine[]`, `DiffLineKind[]`, ...), and `moves.ts` needed the
  identical pattern for `MoveLineInfo[]`/`moveRun[]`/etc. — a second
  instance was enough to centralize rather than duplicate a third time.
  `diff.ts` has been retrofitted to call `arrayAt` instead of its own local
  `need` (mechanical, verified via its existing test suite — no behavior
  change, same `RangeError` message shape). **Every future engine file
  indexing a non-byte array should reach for `bytes.ts`'s `arrayAt`, not
  reimplement this locally** — `at`/`slice` are already the sanctioned way
  to index a `Uint8Array`; `arrayAt` is the same idea for everything else.
- The order above is fixed per `migration/prompts/stage3-port.md` — if a
  hazard discovered mid-port or a failing vector makes a later item more
  urgent than the next unblocked one, take that instead and say why (per
  the loop's Phase B rule 1), but don't silently reorder this list.
- **`elision.ts` was moved from 4d to 4j** (originally moved to 4i during
  the `gateway.ts` iteration; shifted one further to 4j when `plan.ts` was
  inserted — see the next note). `elision.go:86` calls
  `compileElisionProjection`, which is defined and tested in
  `editplan.go`/`editplan_test.go`, not `elision.go` — Go doesn't care about
  file order within a package, but a TS module genuinely cannot import a
  function from a file that doesn't exist on disk yet.
  `migration/INVENTORY.md`'s "ordered by porting dependency" table had the
  same bug (elision.go listed before editplan.go despite depending on it)
  and has been corrected to match. Verified via `grep -rn ElisionLine(
  meat/*.go`: `ElisionLine` itself is called only from
  `cmd/meat/main.go:147` (the CLI, item 5d) — nothing between `gateway.ts`
  and `editplan.ts` in the engine actually needs `elision.ts`, so moving it
  past `editplan.ts` (which does need it) breaks nothing. `editplan.ts`'s
  own Delivers text already documented building `compileElisionProjection`
  as part of its own scope before this reorder happened, so this was a pure
  ledger-ordering fix, not a new design decision.
- **`plan.ts` (item 4e) was inserted while starting `moves.ts`** — a bigger
  version of the same class of problem elision.ts hit, discovered by
  reading `meat/moves.go` directly rather than trusting the spec prose
  alone. `validateMoveSymmetry`'s `compressionAt` needs `editplan.go`'s
  `planState` type; every validator in `python.go` takes a
  `state planState`/`*planState` parameter; `imports.go`'s three
  plan-state-aware functions do too (that one was already flagged, without
  a resolution, in this file's own original `imports.ts` entry). But
  `editplan.go`'s own orchestrator (`compileEditPlan`/
  `compileEditPlanMoves`) calls into `moves.go`/`imports.go`/`python.go` —
  so `editplan.ts` cannot simply move earlier than all three either, without
  breaking the reverse direction. That's a genuine file-level circular
  dependency, not a one-function forward reference like `elision.ts`'s or
  `diff.ts`'s `joinEditPlanErrors`, and no linear reordering of
  `{moves, imports, python, editplan}` as four monolithic files can resolve
  it. Fix: extracted `editplan.go`'s pure type-definition layer
  (`lineRange`, `lineReplacement`, `lineFold`, `plannedReplacement`,
  `plannedFold`, `planState`, `newPlanState`, `planState.represented`,
  `applyPlannedReplacements`, `leadingWhitespace` — none of which call into
  moves/imports/python) into a new file, `plan.ts`, with no direct Go
  source — the same kind of deliberate, documented exception to
  `migration/TARGET.md`'s one-to-one layout rule that `bytes.ts` already
  is. `editplan.ts` keeps everything else (the actual orchestrator,
  `prepareFold`, `validateSummary`, the elision-projection compiler, etc.)
  in its own, still-later slot. `migration/TARGET.md`'s Layout section and
  `migration/INVENTORY.md` have been updated to note `plan.ts` alongside
  `bytes.ts`'s existing "NEW" callout. This shifted every item from
  `moves.ts` onward down one letter (old 4e–4o → new 4f–4p) — checked every
  `item 4X` cross-reference in this file, not just the ones adjacent to the
  insertion point.
- `python.ts` (4g) has no dedicated conformance vector directory — its
  correctness is proven entirely through `plan-compile/`'s three Python
  golden fixtures (item 4i), and (since the `imports.ts`/`python.ts` swap)
  transitively through `imports/`'s vectors too. Do not consider 4g "done"
  independently of those.
- `meat.ts` (4n) and `anthropic.ts` (4o) similarly have no dedicated pure
  -function vectors — `providers.md`'s own "Known gap" note flags there is
  no `anthropic-request/` vector because the Anthropic body builder isn't
  reachable from a pure function the way `toOpenAIInput` is. Port their
  `node:test` coverage from `specs/test-infrastructure.md`'s harness
  descriptions (scripted model, HTTP-stub harnesses), not from a vector
  count.
- **Items 1 and 2 were done together**, in one iteration: item 1's own
  Definition of Done (`tsc --noEmit`, `node --test`) can't be verified
  without item 2's `tsconfig.json`/`package.json` existing, so item 2 was
  treated as an unblocking prerequisite rather than a separate iteration.
  Both are now ticked; nothing left undone in either.
- **Import-extension gotcha, applies to every future item — superseded once
  (see item 4d's "As built" note, `migration/TARGET.md`'s tsconfig section)**:
  `tsconfig.json` only `include`s `src/**/*`, so `test/**/*.test.ts` is never
  type-checked by `tsc` (the `check` script's `tsc --noEmit` genuinely does
  not see test files — intentional, not an oversight). `node --test` runs
  both test and source files directly via Node's built-in TypeScript
  type-stripping — no build step — and that resolves import specifiers
  against real on-disk files only, with **no** extension remapping at all
  (originally documented here as only a test-file concern, before item 4d
  — `diff.ts`, the first file with an intra-`src/meat/` import — proved
  source-to-source imports hit the identical problem). Fix: **every relative
  import, in both `src/` and `test/`, uses the literal on-disk `.ts`
  extension** (e.g. `from "./bytes.ts"`, `from "../../src/meat/bytes.ts"`).
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (TS 5.7+,
  added to `tsconfig.json`/`migration/TARGET.md` in item 4d) make `tsc
  --noEmit` accept this and make the real `tsc` build rewrite `.ts` → `.js`
  in `dist/`, so the published package still resolves under plain Node.
  `tsc` never sees test files either way, so this costs nothing on the
  type-checking side for `test/` — just remember the extension, everywhere.
- **`bytes.ts` caught one real bug via its own test suite**: the first draft
  of `splitLines` used an unconditional loop with a not-found-newline break,
  which does not reproduce Go's `for len(text) > 0 { ... }` — it emitted a
  phantom empty final line whenever the input ended exactly on `\n` (e.g.
  `"abc\n"` produced 2 lines, not 1). Fixed to `while (rest.length > 0)`.
  `specs/diff.md:90-92` calls the no-phantom-line guarantee load-bearing for
  `numberedDiff`, so this would have been a real, silent divergence — a
  useful reminder that `splitLines`'s loop *shape*, not just its per-line
  logic, is part of the contract. No `migration/HAZARDS.md` entry needed —
  this was an implementation bug caught before the item was ticked, not a
  Go-vs-JS semantic gap.
- `decodeRune`/`decodeLastRune`/`trimSpace`/`isSpaceRune` in `bytes.ts` were
  cross-checked against live `go run` output (a throwaway script outside the
  Go tree, not committed) covering overlong encodings, surrogate-range
  rejection, 4-byte boundary values, truncated sequences, and the exact
  `unicode.IsSpace` codepoint set (confirms it excludes U+FEFF and U+200B,
  includes U+0085/U+00A0/U+1680/U+2000-U+200A/U+2028/U+2029/U+202F/U+205F/
  U+3000) — all matched on the first implementation, no divergence found.
  Future items needing similar Go-semantic confidence can use the same
  approach: a standalone `go run` script using only stdlib, outside the
  module, never touching a tracked `.go` file.
- **Correction: `meat/conformance_dump_test.go` and
  `cmd/meat/conformance_dump_test.go` DO exist** (committed in `init`,
  `c4057fe`) — CONFORMANCE.md's framing ("delete when the port is complete")
  had made it seem plausible they'd already been cleaned up, and an early
  `wc -l` in this iteration hit a transient shell issue that looked like
  they were missing. They weren't. **Read them in full before writing any
  vector-consuming code** — they are the authoritative, verified source for
  every vector's exact shape and the input fixtures behind `openai-request/`
  and `json-wire/`/`cache-key/`, far more reliable than reverse-engineering
  from the vector files alone. `test/conformance.test.ts` was written only
  after reading both in full.
- **`test/conformance.test.ts` is built and correctly failing**: 119 tests,
  1 passing (a corpus-loader sanity check — 9 entries expected and found),
  118 failing, every single failure verified to be a clean
  `ERR_MODULE_NOT_FOUND` from a dynamic `import()` of a not-yet-created
  source file — zero assertion or type bugs in the harness itself. This is
  the correct starting state per `migration/CONFORMANCE.md`'s "vectors for a
  stage only start passing once that stage is ported." As each engine/CLI
  item lands, its corresponding subtests should flip from
  `ERR_MODULE_NOT_FOUND` to real pass/fail — a real fail at that point is a
  genuine bug (in the port, or in this runner's shape assumption) to fix
  before ticking the item, not something to wave through.
- **`test/conformance.test.ts`'s shape assumptions for not-yet-built modules
  are provisional by necessity** (documented at the top of the file itself):
  camelCase runtime field names throughout (`fileId`, `startLine`, `metaPrefix`,
  etc. — vectors themselves stay snake_case/PascalCase JSON on disk, translated
  in the runner, never expected from the TS runtime objects); byte-oriented
  functions (`diff`/`moves`/`imports`/`chunk`/`editplan`, and `elision.ts` by
  inference from its own Hazards section) accept/return `Uint8Array` OR
  `string` — the runner normalizes either way via local `toBytesVal`/
  `toTextVal` helpers, so this genuinely doesn't need to be decided now;
  validate/compile-style functions (`validateSupportedDiff`,
  `splitDiffForAbridging`, `compileEditPlan`) are assumed to **throw** an
  `Error` whose `.message` matches Go's exact text on failure, mirroring
  `errText(err)`. `ElisionLine` and `RubricHash` keep their exact Go casing
  (confirmed, not guessed — `migration/TARGET.md`'s cross-boundary export
  list names both). **When porting the file that fills in an assumption,
  check it against what got built and adjust the test — this is expected
  maintenance each of items 4a-4o and 5b/5c should budget a few minutes for,
  not a sign the runner was wrong to commit to a shape early.**
- **One frozen-vector quirk worth knowing about**: `moves/*.json` and
  `plan-compile/*.json`'s `moves` field serialize as PascalCase `Removed`/
  `Added` (each holding snake_case `start_line`/`end_line`) — Go's
  `detectedMove` struct has no `json:` tags, so it fell back to default
  Go-exported-field casing, unlike every other vector's deliberate
  snake_case. This is a fact about the frozen oracle, not a hazard to "fix" —
  `conformance.test.ts` already normalizes both sides before comparing
  (`normalizeMove`/`normalizeVectorMove`). Anyone writing additional
  hand-authored fixtures against these two vector shapes should know the
  casing is inconsistent on purpose (frozen, not stylistic).
