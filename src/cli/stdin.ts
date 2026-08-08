// stdin.ts (cmd/meat/stdin.go): owns the *file-mode* stdin check `readDiff`
// uses to decide whether to abridge piped data or fall back to summarizing
// HEAD. This is a deliberately different mechanism from the ioctl-based
// `isatty` check `render.ts`/`main.ts` (item 5c/5d) use for progress/color/
// paging — Node's `tty.isatty(fd)` replaces that one (H11), not this one.
// The two disagree on `/dev/null`: it is a character device, so
// `stdinIsPiped` classifies it as "not piped" (terminal-like), while
// `isatty` classifies it as "not a terminal" — an intentional asymmetry
// (specs/cli.md Mechanism "`stdinIsPiped` vs. `isatty`/`isTerminal`", H11).
//
// Untested anywhere in the Go suite (specs/cli.md Open questions): no test
// constructs an `os.Pipe` or otherwise fakes stdin's device type, so this
// file's tests are new coverage written against the source, not a port of
// an existing one.

import { fstatSync } from "node:fs";

/**
 * Go's `stdinIsPiped` (`cmd/meat/stdin.go:8-18`): true when fd 0 is *not* a
 * character device — a pipe, regular file, or socket redirected onto
 * stdin. A stat failure (e.g. stdin closed entirely) counts as "not
 * piped," matching Go's `err != nil` branch, which also returns false.
 */
export function stdinIsPiped(): boolean {
  try {
    return !fstatSync(0).isCharacterDevice();
  } catch {
    return false;
  }
}

/**
 * Go's `readAllStdin` (`cmd/meat/stdin.go:20-22`, `io.ReadAll(os.Stdin)`):
 * reads stdin to completion. No size cap, matching Go exactly (H1) — a
 * deliberate port decision, not a gap; see specs/cli.md Open questions.
 * A read error propagates as a rejected promise, matching Go's returned
 * `error`.
 */
export async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
