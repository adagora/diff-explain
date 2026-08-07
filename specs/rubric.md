# rubric

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `meat/rubric.go`
> Go tests: `meat/meat_test.go` (frozen prompt surface, protocol hash);
> `meat/rubric_e2e_test.go` (3 tests, costed/stochastic, opt-in live-LLM)

## Purpose

The system prompt, the protocol version, and the complete enumerable,
hashable model-visible surface (`promptSurface()` / `RubricHash()`). This
subject is the design contract that every string the model can ever see is
known, frozen, and free of "compiler-internal" vocabulary that would leak
implementation detail the model has no business reasoning about. Live e2e
tests also calibrate that a real model under this rubric produces reading
diffs meeting semantic minima, import absence, retention ceilings, and
no-semicolon-packing readability.

## Vocabulary

- **Protocol version** (`abridgeProtocolVersion`, `meat/rubric.go:13`) — a
  string manually bumped when the *edit semantics* of the submit schema
  change (not just prose wording), mixed into `RubricHash` too
  (`meat/rubric.go:68`).
- **Frozen prompt surface** — the design invariant that every string the
  model can see is enumerable and hashable via `promptSurface()`, and must
  never leak "compiler-internal" conflict-arbitration vocabulary — conflicts
  are explained only via plan-specific feedback when a real plan hits a
  real conflict (`meat/rubric.go:183-191`).
- **`promptSurface`** — the function (`meat/rubric.go:62-124`) that renders
  every static model-visible string through the real production builders
  (not a manifest/list) over canonical fixtures, concatenated with NUL-byte
  separators, for hashing. Hashing rendered output means both rewording and
  recomposition of the surface changes the hash.
- **Move (detected move)** — see `moves.md`; rendered to the model as
  coordinate pairs like `-6..9 ↔ +16..19` (`meat/moves.go:474`).
- **Live-LLM rubric e2e** — opt-in smoke tests gated by env `MEAT_E2E=1`;
  they call a real model via env credentials and assert semantic minima /
  ceilings, not golden bytes. Skip message:
  `set MEAT_E2E=1 to run the live-LLM rubric test`
  (`meat/rubric_e2e_test.go:22-23`).
- **Semantic minimum** — a load-bearing retained substring (or any-of set
  of alternatives) that a live reading diff must contain; deliberately
  looser than hermetic golden plans.
- **Semicolon packing** — cramming several statements onto one added (`+`)
  line with `;` instead of dropping uninteresting lines. Live rule: any
  added line containing `;` fails, except `for ` loops and `;` only inside
  a trailing `//` comment (`meat/rubric_e2e_test.go:346-363`).

## Guarantees

G1. The complete model-visible protocol surface — the system prompt, every
    branch of the user prompt (with/without repo root, with/without
    detected moves), the no-tool-call nudge, every tool's
    name/description/schema, and every plan-feedback branch (moves / plain
    / high-pressure) — must never contain "compiler-internal arbitration"
    vocabulary: `mandatory`, `compiler`, `precedence over`, `import
    precedence`, `hiding wins`, `wins before`, `counterpart`,
    `compiler-owned`, `arbitrat` (substring, case-insensitive).
    — `meat/meat_test.go:646-690` (`TestPromptSurfaceStaysFrozen`, iterates
    all surfaces and fails on any banned substring). Mechanism/policy:
    `meat/rubric.go:183-191` (doc comment on `systemPrompt` stating this as
    a design invariant), rendered surface built by `promptSurface()`
    (`meat/rubric.go:62-124`).

G2. Despite the vocabulary ban in G1, the surfaces must still state the
    load-bearing guidance the model acts on. Specifically: `systemPrompt`
    must contain the literal strings `"IMPORTS ARE REMOVED AUTOMATICALLY"`,
    `"TREAT BEHAVIORAL MOVES SYMMETRICALLY"`, and `"NEVER invent or alter
    program logic"`; the with-tools/root user prompt must contain `"removed
    automatically"`, the exact rendered move-pair `"-6..9 ↔ +16..19"` for
    the canonical move fixture, and `"identical keep/remove/fold/replace
    treatment"`.
    — `meat/meat_test.go:695-713`. Mechanism: `meat/rubric.go:216` (imports
    rule), `218` (moves rule), `220` (never-invent rule); `meat/meat.go:243`
    (`userPromptImports`), `244` (`userPromptMoves` template).

