# python

> Status: stage 1 ✅ | stage 2 ⬜
> Go sources: `meat/python.go`
> Go tests: `meat/editplan_test.go` (Python-specific validation cases), `meat/chunk_test.go` (continuation/owner atomicity across cuts)

## Purpose

Python-aware plan validators, applied on top of the language-agnostic
structural rules in `editplan.md`. They are conservative and text-level:
rather than parsing Python, they recognize a fixed set of syntactic
signatures (suite headers, decorators, triple-quoted strings, backslash
continuations, bracket nesting) and reject any plan operation that would
leave one of them structurally broken. When in doubt, they reject rather
than guess.

## Vocabulary

- **Suite owner / suite header** — a Python line ending in `:` that opens an
  indented block: `def`, `async def`, `class`, or a control-flow keyword
  (`if`, `elif`, `for`, `while`, `with`, `except`, `except*`, `match`, `case`,
  `async for`, `async with`, bare `else:`/`try:`/`except:`/`finally:`).
  `meat/python.go:756-777,787-790`.
- **Structural anchor** — the decorator line or the suite-header line itself,
  as distinct from its body/argument interior; folds and replacements may
  compress the interior but must leave the anchor line untouched.
- **Orphaned body** — a suite owner's indented body line(s) left visible
  after the owning header line has been hidden. Rejected by
  `validateHiddenPythonOwners` (`meat/python.go:25-52`).
- **Bare suite owner** — a retained suite-header line whose entire raw body
  has been removed (not folded), leaving no indented content at all.
  Rejected by `validatePythonSuiteSkeleton` (`meat/python.go:238-275`).
- **Boundary tokens** — the bracket and triple-quote characters `(` `)` `[`
  `]` `{` `}` `'''` `"""`, whose per-character count a replacement must not
  change even when otherwise a valid elision. `changesPythonBoundaryTokens`
  (`meat/python.go:16-23`).
- **Delimiter balance** — the net count of `(`/`[`/`{` minus `)`/`]`/`}`,
  tracked independently per bracket kind, across a hunk's old-side and
  new-side text; hiding lines must not change this balance from the raw
  hunk. `pythonDelimiters` (`meat/python.go:379-519`).
- **Triple-quote parity** — whether a hunk's old-side/new-side text ends
  inside or outside a `'''`/`"""` string, tracked as a 3-state machine
  (none/single/double); hiding lines must not change this end-state.
  `meat/python.go:582-693`.
- **Backslash continuation** — a Python line ending in an odd count of
  (non-string, non-comment) backslashes, logically joined to the next
  physical line; both must be hidden or retained together.
  `meat/python.go:521-580`.
- **Reference guard / hidden definition** — a simple assignment target
  (`name = ...` or `self.attr = ...`) cannot be hidden while another
  retained line in the same file (any hunk) still references that
  identifier. `validateHiddenReferences` (`meat/python.go:195-236`); target
  extraction `simpleAssignedReference` (`meat/python.go:804-828`).
- **Fold-aware scanning** — the owner/body lookup helpers
  (`pythonSuiteHeaderEnd`, `hasPythonBodyAfter`, `hasPythonDefinitionAfter`)
  accept an optional plan state and specifically special-case folded lines
  rather than treating them as ordinary hidden lines, so a folded body still
  counts as "a body". `meat/python.go:277-372`.

## Guarantees

### File-scoping

G1. Every Python-specific structural check applies only to lines classified
    as Python (`layout.python[i]`), driven by file-extension/path detection
    on the diff header or `---`/`+++` markers (`.py`/`.pyi`); source in
    another language that merely resembles Python (e.g. Objective-C
    `@interface Foo` / `@end`) is never subject to decorator/suite-owner/
    triple-quote/delimiter checks, even though it starts with `@`.
    — `meat/editplan_test.go:151-156`, pinned against `meat/diff.go:220-221`
    (`layout.python[i] = currentLanguage == sourceLanguagePython`),
    `pathLanguage` (`meat/diff.go:427-451`), gates at e.g.
    `meat/python.go:28,66,199,241`.

### Decorators and suite owners — hiding, detachment, and body requirements

