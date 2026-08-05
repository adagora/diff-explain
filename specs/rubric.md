# rubric

> Status: stage 1 🟡 | stage 2 ⬜
> Go sources: `meat/rubric.go`
> Go tests: `meat/meat_test.go` (frozen prompt surface, protocol hash); `meat/rubric_e2e_test.go` (3 tests, costed/stochastic, opt-in) not yet processed

## Purpose

The system prompt, the protocol version, and the complete enumerable,
hashable model-visible surface (`promptSurface()` / `RubricHash()`). This
subject is the design contract that every string the model can ever see is
known, frozen, and free of "compiler-internal" vocabulary that would leak
implementation detail the model has no business reasoning about.

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

## Open questions

- This fragment covers only what `meat_test.go` pins about the prompt
  surface as a whole. `rubric_e2e_test.go` (costed, opt-in, stochastic —
  see `test-infrastructure.md`) is not yet processed and may add
  calibration-level guarantees about how the model behaves *given* this
  rubric, as opposed to the rubric's own frozen text.
- The port's equivalent of `RubricHash`/`abridgeProtocolVersion` needs to
  decide whether the pinned hash value itself is meaningful to preserve
  (it almost certainly is not, since the port's exact string bytes for
  prompts may differ) — flagging so stage 3 doesn't assume the literal hex
  string `441f5e6e28ad3add` must be reproduced.