G3. `numberedDiff` prefixes every physical line of the original diff with a
    `N|` gutter (1-based) and produces no phantom trailing numbered line
    even when the input has no trailing newline — the exact form the model
    sees in the user prompt.
    — `meat/meat_test.go:716-727` (3-physical-line, no-final-newline diff
    renders exactly `1|`, `2|`, `3|`; must not contain `4|`). Mechanism:
    `meat/diff.go:126-137` (`numberedDiff`); see `diff.md` G5 for the
    generic guarantee.

G4. `RubricHash()` returns a 16-character hex string (an 8-byte SHA-256
    prefix) and is deterministic within a process (repeated calls with no
    state change return the same value).
    — `meat/meat_test.go:730-737`. Mechanism `meat/rubric.go:175-178`.

G5. The canonical fixtures used to render the hashed prompt surface must
    actually exercise the branches they're meant to: `surfaceFixtureDiff`
    must trigger move detection (&gt;0 detected moves), `surfaceFixtureNoMoveDiff`
    must trigger none, and `surfaceOverflowDiff()` must detect strictly more
    moves than `maxMoveHints` (12) so the prompt's overflow phrasing
    (`"and N more"`) actually renders in the hashed surface.
    — `meat/meat_test.go:751-761`. Mechanism: `meat/moves.go:441-448`
    (`detectedMovesInDiff`), `meat/moves.go:14` (`maxMoveHints`), overflow
    phrasing at `meat/moves.go:476-478`.

G6. The complete protocol surface hash is pinned to the literal value
    `441f5e6e28ad3add`; any change to any static model-visible string
    (system prompt, user-prompt fragments, tool descriptions/schemas, the
    nudge, or plan-feedback fragments) changes this hash and must be a
    deliberate, reviewed update of the pin (and a bump of
    `abridgeProtocolVersion` if edit semantics — not just wording —
    changed).
    — `meat/meat_test.go:763-768` (`TestRubricHashPinned`). Mechanism:
    `meat/rubric.go:13` (`abridgeProtocolVersion`, currently
    `"source-edit-plan-v10-frozen-prompt-surface"`), mixed into the hash at
    `meat/rubric.go:68`.

### Live-LLM calibration (opt-in, stochastic — `rubric_e2e_test.go`)

**Nature of G7–G12:** They hold only when the tests are actually run
(`MEAT_E2E=1` and a model constructible from env). They are **stochastic
smoke / calibration** pins: they can flake under model drift; they
intentionally do **not** require hand-authored golden plans or exact
fold/remove layouts. Default CI does not enforce them.

G7. **Env and model gates for live rubric e2e.** Every live rubric e2e
    test skips unless env `MEAT_E2E` is exactly `"1"`, with message
    `set MEAT_E2E=1 to run the live-LLM rubric test`. If model construction
    from env fails, the test skips with `no LLM available: %v` (not a hard
    fail). Model is constructed with an empty model id so resolution uses
    env/default (`NewModelFromEnv(ctx, "")`).
    — `meat/rubric_e2e_test.go:22-29`, `:158-165`, `:304-311`. Mechanism:
    `meat/provider.go:29-36` (`NewModelFromEnv` → Anthropic for `claude-*`,
    else OpenAI); model id resolution `meat/provider.go:12-26`
    (`$MEAT_MODEL` then default).

