// Port of cmd/meat/stdin.go — except there is nothing to port a *test*
// from: specs/cli.md's Open questions flags stdinIsPiped/readAllStdin as
// "untested anywhere in the Go suite," since no test in the Go tree
// constructs an os.Pipe or otherwise fakes stdin's device type. These are
// new tests written directly against src/cli/stdin.ts's contract.
//
// Both functions read the real fd 0 of the process they run in, so the
// only way to exercise a chosen device type is to spawn a child process
// with a chosen `stdio` wiring — there is nothing in node:fs to fake fd 0
// in-process. `stdio: ["ignore", ...]` makes Node open /dev/null or Windows
// NUL (a character device) for the child's fd 0; `stdio: ["pipe", ...]` with an
// `input` makes it a real pipe.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stdinModuleURL = new URL("../../src/cli/stdin.ts", import.meta.url).href;

async function writeProbe(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "meat-stdin-"));
  const probePath = join(dir, name);
  await writeFile(probePath, source);
  return probePath;
}

describe("stdinIsPiped (cmd/meat/stdin.go:8-18, H11)", () => {
  test("a character device (stdio 'ignore', backed by the null device) is classified as not piped", async () => {
    const probe = await writeProbe(
      "probe.mjs",
      `import { stdinIsPiped } from ${JSON.stringify(stdinModuleURL)};\n` +
        `import { fstatSync } from "node:fs";\n` +
        `if (!fstatSync(0).isCharacterDevice()) throw new Error("stdin is not a character device");\n` +
        `process.stdout.write(stdinIsPiped() ? "true" : "false");\n`,
    );
    const result = spawnSync(process.execPath, [probe], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
    assert.equal(result.status, 0, `probe failed: ${result.error?.message ?? ""}`);
    assert.equal(result.stdout, "false");
  });

  test("a real pipe is classified as piped", async () => {
    const probe = await writeProbe(
      "probe.mjs",
      `import { stdinIsPiped } from ${JSON.stringify(stdinModuleURL)};\n` +
        `process.stdout.write(stdinIsPiped() ? "true" : "false");\n`,
    );
    const result = spawnSync(process.execPath, [probe], {
      input: "diff --git a/x b/x\n",
      stdio: ["pipe", "pipe", "inherit"],
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `probe failed: ${result.error?.message ?? ""}`);
    assert.equal(result.stdout, "true");
  });
});

describe("readAllStdin (cmd/meat/stdin.go:20-22)", () => {
  async function readBackProbe(): Promise<string> {
    return writeProbe(
      "probe.mjs",
      `import { readAllStdin } from ${JSON.stringify(stdinModuleURL)};\n` +
        `const bytes = await readAllStdin();\n` +
        `process.stdout.write(Buffer.from(bytes));\n`,
    );
  }

  test("reads piped input to completion, byte-exact", async () => {
    const probe = await readBackProbe();
    const input = Buffer.from([0x6c, 0x69, 0x6e, 0x65, 0x0a, 0xff, 0xfe, 0x00, 0x9c]);
    const result = spawnSync(process.execPath, [probe], { input, stdio: ["pipe", "pipe", "inherit"] });
    assert.equal(result.status, 0, `probe failed: ${result.error?.message ?? ""}`);
    assert.ok(Buffer.isBuffer(result.stdout));
    assert.ok((result.stdout as Buffer).equals(input));
  });

  test("empty stdin reads as an empty buffer, matching io.ReadAll on no data", async () => {
    const probe = await readBackProbe();
    const result = spawnSync(process.execPath, [probe], { input: Buffer.alloc(0), stdio: ["pipe", "pipe", "inherit"] });
    assert.equal(result.status, 0, `probe failed: ${result.error?.message ?? ""}`);
    assert.equal((result.stdout as Buffer).length, 0);
  });

  test("no size cap: reads well past a single pipe buffer (H1)", async () => {
    const probe = await readBackProbe();
    const input = Buffer.alloc(1024 * 1024, 0x61);
    const result = spawnSync(process.execPath, [probe], {
      input,
      stdio: ["pipe", "pipe", "inherit"],
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `probe failed: ${result.error?.message ?? ""}`);
    assert.ok((result.stdout as Buffer).equals(input));
  });
});
