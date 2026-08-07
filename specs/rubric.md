# rubric

> Status: stage 1 ✅ | stage 2 ⬜
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
