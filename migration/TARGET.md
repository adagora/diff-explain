# Target: TypeScript on Node

> Historical port target. Current runtime and build requirements are in
> [package.json](../package.json) and [README](../README.md), including Node
> 22.18+. Original version examples and binding language below describe the
> migration. Current design and planned work live in
> [system design](../docs/system-design.md) and [roadmap](../docs/roadmap.md).

The stack stage 3 builds against. Decisions here are settled; changing one means
revisiting the specs that assume it.

## Stack

| | Choice | Why |
|---|---|---|
| Runtime | **Node ≥ 20** | Stable `node:test`, `AbortSignal.timeout()`/`any()`, global `fetch`. All three are load-bearing. |
| Language | **TypeScript 5.5+**, ESM (`"type": "module"`) | `verbatimModuleSyntax` and modern strictness flags. |
| Build | **`tsc` → `dist/`** | No bundler. Nothing needs one. |
| Tests | **`node:test` + `node:assert/strict`** | Zero dependencies, table-driven style, built-in runner. |
| Distribution | **npm package, `npx meat`** | Replaces `go install meat.dev/cmd/meat@latest`. |
| Runtime deps | **zero** | Non-negotiable — see below. |

### Zero runtime dependencies

`go.mod` has no `require` block: `meat` today is pure standard library. The port
keeps that. Every Go stdlib call maps to a Node built-in (table below), so there
is no gap an npm package needs to fill. `devDependencies` is `typescript` and
`@types/node`, nothing else.

This is a hard constraint, not a preference. A CLI that reads your source tree
and talks to an LLM has a supply-chain surface worth keeping at zero, and the Go
version set that bar.

### Accepted regression

`go install` produces a single static binary; `npx meat` requires a Node
runtime. This was chosen deliberately over Bun/Deno for tooling ubiquity. If
binary parity matters later, add a packaging step (Node SEA) — it does not
affect any spec, only `package.json` and CI.

## Layout

Go packages map one-to-one — same file names, same responsibilities — with
two deliberate, documented exceptions where a Go *file* boundary doesn't
survive translation into a TypeScript *module* graph (Go's single-package
compilation has no file-order dependency; per-file TS imports do). Port
order is [`INVENTORY.md`](INVENTORY.md)'s, as corrected by stage 3's own
discoveries — see `TODO.md`'s "Notes for future iterations" for exactly what
each exception fixes and why.

```
src/
  meat/                    ← package meat
    bytes.ts               ← NEW — the byte-slice layer (H1). Port this first.
    model.ts   provider.ts  gateway.ts  diff.ts
    plan.ts                ← NEW — editplan.go's type layer, extracted to
                              break a moves/imports/python ↔ editplan cycle
    moves.ts   imports.ts   python.ts   editplan.ts
    elision.ts chunk.ts     rubric.ts   tools.ts
    meat.ts    anthropic.ts openai.ts
  cli/                     ← package main
    main.ts    cache.ts     render.ts   stdin.ts
                           ← isatty_*.go does NOT port (H11)
test/                      ← mirrors src/, one file per source file
testdata/                  ← copied verbatim from meat/testdata/, byte-for-byte
conformance/               ← frozen vectors from stage 0 (CONFORMANCE.md)
```

`src/meat/` exports the library; `src/cli/` is the executable. Keep the boundary
as strict as Go's package boundary: `cli` imports from `meat`, never the
reverse, and only `meat`'s exported surface (`Abridge`, `Result`, `Request`,
`Model`, `Message`, `Block`, `Tool`, `Response`, `ResolveModel`, `ElisionLine`,
`DefaultModel`, and the provider constructors) crosses it.

`testdata/` is copied, not regenerated. Those bytes are the oracle (H1, and
[`CONFORMANCE.md`](CONFORMANCE.md)).

## `tsconfig.json`

Maximum strictness. The whole point of the target-language config is that the
compiler catches what the specs could not say.

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",

    "strict": true,
    // ↑ noImplicitAny, strictNullChecks, strictFunctionTypes,
    //   strictBindCallApply, strictPropertyInitialization,
    //   noImplicitThis, useUnknownInCatchVariables, alwaysStrict

    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,

    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    // ↑ Stage 3 discovery (item 4d, diff.ts — the first file with an
    //   intra-src import): NodeNext wants relative imports written with a
    //   `.js` specifier so `tsc --noEmit` type-checks them as if compiled,
    //   but `node --test`/direct `import()` run the raw `.ts` sources with
    //   no build step, and Node's native type-stripping does not remap
    //   `.js` -> `.ts` the way `tsc` does — a `.js` specifier 404s at
    //   runtime. Source files import each other with a literal `.ts`
    //   extension instead; `rewriteRelativeImportExtensions` (TS 5.7+)
    //   makes the real `tsc` build (the `build` script, not `--noEmit`)
    //   rewrite those to `.js` in `dist/`, so the published package still
    //   resolves normally under plain Node with no TS support. Verified:
    //   `tsc --noEmit` clean, `node --test` resolves `.ts` imports
    //   directly, and a real `tsc` build emits `.js`-suffixed imports.

    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

Three of these deserve comment.

**`noUncheckedIndexedAccess` is the most valuable flag in this port and the most
annoying.** It types `bytes[i]` as `number | undefined`, which is exactly right
— Go's bounds-check panics on out-of-range, and silently reading `undefined`
would be strictly worse. But a byte engine indexes constantly, and littering the
parsers with `!` assertions defeats the flag entirely.

