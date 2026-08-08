// cache.ts (cmd/meat/cache.go): the `~/.meat` result cache — resolve a
// directory, derive a key, and get/put one JSON blob under that key. Exactly
// four functions, matching Go's file scope exactly: the `run` orchestration
// that decides *when* to read/write the cache (specs/cache.md G6-G8) lives
// in `cmd/meat/main.go`, not `cache.go` — ported later, in `main.ts` (item
// 5d), not here.
//
// H1: `cacheKey` hashes the UTF-8 bytes of `rubric`/`model`/`diff`, in that
// write order (not the parameter order). Node's `Hash.update(str, "utf8")`
// already reinterprets a JS string as UTF-8 bytes, the same move Go's
// `[]byte(s)` makes on an already-UTF-8 Go string — no `TextEncoder` needed
// here, matching the precedent in `rubric.ts`'s `RubricHash`.
//
// H15: `cacheLoad`'s JSON decode is deliberately lenient, matching Go's
// `json.Unmarshal` into a zero-valued struct — a syntactically valid but
// field-incomplete object (`{}`, `{"summary":"x"}`) is a **hit** with the
// missing fields at their zero value, not corrupt. Only a JSON syntax error
// or a present-but-wrong-typed field is a miss. A JSON top-level of `null`
// is also a hit at the all-zero value: Go's `json.Unmarshal` documents
// unmarshaling `null` into a non-pointer destination as a no-op, producing
// no error and leaving the zero-valued destination untouched — an obscure,
// untested-in-Go corner (specs/cache.md Open questions doesn't even list
// it), kept here because it costs one branch to preserve faithfully.
//
// The `dir === ""` disable gate is duplicated verbatim in `cacheLoad` and
// `cacheStore`, matching Go — specs/cache.md's Invariants: "there is no
// single shared gate to port once and reuse."
//
// None of the four functions distinguishes error *kinds* anywhere (not even
// `cacheStore`'s temp-file open, which doesn't retry on collision): Go's
// `cache.go` never inspects an error's type either, every failure branch is
// an unconditional bare return/miss. A port that started pattern-matching
// on `NodeJS.ErrnoException` codes would be adding a distinction Go itself
// doesn't make.

import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { encodeUTF8, decodeUTF8 } from "../meat/bytes.ts";
import { type Result } from "../meat/meat.ts";

/**
 * Go's `cacheDir` (`cmd/meat/cache.go:15-24`, G5): `MEAT_CACHE` wins
 * verbatim whenever it is present in the environment at all — including
 * present-and-empty, the sanctioned way to disable caching — checked via
 * `!== undefined` rather than `??`/`||`, which would collapse "set to
 * empty" into "unset" and silently reintroduce this default. Only when the
 * variable is entirely absent does this fall through to the OS home
 * directory joined with `.meat`, or `""` if that can't be resolved.
 */
export function cacheDir(): string {
  const fromEnv = process.env["MEAT_CACHE"];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  try {
    return join(homedir(), ".meat");
  } catch {
    return "";
  }
}

/**
 * Go's `cacheKey` (`cmd/meat/cache.go:31-41`, G1): SHA-256 over
 * NUL-separated UTF-8 bytes, written in the order rubric, model, diff — not
 * the parameter order — then lowercase-hex-encoded.
 */
export function cacheKey(diff: string, model: string, rubric: string): string {
  return createHash("sha256")
    .update(rubric, "utf8")
    .update("\0", "utf8")
    .update(model, "utf8")
    .update("\0", "utf8")
    .update(diff, "utf8")
    .digest("hex");
}

function decodeCachedResult(value: unknown): Result | null {
  if (value === null) {
    return { smartDiff: new Uint8Array(0), summary: "", inputTokens: 0, outputTokens: 0 };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const smartDiff = obj["smart_diff"];
  const summary = obj["summary"];
  const inputTokens = obj["input_tokens"];
  const outputTokens = obj["output_tokens"];
  if (
    (smartDiff !== undefined && typeof smartDiff !== "string") ||
    (summary !== undefined && typeof summary !== "string") ||
    (inputTokens !== undefined && typeof inputTokens !== "number") ||
    (outputTokens !== undefined && typeof outputTokens !== "number")
  ) {
    return null;
  }
  return {
    smartDiff: encodeUTF8(smartDiff ?? ""),
    summary: summary ?? "",
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };
}

/**
 * Go's `cacheLoad` (`cmd/meat/cache.go:46-59`, G2-G4): a missing directory,
 * a missing/unreadable file, or a decode failure (syntax error or a
 * present field of the wrong type) all collapse to a miss (`null`) — see
 * the file header for the `null`-top-level and field-incompleteness cases.
 */
export async function cacheLoad(dir: string, key: string): Promise<Result | null> {
  if (dir === "") {
    return null;
  }
  let data: Buffer;
  try {
    data = await readFile(join(dir, `${key}.json`));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUTF8(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
  } catch {
    return null;
  }
  return decodeCachedResult(parsed);
}

interface ExclusiveTempFile {
  readonly path: string;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

async function openExclusiveTempFile(dir: string, key: string): Promise<ExclusiveTempFile | null> {
  const path = join(dir, `${key}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const handle = await open(path, "wx");
    return {
      path,
      write: async (data) => {
        await handle.writeFile(data);
      },
      close: () => handle.close(),
    };
  } catch {
    return null;
  }
}

/**
 * Go's `cacheStore` (`cmd/meat/cache.go:63-92`, G2/G7/G8): every failure
 * branch — `mkdir`, marshal, temp-file create/write/close, rename — is a
 * silent no-op, matching Go's bare `return`s exactly (specs/cache.md
 * Invariants: "there is no return path through which a caching failure
 * could propagate"). The write path is temp-file-then-rename so a
 * concurrent reader never observes a half-written file.
 */
export async function cacheStore(dir: string, key: string, result: Result): Promise<void> {
  if (dir === "") {
    return;
  }
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  const payload = JSON.stringify({
    smart_diff: decodeUTF8(result.smartDiff),
    summary: result.summary,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
  });
  const tmp = await openExclusiveTempFile(dir, key);
  if (tmp === null) {
    return;
  }
  try {
    await tmp.write(encodeUTF8(payload));
  } catch {
    await tmp.close().catch(() => undefined);
    await unlink(tmp.path).catch(() => undefined);
    return;
  }
  try {
    await tmp.close();
  } catch {
    await unlink(tmp.path).catch(() => undefined);
    return;
  }
  try {
    await rename(tmp.path, join(dir, `${key}.json`));
  } catch {
    await unlink(tmp.path).catch(() => undefined);
  }
}
