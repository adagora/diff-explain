// render.ts (cmd/meat/render.go): turns a compiled `Result` into what the
// user sees — colorized/plain terminal output (`renderResult`) or the
// `-json` wire form (`renderJSON`). Decoding `Result.smartDiff` from bytes
// (H1) to a string happens here, at the CLI boundary — nowhere upstream.
//
// **Signature note**: Go's `renderJSON(w io.Writer, res *meat.Result, elision
// string)` writes to a caller-supplied writer. This port instead returns the
// encoded string (`renderJSON(res, elision): string`) — a pure function is
// both simpler to test and what `test/conformance.test.ts`'s `json-wire`
// block already calls it as; a caller (item 5d's `main.ts`) can trivially
// `process.stdout.write(renderJSON(...))`. `renderResult` keeps Go's
// writer-taking shape since it is genuinely side-effecting (may shell out to
// a pager, may write to `process.stdout` directly inside `page`, falls back
// to a caller-supplied `w` on pager failure) — no such simplification
// applies there, and it has no dedicated conformance vector to answer to.
//
// H12: four subprocess call sites below — `gitWantsColor`, `diffColor` (up
// to 5x per render: one per palette slot, including `commit`), `gitPager`,
// and the pager invocation itself. All fail closed/silent (color off, no
// pager) matching Go exactly. No AbortSignal/cancellation anywhere in this
// file — H6 confirmed not applicable (specs/render.md Hazards).
//
// H9: only the `elision` field of the -json wire form omits its key when
// empty; `smart_diff`/`summary`/`input_tokens`/`output_tokens` always
// serialize, including at their falsy zero value.
//
// H14: `formatBody`'s blank-diff check reproduces Go's
// `unicode.IsSpace`-based `strings.TrimSpace(diff) == ""` (render.go:92) via
// bytes.ts's audited `trimSpace`, never JS's `.trim()`. `goTrimSpaceString`
// below is the same Go-matching helper applied to `gitWantsColor`'s and
// `gitPager`'s captured stdout — neither site is on migration/HAZARDS.md's
// H14 catalogue (git's own stdout there is verified ASCII-only), but they
// route through it anyway rather than `.trim()`, per item 1's "do not call
// `.trim()` anywhere in the port" rule.

import { execFileSync } from "node:child_process";
import { isatty } from "node:tty";
import { trimSpace, decodeUTF8, encodeUTF8 } from "../meat/bytes.ts";
import { type Result } from "../meat/meat.ts";

/** Go's `ansiReset` (`render.go:47`). */
export const ansiReset = "\x1b[m";

/** Go's `diffPalette` (`render.go:51-53`). An empty slot means "no color". */
export interface DiffPalette {
  readonly meta: string;
  readonly frag: string;
  readonly old: string;
  readonly new: string;
}

const emptyPalette: DiffPalette = { meta: "", frag: "", old: "", new: "" };

function isEmptyPalette(p: DiffPalette): boolean {
  return p.meta === "" && p.frag === "" && p.old === "" && p.new === "";
}

/**
 * A destination `renderResult` can write to and, via `.fd`, test for
 * terminal-ness — Go's `io.Writer` narrowed to `*os.File` inside
 * `isTerminal`. Anything without a numeric `fd` (an in-memory buffer, for
 * instance) is never a terminal, matching G6. `process.stdout`/
 * `process.stderr` satisfy this structurally, with no adapter needed.
 */
export interface Writer {
  readonly fd?: number;
  write(text: string): void;
}

/**
 * Go's `isTerminal` (`render.go:230-236`). H11: the real `isatty(3)` ioctl
 * `isatty_*.go` implemented per-platform is `node:tty`'s built-in `isatty`
 * here — nothing to hand-port. Redirecting to a regular file or `/dev/null`
 * (a character device, the same OS category as a real terminal) both
 * correctly report `false` (G7), since `isatty` performs the real ioctl
 * rather than a char-device check.
 */
export function isTerminal(w: Writer): boolean {
  return typeof w.fd === "number" && isatty(w.fd);
}

function goTrimSpaceString(s: string): string {
  return decodeUTF8(trimSpace(encodeUTF8(s)));
}