Resolve it in `bytes.ts`: expose `at(b, i): number` that throws a `RangeError`
on out-of-bounds (matching Go's panic semantics), plus `slice`, `indexOf`,
`equals`, `hasPrefix`, `splitLines`, `concat`, `trimSpace`. The parsers call
those and never index raw. Then the flag protects the code that *should* be
checked without fighting the code that shouldn't.

**`exactOptionalPropertyTypes`** keeps the `omitempty` distinction honest (H9):
`{ elision?: string }` will not accept an explicit `undefined`, so omitting a
key becomes a deliberate act.

**`useUnknownInCatchVariables`** (via `strict`) forces the error-cause walker
from H5 to narrow properly instead of assuming `err.message` exists.

Consider `"erasableSyntaxOnly": true` if you want the source to run under
`node --experimental-strip-types` without a build. It bans `enum`, `namespace`,
and parameter properties — none of which this port needs, since Go has no
equivalents.

## Go stdlib → Node

The complete dependency mapping. Nothing here needs a third-party package.

| Go | Node | Notes |
|---|---|---|
| `strings`, `bytes` | `src/meat/bytes.ts` | Hand-written. Byte semantics (H1). |
| `unicode`, `unicode/utf8` | `TextEncoder`/`TextDecoder`, `/\p{…}/u` | H2. `ValidString` → decode with `{ fatal: true }`. |
| `regexp` | `RegExp` | **Not equivalent** — H3. |
| `encoding/json` | `JSON` + a raw-fragment serializer | H4. `RawMessage` must stay opaque. |
| `context` | `AbortSignal.any` / a hand-rolled `setTimeout`-backed signal | H6. **Not** `AbortSignal.timeout()` for a deadline whose expiry must be reliable — H19: its timer is deliberately unref'd and can lose a race against an otherwise-idle event loop. `AbortSignal.any()` itself is fine for composing signals. |
| `net/http` | `fetch` | Both providers. |
| `os/exec` | `node:child_process` | H12. `{ signal }` for cancellation. |
| `os`, `io` | `node:fs/promises`, `node:process` | |
| `path/filepath` | `node:path` | H10 — confinement ported verbatim. |
| `bufio` | manual chunking | H12 — buffer caps are behavior. |
| `crypto/sha256`, `encoding/hex` | `node:crypto` | `createHash('sha256').digest('hex')`. |
| `sort` | `Array.prototype.sort` | H7 — stability differs. |
| `strconv` | `Number.parseInt` etc. | Check `NaN`; Go returns an error. |
| `time` | `Date.now()`, ms | H6 — ns vs ms. |
| `flag` | `node:util` `parseArgs` | Must reproduce Go's exact flag syntax. |
| `syscall`, `unsafe` | `node:tty` | H11 — collapses to `isatty(fd)`. |
| `testing` | `node:test` | |
| `net/http/httptest` | `node:http` server on port 0 | Provider tests stub endpoints. |

### Two mappings that are not drop-in

**`flag` → `parseArgs`.** Go's `flag` accepts `-json`, `--json`, `-model=x`, and
`-model x`, stops at the first non-flag argument, and has its own `ErrHelp`
path (`cmd/meat/main.go:89-99`). `parseArgs` defaults differ on single-dash long
options and on positional handling. The CLI accepts git-shaped positionals
(`HEAD~3`, `a..b`, `main...HEAD`) alongside flags, so getting this wrong breaks
ordinary invocations. Specify the exact accepted grammar in stage 1 from
`cmd/meat/readdiff_test.go` and treat it as a contract.

**`httptest` → `node:http`.** The provider tests spin up stub servers to
exercise retry, streaming, and error paths (`meat/anthropic_test.go`,
`meat/openai_test.go`, `meat/gateway_test.go`). `node:http` listening on port 0
gives the same hermetic pattern. Keep them hermetic — no test may reach a real
provider.

## `package.json`

```jsonc
{
  "name": "meat",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "meat": "./dist/cli/main.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "postbuild": "chmod +x dist/cli/main.js",
    "test": "node --test",
    "check": "tsc --noEmit && node --test"
  },
  "dependencies": {},
  "devDependencies": { "typescript": "^5.5", "@types/node": "^20" }
}
```

**`version` is not optional** — `npm pack`/`npm publish` refuse to run
without one (discovered in item 6/Packaging: the field was missing from
this snippet until then, since nothing before that item ever actually
packed the tarball). `0.1.0` for the initial port; bump per ordinary semver
from here.

`dist/cli/main.js` needs a `#!/usr/bin/env node` shebang preserved through
the build (confirmed: `tsc` passes a source file's hashbang line straight
through to its emitted `.js`, no extra config needed — the shebang must be
literally the first line of `src/cli/main.ts` itself), and the executable
bit set on publish. `tsc` does **not** set the executable bit on its own
output, so `postbuild: chmod +x dist/cli/main.js` (npm's implicit
pre/post-script convention — runs automatically after `npm run build`) is
required; verified this is necessary, not defensive, by inspecting a real
`npm pack` tarball's contents before adding it.

## Definition of done

A stage-3 TODO item is complete when all four hold:

1. `tsc --noEmit` is clean with the config above — no `any`, no `!` outside
   `bytes.ts`, no `@ts-expect-error` without a cited reason.
2. Its ported tests pass under `node --test`.
3. Every conformance vector it touches still passes
   ([`CONFORMANCE.md`](CONFORMANCE.md)).
4. Its spec's citations still resolve, and any hazard it hit is recorded in
   [`HAZARDS.md`](HAZARDS.md).
