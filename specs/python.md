# python

> Status: stage 1 ✅ | stage 2 ✅
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

## Mechanism

`python.go` is a pure function library: every entry point takes the
already-parsed diff (`lines []sourceLine`, `layout diffLayout`) plus a
plan-in-progress (`planState`, sometimes `nil`) and returns either a
boolean/value or a `joinEditPlanErrors`-wrapped `error`. It owns no state
itself and performs no I/O; everything it decides is recomputed from source
text on every call. It is invoked exclusively from `meat/editplan.go`'s
`compileEditPlanMoves` (the implementation behind `compileEditPlan`), and
from `meat/imports.go`'s Algorithm 8/9 (`addMandatoryPythonSuitePlaceholders`,
`stateWithMandatoryImportsRepresented`, fully specified in `imports.md` —
not redescribed here).

### 0. Where python.go's checks sit inside `compileEditPlan`

`compileEditPlanMoves` (`meat/editplan.go:165-386`) runs these steps in this
exact order; every step after step 3 that touches Python source depends on
the step before it:

1. `mandatoryImportRemovalPlan` → `mandatoryRemovalMask` →
   `applyMandatoryMovePrecedence` produce `mandatoryHidden []bool`, the
   compiler-owned import-hiding decision, independent of the model plan
   (`meat/editplan.go:180-182`; fully specified in `imports.md`).
2. `state := newPlanState(...)`, seeded with `mandatoryHidden`
   (`meat/editplan.go:183-184`).
3. Model `Remove` ranges are applied to `state.hidden`
   (`meat/editplan.go:187-213`).
4. Model `Fold` ranges are applied via `prepareFold`
   (`meat/editplan.go:215-260`), which itself calls into python.go:
   `pythonTripleStateBeforeLine` and `isPythonSuiteHeaderStart` gate whether
   a fold may start on a given line at all (`meat/editplan.go:444-448`) —
   the anchor-protection check behind G7/G9.
5. If removals and folds are both structurally valid:
   `addMandatoryPythonSuitePlaceholders(lines, layout, &state,
   mandatoryHidden)` **mutates** `state` in place, synthesizing
   compiler-owned placeholder folds so mandatory import removal never
   orphans a suite owner (`meat/editplan.go:262`; Algorithm 8 in
   `imports.md`). This runs *before* any python.go validator sees the
   state.
6. `pythonValidationState := state` is captured, then — still only if
   removals/folds are valid — reassigned to
   `stateWithMandatoryImportsRepresented(state, mandatoryHidden, layout)`
   (`meat/editplan.go:267-269`; Algorithm 9 in `imports.md`). This produces
   a **separate, deep-copied** state (own `hidden`/`folded`/`foldAt`
   slices) in which mandatory-import rows are faked "represented" wherever
   their hunk has other genuinely visible content. Every python.go
   validator below reads `pythonValidationState`, never the raw `state`,
   and never reads `mandatoryHidden` directly.
7. In this exact order (`meat/editplan.go:270-281`):
   `validateHiddenPythonOwners` → `validateHiddenPythonBoundaries` →
   `validateHiddenReferences` → `validatePythonSuiteSkeleton`, all against
   `(lines, layout, pythonValidationState)`. This call order does **not**
   match the functions' definition order in `python.go` (owners,
   boundaries, references, suite-skeleton — suite-skeleton is defined
   between owners and boundaries in the file but called last).
8. `Replace` operations are validated and turned into a `replacements
   map[int][]plannedReplacement` (`meat/editplan.go:284-362`). Two of these
   per-replacement checks call python.go directly, using the **raw**
   `lines`/`layout` (not `pythonValidationState`, since
   `pythonTripleStateBeforeLine` takes no state parameter at all — see §1):
   the anchor-protection check at `meat/editplan.go:330-336` (guarded by
   `pythonTripleStateBeforeLine(...) == pythonTripleNone`, calling
   `trimPythonCode` and `isPythonSuiteHeaderStart`), and the boundary-token
   check at `meat/editplan.go:337-340` (`changesPythonBoundaryTokens`).
9. If removals/folds/replacements are all valid: `validateTripleQuoteParity`
   → `validatePythonDelimiterBalance` → `validatePythonBackslashContinuations`
   (`meat/editplan.go:369-377`), all against `(lines, layout,
   pythonValidationState, replacements)` — the **same** `pythonValidationState`
   captured in step 6, not recomputed.
10. Finally `completeMandatoryImportFraming(layout, &state, mandatoryHidden)`
    and `validateRetainedStructure(layout, state)` run against the **real**
    `state` (`meat/editplan.go:378-381`), never `pythonValidationState`.
    `pythonValidationState` exists solely to make validation see mandatory
    imports as present when they're validation-relevant; it is discarded
    before rendering.

### 1. The triple-quote state machine