G2. A retained Python suite owner must keep at least one line of indented
    body; removing all of its raw body lines while keeping the header is
    rejected — `"...suite owner on line %d has no indented body; keep a
    semantic body line or an interior fold"` — but folding those same lines
    (leaving an indented ellipsis) satisfies the requirement. A comment-only
    remaining line does not count as a body.
    — `meat/editplan_test.go:81-99,268-278,349-355`, pinned against
    `validatePythonSuiteSkeleton` (`meat/python.go:238-275`, error at 267),
    body-detection `hasPythonBodyAfter` (`meat/python.go:308-333`,
    comment/blank skip at 327, fold branch 312-317).

G3. A retained Python decorator with no attached `def`/`async def`/`class`
    immediately following it (skipping only its own multi-line argument list
    and further stacked decorators, tracked via delimiter depth) is
    rejected — `"...decorator on line %d has no attached definition"` —
    whether the decorator is on a `+` line, a multi-line decorator call, or
    an unchanged context line.
    — `meat/editplan_test.go:125-134,200-205,234-242`, pinned against
    `validatePythonSuiteSkeleton` (`meat/python.go:249-254`),
    `hasPythonDefinitionAfter` (`meat/python.go:335-372`, argument-depth skip
    355-361, decorator restack 365-368).

G4. A hunk consisting of a single changed definition line with no
    surrounding context and no body anywhere in the hunk ("zero-context
    signature-only hunk") is a valid identity plan — the body requirement
    (G2) only fires when the raw hunk actually has a body to preserve.
    — `meat/editplan_test.go:244-247`, pinned against
    `validatePythonSuiteSkeleton`'s gate on `hasPythonBodyAfter(..., nil,
    ...)` (`meat/python.go:264`).

G5. Removing (or folding) a Python suite-owner line — including a context
    (unchanged) owner line — while any part of its body remains visible is
    rejected: `"...hides Python suite owner on line %d while its body
    remains visible"`.
    — `meat/editplan_test.go:158-164,312-316`, pinned against
    `validateHiddenPythonOwners` (`meat/python.go:25-52`, suite-owner branch
    42-46, error 44). The symmetric decorator case (hiding the decorator
    while its definition remains visible) is defined by the same function
    but has no pinning test found (see Open questions).

G6. `except* <Exception>:` (PEP 654 exception groups) is recognized as a
    Python suite-owner keyword identical to `except:`.
    — `meat/editplan_test.go:305,312-316`, pinned against
    `isPythonSuiteHeaderStart` (`meat/python.go:761-763`, keyword list
    includes `"except*"`).

G7. A multi-line, parenthesized condition (`if (\n    condition\n):`) is one
    logical suite-owner construct; folding any part of it — including its
    opening `if (` line — is rejected the same as folding a single-line
    owner.
    — `meat/editplan_test.go:305-310`, pinned against
    `isPythonSuiteHeaderStart`'s `"if"` keyword recognition
    (`meat/python.go:761-763`) and `prepareFold` (`meat/editplan.go:444-448`).

G8. Fold-target validation strips a trailing `#` comment before checking for
    suite-header-ness, so `def helper():  # setup helper` is still
    recognized as a suite owner subject to the anchor-preservation and
    body-required rules.
    — `meat/editplan_test.go:268-278`, pinned against `trimPythonCode`
    (`meat/python.go:726-754`, comment strip 749-750, quote-aware),
    `isPythonSuiteHeaderStart`/`isPythonSuiteOwner` (`meat/python.go:756-790`).

### Structural anchors — what a fold or replace may and may not touch

G9. A fold may not include the decorator line or the suite-header line
    itself (its "anchor") — only the indented interior may be folded. This
    applies to single-line owners, multi-line parenthesized
    signatures/conditions, and multi-line decorator calls alike; but folding
    only the interior of a multi-line signature or decorator's argument
    list (between its opening line and its closing `):`/`)`) is permitted.
    — `meat/editplan_test.go:125-130,166-179,280-289,319-334`, pinned against
    `prepareFold` (`meat/editplan.go:444-448`).

G10. A `replace` targeting the entirety of a Python decorator line or a
     suite-header line (when not inside a triple-quoted string) is rejected
     regardless of whether the replacement text is otherwise a valid
     elision: `"replace[%d]: line %d is a Python decorator or suite header;
     keep structural anchors intact"`.
     — `meat/editplan_test.go:112-123`, pinned against
     `meat/editplan.go:330-336` (guarded by
     `pythonTripleStateBeforeLine(...) == pythonTripleNone`, message 333).