G8. **Import blocks are absent from the live reading diff even for
    security-relevant package swaps; behavioral body evidence is kept.** On
    a full live `Abridge` of a Go `token.go` unified diff that swaps
    `math/rand` → `crypto/rand` + `encoding/hex` and rewrites `NewToken` to
    use `rand.Read` / `hex.EncodeToString`, the SmartDiff must **not**
    contain any of: `import (`, `"math/rand"`, `"crypto/rand"`,
    `"encoding/hex"`, `"fmt"`; and **must** contain `rand.Read`.
    — Fixture: inline unified diff for `a/token.go` / `b/token.go`, hunk
    `@@ -1,14 +1,15 @@`, package `auth`
    (`meat/rubric_e2e_test.go:32-56`). Request is only
    `{UnifiedDiff: diff}` (`:57`). Fail messages:
    `import scaffolding %q was kept:\n%s` (`:65`);
    `behavioral body change (rand.Read) was lost:\n%s` (`:69`).
    — `meat/rubric_e2e_test.go:31-71`
    (`TestRubric_ImportsAlwaysHidden` / `"security package swap hidden,
    behavior kept"`). End-to-end path: `Abridge` `meat/meat.go:115`;
    guidance mirrored in system prompt example with the same package swap
    (`meat/rubric.go:341`); mandatory import stripping
    `meat/imports.go:156-250` / `meat/editplan.go:180`.

G9. **Boring stdlib import churn is dropped; multi-part behavioral body
    changes are all kept (conjunction, not disjunction).** On a live
    abridge of a Go `util.go` diff that adds `"sort"` / `"strings"` and
    changes `Join` from `fmt.Sprint` to `sort.Strings` + `strings.Join`,
    SmartDiff must contain none of `import (`, `"fmt"`, `"sort"`,
    `"strings"`, and must contain **both** `sort.Strings` and
    `strings.Join`.
    — Fixture: `a/util.go` / `b/util.go`, hunk `@@ -1,9 +1,12 @@`, package
    `util` (`meat/rubric_e2e_test.go:74-91`). Fail messages:
    `import scaffolding %q was kept:\n%s` (`:99`);
    `behavioral change sort.Strings was lost:\n%s` (`:105`);
    `behavioral change strings.Join was lost:\n%s` (`:108`).
    — `meat/rubric_e2e_test.go:73-110`. Same end-to-end `Abridge` + import
    compiler as G8.

G10. **Embedded import statements inside multiline source fixtures are
     hidden; the surrounding control/behavior skeleton is retained (not
     byte-identical call sites).** On a live abridge of a new-file Python
     pytest plugin test that embeds `import warnings` / `import pytest`
     inside a triple-quoted `makeconftest` string, SmartDiff must not
     contain `import warnings` or `import pytest`, and must contain all of:
     `@pytest.hookimpl`, `def pytest_configure`, `warnings.warn(`,
     `pytester.runpytest`, `assert result.ret == 0`. Warning message prose
     and warning category arguments are **explicitly allowed** to be
     locally elided (test comment: do not require hand-authored call
     byte-for-byte).
     — Fixture: `a/test_plugin.py` / `b/test_plugin.py`, hunk
     `@@ -0,0 +1,13 @@` (`meat/rubric_e2e_test.go:112-129`). Fail messages:
     `embedded import %q was kept:\n%s` (`:136`);
     `embedded behavior %q was lost:\n%s` (`:144`).
     — `meat/rubric_e2e_test.go:111-147`. Rubric principle 6 explicitly
     includes “import statements inside embedded source snippets or
     multiline test-fixture strings” (`meat/rubric.go:216`).