`pythonTripleState` is a 3-value enum — `pythonTripleNone`,
`pythonTripleSingle`, `pythonTripleDouble` (`meat/python.go:582-588`) —
meaning "not inside a triple-quoted string" / "inside an open `'''…'''`" /
"inside an open `"""…"""`". Nothing else is tracked (no nesting count:
Python triple-quoted strings don't nest).

`scanPythonTripleLine(text string, state *pythonTripleState) int`
(`meat/python.go:590-641`) advances `state` across one physical line's text
(a line already has its `+`/`-`/` ` diff marker stripped) and returns the
number of open/close transitions seen on that line. Per byte position `i`,
in this priority order:
1. **If already inside a triple-quote** (`*state != pythonTripleNone`):
   search for the matching 3-byte closing delimiter (`'''` or `"""`) via
   `strings.Index` from `i` onward. Not found → the whole rest of the line
   is string content; return immediately with however many transitions have
   been counted so far (`meat/python.go:598-601`). Found → jump `i` past
   it, reset state to `pythonTripleNone`, increment the transition count,
   and continue scanning the remainder of the line as ordinary code
   (`meat/python.go:602-605`).
2. **Else, `#` short-circuits the entire scan**: if not inside any string, a
   bare `#` byte ends the line's meaningful content immediately — `return
   transitions` with no further scanning (`meat/python.go:607-609`). This
   runs *before* the triple-quote-opener and ordinary-quote checks below,
   but only ever fires when step 1 didn't already consume the position.
3. **Else, a `'''`/`"""` prefix at `i` opens a triple-quote**: set state
   accordingly, advance `i` by 3, increment transitions
   (`meat/python.go:610-621`).
4. **Else, a single `'`/`"` byte opens an ordinary (non-triple) string**:
   consume forward, skipping `\X` pairs (`i += 2` on any backslash) and
   stopping right after the matching same-character closing quote, or at
   end-of-text if unterminated (`meat/python.go:622-636`). **This inner
   loop tests only "is this byte the closing quote character", never "is
   this a 3-byte triple-quote-looking run"** — so a `"""` sequence
   occurring *inside* an ordinary `'...'`-quoted string (e.g. `'x"""y'`) is
   walked over byte-by-byte as ordinary string content and never inspected
   for triple-quote-ness; the scan only re-examines bytes for triple-quote
   openers *after* it exits back to the outer loop, i.e. after the ordinary
   string's own closing quote has been found. This is the mechanism behind
   G15.
5. Otherwise the byte is ordinary code; `i++`.

`pythonTripleStateBeforeLine(lines, layout, line int) pythonTripleState`
(`meat/python.go:792-802`) reconstructs "what triple-quote state does the
diff's source text have immediately before this physical line" by walking
every hunk-source line from the containing hunk's start (`containingHunk`,
`meat/diff.go:139-156`) up to (not including) `line`, **skipping `-`-only
lines** (`lines[i].text[0] == '-'`) and feeding every other hunk-source
line's body through `scanPythonTripleLine` unconditionally — i.e. it always
uses the *raw* hunk text, and takes **no `*planState` parameter at all**:
hidden/removed/folded status never affects this function's answer. This is
unlike `pythonSuiteHeaderEnd`/`hasPythonBodyAfter`/`hasPythonDefinitionAfter`
(§5), which do accept an optional state.

### 2. The delimiter-balance tracker

`pythonDelimiters{round, square, curly int}` (`meat/python.go:379-391`) is a
per-bracket-kind signed running count; `.add` sums componentwise, `.equal`/
`==` compares componentwise (Go struct equality — a port must compare
fields explicitly, not by reference).

`pythonDelimiterBalanceWithState(text string, state *pythonTripleState)
pythonDelimiters` (`meat/python.go:403-466`) walks one line byte-by-byte
with the same priority order as `scanPythonTripleLine` — triple-state
consumption first, then `#`-short-circuit, then triple-opener detection,
then ordinary-quote skip-over — and on every byte that isn't consumed by
one of those, increments/decrements `round`/`square`/`curly` for
`(`/`)`/`[`/`]`/`{`/`}` (`meat/python.go:449-462`). The `#`-break at line
420-422 runs only when `*state == pythonTripleNone` (the `if *state !=
pythonTripleNone` branch at 406-418 already `continue`s past that check),
and any ordinary or triple quote opened on the same line is fully consumed
by its own dedicated skip loop *before* the outer loop's index ever
revisits those inner bytes — so a `#` inside a string (ordinary or triple)
is never mistaken for a comment start, and a bracket character inside a
string is never counted. `pythonDelimiterBalance(text)`
(`meat/python.go:398-401`) is a convenience wrapper that always starts from
a fresh `pythonTripleNone` state — it never carries triple-quote context in
from a previous line. `pythonDelimiterDepth(text) int`
(`meat/python.go:393-396`) sums `pythonDelimiterBalance(text)`'s three
fields into one net signed integer ("how many more opens than closes,
across all bracket kinds, on this one line, read as if it started outside
any string").

Composing across a hunk: nothing in `python.go` computes one persistent
depth *object* across multiple lines for its own sake — instead, three
different call sites thread a delimiter/triple accumulator across lines by
hand, each for a different purpose (see §5 for `pythonSuiteHeaderEnd`'s
per-line, fresh-start use of `pythonDelimiterDepth`; §7 for
`hiddenPythonRegionBalanced`'s region-scoped `pythonDelimiters`
accumulation; §8 for `pythonNewSideStates`'s whole-hunk accumulation; §9
for the raw/kept whole-hunk accumulation in the two parity validators).

### 3. `trimPythonCode` — the quote-aware comment stripper, and how it differs from §1

`trimPythonCode(text string) string` (`meat/python.go:726-754`) returns the
line's code with any trailing `# comment` removed and the result
whitespace-trimmed (`strings.TrimSpace`). Its state machine is deliberately
simpler than `scanPythonTripleLine`'s: a single `quote byte` (0 = not in a
string) plus an `escaped bool`, advancing **one byte at a time** (never a
multi-byte jump). On a quote byte (`'` or `"`) while not already in a
string, it sets `quote = b` (`meat/python.go:745-747` — this treats every
quote byte as a single-character string opener; it never looks ahead for
two more of the same byte to recognize a triple-quote token). On a `#`
while `quote == 0`, it cuts the line there (`meat/python.go:749-750`).

**This is a distinct approximation from §1's machine, not a variant of
it**: `trimPythonCode` has no triple-quote concept whatsoever. Concretely:
- A line that *opens* a triple-quoted string mid-line, e.g. `x = """foo #
  not a comment`, still gets a *usable* answer from `trimPythonCode` by
  coincidence: three consecutive `"` bytes toggle `quote` open→closed→open
  (odd count ⇒ still "in a string" at the end, which happens to match
  reality), so the trailing `#` is correctly left un-treated as a comment.
  But this is exactly a coincidence of toggling an odd number of times, not
  real triple-quote recognition.
- Where it genuinely diverges from a correct Python tokenizer: a
  triple-quoted string containing an **embedded lone quote character of
  the same kind** before the closing triple sequence, e.g. `"""Say "hi" #
  not a comment"""`. A real tokenizer stays inside the triple string across
  the whole line. `trimPythonCode` instead: 3×`"` → in-string; `Say ` →
  consumed as string content; the single embedded `"` **closes**
  `trimPythonCode`'s quote state (byte equals `quote`); ` hi` is then read
  as *code*; the next `"` reopens a string; `# not a comment` is consumed
  as if it were inside that second bogus string, `"""` at the end closes
  it. Net effect: the `#` in that example happens to still not be treated
  as a comment here, but for a differently-shaped embedded-quote line the
  boundary answer can flip either way depending on the parity of embedded
  quote characters before the trailing content. **This must be reproduced
  exactly as this specific approximation** (byte-toggle, no
  triple-awareness), not "fixed" to be triple-quote-correct, because
  `isPythonSuiteHeaderStart`, `isPythonDefinition`, `endsPythonBackslash`,
  and the anchor-protection check at `meat/editplan.go:330-336` all depend
  on `trimPythonCode`'s exact (imperfect) output, and
  `editplan_test.go`/`python_golden_test.go` pin outputs computed with this
  exact machine.
- Every caller of `trimPythonCode` on a hunk-source line is itself already
  guarded by `pythonTripleStateBeforeLine(...) == pythonTripleNone`
  (verified at each call site: `meat/python.go:31,244`;
  `meat/editplan.go:445`; `meat/imports.go:17`) — so `trimPythonCode` is
  only ever asked to judge a line known (by the *other*, correct machine)
  to *start* outside a triple string. It can still misjudge content
  *within* that one physical line, as shown above.

### 4. `isPythonSuiteHeaderStart` / `isPythonSuiteOwner` / `hasPythonKeyword`

`isPythonSuiteHeaderStart(trimmed string) bool` (`meat/python.go:756-777`)
re-applies `trimPythonCode` to its input (idempotent given callers already
trim), then returns true if any of:
- `isPythonDefinition(trimmed)` (`meat/python.go:374-377`): `trimmed`
  starts with the literal prefix `"def "`, `"async def "`, or `"class "`
  (the trailing space is part of the literal — `deffoo():` does not match
  `"def "`).
- `hasPythonKeyword(trimmed, keyword)` is true for any of `"if"`, `"elif"`,
  `"for"`, `"while"`, `"with"`, `"except"`, `"except*"`, `"match"`,
  `"case"` (`meat/python.go:761-765`).
- `trimmed` starts with `"async for "`/`"async for("`/`"async with "`/
  `"async with("` (`meat/python.go:766-770`).
- `trimmed` is *exactly* `"else:"`, `"try:"`, `"except:"`, or `"finally:"`
  (`meat/python.go:771-776`).

`hasPythonKeyword(text, keyword string) bool` (`meat/python.go:779-785`):
true only if `text` **starts with** `keyword` (position 0 — an anchored
prefix test, not a substring search) **and** `text` has at least one more
byte, **and** that next byte is `' '`, `'\t'`, or `'('`. There is no
requirement that the keyword be followed by anything syntactically valid
beyond that one boundary byte.

`isPythonSuiteOwner(trimmed string) bool` (`meat/python.go:787-790`) ANDs
`isPythonSuiteHeaderStart` with `strings.HasSuffix(trimmed, ":")` — i.e. it
additionally requires the **same, single line** to end in `:`. **This
function is never called anywhere in the `meat` module or its tests**
(verified by grepping the whole repository — the only match is its own
definition; see Open questions). The trailing-`:` requirement it embodies
is instead applied correctly (across a possibly multi-line header) by
`pythonSuiteHeaderEnd`'s own `strings.HasSuffix(trimmed, ":")` check at
zero delimiter depth (§5) — `isPythonSuiteHeaderStart` deliberately has
*no* colon requirement, because on a multi-line header's opening line
(`if (`) the colon hasn't appeared yet, and every caller that needs "is
this the *complete, terminated* header" uses `pythonSuiteHeaderEnd`, not a
same-line colon check.

### 5. Owner/body/definition lookahead: `pythonSuiteHeaderEnd`, `hasPythonBodyAfter`, `hasPythonDefinitionAfter`

All three accept `state *planState` and are called both with `nil` (raw
hunk truth — "what does the unedited hunk actually contain") and with a
live state pointer (either `&pythonValidationState` or `&state` at the
placeholder-synthesis call site in `imports.go`) meaning "what does this
plan actually leave visible". None of the three carries triple-quote state
*between* physical lines internally (see the caveat at the end of this
section).

**`pythonSuiteHeaderEnd(lines, layout, state, start int) (int, bool)`**
(`meat/python.go:277-306`): scans forward from `start` to the end of
`start`'s containing hunk (`containingHunk`), accumulating `depth +=
pythonDelimiterDepth(body)` per non-blank hunk-source line (skipping `-`
lines; skipping fold-covered and hidden lines uniformly when `state !=
nil`, **regardless of fold marker** — `meat/python.go:281-288`). `depth <
0` at any point aborts with `(0, false)` — malformed/over-closed. The
header's true end is the first line where `depth == 0 && strings.HasSuffix(
trimmed, ":")` (`meat/python.go:301-303`); reaching the hunk's end without
that returns `(0, false)`.

**`hasPythonBodyAfter(lines, layout, state, ownerLine, indent int) bool`**
(`meat/python.go:308-333`): scans forward from `ownerLine+1`, and returns
on the **first** line that is decisive, rather than scanning to find the
deepest/best candidate:
- If `state != nil` and this line is the **first source line of a fold**
  (`state.foldAt[i] >= 0`): decide from the fold's own recorded metadata
  without looking at its (hidden) content — a fold whose `marker == '-'`
  does **not** count as a body, so the scan `continue`s past it looking for
  something else; a fold whose `marker` is `'+'` or `' '` counts as a body
  **iff** `len(fold.indent) > indent` (byte length of the fold's own common
  leading indentation, compared to the owner's), and the function returns
  that boolean **immediately**, without inspecting any line after the fold
  (`meat/python.go:312-317`). This fold-marker special case exists **only**
  in `hasPythonBodyAfter` — contrast `hasPythonDefinitionAfter` below.
- Else if `state != nil` and the line is otherwise hidden
  (`state.hidden[i]`, not a fold's first line — i.e. a later line of a
  fold, or a plain removal), `continue` (skip, keep looking).
- Else, if the line isn't hunk source, is too short, or is a `-` line,
  `continue`.
- Else, if `trimPythonCode(body) == ""` (blank or comment-only after
  stripping), `continue` — a comment-only line never counts as a body
  (G2's "a comment-only remaining line does not count as a body").
- Else: **return** `len(leadingWhitespace(body)) > indent` immediately —
  the first real content line decides the whole answer.

**`hasPythonDefinitionAfter(lines, layout, state, decoratorLine, indent
int) bool`** (`meat/python.go:335-372`): initializes `depth :=
pythonDelimiterDepth(lines[decoratorLine].text[1:])` (the decorator's own
line may itself open an unclosed multi-line argument list) and scans
forward. When `state != nil`, **every** fold-start line is `continue`d past
uniformly regardless of `marker` (`meat/python.go:340-342`) — **unlike
`hasPythonBodyAfter`, there is no marker-aware decision here**; a folded
decorator argument or folded intervening content is simply treated as
invisible and skipped. While `depth > 0` (still inside the decorator's own
multi-line call), each subsequent line adds `pythonDelimiterDepth(body)` to
`depth` (negative depth aborts `false`) and is otherwise skipped without
further inspection. Once depth reaches exactly 0, the next real content
line must sit at **exactly** `indent` (not merely deeper —
`meat/python.go:362-364`, `!=` not `>`); if it's itself another
`@`-prefixed line (a stacked decorator), `depth` resets to that new line's
own opening depth and scanning continues (recursing through a decorator
stack); otherwise the final answer is `isPythonDefinition(trimmed)` (§4) —
true only for `def `/`async def `/`class `.

**Caveat verified across all three**: `pythonDelimiterDepth` (used at
`meat/python.go:297,337,356,366`) is built on `pythonDelimiterBalance`,
which always starts each call from a **fresh** `pythonTripleNone` state
(§2) — none of these three functions threads triple-quote state from one
signature/decorator-continuation line to the next. A multi-line
`def`/decorator signature whose argument list itself contains a
triple-quoted string literal spanning more than one physical line (e.g.
`@foo("""` / `multi-line default` / `""")`) will have its continuation
lines' bracket-looking characters counted as if they were code, potentially
miscounting `depth` — see Open questions.

### 6. The four hunk/line-driven validators

All four share a recurring per-line guard shape: skip unless the line is
hunk source, at least 2 bytes (a diff marker plus content), Python-classified,
and **not** a `-`-only line (i.e. only context/added-side content is
examined) — this repeats near-verbatim at `meat/python.go:28,151,170,199,241`.

- **`validateHiddenPythonOwners(lines, layout, state) error`**
  (`meat/python.go:25-52`): iterates **every line**, no hunk-level
  pre-filter, and only examines lines where `state.hidden[i]` is **true**
  (i.e. this validator's whole purpose is "for lines this plan hides, was
  hiding them safe?"). It additionally skips any line where
  `pythonTripleStateBeforeLine(...) != pythonTripleNone` (a hidden line
  that starts inside a triple string isn't suite-header-checked at all).
  For a hidden decorator line (`trimmed` starts with `@`): reject if
  `hasPythonDefinitionAfter` is true against **both** the raw (`nil`) and
  the given `state` — i.e. reject only if the definition really exists in
  the raw hunk *and* still shows through the plan (so hiding the decorator
  wasn't paired with hiding its definition too). For a hidden suite-header
  line (`isPythonSuiteHeaderStart`): reject symmetrically using
  `pythonSuiteHeaderEnd` + `hasPythonBodyAfter`, both against raw and
  against `state`.
- **`validatePythonSuiteSkeleton(lines, layout, state) error`**
  (`meat/python.go:238-275`): the mirror image — iterates every line, but
  only examines lines that are **retained** (`!state.hidden[i]`). For a
  retained decorator, reject if `hasPythonDefinitionAfter(..., nil, ...)`
  is true (raw hunk really had an attached definition) but
  `hasPythonDefinitionAfter(..., &state, ...)` is false (the plan no
  longer shows it). For a retained suite header, first find its raw true
  end via `pythonSuiteHeaderEnd(..., nil, ...)` (skip entirely if the raw
  header can't even be resolved); if the raw hunk had a body after that raw
  end (`hasPythonBodyAfter(..., nil, ...)` — G4's gate: no raw body means
  nothing to require), then require the header's end **as resolved against
  the live state** (`pythonSuiteHeaderEnd(..., &state, ...)`) to both
  resolve and still have a body (`hasPythonBodyAfter(..., &state, ...)`).
- **`validateHiddenPythonBoundaries(lines, layout, state) error`**
  (`meat/python.go:63-99`): the only one of the four that is
  **hunk-header-driven** rather than line-driven, and the only one gated by
  `hunkHasVisibleChange` (below) — a hunk with no visible change line at
  all is skipped entirely (`meat/python.go:66-74`). Within a qualifying
  hunk, it groups **consecutive** hidden hunk-source lines into maximal
  runs (`start` to `i`, `meat/python.go:75-83`) and, for each such run,
  calls `hiddenPythonRegionBalanced` (§7) once per side (`'-'` then `'+'`),
  producing one error per unbalanced side with `sideName` `"old"` or
  `"new"`.
- **`validateHiddenReferences(lines, layout, state) error`**
  (`meat/python.go:195-236`): first precomputes `pythonNewSideStates` (§8)
  once for the whole diff. Then, for every hidden, Python, hunk-source,
  non-`-` line whose new-side context is neither inside a triple-quote nor
  at nonzero delimiter depth (`insideTriple[i] || depthBefore[i] != 0`
  skips it), it extracts a candidate assignment target via
  `simpleAssignedReference(pythonCodeWithoutStrings(...))` (§11). If found,
  it scans **every other hunk-source line in the same file**
  (`layout.fileID[j] == fileID`, not scoped to the same hunk) that is
  retained and not itself inside a triple-quote, skipping the specific case
  of "hidden line is `+`-side and candidate line is `-`-side" (comparing an
  added definition against an about-to-be-removed old reference is not a
  real conflict — `meat/python.go:214-216`), and rejects on the **first**
  retained line whose `pythonCodeWithoutStrings` text contains the
  identifier as a whole word (`containsIdentifier`, §11).

`hunkHasVisibleChange(layout, state, start, end) bool`
(`meat/python.go:54-61`): true iff at least one `diffLineHunkChange` line in
`[start,end)` is still `state.represented` (visible or folded). This gate
is applied by **four** functions in total: `validateHiddenPythonBoundaries`
(`meat/python.go:72`), and, later in the pipeline,
`validatePythonDelimiterBalance` (`meat/python.go:477`),
`validateTripleQuoteParity` (`meat/python.go:652`), and
`validatePythonBackslashContinuations` (`meat/python.go:530`). It is
**not** applied by `validateHiddenPythonOwners`, `validateHiddenReferences`,
or `validatePythonSuiteSkeleton`, which scan every qualifying line
unconditionally regardless of whether the hunk has any visible change.
Practically: a hunk whose every `+`/`-` line has been fully hidden (nothing
survives, not even a fold) is exempted from the boundary/delimiter/
triple-quote/backslash-parity checks — there is no "old vs. new text" left
to compare — but is still subject to the owner/reference/skeleton checks on
whatever lines remain individually hidden or retained.

### 7. `hiddenPythonRegionBalanced` — per-region balance check

`hiddenPythonRegionBalanced(lines, layout, hunkStart, start, end int, side
byte) bool` (`meat/python.go:101-148`) decides whether hiding the
contiguous run `[start,end)` is safe for one diff `side` (`'-'` or `'+'`;
context `' '` lines count toward both sides via `pythonLineOnSide`,
`meat/python.go:150-155`).

1. **Establish entry state**: replay `scanPythonTripleLine` over every
   `side`-visible hunk-source line from `hunkStart` up to (not including)
   `start`, producing `beforeTriple`. `enteredTriple := beforeTriple !=
   pythonTripleNone` records whether the region begins already inside a
   triple-quoted string (`meat/python.go:102-108`).
2. **Scan the region twice, differently**: for each `side`-visible line in
   `[start,end)`, run `scanPythonTripleLine` into `localTriple` (always,
   starting fresh from `pythonTripleNone` — "read this region in isolation,
   as if it were its own file") **and**, only if `enteredTriple`, also run
   it into `actualTriple` (continuing from `beforeTriple`), accumulating
   the returned transition counts into `tripleTransitions`
   (`meat/python.go:113-123`).
3. Empty region (no `side`-visible lines at all) is trivially balanced
   (`meat/python.go:124-126`).
4. `startsWithBareTriple` — the region's first line, trimmed, is exactly
   `"""` or `'''` with nothing else on it (`meat/python.go:127-128`).
5. **Reject condition 1** (`meat/python.go:129-131`): `enteredTriple &&
   tripleTransitions > 0 && (localTriple != pythonTripleNone ||
   startsWithBareTriple)`. This fires when the region began inside an
   ongoing string, that string's boundary genuinely moves within the
   region (at least one transition), **and** either the region read in
   isolation still looks unterminated (`localTriple != pythonTripleNone`)
   or the region's first line is a lone closing/opening triple token by
   itself.
6. **Reject condition 2** (`meat/python.go:132-134`): `!enteredTriple &&
   localTriple != pythonTripleNone` — the region did **not** start inside a
   string, but scanned on its own it ends up inside one (an unmatched
   opener whose close lies outside the region).
7. **Delimiter balance, region-scoped**: seed `delimiterTriple` with
   `beforeTriple` only if the region both entered already-inside-a-triple-
   quote **and** never transitioned out of it (`tripleTransitions == 0`) —
   i.e. only when the entire region is confirmed to stay inside the same
   ongoing string throughout, so its brackets must be skipped as string
   content (`meat/python.go:136-139`). Otherwise `delimiterTriple` starts
   at `pythonTripleNone`. Accumulate `pythonDelimiterBalanceWithState` per
   line into `balance`; **reject immediately** if any bracket kind goes
   negative mid-scan (`meat/python.go:143-145` — a closer with no matching
   opener *within the region itself*, checked line-by-line, not just at the
   end). Finally require `balance == pythonDelimiters{}`
   (`meat/python.go:147`) — net-zero across all three bracket kinds.

The two reject classes are exactly steps 5-6 (triple-quote boundary crossed
unexpectedly) versus step 7's two checks (delimiter balance negative
mid-scan, or nonzero at the end).

### 8. `pythonNewSideStates` — precomputed per-line new-side vectors

`pythonNewSideStates(lines, layout) (insideTriple []bool, depthBefore
[]int)` (`meat/python.go:157-193`) is a whole-diff precompute feeding only
`validateHiddenReferences`. Per Python hunk, walking hunk-source lines that
are **not** `-`-only (`lines[i].text[0] != '-'` — i.e. context and added
lines, reconstructing the *new file's* text), it records **before**
processing line `i`: `insideTriple[i] = (triple != pythonTripleNone)` and
`depthBefore[i] = delimiters.round + delimiters.square + delimiters.curly`,
then advances `triple`/`delimiters` through line `i`'s own text. After
advancing, each of the three delimiter kinds is **independently clamped to
zero if negative** (`meat/python.go:181-189`) — this is G18's clamp, cited
there against these same lines: it exists because a hunk's leading context
can close a delimiter opened above the hunk (invisible context), which must
not be read as "still inside an expression" for the rest of the hunk's
reference-guard purposes.

### 9. Raw-vs-kept comparison: `validatePythonDelimiterBalance` and `validateTripleQuoteParity`

Both (`meat/python.go:468-519` and `:643-693`) share one pattern, run once
per Python hunk header, skipped when `!hunkHasVisibleChange` (§6):

For every hunk-source line `j`, compute `body := lines[j].text[1:]` and
`keptBody` (equal to `body`, or `applyPlannedReplacements(body,
replacements[j+1])` if that line has planned replacements —
`meat/editplan.go:413-419` splices each replacement's `New` text in at its
recorded byte span, right-to-left so earlier spans' offsets stay valid).
Then, branching on the line's own diff marker:
- `' '` (context): feed `body` into **both** a running "raw old" and "raw
  new" accumulator (context lines belong to both files' text); if the line
  is **not** hidden in `state`, also feed `keptBody` into both "kept old"
  and "kept new".
- `'-'`: feed `body` into "raw old" only; if not hidden, feed `keptBody`
  into "kept old" only.
- `'+'`: feed `body` into "raw new" only; if not hidden, feed `keptBody`
  into "kept new" only.

Each of the four accumulators (raw-old, raw-new, kept-old, kept-new)
carries its **own independent** running `pythonTripleState` (in the parity
check) or `pythonDelimiters` + its own triple-state passed to
`pythonDelimiterBalanceWithState` (in the balance check) across the whole
hunk, in hunk physical order — this reconstructs each side's true textual
sequence out of the interleaved diff. "Raw" always includes every
hunk-source line's **original** text regardless of what the plan hides;
"kept" includes only what the plan actually leaves visible
(`!state.hidden[j]`), using **replacement-applied** text where a
replacement exists. The check requires `rawOld == keptOld && rawNew ==
keptNew` — i.e. hiding lines (with or without replacements) must not have
changed either side's final delimiter balance / triple-quote parity from
what the raw hunk would have produced. This does **not** check that old and
new sides individually balance to zero against each other — that
net-zero-ness is `hiddenPythonRegionBalanced`'s (§7) job, on a different,
region-scoped question. One error is produced per offending hunk, at
`meat/python.go:512` (delimiter) / `meat/python.go:686` (triple-quote).

### 10. `validatePythonBackslashContinuations`

`meat/python.go:521-571`, gated by `hunkHasVisibleChange`. Per side (`'-'`,
`'+'`), it reconstructs that side's own line sequence via
`pythonLineOnSide` (context lines included for both), then walks
**adjacent pairs within that reconstructed sequence** (not raw physical
adjacency in the interleaved hunk). A single `pythonTripleState` threads
across the sequence. For each line: capture `insideTriple := triple !=
pythonTripleNone` **before** advancing `triple` via `scanPythonTripleLine`
for that line; if the line started inside a triple-quote, or its (raw)
body doesn't end in an odd count of backslashes (`endsPythonBackslash`,
below), skip the pair entirely — continuation pairing is only checked for
lines that, read raw, genuinely end in a continuation backslash while not
themselves inside an open string. If the line survives visibly
(`!state.hidden[line]`), additionally recompute `endsPythonBackslash`
against its **replacement-applied** body; if the replacement erased the
trailing backslash, skip (the replace legitimately changed the code, no
pairing constraint applies). Otherwise, reject if `state.hidden[line] !=
state.hidden[next]` — the backslash-line and its continuation must be
hidden or retained together (error at `meat/python.go:562`).

`endsPythonBackslash(body string) bool` (`meat/python.go:573-580`): runs
`trimPythonCode` first (so a trailing `#`-comment or its content doesn't
count), then counts trailing `\` bytes from the end and requires an **odd**
count (an even run of backslashes is all self-escaping, not a line
continuation).

### 11. Reference-guard extraction: `simpleAssignedReference`, `containsIdentifier`, `pythonCodeWithoutStrings`

`pythonCodeWithoutStrings(text string) string` (`meat/python.go:695-724`):
builds "code with string literal *contents* removed" for one line,
assuming the line starts outside any string (callers guard this via
`insideTriple[i]`/`depthBefore[i]==0` from §8). Per byte: a `#` or a
`'''`/`"""`-looking prefix **breaks the entire scan immediately** (not just
"skip the string" — the rest of the line, including any real code after a
same-line-closed triple-quoted string, is discarded); an ordinary `'`/`"`
opens a skip-to-matching-quote (backslash-aware) that consumes the
string's content without appending it to the output; everything else is
copied through. **This function carries no persistent state and is never
told "start already inside a string"** — it always assumes a fresh start,
which its callers guarantee is correct for where the string *begins*, but
see Open questions for a same-line consequence.

