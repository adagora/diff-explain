import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { subscriptionEnv, isSubscriptionLogin, agentCommand, visualGuidance } from "../../src/cli/agent.ts";
import { parseFlags } from "../../src/cli/main.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const fixture = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

test("child environment excludes API credentials/routing and preserves login locations", () => {
  const env = { OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", ANTHROPIC_API_KEY: "secret",
    XAI_API_KEY: "secret", ANTHROPIC_BASE_URL: "proxy", CLAUDE_CODE_USE_BEDROCK: "1",
    HOME: "/home/test", CODEX_HOME: "/home/test/codex", PATH: "/bin" };
  assert.deepEqual(subscriptionEnv(env), { HOME: env.HOME, CODEX_HOME: env.CODEX_HOME, PATH: env.PATH });
  assert.equal(env.OPENAI_API_KEY, "secret");
});

test("subscription filtering handles Windows environment key casing without changing its input", () => {
  const env = { openai_api_key: "fake", Anthropic_Base_Url: "local", xai_api_key: "fake",
    codex_api_key: "fake", claude_code_use_vertex: "1", Claude_Code_OAuth_Token: "fake",
    Path: "/bin", CODEX_HOME: "/login", Meat_Agent_Active: "0" };
  assert.deepEqual(subscriptionEnv(env), { Path: "/bin", CODEX_HOME: "/login", Meat_Agent_Active: "0" });
  assert.equal(env.openai_api_key, "fake");
});

test("recursive fresh-agent requests stop before looking for a CLI or login", () => {
  const result = spawnSync(process.execPath, [cli, "-agent", "codex"], {
    input: fixture, encoding: "utf8", env: { ...process.env, MEAT_AGENT_ACTIVE: "1", PATH: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /recursive meat agent invocation refused/);
  assert.doesNotMatch(result.stderr, /cannot run codex|subscription login not confirmed/);
  assert.equal(result.stdout, "");
});

test("auth gate fails closed on API accounts and unknown status formats", () => {
  assert.ok(isSubscriptionLogin("codex", "Logged in using ChatGPT\n"));
  assert.equal(isSubscriptionLogin("codex", "Logged in using an API key"), false);
  const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
  assert.ok(isSubscriptionLogin("claude", JSON.stringify(status)));
  for (const change of [{ subscriptionType: null }, { apiKeySource: "/login managed key" },
    { loggedIn: false }, { authMethod: "api_key" }, { apiProvider: "bedrock" }]) {
    assert.equal(isSubscriptionLogin("claude", JSON.stringify({ ...status, ...change })), false);
  }
  assert.equal(isSubscriptionLogin("claude", "not JSON"), false);
});

test("agent flags reject unknown providers and conflicting modes", () => {
  for (const agent of ["codex", "claude"]) {
    const result = parseFlags(["-agent", agent, "-w"]);
    assert.ok(result.kind === "ok" && result.flags.agent === agent && result.flags.worktree);
    assert.ok(agentCommand(agent).length > 0);
  }
  for (const flag of ["-look", "-json", "-prompt", "-model=x", "-no-cache"]) {
    assert.equal(parseFlags(["-agent", "codex", flag]).kind, "error");
  }
  assert.equal(parseFlags(["-agent", "grok"]).kind, "error");
  assert.equal(parseFlags(["-agent="]).kind, "error");
});

for (const agent of ["codex", "claude"]) test(`${agent}: stdin, cwd, streaming, and no API fallback`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "meat agent & (test)-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.json");
  const fake = join(dir, process.platform === "win32" ? `${agent}.cjs` : agent);
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('status')) {
  fs.writeFileSync(process.env.TEST_CAPTURE + '.auth', JSON.stringify({args: process.argv.slice(2), key: process.env.OPENAI_API_KEY}));
  if (${JSON.stringify(agent)} === 'codex') console.log(process.env.TEST_AUTH === 'api' ? 'Logged in using an API key' : 'Logged in using ChatGPT');
  else console.log(JSON.stringify({loggedIn: true, authMethod: process.env.TEST_AUTH === 'api' ? 'api_key' : 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max'}));
} else {
  let input = '';
  process.stdin.on('data', b => input += b);
  process.stdin.on('end', () => {
    fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({ input, cwd: process.cwd(), args: process.argv.slice(2), key: process.env.OPENAI_API_KEY }));
    process.stderr.write('AGENT-LOG-LINE echoing the whole packet\\n');
    console.log('Review finished');
    process.exit(Number(process.env.TEST_EXIT || 0));
  });
}
`);
  chmodSync(fake, 0o755);
  if (process.platform === "win32") {
    writeFileSync(join(dir, `${agent}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${agent}.cjs" %*\r\n`);
  }
  const env = { ...process.env, PATH: dir, TEST_CAPTURE: capture, OPENAI_API_KEY: "must-not-reach-child", MEAT_AGENT_ACTIVE: "" };
  const invoke = (extra = {}, flags: string[] = []) => spawnSync(process.execPath, [cli, "-agent", agent, ...flags], {
    cwd: dir, env: { ...env, ...extra }, input: fixture, encoding: "utf8", timeout: 5000,
  });
  const ok = invoke();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "Review finished\n");
  // The agent's own log stays hidden on success unless -verbose asks for it.
  assert.doesNotMatch(ok.stderr, /AGENT-LOG-LINE/);
  assert.match(ok.stderr, /add -verbose to show it/);
  const verbose = invoke({}, ["-verbose"]);
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.equal(verbose.stdout, "Review finished\n");
  assert.match(verbose.stderr, /AGENT-LOG-LINE/);
  const saved = join(dir, "review.md");
  const toFile = invoke({}, ["-o", saved]);
  assert.equal(toFile.status, 0, toFile.stderr);
  assert.equal(toFile.stdout, "");
  assert.equal(readFileSync(saved, "utf8"), "Review finished\n");
  const got = JSON.parse(readFileSync(capture, "utf8"));
  const auth = JSON.parse(readFileSync(capture + ".auth", "utf8"));
  assert.deepEqual(auth.args, agent === "codex" ? ["login", "status"] : ["--setting-sources", "", "auth", "status"]);
  assert.equal(auth.key, undefined);
  assert.equal(realpathSync(got.cwd), realpathSync(dir));
  assert.equal(got.key, undefined);
  assert.ok(got.input.includes(fixture));
  assert.ok(got.input.includes(visualGuidance));
  assert.doesNotMatch(got.input, /name: show-me|Bash\(open /);
  assert.deepEqual(got.args, agentCommand(agent));
  const failed = invoke({ TEST_EXIT: "7" });
  assert.equal(failed.status, 1);
  // A failed run shows the hidden log so the cause is visible.
  assert.match(failed.stderr, new RegExp(`meat: ${agent} log \\(last \\d+ bytes\\):\\nAGENT-LOG-LINE`));
  assert.match(failed.stderr, /review failed \(exit 7\); no API fallback/);
  const denied = invoke({ TEST_AUTH: "api" });
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.match(denied.stderr, /subscription login not confirmed/);
});
