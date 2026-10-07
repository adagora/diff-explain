import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Windows-style Git checkout preserves byte fixtures and intentional line endings", t => {
  const temporary = mkdtempSync(join(tmpdir(), "meat-fixture-checkout-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = join(temporary, "repository");
  const checkout = join(temporary, "checkout with spaces");
  mkdirSync(repo);
  mkdirSync(checkout);
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: repo, env, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, ".gitattributes"), readFileSync(join(root, ".gitattributes")));
  const fixtures = new Map([
    ["conformance/vectors/numbered/example.txt", Buffer.from("line one\n+é\n")],
    ["conformance/vectors/raw/example.diff", Buffer.from([0xff, 0x0d, 0x0a, 0x2b, 0x0a])],
    ["testdata/python/example.diff", Buffer.from("@@ -1 +1 @@\n-a\n+b\n")],
    ["testdata/python/example.golden.diff", Buffer.from("+a\r\n+b\r\n")],
    ["analysis/example/example.original.diff", Buffer.from("+a\n+b\n")],
    ["analysis/example/nested/example.live.diff", Buffer.from("+a\r\n+b\n")],
  ]);
  for (const [path, bytes] of fixtures) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), bytes);
  }
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "raw fixture bytes");
  // Explicit conversion policy overrides the caller's configuration. The
  // attributes must protect an actual checkout, not a normalized test reader.
  execFileSync("git", ["-c", "core.autocrlf=true", "checkout-index", "--all", "--force",
    `--prefix=${checkout.replaceAll("\\", "/")}/`], { cwd: repo, env, stdio: "pipe" });
  for (const [path, bytes] of fixtures) {
    assert.deepEqual(git("cat-file", "blob", `HEAD:${path}`), bytes, `${path}: committed oracle changed`);
    assert.deepEqual(readFileSync(join(checkout, path)), bytes, `${path}: checkout changed raw bytes`);
  }
});