`simpleAssignedReference(body string) (string, bool)`
(`meat/python.go:804-828`) extracts an assignment target from already-
`pythonCodeWithoutStrings`-filtered text: find the first `=` byte
(`strings.IndexByte`); reject if none found, or if it's the very first
character, or if the byte right after it is also `=` (rejects `==`, and
incidentally — via the identifier-segment check below, not an explicit
operator list — also rejects augmented-assignment operators like `+=`,
comparisons like `<=`/`!=`, and walrus `:=`, because their residual
left-hand text ends in a non-identifier character). Trim the left-hand
side; if it contains a `:`, truncate at the **first** one (strips a type
annotation, e.g. `count: int = 5` → `count`). The remaining left-hand side
is split on `.` (`strings.Split(lhs, ".")`) and every segment must be
non-empty, start with `isIdentifierStart`, and continue with
`isIdentifierContinue` for every subsequent byte (both defined in
`meat/editplan.go:472-478`, reused unmodified — not redefined in
`python.go`) — this is the dotted-attribute-path validation
(`meat/python.go:817-826`) that lets `self.tests = [...]` be recognized
(G21).

`containsIdentifier(text, name string) bool` (`meat/python.go:830-846`):
repeated `strings.Index` scan for `name` as a raw substring, advancing the
search offset by 1 past each **non-boundary** match (so overlapping
candidate positions are all considered — mirrors `uniqueSubstringIndex`'s
one-byte-forward rescan at `meat/editplan.go:546-551`); a match counts only
if the byte immediately before it (or start-of-text) is not
`isIdentifierContinue`, and the byte immediately after it (or end-of-text)
is not `isIdentifierContinue` — a true whole-word match by the same ASCII
identifier-continuation rule used everywhere else in this file.