G11. **Live model on the three Python famous-commit fixtures meets
     calibrated semantic minima, unconditional import absence, and broad
     retention ceilings — without matching hermetic golden plans.** For
     each case, the test reads `testdata/python/<fixture>` relative to the
     package, runs live `Abridge` on the raw unified diff, then asserts:

     1. **mustContain** — every listed substring is present in SmartDiff;
        fail `missing semantic minimum %q:\n%s`
        (`meat/rubric_e2e_test.go:264-267`).
     2. **semanticMinimums** — for each named group, **at least one** of
        the `any` alternatives is present; fail
        `missing semantic minimum %q (want any of %q):\n%s` (`:269-279`).
     3. **importsMustBeGone** — none of the listed import/scaffolding
        substrings appear; fail
        `compiler-owned import scaffolding %q survived:\n%s` (`:281-284`).
     4. **Retention ceiling** — fixture must have `rawChanged > 0` else
        fatal `live fixture has no changed rows` (`:286-288`); if
        `keptChanged*100 > rawChanged*maxRetention`, fail
        `retained %d/%d changed rows (%d%%), want at most %d%%`
        (`:293-294`). Success path only logs
        `live retention: %d/%d changed rows (%d%%; ceiling %d%%)` (`:292`).

     **Per-case pins** (`meat/rubric_e2e_test.go:179-250`, runner
     `:253-296`):

     | Case | Fixture | maxRetention | mustContain (all) | semanticMinimums (any-of) | importsMustBeGone |
     |---|---|---:|---|---|---|
     | django 526b1b414d8e | `django-526b1b414d8e.diff` | **80** (observed ~62–75%) | `def split_header_value`, `value.split(sep)`, `part.strip()`, `yield stripped` | (1) migrated call site: ``split_header_value(response.get("Cache-Control"`` **or** ``split_header_value(response.headers["Cache-Control"]`` **or** `newheaders = [newheader.strip() for newheader in newheaders]`; (2) executable outcome: `self.assertNotEqual(key_a, key_b)` **or** ``split_header_value(value, sep=";")`` **or** ``header.lower() != "no-store"`` | `from django.utils.cache import`, `from django.utils.http import`, `-    cc_delim_re,`, `+    get_max_age,`, `+    split_header_value,` |
     | flask c17f37939073 | `flask-c17f37939073.diff` | **90** (~75–86%) | `def session(self) -> SessionMixin`, `self._session.accessed = True`, `return self._session`, `accessed = False` | (1) internal path: `ctx._session` **or** `session=self._session` **or** `if self._session is None`; (2) access-tracking effect: `request_ctx._session.accessed` **or** ``"cookie" in rv.vary`` **or** `sets session.accessed` | `from flask.globals import`, `from flask.testing import` |
     | pytest b4e846616cbb | `pytest-b4e846616cbb.diff` | **90** (~66–84%) | `def _catch_configured_warnings`, ``self.getini("filterwarnings")``, ``self._catch_configured_warnings(record=False)``, ``config._catch_configured_warnings(record=record)``, `filterwarnings =`, `warnings.warn(` | (1) warnings-plugin lifecycle: ``pluginmanager.hasplugin("warnings")`` **or** `pytest_configure.call_historic`; (2) no-warning outcome: `assert_outcomes(passed=1)` **or** `no_fnmatch_line` | `from contextlib import ExitStack`, `import sys`, `from _pytest.config import apply_warning_filters`, `        import warnings`, `        import pytest` |

     Explicit non-requirements: does **not** require reproduction of
     hand-authored golden plans; exact folds/removals/retention of the
     hermetic suite are out of scope (`meat/rubric_e2e_test.go:150-156`).
     — `meat/rubric_e2e_test.go:157-298`
     (`TestRubric_PythonGoldenCommits`). Fixtures under
     `meat/testdata/python/`. Stats: `diffStats` / `retainedDiffStats`
     `meat/elision.go:36-47`, `:53+`. Full pipeline: `Abridge`
     `meat/meat.go:115`.

G12. **Live abridging must keep load-bearing control/error-path evidence
     and must not semicolon-pack multiple statements onto one added line.**
     On a live abridge of a Go `serve.go` plumbing-heavy diff (host
     override, default port 8080, `net.Listen`, wrapped `fmt.Errorf`, then
     `http.Serve`), SmartDiff must contain all of: `net.Listen`,
     `override != ""`, `port = 8080`, `fmt.Errorf`. Diagnostic message
     **arguments** may be kept verbatim or locally elided. Separately,
     every SmartDiff line starting with `+` is scanned: after stripping the
     leading `+` and trimming, if the body does not start with `for `, and
     after cutting a trailing `//` comment, the body must not contain `;`.
     Fail: `semicolon-packed line (should drop lines, not cram them):\n%s\nfull:\n%s`.
     Meaningful-line fail: `meaningful line %q was lost:\n%s`.
     — Fixture: `a/serve.go` / `b/serve.go`, hunk `@@ -10,3 +10,16 @@`,
     function `Serve(cfg Config, override string) error`
     (`meat/rubric_e2e_test.go:313-333`).
     — `meat/rubric_e2e_test.go:303-365`
     (`TestRubric_NoSemicolonPacking`). Rubric: keep error control flow /
     fact of erroring, elide noisy message args (`meat/rubric.go:210`);
     never invent semicolon-packed substitutes for dropped lines
     (`meat/rubric.go:349`).

## Mechanism

`rubric.go` has two responsibilities: it holds the one large literal,
`systemPrompt` (`meat/rubric.go:192-357`), sent to the model verbatim every
run, and it assembles and hashes the **complete** model-visible surface via
`promptSurface()` / `RubricHash()` so that surface can be pinned by a test
(G6) and mixed into the on-disk cache key. `promptSurface()` is unexported;
the only cross-package entry point is `RubricHash()` (`meat/rubric.go:175-178`),
consumed by `cmd/meat/main.go:160` to build the cache key. `promptSurface()`'s
output is also dumped verbatim to a conformance fixture (`prompt-surface.txt`,
`meat/conformance_dump_test.go:119`) — a likely cross-implementation
comparison point for the port.

### `promptSurface()`: what gets hashed, in what order

`promptSurface()` (`meat/rubric.go:62-124`) builds one string by
concatenating a fixed, hand-enumerated sequence of fragments, each rendered
through the **real** production builders (never a separate "prompt
manifest") over a small set of canonical fixtures (design rationale at
`meat/rubric.go:48-56`). Fragments are joined by a single `0x00` byte: the
very first fragment (the protocol version) has no leading separator
(`meat/rubric.go:68`); every fragment after it is preceded by exactly one
`0x00` byte via the `add` closure (`meat/rubric.go:64-67`); there is no
trailing separator after the last fragment. The exact ordered sequence:

1. `abridgeProtocolVersion`, the protocol-version literal
   (`meat/rubric.go:13,68`).
2. `systemPrompt`, the entire rubric prose (`meat/rubric.go:69`; text at
   `192-357`).
3. Four renderings of the user prompt via the real `buildUserPrompt`
   (`meat/meat.go:250-270`), one per combination of {canonical surface move
   fixture (`surfaceFixtureDiff`), `surfaceFixtureNoMoveDiff`} ×
   {`RepoRoot: "/repo"`, no repo root} (`meat/rubric.go:71-76`). These four
   calls are what make every branch of `buildUserPrompt` actually land on
   the hashed surface: the moves paragraph (only when `len(moves)>0`,
   `meat/meat.go:258`) and the tools-vs-no-tools paragraph (branching on
   `req.RepoRoot != ""`, `meat/meat.go:261-264`).
4. `noToolCallNudge`, the fixed nudge text (`meat/rubric.go:77`).
5. Every tool's `Name`, `Description`, and `InputSchema` (schema included
   as its literal source text via `string(tool.InputSchema)`, never
   re-encoded), for two toolbox configurations in turn: `root: "/repo"`
   (yields `read_file`, `grep`, `preview_plan`, `submit`;
   `meat/tools.go:88-101`) then `root: ""` (yields only `preview_plan`,
   `submit`; `meat/tools.go:85-86`) — `meat/rubric.go:79-88`.
   `preview_plan`/`submit` are textually identical in both configurations,
   so this covers all four distinct tool texts once each plus a harmless
   repeat of two.
6. One rendering of the user prompt over `surfaceOverflowDiff()` (no repo
   root) (`meat/rubric.go:90-94`) — the only place the move-hint "and N
   more" overflow phrasing enters the hashed surface.
7. Plan feedback for the canonical surface move fixture, with a plan that
   folds both sides of its one move (source lines 6-9 and 16-19) —
   rendered by calling the real `(*toolbox).previewPlan` on a fresh
   `toolbox{rawDiff: surfaceFixtureDiff}` (`meat/rubric.go:99-104`). On
   error, `promptSurface()` panics with `"meat: promptSurface fixture
   plan: " + moveFeedback` (`meat/rubric.go:102`) instead of returning it.
8. Two more plan-feedback strings built by calling `planFeedback` +
   `truncateForTool` directly (bypassing `previewPlan`/`submit` and their
   input validation — no plan is actually compiled) on bare
   `compiledPlan{stats: planStats{...}}` values with `moves`/`smartDiff`
   left at zero value: `{rawChanged:10, visibleChanged:4, rawFiles:1,
   visibleFiles:1}` and `{rawChanged:100, visibleChanged:90, rawFiles:2,
   visibleFiles:2}` (`meat/rubric.go:105-107`). These exist purely to put
   the two pressure phrasings (`feedbackPressureOK`/`feedbackPressureHigh`,
   `meat/tools.go:260-261`) on the surface; because `moves` is empty
   neither string contains a "Moves:" line, and because `smartDiff` is
   `""` both end with the bare "Preview (...):\n" header.
9. Preview feedback for an empty ("identity") plan against
   `surfaceOversizeDiff()`, via a fresh
   `toolbox{rawDiff: surfaceOversizeDiff()}`'s real `previewPlan`
   (`meat/rubric.go:111-116`) — sized so the preview text is forced
   through `truncateForTool`'s truncation path, putting the
   truncation-marker text itself on the surface. Panics with `"meat:
   promptSurface oversize preview: " + oversizeFeedback` on error
   (`meat/rubric.go:114`).
10. Submit feedback for the same identity plan against a second,
    independently constructed `toolbox{rawDiff: surfaceOversizeDiff()}`
    (`meat/rubric.go:117`), via the real `submit` handler. Panics with
    `"meat: promptSurface oversize submit: " + submitFeedback` on error
    (`meat/rubric.go:120`).

Steps 7, 9, 10 go through the real `toolbox` handlers and so also
implicitly exercise move detection, mandatory import removal, and
plan-compilation validation on their fixtures (`meat/editplan.go:165-180`);
step 8 reaches only the feedback-string template.

Deliberately excluded from the surface: plan-specific validation/conflict
error text — the messages a model sees only when its own submitted plan is
rejected (`meat/rubric.go:57-61`). Hashing those would invalidate every
cache entry whenever the compiler's rejection rules are merely tightened,
even though the standing instructions did not change.

### `surfaceOverflowDiff()` (`meat/rubric.go:126-156`)

Builds a synthetic two-file diff containing `maxMoveHints + 2` (14, since
`maxMoveHints` is 12 at `meat/moves.go:14`) textually distinct move blocks,
so move detection reports more moves than the prompt's hint cap and the
overflow branch renders:

1. For `i` in `0..blocks-1`: emit three `-`-marked lines assigning
   `alphaI`/`betaI`/calling `publishResultI`, each embedding `i` so no two
   blocks are byte-identical (this is what keeps 14 blocks from merging
   into fewer detected moves) — mirrored as three `+`-marked lines.
   Between blocks (not after the last), insert one identical
   `" separatorI\n"` context line into both streams, breaking each block
   into its own contiguous run (`meat/rubric.go:131-144`).
2. `seps = blocks - 1` (13).
3. Emit `old.txt`'s hunk `@@ -1,X +1,Y @@` with `X = 1 + 3*blocks + seps`,
   `Y = 1 + seps` (`meat/rubric.go:146-150`).
4. Emit `new.txt`'s hunk `@@ -1,Y +1,X @@` — counts swapped, since
   `new.txt` gains what `old.txt` lost (`meat/rubric.go:151-154`).

### `surfaceOversizeDiff()` (`meat/rubric.go:158-169`)

Builds a synthetic new-file diff for `big.txt` with `rows = maxToolOutput /
8` (2048, `maxToolOutput = 16*1024` at `meat/tools.go:19`) added lines,
each `"+row %d\n"` — sized so even an identity plan's preview exceeds
`maxToolOutput` bytes and must be truncated by `truncateForTool`
(`meat/tools.go:350-359`).

### `RubricHash()` (`meat/rubric.go:175-178`)

Computes SHA-256 over the UTF-8 bytes of `promptSurface()`'s return value
and returns the **first 8 bytes** (16 hex characters), hex-encoded. Takes
no arguments, has no side effects; every call re-renders the whole surface
from scratch (no memoization).

## Invariants

- Fragment order inside `promptSurface()` is a fixed literal sequence —
  every loop ranges a slice literal (`meat/rubric.go:79,83`), never a map —
  so the concatenation, and therefore `RubricHash()`, is byte-for-byte
  deterministic within one build. Breaking this would make G6's pinned
  hash flap between runs for no content reason.
- Fragments are separated by exactly one `0x00` byte, prefixed before
  every fragment but the first (`meat/rubric.go:64-68`). Dropping the
  separator (bare concatenation) lets two different fragment pairs whose
  boundary text coincides hash identically, masking a real wording change
  from G6.
- The three real-handler round-trips are asserted with `panic`, not a
  returned `error` (`meat/rubric.go:100-103,112-115,118-121`). Since
  `RubricHash()` runs unconditionally on every `cmd/meat` invocation's
  cache-key path (`cmd/meat/main.go:160`), a broken fixture crashes the
  whole CLI, not just a test — a stronger failure mode than an ordinary Go
  error and must be reproduced as an unconditional throw in the port, not
  a caught/logged warning.
- The two hand-picked stats pairs at `meat/rubric.go:106-107` must remain
  on opposite sides of `retentionPressure`'s threshold
  (`meat/tools.go:248-252`: false when `rawChanged<40 || visibleChanged<20`,
  else true when `visibleChanged>=80` or `visibleChanged*100 >=
  rawChanged*45`) for both pressure phrasings to appear on the surface.
  Today `{10,4}` and `{100,90}` do straddle it. Nothing enforces this
  pairing (see "Uncovered mechanism" in Open questions) — if the formula
  changes, `promptSurface()` keeps returning a well-formed hash while
  silently dropping one phrasing from the surface.
- `surfaceFixtureDiff`/`surfaceFixtureNoMoveDiff` must keep triggering
  (respectively) ≥1 and exactly 0 detected moves, and
  `surfaceOverflowDiff()` must keep detecting strictly more than
  `maxMoveHints` moves, or `promptSurface()` silently stops exercising the
  branch each fixture exists for (G5; the one fixture-coverage property
  that *is* independently tested, `TestSurfaceFixturesCoverBothMoveBranches`,
  `meat/meat_test.go:751-761`).

## Hazards

- **H1** (byte vs. UTF-16 semantics, critical): `RubricHash()` hashes
  `[]byte(promptSurface())` — the UTF-8 byte encoding of the concatenated
  surface — at `meat/rubric.go:176`. A port must feed SHA-256 the UTF-8
  bytes of the equivalent concatenation, not a UTF-16-derived byte view,
  or digests diverge for any surface fragment containing non-ASCII text.
  Nothing constrains the embedded fixtures to ASCII, so this is latent,
  not merely theoretical.
- **H4** (`json.RawMessage` byte-preservation): applies at
  `meat/rubric.go:86`, `add(string(tool.InputSchema))` — each tool's JSON
  schema enters the hash as literal source bytes, never re-serialized. A
  port that parses `InputSchema` into an object and re-stringifies before
  hashing will reorder keys/whitespace and diverge from Go's byte-exact
  text — breaking hash comparability, and contradicting the "hash
  rendered output, not a manifest" design at `meat/rubric.go:52-55`.
- **H8** (integer division): `meat/rubric.go:161`, `rows := maxToolOutput
  / 8`. Divides evenly today (2048) so no observable divergence, but the
  port must still truncate rather than float-divide, per H8's blanket
  rule, in case `maxToolOutput` changes to a value not divisible by 8.
- **H7 / H13 checked — neither applies**: no `sort` call and no Go-map
  iteration anywhere in `promptSurface()`, `surfaceOverflowDiff()`, or
  `surfaceOversizeDiff()` — every loop ranges a slice literal or an
  integer counter. Fragment order and both synthetic fixtures are already
  fully deterministic in Go, which is why G6 can pin a literal hash; there
  is no reachable tie or iteration-order choice for the port to resolve
  here.

## Errors

All three failure modes in this file are `panic`, not returned `error`s —
internal self-checks that a canonical fixture still round-trips through
the real plan handlers, not a user-facing validation path. Grepped across
every `_test.go` file: none of these three strings is asserted by any
test.

- `"meat: promptSurface fixture plan: " + moveFeedback` — the canonical
  move fixture's fold-both-sides plan was rejected by `previewPlan`
  (`meat/rubric.go:100-103`).
- `"meat: promptSurface oversize preview: " + oversizeFeedback` — the
  empty identity plan was rejected by `previewPlan` over
  `surfaceOversizeDiff()` (`meat/rubric.go:112-115`).
- `"meat: promptSurface oversize submit: " + submitFeedback` — the same
  identity plan was rejected by `submit` over a fresh
  `surfaceOversizeDiff()` toolbox (`meat/rubric.go:118-121`).

Any of these three is effectively a CLI-wide crash (see Invariants), since
`RubricHash()` runs unconditionally in the cache-key path.

## Ordering that Go leaves unspecified

None. No `sort` call and no Go-map iteration anywhere in `rubric.go` —
every loop ranges a slice literal or an integer counter (see H7/H13 note
under Hazards).

## Open questions

- G7–G12 cannot replace G1–G6 or the hermetic Python golden suite; a port
  that only runs hermetic tests will not exercise live model compliance
  with the rubric.
- The e2e tests observe SmartDiff after the full pipeline (model plan +
  compiler mandatory import removal). They do not isolate whether the model
  omitted import coordinates or the compiler stripped them. Production
  design says both: model is told not to target imports
  (`meat/rubric.go:216`) and compiler always removes them
  (`meat/imports.go:156-250`). Hermetic import tests own the compiler half.
- Retention floors absent: only upper ceilings are asserted. A model that
  over-elides semantic content fails via `mustContain` / `semanticMinimums`,
  not via a minimum retention %.
- No cost budget constant in code: cost is controlled operationally
  (opt-in env), not by a named token/dollar limit in these tests.
- Provider/model identity not pinned: empty model string → whatever
  `ResolveModel` selects; behavior of G8–G12 can vary by configured model.
- Semicolon rule language-scope: scan is applied to the whole SmartDiff of
  a Go fixture; exemption is only `for `-prefixed added lines. No live e2e
  pin for other languages’ statement separators.
- The port's equivalent of `RubricHash`/`abridgeProtocolVersion` needs to
  decide whether the pinned hash value itself is meaningful to preserve
  (it almost certainly is not, since the port's exact string bytes for
  prompts may differ) — flagging so stage 3 doesn't assume the literal hex
  string `441f5e6e28ad3add` must be reproduced.
- **Reconciliation finding (stage 2):** `TestPromptSurfaceStaysFrozen`
  (G1's banned-vocabulary scan) reconstructs its own hand-rolled `surfaces`
  map (`meat/meat_test.go:660-681`) rather than calling `promptSurface()`
  directly, and that hand-rolled set omits three fragments
  `promptSurface()`/`RubricHash()` actually render: the no-repo-root/no-move
  user-prompt branch, the move-overflow user-prompt branch, and the
  oversize preview/submit truncation-marker branches. A banned word
  introduced only inside one of those three would still change
  `RubricHash()` (tripping G6) but would not be directly caught by G1's
  automated scan. G1 as literally tested is narrower than the mechanism it
  describes — not a source/guarantee contradiction, but a coverage gap
  worth closing if the port carries this test forward.
- **Uncovered mechanism** (no guarantee constrains these; a port could
  break them with no test failing):
  1. The NUL-byte join discipline between fragments (`meat/rubric.go:64-68`)
     — G6 only detects *that* something changed, not *how* fragments are
     joined.
  2. `surfaceOverflowDiff()`/`surfaceOversizeDiff()`'s internal
     construction (hunk-header arithmetic, separator placement, row
     sizing) — exercised only indirectly through G5 (move count) and G6
     (hash pin).
  3. The three panic message strings (`meat/rubric.go:102,114,120`) are
     unpinned by any test.
  4. The pressure-branch stats coupling between `meat/rubric.go:106-107`
     and `retentionPressure`'s threshold (`meat/tools.go:248-252`) — see
     Invariants above.
  5. `abridgeProtocolVersion`'s bump discipline (`meat/rubric.go:10-13,61`)
     — the human-process rule ("bump only on schema/semantic change, not
     wording") is unenforced by any test, only indirectly covered via G6's
     hash.
- No dead or unreachable code was found in `rubric.go`; the three `panic`
  sites are reachable-but-should-never-fire defensive self-checks, not
  dead code.