G11. A replacement is rejected if it would change the count of any Python
     boundary token on that line, even when otherwise a valid elision
     projection: `"replace[%d]: must preserve Python string and expression
     boundary tokens"`.
     — `meat/editplan_test.go:145-148` (replacing `"""scenario` with `...`),
     pinned against `changesPythonBoundaryTokens` (`meat/python.go:16-23`),
     call site `meat/editplan.go:337-339`.

G12. Fold-aware owner/body scanning treats folded lines specially rather
     than as ordinary hidden lines: folding removed-side (`-`) body lines
     beneath a retained context owner is allowed as long as some new-side
     body remains visible elsewhere in the hunk; but if the owner's own
     context line is also removed while that new-side body stays visible,
     it is rejected as a hidden-owner violation (G5) — a deleted-side fold
     does not itself supply "visible body" evidence for the owner check.
     — `meat/editplan_test.go:319-329`, pinned against
     `hasPythonBodyAfter`/`pythonSuiteHeaderEnd`'s `*planState`-aware fold
     handling (`meat/python.go:277-333`), `validateHiddenPythonOwners`
     (`meat/python.go:25-52`).

### Delimiter balance and triple-quote parity

G13. A fold/removal that hides one delimiter of a matched pair (e.g. a
     closing `)`/`]`/`}` line) while the matching opener remains visible in
     the same hunk is rejected: `"...must preserve Python (), [], and {}
     delimiter balance; keep both boundaries or fold/remove the complete
     balanced expression"`.
     — `meat/editplan_test.go:250-255` (folding `value,`+`):` while
     `def build(` stays visible), pinned against
     `validatePythonDelimiterBalance` (`meat/python.go:468-519`, error 512).

G14. Parentheses/brackets/braces appearing inside a Python triple-quoted
     string's text do not count toward delimiter-balance checks; hiding such
     "unbalanced-looking" prose is allowed as long as the docstring's own
     triple-quote boundaries are hidden together with it.
     — `meat/editplan_test.go:181-190` (folding a docstring containing
     literal `foo(` and `[value]`), pinned against
     `pythonDelimiterBalanceWithState`'s triple-state skip
     (`meat/python.go:406-418`).

G15. A `"""`/`'''` token appearing inside an ordinary (single/double,
     non-triple) quoted string literal is not a triple-quote boundary — the
     ordinary-quote scan consumes it as literal content before triple-quote
     detection would apply.
     — `meat/editplan_test.go:227-232` (`value = '"""'`, removed without
     triggering any parity/balance check), pinned against ordinary-quote
     handling (`meat/python.go:433-447`) vs. triple detection
     (`meat/python.go:423-431`).

G16. A region hidden by removal or fold that changes whether a Python hunk's
     visible old-side/new-side text ends inside vs. outside a
     triple-quoted string is rejected: `"...must preserve balanced Python
     triple-quote boundaries; fold or remove the complete string, or keep
     both boundaries"`. Removing/folding an entire triple-quoted block (both
     boundary tokens and everything between) is allowed, since the end-state
     is unchanged either way.
     — `meat/editplan_test.go:136-140,141-143`, pinned against
     `validateTripleQuoteParity` (`meat/python.go:643-693`, error 686).

G17. A hidden (folded/removed) region may not straddle the boundary between
     two adjacent top-level expressions or strings on one side — e.g. a
     region covering the closing `)`/`"""` of one statement together with
     the opening line of the next statement is rejected:
     `"remove/fold: hidden Python region %d-%d crosses %s-side expression or
     string boundaries; keep the boundaries and compress only their
     interior"` (`%s` is `"old"` or `"new"`; only the "new" phrasing is
     exercised — see Open questions).
     — `meat/editplan_test.go:291-303`, pinned against
     `validateHiddenPythonBoundaries` (`meat/python.go:63-99`, error 90),
     balance test `hiddenPythonRegionBalanced` (`meat/python.go:101-148`).