### 12. `changesPythonBoundaryTokens`

`meat/python.go:16-23`: for exactly 8 fixed tokens — `"("`, `")"`, `"["`,
`"]"`, `"{"`, `"}"`, `` `'''` ``, `` `"""` `` — compares
`strings.Count(old, token)` against `strings.Count(new, token)`; any
mismatch on any one token returns true ("changes boundary tokens"). This is
a per-line replacement check (`old`/`new` are the model's proposed
`Old`/`New` replacement strings, not diff lines), called from
`meat/editplan.go:337-340` and backing G11.

### Data shapes

- **`pythonTripleState`**: not a Boolean "in a string or not" — a 3-way
  discriminator (none / inside-single / inside-double), because the *kind*
  of triple-quote matters for finding the correct closing delimiter.
- **`pythonDelimiters`**: not one nesting depth — three independent signed
  counters (round/square/curly), each meaningfully able to go negative
  *during* a scan (an unmatched closer) even where the net sum across a
  whole hunk ends at zero.
- **`insideTriple []bool, depthBefore []int`** (from `pythonNewSideStates`):
  per-physical-line vectors, indexed by the same line index as
  `lines`/`layout`, meaningful only at lines that are new-side-visible
  hunk source; both represent state **as of just before** that line's own
  content is scanned (not after), and `depthBefore` deliberately loses
  information (clamped to ≥0 per bracket kind) that a byte-for-byte-faithful
  tracker would keep, by design (G18).