/**
 * Go's `gitWantsColor` (`render.go:170-184`, G9): defers to git's own
 * `color.diff`/`color.ui` policy rather than coloring unconditionally on a
 * tty. With an explicit trailing `true`/`false` argument, `--get-colorbool`
 * always exits 0 and prints the resolved text — the exit-status convention
 * only applies when the argument is omitted. Any subprocess failure
 * (including "git not on PATH") fails closed to `false` (H12).
 */
export function gitWantsColor(tty: boolean): boolean {
  const arg = tty ? "true" : "false";
  try {
    const out = execFileSync("git", ["config", "--get-colorbool", "color.diff", arg], { encoding: "utf8" });
    return goTrimSpaceString(out) === "true";
  } catch {
    return false;
  }
}

/**
 * Go's `diffColor` (`render.go:189-195`). Returns git's raw `--get-color`
 * stdout **unprocessed** — no trim. Verified empirically: unlike
 * `--get-colorbool`, `--get-color` prints only the raw ANSI escape with no
 * trailing newline, so the absence of trimming here is correct, not an
 * oversight — do not "helpfully" add one. Subprocess failure → `""` (H12);
 * `def` is used by *git*, not this function, as the fallback color name.
 */
function diffColor(slot: string, def: string): string {
  try {
    return execFileSync("git", ["config", "--get-color", `color.diff.${slot}`, def], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/**
 * Go's `palette` (`render.go:57-67`). `color === false` returns the empty
 * palette directly with no subprocess call at all.
 */
export function palette(color: boolean): DiffPalette {
  if (!color) return emptyPalette;
  return {
    meta: diffColor("meta", "bold"),
    frag: diffColor("frag", "cyan"),
    old: diffColor("old", "red"),
    new: diffColor("new", "green"),
  };
}

/**
 * Go's `commitColor` (`render.go:105-110`): a fifth, on-demand slot,
 * queried at most once per render and only when some other palette slot is
 * already active (no subprocess under the zero/plain palette).
 */
function commitColor(p: DiffPalette): string {
  if (isEmptyPalette(p)) return "";
  return diffColor("commit", "yellow");
}

// Go's `diffMetaPrefixes` (`render.go:152-165`): the non-+++/--- metadata
// line starts git colors as meta. Fixed order, walked linearly.
const diffMetaPrefixes: readonly string[] = [
  "diff ",
  "index ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
];

/**
 * Go's `isDiffMeta` (`render.go:139-149`). `+++`/`---` file headers count
 * as meta, checked explicitly before the fixed prefix table.
 */
export function isDiffMeta(line: string): boolean {
  if (line.startsWith("+++") || line.startsWith("---")) return true;
  return diffMetaPrefixes.some((prefix) => line.startsWith(prefix));
}

/**
 * Go's `colorizeDiffLine` (`render.go:116-134`). `isDiffMeta` is checked
 * before the generic `@@`/`+`/`-` tests — reordering would recolor
 * `+++`/`---` file headers and every `diffMetaPrefixes` line as
 * added/removed content. The original line text is always preserved
 * unmodified inside the color wrapping.
 */
export function colorizeDiffLine(line: string, p: DiffPalette): string {
  let color: string;
  if (isDiffMeta(line)) {
    color = p.meta;
  } else if (line.startsWith("@@")) {
    color = p.frag;
  } else if (line.startsWith("+")) {
    color = p.new;
  } else if (line.startsWith("-")) {
    color = p.old;
  } else {
    return line; // context line: no color
  }
  if (color === "") return line;
  return color + line + ansiReset;
}

/**
 * Go's `formatBody` (`render.go:72-101`). Header presence is a decision,
 * not just a color one: an empty `summary` means no header line at all. The
 * blank-diff placeholder is written via plain concatenation, never through
 * `colorizeDiffLine`, so it is categorically un-colorizable.
 */
export function formatBody(res: Result, elision: string, p: DiffPalette): string {
  let out = "";
  if (res.summary !== "") {
    const c = commitColor(p);
    out += c !== "" ? `${c}# ${res.summary}${ansiReset}\n` : `# ${res.summary}\n`;
  }
  if (elision !== "") {
    out += `# ${elision}\n`;
  }
  if (out.length > 0) {
    out += "\n";
  }
  if (trimSpace(res.smartDiff).length === 0) {
    return out + "(no meaningful change to read)\n";
  }
  const diff = decodeUTF8(res.smartDiff).replace(/\n+$/, "");
  for (const line of diff.split("\n")) {
    out += colorizeDiffLine(line, p) + "\n";
  }
  return out;
}

interface JsonResult {
  smart_diff: string;
  summary: string;
  input_tokens: number;
  output_tokens: number;
  elision?: string;
}

/**
 * Go's `renderJSON` (`render.go:23-27`, G10). Returns the `-json` wire form
 * — see the file header's Signature note. `JSON.stringify` never
 * HTML-escapes (H4, matching Go's explicit `SetEscapeHTML(false)`); only
 * `elision` omits its key when empty (H9), the other four fields always
 * serialize their key, including at a falsy value. The trailing `"\n"`
 * matches `json.Encoder.Encode`'s own appended newline.
 */
export function renderJSON(res: Result, elision: string): string {
  const payload: JsonResult = {
    smart_diff: decodeUTF8(res.smartDiff),
    summary: res.summary,
    input_tokens: res.inputTokens,
    output_tokens: res.outputTokens,
    ...(elision !== "" ? { elision } : {}),
  };
  return JSON.stringify(payload) + "\n";
}

/**
 * Go's `gitPager` (`render.go:219-225`). One subprocess call embodies
 * git's entire pager-resolution chain (`GIT_PAGER` → `core.pager` →
 * `$PAGER` → `less`) — meat does not reimplement that chain itself, it
 * takes git's answer verbatim. Subprocess failure → `""` (H12).
 */
function gitPager(): string {
  try {
    const out = execFileSync("git", ["var", "GIT_PAGER"], { encoding: "utf8" });
    return goTrimSpaceString(out);
  } catch {
    return "";
  }
}

/**
 * Go's `page` (`render.go:200-216`, H12). An empty or literal `"cat"` pager
 * writes `text` straight to `process.stdout`, no subprocess. Otherwise the
 * whole resolved pager string is handed to a shell as one command line —
 * never tokenized, since `$PAGER`/`core.pager` values legitimately contain
 * arguments and pipes — with `text` on its stdin and its stdout/stderr
 * wired to the *process's* own (not any `Writer` a caller supplied). `LESS`
 * is injected as `FRX` only when not already set in the environment,
 * mirroring git's own `less` defaults (F=quit-if-fits-one-screen,
 * R=raw-ANSI-passthrough, X=no-altscreen-clear). Returns whether the write
 * succeeded, collapsing Go's `error` to a boolean since nothing downstream
 * inspects more than "did this fail."
 */
function page(text: string): boolean {
  const pager = gitPager();
  if (pager === "" || pager === "cat") {
    try {
      process.stdout.write(text);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const envOverride = process.env["LESS"] === undefined ? { env: { ...process.env, LESS: "FRX" } } : {};
    execFileSync("sh", ["-c", pager], {
      input: text,
      stdio: ["pipe", "inherit", "inherit"],
      ...envOverride,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Go's `renderResult` (`render.go:33-45`). Mimics `git show`: an
 * interactive terminal gets a colorized, paged rendering, deferring
 * entirely to git's `color.diff`/`color.ui` policy (G9); anything else gets
 * plain text and never touches git at all. The `tty &&` short-circuit below
 * is the single most important short-circuit in this file (specs/render.md
 * Invariants): a non-tty writer never shells out to git, even under
 * `color.diff=always`. On pager failure the fallback writes to the
 * caller-supplied `w`, not `process.stdout` — a real, if usually harmless,
 * textual distinction from `page`'s own direct-write branch.
 */
export function renderResult(w: Writer, res: Result, elision: string): void {
  const tty = isTerminal(w);
  const color = tty && gitWantsColor(tty);
  const body = formatBody(res, elision, palette(color));
  if (!tty) {
    w.write(body);
    return;
  }
  if (!page(body)) {
    w.write(body);
  }
}
