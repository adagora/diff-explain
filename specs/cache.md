# cache

> Status: stage 1 ✅ | stage 2 ✅
> Go sources: `cmd/meat/cache.go`
> Go tests: `cmd/meat/cache_test.go` (8 tests — key derivation, round-trip
> storage, disabling, corruption handling, env override, and the `run`
> orchestration that decides when to read/write it)

## Purpose

The `~/.meat` result cache: a deterministic key derived from a diff, a
model id, and a rubric hash, mapped to a stored `Result` on disk, so that
re-running meat on the same inputs against the same compiler protocol skips
the model call entirely. Caching is opt-out (`MEAT_CACHE=""` or `-no-cache`)
and fails open — a cache that can't be read or written never blocks meat
from producing an answer.

## Vocabulary

- **Cache key** — the SHA-256 hex digest naming a cached result, computed
  from three NUL-separated fields in fixed order: rubric hash, model id,
  diff text. See G1.
- **Rubric hash** — the value actually passed as the cache key's "rubric"
  input: not raw rubric prose but a hash summarizing the complete
  rubric/compiler protocol (see `rubric.md`'s `RubricHash`/`promptSurface`),
  so that upgrading model guidance or a hard compiler invariant invalidates
  every previously cached entry. See G1.
- **Cache hit / cache miss** — a hit is a successful load by key that
  yields a stored result without invoking compute; a miss is any other
  outcome (key absent, unreadable, or corrupt) and always falls through to
  computing fresh. See G4, G6.
- **Cache directory** — the filesystem directory holding one JSON file per
  cache key; resolved by `cacheDir`, overridable via `MEAT_CACHE`, and
  treated as "caching disabled" when empty. See G3, G5.
- **Write-through (refresh)** — storing a freshly computed result under a
  key that already had a (possibly stale) entry, unconditionally
  overwriting it. Exercised specifically by the `-no-cache` path. See G7.
- **`-no-cache` (`runOpts.noCache`)** — an option that skips the cache
  *read* only; the subsequent store still happens, so it acts as a forced
  refresh, not a full cache bypass. See G7.

## Guarantees

G1. The cache key is a deterministic function of exactly three inputs — the
    diff text, the model id, and the rubric hash — such that identical
    inputs always produce the same key, and changing any one of the three
    changes the key. Field boundaries are unambiguous: no pair of distinct
    `(diff, model)` values can be shifted across the field boundary to
    produce a colliding key.
    — `cmd/meat/cache_test.go:15-36` (`TestCacheKeyDependsOnDiffModelAndRubric`):
    same triple twice → same key (`:18`); a changed diff changes the key
    (`:21`); a changed model changes the key (`:24`); a changed rubric
    changes the key (`:29`, with the comment at `:27-28` explaining why —
    "tuning the rubric (a meat upgrade) must invalidate stale cached
    abridgements"); `cacheKey("a","b","r")` differs from
    `cacheKey("a\x00b","","r")` (`:33`), guarding against a
    naive-concatenation collision at the model/diff boundary. Mechanism:
    `cacheKey` `cmd/meat/cache.go:31-41` hashes with SHA-256 in fixed
    order — rubric bytes, a NUL byte, model bytes, a NUL byte, diff bytes —
    then hex-encodes the digest; the NUL separators are what make the field
    boundary unambiguous (a NUL cannot occur in a model id or a rubric
    hash, and is treated as vanishingly unlikely in a diff).

G2. A cache directory that has never been written to always misses; storing
    a result under a key and then loading that same key returns a value
    equal in every field to what was stored.
    — `cmd/meat/cache_test.go:38-59` (`TestCacheRoundTrip`): a miss on an
    empty temp directory (`:48`); stores a `Result{SmartDiff, Summary,
    InputTokens, OutputTokens}` and asserts the loaded value is `==` (Go
    value equality) to the stored value (`:51-58`). Mechanism: `cacheStore`
    `cmd/meat/cache.go:63-92` JSON-marshals the result and writes it to
    `<dir>/<key>.json`; `cacheLoad` `cache.go:46-59` reads that path and
    JSON-unmarshals it. The cached payload is `meat.Result`
    (`meat/meat.go:94-105`) — four scalar fields, no slices/maps/pointers,
    which is why plain value equality is a valid round-trip check.

G3. Passing an empty string as the cache directory disables caching
    completely: storing is a silent no-op and loading always reports a
    miss, regardless of what (if anything) was "stored" before.
    — `cmd/meat/cache_test.go:61-68` (`TestCacheDisabledWithEmptyDir`).
    Mechanism: `cacheStore` `cache.go:64-66` returns immediately when `dir
    == ""`, before touching the filesystem; `cacheLoad` `cache.go:47-49`
    returns `(nil, false)` immediately under the same condition.

G4. An on-disk entry that isn't valid JSON is treated as an ordinary cache
    miss — not an error, not a panic, and not a hit with garbage data.
    — `cmd/meat/cache_test.go:70-79` (`TestCacheMissOnCorruptEntry`): writes
    the literal bytes `{not json` directly to `<dir>/<key>.json` via
    `os.WriteFile`, bypassing `cacheStore` entirely, then asserts
    `cacheLoad` on that key misses. Mechanism: `cacheLoad`
    `cache.go:54-57` — a `json.Unmarshal` failure on the file's bytes
    returns `(nil, false)`, identically to the missing-file path.

G5. The cache directory is resolved from the `MEAT_CACHE` environment
    variable when that variable is *set at all* (even to the empty
    string) — its value is returned verbatim, and an empty value is the
    sanctioned way to disable caching.
    — `cmd/meat/cache_test.go:81-90` (`TestCacheDirEnvOverride`):
    `MEAT_CACHE=/custom/path` → `cacheDir() == "/custom/path"`;
    `MEAT_CACHE=""` → `cacheDir() == ""`. Mechanism: `cacheDir`
    `cache.go:15-24` — `os.LookupEnv("MEAT_CACHE")` distinguishes "unset"
    from "set to empty" via its boolean return; when present (`ok ==
    true`), the value (possibly `""`) is returned directly (`:16-18`).
    Only when the variable is entirely absent does it fall through to
    `os.UserHomeDir()` joined with `.meat` (`:19-23`), or `""` if that
    errors (`:20-21`) — neither fallback branch is exercised by any test
    (see Open questions).

G6. On a cache hit, `run` renders the cached result and prints a cache-hit
    notice to stderr, and **never** invokes the compute callback — this
    holds even when compute would itself return an error if called,
    proving the hit path is structurally incapable of reaching it. A cache
    miss computes once, reports token usage and elapsed time, and stores
    the result for next time.
    — `cmd/meat/cache_test.go:117-152` (`TestRunCacheHitSkipsCompute`):
    first `run` (miss) asserts exactly one compute call (`:126-128`) and
    that stderr contains `"tokens in=7 out=3 in "` (`:130-131`) for a
    compute result of `InputTokens:7, OutputTokens:3`. A second `run` with
    the same diff/model/rubric but a compute that would return an error if
    invoked asserts the call count stays at 1 (`:143-145`), that the
    rendered output contains the cached summary (`:146-147`), and that
    stderr contains `"meat: cached"` (`:149-151`, substring only — the
    trailing `(sha %s)` portion isn't asserted). Mechanism: `run`
    `cmd/meat/main.go:196-218`. Computes `key := cacheKey(o.diff, o.model,
    o.rubric)` (`:197`); if `!o.noCache`, attempts `cacheLoad(o.cacheDir,
    key)` (`:199`); on a hit, calls `o.render(res)` then prints `"\nmeat:
    cached (sha %s)\n"` with `key[:12]` (`:201`) and returns — `o.compute`
    is never referenced on this path. On a miss, it times the call,
    invokes `o.compute(ctx)` (`:207`), returns immediately on error
    (`:208-210`, before any store), otherwise calls `cacheStore(o.cacheDir,
    key, res)` (`:213`), renders, and prints `"\nmeat: tokens in=%d out=%d
    in %s\n"` (`:216`).

G7. Bypassing the cache read (`-no-cache`, modeled as `runOpts.noCache =
    true`) forces a fresh compute even when a matching — but now considered
    stale — entry already exists under that key, and the fresh result
    overwrites (write-through refreshes) that entry afterward, so a
    subsequent normal lookup sees the fresh value, not the stale one.
    — `cmd/meat/cache_test.go:156-178`
    (`TestRunNoCacheBypassesReadButWritesThrough`): pre-seeds the cache with
    `Result{Summary:"stale"}` under the exact key the run will use
    (`:162`); with `noCache=true`, asserts exactly one compute call
    (`:168-170`); asserts the output contains `"fresh"` and not `"stale"`
    (`:171-173`); asserts a plain `cacheLoad` after the run returns
    `Summary=="fresh"` (`:175-176`), proving the entry was overwritten, not
    left stale or unwritten. Mechanism: `run` `main.go:198` — the `if
    !o.noCache { ... }` block wrapping the entire `cacheLoad` attempt is
    skipped outright when `noCache` is true, falling straight through to
    the compute-then-store path (`main.go:206-213`) with no read attempted.

G8. When compute fails on a miss, `run` propagates that error to its
    caller and leaves the cache untouched — no entry is written for a
    failed computation.
    — `cmd/meat/cache_test.go:182-190` (`TestRunComputeErrorPropagates`):
    compute returns an error; asserts `run` returns non-nil; asserts a
    subsequent `cacheLoad` for that key still misses. Mechanism: `run`
    `main.go:207-210` — the compute error is returned immediately;
    `cacheStore` (`main.go:213`) is unreachable on that path, appearing
    strictly after the error check.

## Mechanism

`cache.go` contains exactly four functions — `cacheDir`, `cacheKey`,
`cacheLoad`, `cacheStore` — and nothing else. **Scope note:** the "`run`
orchestration that decides when to read/write it," which stage 1's file
header attributes to this file, actually lives in `cmd/meat/main.go:196-218`
(the `run` function and its `runOpts` struct), inside package `main`
alongside `cache_test.go` but in a different source file — already cited
correctly by G6-G8 above. `cache.go`'s own responsibility ends at:
resolve a directory, derive a key, and get/put one JSON blob under that
key, plus the `dir == ""` disable gate duplicated at the top of both
`cacheLoad` and `cacheStore`.

**Directory resolution** (`cacheDir`, `cache.go:15-24`). Three-way
precedence, driven by `os.LookupEnv`'s two-value form rather than a plain
string read, specifically to distinguish "unset" from "set to empty":
1. Look up `MEAT_CACHE`. If it is present in the environment *at all* —
   including present-and-empty — return its value verbatim, unmodified,
   with no further processing (`cache.go:16-18`). An empty string
   returned here is what "caching disabled" means everywhere else in
   this file.
2. Only if `MEAT_CACHE` is entirely absent from the environment, resolve
   the OS-reported home directory (`cache.go:19`).
3. If that resolution errors, return `""` — same as explicit-disable
   (`cache.go:20-21`).
4. Otherwise join home directory with the literal path segment `.meat`
   and return it (`cache.go:23`).

**Key derivation** (`cacheKey`, `cache.go:31-41`). Given three strings —
diff text, model id, rubric hash (itself already a hex digest, not
prose; see `rubric.md`) — in that call-signature order:
1. Start a new SHA-256 hash state.
2. Feed it the rubric string's bytes.
3. Feed it one literal `0x00` byte.
4. Feed it the model string's bytes.
5. Feed it one literal `0x00` byte.
6. Feed it the diff string's bytes — no trailing separator after this
   field.
7. Take the 32-byte digest and lowercase-hex-encode it (64 characters).

The write order is rubric, then model, then diff — not the parameter
order (diff, model, rubric) `cache.go:31,35-39`. The two NUL bytes are
the only field separators; there is no length-prefixing or other
framing. A byte value of `0x00` cannot occur in a hex-encoded rubric
hash or (in practice) a model id, and is not defended against in a diff
— collision via a literal NUL inside diff text is treated as
unreachable, not prevented `cache.go:33-34`.

**Read path** (`cacheLoad`, `cache.go:46-59`). Given a resolved
directory and a key:
1. If `dir` is the empty string, return "no result, false" immediately
   — no filesystem call is made at all `cache.go:47-49`.
2. Otherwise read the file at `dir/<key>.json` in one shot
   (`filepath.Join`, then `os.ReadFile`) `cache.go:50`.
3. Any read error whatsoever — file absent, permission denied, path is
   a directory, I/O error — is not distinguished from any other; all
   collapse to "no result, false" `cache.go:51-53`. There is no
   separate "cache directory unreadable" signal from "key not present."
4. On a successful read, JSON-decode the bytes into a zero-valued
   `Result` (`meat/meat.go:94-105`: `SmartDiff string`, `Summary
   string`, `InputTokens int`, `OutputTokens int` — four scalars, no
   slices/maps/pointers) `cache.go:54`.
5. Any decode error — malformed JSON syntax, a JSON value of the wrong
   type for a field, non-object top level — is treated identically to a
   missing file: "no result, false" `cache.go:55-57`. This, and only
   this, is what "corrupt" means in this file: a decode failure. It is
   not an error return, not a panic, not surfaced anywhere.
6. Otherwise return a pointer to the populated `Result` and `true`
   `cache.go:58`.

**Decision boundary not covered by any existing guarantee**: step 4-5
uses Go's default, lenient `json.Unmarshal` — a syntactically valid JSON
object that is simply missing one or more of the four fields (e.g. the
literal text `{}`, or `{"summary":"x"}`) decodes *successfully*, leaving
the unset fields at their Go zero values (`""`, `0`). That is reported
as a **hit**, not a miss — "corrupt" is purely a syntax/type-decode
failure, never a completeness check on the decoded value.

**Write path** (`cacheStore`, `cache.go:63-92`). Given a directory, key,
and result pointer; returns nothing — every failure branch is a bare
`return`:
1. If `dir` is `""`, return immediately; nothing is touched
   `cache.go:64-66`.
2. Create `dir` and any missing parents via `os.MkdirAll(dir, 0o700)`.
   On error, return `cache.go:67-69`. (`MkdirAll` on an already-existing
   directory succeeds without changing its mode.)
3. JSON-marshal the `Result` value using the default `encoding/json`
   encoder — compact, no indentation, HTML-escaping *on* (Go's default;
   this differs from the `-json` CLI output path, which explicitly
   disables HTML escaping — see Hazards, H4). On a marshal error, return
   `cache.go:70-72`.
4. Create a temp file inside `dir` via `os.CreateTemp(dir,
   key+".*.tmp")` — Go substitutes a random string for the `*`, so the
   temp name is `<key>.<random>.tmp` sitting in the same directory as
   the final destination. On error, return `cache.go:75-78`.
5. Write the marshaled bytes to the temp file in one call. On error:
   close the temp file (its close error, if any, is discarded), delete
   the temp file, and return — no partial file is left behind under any
   name `cache.go:80-84`.
6. Close the temp file. On error: delete it and return `cache.go:85-88`.
7. Rename the temp file onto `dir/<key>.json`, replacing any existing
   file at that path in one filesystem operation. On error: delete the
   (unrenamed) temp file and return; the previous `dir/<key>.json`, if
   any, is left completely untouched `cache.go:89-91`.

The rename-based sequence (steps 4-7) is what backs the code comment "a
concurrent reader never sees a half-written file" `cache.go:74`: a
reader of `dir/<key>.json` at any instant sees either nothing, the
complete prior write, or the complete new write — never bytes from an
in-progress write, because the write happens entirely under the temp
name and only an atomic rename ever changes what `<key>.json` points to.

## Invariants

- **The `dir == ""` disable check is duplicated, not shared**, once in
  `cacheLoad` `cache.go:47-49` and once in `cacheStore` `cache.go:64-66`.
  A port must apply the check symmetrically at the top of both
  operations; there is no single shared gate to port once and reuse.
- **A cache key is always exactly 64 lowercase hex characters**
  (`hex.EncodeToString` of a 32-byte SHA-256 digest, `cache.go:40`), so
  it can never contain a path separator or a `..` segment — the join
  with `dir` at `cache.go:50,89` is safe by construction, not by
  explicit validation. Breaking this (e.g. a port that lets an unhashed
  or user-controlled string reach the filename position) reopens a
  path-escape class of bug that Go never had to guard against explicitly
  here.
- **None of the four functions returns a Go `error`** —
  `cacheDir() string`, `cacheKey(...) string`, `cacheLoad(...)
  (*meat.Result, bool)`, `cacheStore(...)` (no return value). This is a
  structural guarantee: there is no return path through which a caching
  failure *could* propagate as an error to the caller, short of a panic
  (nothing in the file panics — no unchecked type assertions, no
  explicit `panic`). A port that gives any of these an error-returning
  or throwing signature changes the contract G6-G8 depend on (cache
  misses/failures must be silently absorbed by `run`, never surfaced).
- **Atomicity of the write is a filesystem property (rename on the same
  volume), not a Go-level lock or concurrency primitive** — `cache.go`
  has no mutex, channel, or goroutine. If broken (e.g. a port that
  writes in place, or renames across filesystems where rename isn't
  atomic), the failure mode is bounded: `cacheLoad`'s decode-failure
  path already treats a torn/partial file as an ordinary miss, so the
  observable consequence of losing this invariant is "occasionally
  recompute instead of hit," not corruption of `meat`'s own output.
- **`cacheDir`'s ok-vs-value distinction must survive porting.** A port
  that reads the environment as `value ?? default` or `value || default`
  — instead of a presence check — collapses "set to empty" into "unset"
  and silently reintroduces a default cache directory when the
  sanctioned disable value (`MEAT_CACHE=""`) is passed, breaking the
  external contract in `migration/INVENTORY.md`'s "MEAT_CACHE (empty
  disables caching)" line.

## Hazards

- **H1** (Go strings are UTF-8 bytes; JS strings are UTF-16 code units):
  `cacheKey` hashes the raw byte encoding of `rubric`, `model`, and
  `diff` (`cache.go:35,37,39`) — in Go, `[]byte(s)` on an
  already-UTF-8-encoded string is a reinterpretation, not a re-encode. A
  port must feed SHA-256 the UTF-8 byte encoding of each string (e.g.
  `TextEncoder().encode(...)`), not a UTF-16 buffer, or keys diverge
  from Go's for any diff containing non-ASCII bytes. `model` and
  `rubric` are effectively ASCII in practice so this bites almost
  exclusively through the `diff` field.
- **H4** (`json.RawMessage` byte-preservation) — checked, **not
  applicable**. `meat.Result` (`meat/meat.go:94-105`) has no
  `RawMessage`/opaque-provider-state field; its four fields are two
  plain strings and two plain ints.
- **H9** (nil vs. empty slice in JSON) — checked, **not applicable**.
  `Result` has no slice or map fields, so the nil-vs-`[]` ambiguity
  cannot arise in the cached payload. (H9's actual site,
  `jsonResult.Elision` with `omitempty`, is a *different*, render.go-only
  wrapper struct for the `-json` CLI form — outside this file's scope.)
- **H15** (zero values): applies narrowly. `cacheLoad` decodes into a
  zero-valued `var res meat.Result` (`cache.go:54`). Valid JSON that
  omits some/all of the four keys decodes successfully, leaving those
  fields at Go's zero value, and is reported as a hit (see Mechanism's
  read-path steps 4-5). A port using a strict/schema-validating parser
  that rejects missing required fields would treat such an entry as
  corrupt where Go treats it as a (degenerate) hit — no test in
  `cache_test.go` exercises a syntactically-valid-but-incomplete cache
  file.
- **No H7/H13 relevance** — `cache.go` contains no `sort.*` call and no
  map type or map iteration anywhere in the file. Ordering is fully
  deterministic.
- **No H6 relevance** — none of the four functions takes a
  `context.Context` or observes cancellation/deadlines; `run`'s `ctx`
  parameter (`main.go:196`) is never threaded into any cache.go call.
  Caching is synchronous, uncancellable filesystem I/O by construction.
- **Structurally analogous to H10, but not the same mechanism**:
  `cache.go` never validates that `key` is safe before joining it into a
  path (`cache.go:50,89`); safety instead falls entirely out of the
  key-is-always-a-hex-digest invariant above. Unlike H10's `read_file`
  confinement, there is no explicit prefix/root check here to port — do
  not add one; it is safe by construction as long as `cacheKey`'s
  hex-encode step is preserved.

## Errors

`cache.go` defines **zero error message strings** — it does not import
`fmt`, never calls `fmt.Errorf`, and never panics. Every failure mode
(missing/unreadable file, malformed JSON, `MkdirAll` failure,
`json.Marshal` failure, `CreateTemp` failure, `Write` failure, `Close`
failure, `Rename` failure) is absorbed into either a bare `(nil, false)`
return from `cacheLoad` (`cache.go:48,52,56`) or a bare `return` from
`cacheStore` (`cache.go:65,68,72,77,83,87,91`) with no observable trace.
**No cache read or write failure is ever fatal to a `meat` invocation,
and none produces even a warning** — from `cache.go`'s perspective a
permission-denied cache directory is indistinguishable from an empty
one. (The two user-visible strings associated with caching —
`"\nmeat: cached (sha %s)\n"` and `"\nmeat: tokens in=%d out=%d in
%s\n"` — belong to `run` in `main.go:201,216`, are both success-path
notices rather than errors, and are `cli.md` territory.)

## Ordering that Go leaves unspecified

None. No `sort.*` call and no map type appears anywhere in `cache.go`;
every operation is either a single deterministic hash/encode pass or a
sequential filesystem call.

## Open questions

- **A syntactically-valid-but-field-incomplete JSON cache entry is a
  hit, not a miss** (stage 2 finding) — `cacheLoad`'s decode into a
  zero-valued `Result` means `{}` or `{"summary":"x"}` decodes
  successfully and is returned as a "hit" with the missing fields at
  their Go zero values. G4 ("isn't valid JSON is treated as an ordinary
  cache miss") is correct as far as it goes but narrower than the actual
  mechanism — untested by any fixture (only the syntactically-invalid
  case `{not json` is exercised).
- **`cacheDir`'s home-directory fallback is entirely untested** — no test
  unsets `MEAT_CACHE` to reach the `os.UserHomeDir()`-joined-with-`.meat`
  branch, and no test forces `UserHomeDir()` to fail to reach its `""`
  fallback.
- **Atomicity of `cacheStore`'s write is asserted only by a code comment,
  not by any test.** The temp-file-then-`os.Rename` sequence
  (`cmd/meat/cache.go:74-91`, commented "so a concurrent reader never sees
  a half-written file") has no test exercising concurrent readers/writers,
  the temp-file naming pattern, or cleanup-on-failure.
- **`cacheStore`'s failure-swallowing is asserted only by comment.** The
  doc comment at `cache.go:61-62` states failures are silently ignored ("a
  machine that can't write the cache should still print its answer"), but
  no test forces any internal failure branch (`MkdirAll`, `json.Marshal`,
  `CreateTemp`, `Write`, `Close`, `Rename` failing) to confirm `run` still
  succeeds when storing fails.
- **File/directory permission bits are never asserted** — no test reads
  back the mode of the created cache directory (`0o700` per
  `cache.go:67`) or of the written files.
- **The cache-hit notice's `(sha %s)` suffix is unpinned** — only the
  `"meat: cached"` prefix is checked; the exact 12-character hash-prefix
  slicing (`key[:12]`, `main.go:201`) is mechanism-only.
- **`cacheKey`'s collision-resistance is pinned for one adversarial pair
  only** (`"a","b","r"` vs. `"a\x00b","","r"`) — a NUL in the model field,
  or in both diff and model simultaneously, or in the rubric-hash field, is
  untested.
- **No test exercises multiple coexisting cache entries** in the same
  directory (one key's store/load not disturbing another's, or ignoring
  unrelated `.json` files) — every populated-directory test uses at most
  one relevant key.