- **`plannedFold.marker`/`.indent`**: a fold's identity for python.go's
  purposes is reduced to exactly two facts — which diff side it's on, and
  its own common leading-indentation text — everything else about its
  (hidden) content is invisible to `hasPythonBodyAfter`.

### Decision boundaries

- **Suite header vs. not**: `isPythonSuiteHeaderStart` (keyword table +
  prefix/boundary check, §4) decides "could this be the *start* of a suite
  header", with **no trailing-colon requirement**. `pythonSuiteHeaderEnd`
  decides where such a header actually *terminates*, and **that** is where
  the trailing-`:` requirement lives, checked only at zero delimiter depth.
  `isPythonSuiteOwner` bundles both into one same-line check but is dead
  code (§4/Open questions) — every real caller needing "is this a
  complete, terminated suite header" uses `pythonSuiteHeaderEnd`, precisely
  because that's the only one of the two that's correct for multi-line
  headers.
- **"Preserved" delimiter/triple-quote balance**: two different meanings
  coexist. `hiddenPythonRegionBalanced` (§7) asks "does *this specific
  hidden region*, taken alone, net to zero/consistent boundaries" — a
  *local* property. `validatePythonDelimiterBalance`/
  `validateTripleQuoteParity` (§9) ask "does the *whole hunk's* running
  state, computed with hiding+replacement applied, match what the same
  running state would be with nothing hidden" — a *global*, per-side,
  whole-hunk equality, not a net-zero requirement.