G18. When a hunk's leading context line closes a delimiter that was opened
     above the hunk (an unmatched closer at hunk start), the per-hunk
     delimiter-depth tracker clamps that negative count to zero per bracket
     kind rather than treating the rest of the hunk as "still inside an
     expression" — so the reference guard (G20) still activates for a later
     top-level assignment in that same hunk.
     — `meat/editplan_test.go:214-225`, pinned against `pythonNewSideStates`
     clamp (`meat/python.go:181-189`), consumed by `validateHiddenReferences`'s
     `depthBefore` check (`meat/python.go:202-204`).

### Backslash continuations

G19. A Python line ending in an odd (unescaped, non-string, non-comment)
     count of backslashes and its following continuation line must be
     hidden or retained together; removing just the continuation line while
     keeping the backslash-ending line is rejected: `"...Python backslash
     continuation on lines %d-%d must be retained or hidden together"`.
     — `meat/editplan_test.go:192-198`, pinned against
     `validatePythonBackslashContinuations` (`meat/python.go:521-571`, error
     562), `endsPythonBackslash` (`meat/python.go:573-580`). Also
     end-to-end at the chunk level, where the same error surfaces inside a
     chunk exactly as whole-diff compilation would raise it — see
     `chunk.md` G39-G40.

### Reference guard (hidden definitions still referenced elsewhere)

G20. A simple top-level assignment target (`name = ...`) that is hidden (by
     remove or fold) while another retained line in the same file — even in
     a different hunk — still references that identifier by name is
     rejected: `"fold[%d]: hides definition %q on line %d while retained
     line %d still references it; keep the definition and fold only its
     interior"` (removal variant: `"remove: hides definition %q on line %d
     ..."`). Folding only the interior of a multi-line literal while
     keeping its opening and closing lines (and thus the assignment target)
     visible is permitted.
     — `meat/editplan_test.go:53-79,207-211`, pinned against
     `validateHiddenReferences` (`meat/python.go:195-236`, fold message 225,
     remove message 227; file-scoped scan by `fileID`, not hunk, at line
     210-211).

G21. The assignment-target extractor recognizes dotted attribute paths (e.g.
     `self.tests`) as a protectable name, not only bare identifiers.
     — `meat/editplan_test.go:261-265` (hiding `self.tests = [...]` while
     `for case in self.tests:` remains), pinned against
     `simpleAssignedReference` (`meat/python.go:804-828`, dot-segment
     validation 817-826).

G22. Text that resembles Python syntax (keywords, `@decorator`-looking
     lines) inside a triple-quoted docstring is not classified as code and
     is exempt from the decorator/suite-owner anchor rule (G9); and the
     reference guard's search for uses of a hidden name ignores occurrences
     of that name's text inside string literals — only real identifier
     references in code count as a "use".
     — `meat/editplan_test.go:337-347`, pinned against the fold-target gate
     `pythonCodeLine := layout.python[index] && pythonTripleStateBeforeLine(...)
     == pythonTripleNone` (`meat/editplan.go:445`), `pythonCodeWithoutStrings`
     (`meat/python.go:695-724`) used by `validateHiddenReferences` at
     `meat/python.go:220`.

## Constants

No named constants belong to `python.go` beyond those already listed in
`constants.md` (`maxReplacementBytes`, `maxSummaryBytes` are enforced
upstream in `editplan.go`, not here).

## Open questions

- **`validateHiddenPythonOwners`'s decorator-hidden branch is untested.**
  Every test that hides a decorator only folds its interior, never the
  decorator line itself while its definition survives; the message
  `"...hides Python decorator on line %d while its definition remains
  visible"` (`meat/python.go:40`) has no pinning test found in
  `editplan_test.go`. May be covered by `python_golden_test.go` — not
  confirmed here.
- **`validateHiddenPythonBoundaries`'s "old-side" message is untested** —
  both cases pinning G17 use `+`-side (new) fixtures; the `sideName ==
  "old"` templating (`meat/python.go:86-89`) is never independently
  exercised.
- **Mandatory Python-import interactions are entirely untested by
  `editplan_test.go`.** No fixture in that file contains an `import`
  statement, so the "fold crosses automatically-removed import rows" error
  path and the "import-only fold is redundant, silently accepted" path
  (`meat/editplan.go:230,233-236`) are not pinned here — but see `chunk.md`
  G33 for the mandatory-placeholder interaction, and `imports.md`.
