# cache

> Status: stage 1 ✅ | stage 2 ⬜
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

## Open questions

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