- **"Simple" assignment target**: exactly one top-level `=` (not `==`, and
  — as a side effect of the identifier-segment check, not an explicit
  exclusion list — not any augmented-assignment/comparison/walrus
  operator), optional `:`-annotation stripped, and a `.`-separated path of
  ASCII-identifier segments. Anything else (tuple unpacking `a, b = ...`,
  subscript targets `d[k] = ...`, chained assignment `a = b = ...`) is
  **not** "simple" and receives no reference-guard protection at all —
  silently, not as a rejection.
- **`nil` vs live `*planState`** across `pythonSuiteHeaderEnd`/
  `hasPythonBodyAfter`/`hasPythonDefinitionAfter`: `nil` means "answer
  using only the raw hunk text, as if nothing were ever hidden" (used to
  establish "did this construct really have a header/body/definition in
  the source at all"); non-`nil` means "answer using what this specific
  plan actually leaves visible" (used to establish "does the *plan* still
  show it"). Only `hasPythonBodyAfter` additionally special-cases *which*
  fold marker counts as a body (`'-'` folds don't, `'+'`/`' '` folds do,
  conditioned on the fold's own indent) — `pythonSuiteHeaderEnd` and
  `hasPythonDefinitionAfter` skip **all** folds uniformly with no marker
  distinction.

## Invariants

- Delimiter kinds are never merged into one counter inside the balance
  validators (only `pythonDelimiterDepth` merges them, and only for
  header/definition-boundary *detection*, never for balance *validation*).
  Merging them in the port would let a plan hide a `)` and reveal an
  unmatched `]` (or vice versa) and still read as "balanced" — silently
  producing syntactically invalid Python — `meat/python.go:379-391` vs.
  `:393-396`.
- The raw/kept comparison in §9 reconstructs the **old-side** and
  **new-side** text as two separately-filtered sequences over one hunk's
  interleaved lines, each with its own running triple/delimiter
  accumulator. Collapsing this into a single shared accumulator over the
  interleaved hunk (rather than one per side) would make "raw" and "kept"
  agree by construction regardless of what's actually hidden, since both
  would be walking the identical interleaved sequence — the check would
  pass vacuously and stop catching real breakage — `meat/python.go:480-509,655-684`.
- `pythonSuiteHeaderEnd`/`hasPythonBodyAfter`/`hasPythonDefinitionAfter` are
  bounded strictly by `containingHunk` (`meat/diff.go:139-156`) and never
  read past a hunk header, file header, or mail signature line. Removing
  this bound would let header/body detection match content belonging to an
  unrelated hunk or file when a real suite header's signature or body
  happens to be truncated near a hunk boundary —
  `meat/python.go:278,309,336`.
- `pythonValidationState` (editplan.go's mandatory-imports-represented
  snapshot) must stay a distinct copy from the real `state` that
  `completeMandatoryImportFraming` later mutates
  (`meat/editplan.go:267,378`). If a port shared the same mutable structure
  between validation and final rendering, the "treat mandatory imports as
  present" trick used only to validate suite/delimiter/reference safety
  would leak into the actually rendered diff, and mandatory imports would
  incorrectly stay visible in the output.
- `trimPythonCode` and `scanPythonTripleLine` must remain two separately-
  implemented state machines with their documented divergence (§3) intact
  — not derived from one another, and not "corrected" to agree.
  `editplan_test.go`/`python_golden_test.go` pin outputs computed with
  `trimPythonCode`'s specific (non-triple-aware) behavior; unifying the two
  machines changes which lines are recognized as decorators/suite-headers/
  backslash-continuations on any line whose content includes an embedded
  same-kind quote inside a same-line triple-quoted string.
- `isPythonSuiteHeaderStart` must never gain a trailing-colon requirement
  (that belongs only to `pythonSuiteHeaderEnd`, at zero delimiter depth).
  Adding one would break recognition of every multi-line header's
  *opening* line (`if (`, a decorator's opening `(`, a multi-line `def(`),
  silently disabling G7/G9/G10's anchor protections on exactly the
  multi-line cases they're meant to cover.

## Hazards

- **H1** (byte offsets) applies pervasively and exclusively — `python.go`
  contains zero rune-range loops and zero `unicode`/`utf8` package use
  (verified: no `range text`-style iteration, no `[]rune`, no `utf8.` call
  anywhere in the file). Every scan (`scanPythonTripleLine`
  `meat/python.go:590-641`, `pythonDelimiterBalanceWithState`
  `:403-466`, `trimPythonCode` `:726-754`, `pythonCodeWithoutStrings`
  `:695-724`, `containsIdentifier` `:830-846`) is byte-indexed via
  `text[i]`/`len(text)`/`strings.Index`/`strings.HasPrefix`/
  `strings.Count`. Per H1's decision (engine operates on `Uint8Array`),
  this ports directly with no adjustment.
  - One byte-skip detail that *looks* like it needs rune-awareness but
    doesn't: the backslash-escape skip inside ordinary-quote consumption
    (`i += 2` at `meat/python.go:437-438,626-627`) only ever skips one
    byte for "the escaped character," even when that character is a
    multi-byte UTF-8 codepoint. This is safe rather than a hidden bug:
    UTF-8 continuation bytes (0x80-0xBF) can never equal any of the ASCII
    bytes this code tests against (quote chars, backslash, brackets, `#`),
    so a stray mid-codepoint position is silently absorbed by the next
    `i++` fallthrough with no effect on where the scan finds the true
    closing quote or the next delimiter. **Do not "fix" this into a
    rune-aware skip when porting** — the byte-for-byte behavior is both
    correct and what the pinned tests assume.
  - Token counting in `changesPythonBoundaryTokens`
    (`meat/python.go:16-23`) and identifier search in `containsIdentifier`
    (`:830-846`) both search for pure-ASCII needles inside byte text —
    also unconditionally safe under a byte-string port for the same
    reason (an ASCII byte can never appear as a UTF-8 continuation byte of
    a different codepoint).
- **H2** (runes vs. UTF-16) — confirmed **not applicable** to `python.go`
  itself: no rune iteration exists in this file to mistranslate. (Contrast
  `editplan.go`/`moves.go`, where H2's `[]rune` and `unicode.Is*` concerns
  are real.)
- **H14** (whitespace trimming) — `strings.TrimSpace` is used at
  `meat/python.go:127` (`hiddenPythonRegionBalanced`'s bare-triple-line
  check), `:750,753` (`trimPythonCode`'s two return points), `:805,810,812`
  (`simpleAssignedReference`'s trims of the whole body, the left-hand side,
  and the left-hand side after colon-truncation). All operate on single
  already-comment-stripped physical lines; none is currently exercised by
  a fixture with U+0085/U+FEFF at the trim boundary (consistent with H14's
  existing "not currently exercised" framing) but the same explicit-trim-
  helper requirement H14 already states applies at each of these six
  sites.
- **H15** (`nil` as meaningful state) — the `state *planState` parameter of
  `pythonSuiteHeaderEnd` (`meat/python.go:277`), `hasPythonBodyAfter`
  (`:308`), and `hasPythonDefinitionAfter` (`:335`) is exactly the pattern
  H15 describes: `nil` and non-`nil` are two semantically distinct,
  both-meaningful states ("raw hunk truth" vs. "what the plan leaves
  visible"), not an optional/absent value. Per H15's own recommendation,
  port this as an explicit nullable reference (e.g. `state: PlanState |
  null`), not an optional parameter defaulting to some sentinel — the
  nil-ness itself is the signal.
- **H16** (indentation-width convention) — re-verified against current
  line numbers, all five citations in the existing `HAZARDS.md` entry are
  still exactly correct: `meat/python.go:36`
  (`validateHiddenPythonOwners`'s `indent := len(leadingWhitespace(body))`),
  `:250` (`validatePythonSuiteSkeleton`'s decorator-branch indent), `:263`
  (`validatePythonSuiteSkeleton`'s `ownerIndent`), `:330`
  (`hasPythonBodyAfter`'s body-indent comparison, `>`), `:362`
  (`hasPythonDefinitionAfter`'s attached-definition indent comparison,
  `!=`). All five use raw byte-length indentation consistently with each
  other; note `:330` and `:362` use **different comparison operators**
  (`>` vs `!=`) for reasons unrelated to H16 — see Decision boundaries
  above.
  - One clarifying note beyond H16's own text: `leadingWhitespace`
    (`meat/editplan.go:480-486`, used throughout `python.go`) is
    implemented as a Go rune-range loop, which might look like an H2
    concern. It isn't one in practice: it only tests for `' '`/`'\t'`,
    both single-byte ASCII values that can never be part of a multi-byte
    UTF-8 sequence, so the byte index it returns is identical to what a
    plain byte-wise "while byte is space or tab" loop would return. A
    byte-wise port is both simpler and behaviorally identical.

No new hazard proposed: every semantic-gap-shaped detail audited in this
file (the `i+=2` backslash skip, the `range`-based `leadingWhitespace`,
ASCII-only identifier checks, byte-string token counting) turned out, on
verification, to be safe under H1's existing "operate on `Uint8Array`"
decision rather than a new gap — see the clarifying notes under H1/H16
above. Everything else worth flagging is a Go-source *approximation* that
must be reproduced faithfully, not a Go→TS translation hazard — those are
written up under Open questions instead.

## Errors

Every `fmt.Errorf` defined in `meat/python.go`, independent of guarantee
cross-referencing:

| Message template | Producer | Line |
|---|---|---|
| `"remove/fold: hides Python decorator on line %d while its definition remains visible"` | `validateHiddenPythonOwners` | `meat/python.go:40` |
| `"remove/fold: hides Python suite owner on line %d while its body remains visible"` | `validateHiddenPythonOwners` | `meat/python.go:44` |
| `"remove/fold: hidden Python region %d-%d crosses %s-side expression or string boundaries; keep the boundaries and compress only their interior"` (`%s` ∈ `{"old","new"}`) | `validateHiddenPythonBoundaries` | `meat/python.go:90` |
| `"fold[%d]: hides definition %q on line %d while retained line %d still references it; keep the definition and fold only its interior"` | `validateHiddenReferences` (fold case) | `meat/python.go:225` |
| `"remove: hides definition %q on line %d while retained line %d still references it; keep the definition and compress only its interior"` | `validateHiddenReferences` (remove case) | `meat/python.go:227` |
| `"remove/fold: retained Python decorator on line %d has no attached definition"` | `validatePythonSuiteSkeleton` | `meat/python.go:252` |
| `"remove/fold: retained Python suite owner on line %d has no indented body; keep a semantic body line or an interior fold"` | `validatePythonSuiteSkeleton` | `meat/python.go:267` |
| `"remove/fold: hunk on line %d must preserve Python (), [], and {} delimiter balance; keep both boundaries or fold/remove the complete balanced expression"` | `validatePythonDelimiterBalance` | `meat/python.go:512` |
| `"remove/fold: Python backslash continuation on lines %d-%d must be retained or hidden together"` | `validatePythonBackslashContinuations` | `meat/python.go:562` |
| `"remove/fold: hunk on line %d must preserve balanced Python triple-quote boundaries; fold or remove the complete string, or keep both boundaries"` | `validateTripleQuoteParity` | `meat/python.go:686` |

All ten are collected via `append(problems, ...)` inside their producing
function's loop (never short-circuited on first error) and returned through
`joinEditPlanErrors(problems)` (`meat/editplan.go:531-540`) — a single
problem returns as-is; multiple problems are joined into one `"edit plan
has %d errors:\n- ...\n- ..."` aggregate error. Two further Python-specific
rejections exist but are **not** in this file — they're produced by
`editplan.go` itself, calling into `python.go` predicates:
`"replace[%d]: line %d is a Python decorator or suite header; keep
structural anchors intact"` (`meat/editplan.go:333`, guarded by
`pythonTripleStateBeforeLine`/`trimPythonCode`/`isPythonSuiteHeaderStart`)
and `"replace[%d]: must preserve Python string and expression boundary
tokens"` (`meat/editplan.go:338`, calling `changesPythonBoundaryTokens`) —
both already cited by G10/G11 in the existing Guarantees section.

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

Found during stage 2 (mechanism study), none pinned by any G-number above —
genuine uncovered mechanism, not a contradiction of stage 1:

- **`isPythonSuiteOwner` is dead code.** Verified by grepping the entire
  repository for `isPythonSuiteOwner`: the only match is its own definition
  at `meat/python.go:787-790`. No production call site, no test call site.
  Superseded by `pythonSuiteHeaderEnd`'s correct multi-line-aware
  trailing-colon check — `isPythonSuiteOwner`'s same-line
  `HasSuffix(trimmed, ":")` check would incorrectly reject any multi-line
  suite header. A port should either drop it or, if kept for parity, must
  not be wired into any live check without re-deriving why it was unused.
  `pythonDelimiterDepth`, by contrast, **is** live
  (`meat/python.go:297,337,356,366`) — not dead.
- **`match`/`case` soft keywords produce false-positive suite-header
  classification on ordinary assignments.** `hasPythonKeyword`
  (`meat/python.go:779-785`) has no way to distinguish Python's
  `match`/`case` *statement* keywords from a variable or parameter literally
  named `match`/`case`: `match = 5` — `hasPythonKeyword("match = 5",
  "match")` sees `HasPrefix` true and the next byte is `' '` → returns
  true, so `isPythonSuiteHeaderStart` misclassifies a plain assignment as a
  suite-header start. Same for `case = get_case()`. No fixture in
  `editplan_test.go` or `python_golden_test.go` exercises this. Consequence
  for a plan touching such a line: it is routed through
  `pythonSuiteHeaderEnd`/`hasPythonBodyAfter` machinery expecting a suite
  body, producing confusing rejections or a spurious body/no-body verdict
  on code that has nothing to do with suite structure.
- **`pythonCodeWithoutStrings` can silently drop real code that follows a
  same-line-closed triple-quoted string, weakening the reference guard.**
  `meat/python.go:695-724` breaks the scan entirely and permanently on the
  *first* `'''`/`"""`-looking prefix on the line (`meat/python.go:701-703`)
  — it does not determine whether that prefix opens *or closes* a string,
  and carries no state to resume after a same-line close. For
  `x = """abc""" + identifier_name`, the function returns only `x = ` and
  silently discards ` + identifier_name` — a genuine identifier reference
  occurring after a same-line triple-quoted string segment is invisible to
  both `simpleAssignedReference` (`meat/python.go:205`) and
  `containsIdentifier`'s search over other lines' output
  (`meat/python.go:220-221`). Consequence: `validateHiddenReferences` (G20)
  can fail to detect that a retained line still references a hidden
  definition, if the only reference on that line appears after a
  same-line-closed triple-quoted string — the reference guard would then
  wrongly allow the definition to be hidden.
- **`pythonSuiteHeaderEnd`/`hasPythonDefinitionAfter`'s per-line
  `pythonDelimiterDepth` calls do not carry triple-quote state between
  lines**, unlike every hunk-level accumulator elsewhere in the file (the
  Mechanism §5 caveat, §2). A multi-line `def`/decorator signature whose
  default-argument or decorator-argument list contains a triple-quoted
  string literal spanning more than one physical line would have
  bracket-looking characters inside that string's later lines miscounted
  as real delimiters by these two functions specifically (though *not* by
  the hunk-level `pythonNewSideStates`/`validatePythonDelimiterBalance`/
  `validateTripleQuoteParity`/`hiddenPythonRegionBalanced`, which do thread
  state correctly). No fixture combines a multi-line signature with an
  embedded multi-line triple-quoted default value.
- **`trimPythonCode`'s non-triple-aware byte-toggle machine can give a
  wrong comment-boundary answer** for a line whose triple-quoted string
  contains an embedded lone quote character of the same kind before the
  line ends (worked example under Mechanism §3). This is a documented
  Go-source approximation that a faithful port must reproduce exactly, not
  a hazard to "fix" — a porter encountering `trimPythonCode`'s doc comment
  alone would likely "improve" it into a correct triple-aware scanner,
  silently changing decorator/suite-header/backslash-continuation
  classification on affected lines relative to the pinned Go behavior.
