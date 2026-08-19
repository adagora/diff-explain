// Reads the shipped Agent Skill SKILL.md files from disk (Claude Code,
// Codex, Grok project roots) and checks Agent Skills frontmatter plus the
// meat CLI invocations the body tells an agent to run. Does not golden-blob
// the description or body, and does not mock the files under test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainModulePath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

const HOST_SKILL_ROOTS = [".claude/skills", ".agents/skills", ".grok/skills"] as const;

const SOURCE_TOKENS = ["HEAD", "revision", "range", "stdin"] as const;
const MODE_FLAGS = ["-staged", "-w", "-look", "-json"] as const;
const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "MEAT_MODEL"] as const;

interface ParsedSkill {
  readonly raw: string;
  readonly fields: Record<string, string>;
  readonly keys: readonly string[];
  readonly body: string;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseSkillMarkdown(raw: string): ParsedSkill {
  assert.ok(raw.startsWith("---"), "SKILL.md first bytes must be YAML frontmatter (---)");
  const lines = raw.split(/\r?\n/);
  assert.equal(lines[0], "---", "SKILL.md first line must be ---");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  assert.ok(end > 0, "SKILL.md frontmatter must close with ---");

  const fields: Record<string, string> = {};
  const keys: string[] = [];
  const fmLines = lines.slice(1, end);
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    assert.ok(!/^\s/.test(line), `unexpected indented frontmatter line: ${line}`);
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `frontmatter line is not key: value: ${line}`);
    const key = line.slice(0, colon).trim();
    let rawVal = line.slice(colon + 1);
    if (rawVal.startsWith(" ")) rawVal = rawVal.slice(1);
    keys.push(key);

    const trimmed = rawVal.trim();
    if (trimmed === ">" || trimmed === ">-" || trimmed === "|" || trimmed === "|-" || trimmed === "|+") {
      const folded = trimmed.startsWith(">");
      i++;
      const chunks: string[] = [];
      while (i < fmLines.length && /^\s+/.test(fmLines[i] ?? "")) {
        chunks.push((fmLines[i] ?? "").replace(/^\s+/, ""));
        i++;
      }
      fields[key] = folded ? chunks.join(" ").trim() : chunks.join("\n");
      continue;
    }
    if (trimmed === "" && key === "metadata") {
      i++;
      const chunks: string[] = [];
      while (i < fmLines.length && /^\s+/.test(fmLines[i] ?? "")) {
        chunks.push((fmLines[i] ?? "").trim());
        i++;
      }
      fields[key] = chunks.join("\n");
      continue;
    }
    fields[key] = unquote(rawVal.trim());
    i++;
  }

  const body = lines.slice(end + 1).join("\n");
  return { raw, fields, keys, body };
}

function discoveryPath(root: string, name: string): string {
  return join(repoRoot, root, name, "SKILL.md");
}

function loadCanonical(): { path: string; parsed: ParsedSkill } {
  for (const root of HOST_SKILL_ROOTS) {
    const dir = join(repoRoot, root);
    if (!existsSync(dir)) continue;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name, "SKILL.md");
      if (!existsSync(p)) continue;
      const parsed = parseSkillMarkdown(readFileSync(p, "utf8"));
      const n = parsed.fields["name"] ?? "";
      if (n === ent.name && /meat/i.test(parsed.fields["description"] ?? "")) {
        return { path: p, parsed };
      }
    }
  }
  assert.fail("expected a shipped meat SKILL.md under a project skill root");
}

describe("agent skill SKILL.md", () => {
  const { parsed } = loadCanonical();
  const name = parsed.fields["name"] ?? "";
  const description = parsed.fields["description"] ?? "";
  const body = parsed.body;

  test("YAML frontmatter parses; name and description meet Agent Skills spec", () => {
    assert.equal(typeof name, "string");
    assert.ok(name.length >= 1 && name.length <= 64, `name length ${name.length} not in 1–64`);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `name ${JSON.stringify(name)} is not lowercase a-z0-9- without leading/trailing/consecutive hyphens`);

    assert.ok(description.length >= 1 && description.length <= 1024, `description length ${description.length} not in 1–1024`);
    assert.ok(description.trim().length >= 1, "description is empty");

    assert.ok(/meat/i.test(description), "description must mention meat");
    assert.ok(/abridge/i.test(description) && /unified diff/i.test(description) && /reading[- ]diff/i.test(description), "description must say meat abridges a unified diff into a reading diff");
    assert.ok(
      /review/i.test(description) || /abridge/i.test(description) || /summar/i.test(description),
      "description must include a when-to-use trigger (review / abridge / summarize)",
    );
    assert.ok(
      /commit/i.test(description) || /range/i.test(description) || /staged/i.test(description) || /unstaged/i.test(description) || /piped/i.test(description) || /look/i.test(description),
      "description must mention a diff source or look trigger",
    );

    for (const key of parsed.keys) {
      assert.ok(ALLOWED_FRONTMATTER_KEYS.has(key), `frontmatter key ${JSON.stringify(key)} is outside the Agent Skills spec set`);
    }
    assert.ok(!parsed.keys.includes("disable-model-invocation"), "skill must stay model-invoked (no disable-model-invocation)");
    assert.ok(parsed.keys.includes("name") && parsed.keys.includes("description"));
  });

  test("parent directory of each SKILL.md equals name", () => {
    for (const root of HOST_SKILL_ROOTS) {
      const p = discoveryPath(root, name);
      assert.ok(existsSync(p), `missing ${root}/${name}/SKILL.md`);
      assert.equal(basename(dirname(p)), name, `parent dir of ${p} is not ${name}`);
    }
  });

  test("body invokes this repo's meat CLI on each source and mode", () => {
    assert.match(body, /node\s+src\/cli\/main\.ts/, "body must launch this repo's source CLI with node");
    assert.match(body, /node\s+dist\/cli\/main\.js/, "body must name the built CLI entry");
    for (const flag of MODE_FLAGS) {
      if (flag === "-w") {
        assert.match(body, /-w\b/, "body missing -w");
      } else {
        assert.ok(body.includes(flag), `body missing ${flag}`);
      }
    }
    for (const token of SOURCE_TOKENS) {
      assert.ok(body.includes(token), `body missing source token ${token}`);
    }
    for (const key of ENV_KEYS) {
      assert.ok(body.includes(key), `body missing provider key ${key}`);
    }
    const dones = body.match(/\*\*Done when\*\*/g) ?? [];
    const steps = body.match(/^## /gm) ?? [];
    assert.ok(steps.length >= 4, `expected a step sequence, got ${steps.length} ## headings`);
    assert.equal(dones.length, steps.length, `each step needs a Done when (steps=${steps.length} dones=${dones.length})`);
  });

  test("Claude, Codex, and Grok project paths exist and are byte-identical", () => {
    const paths = HOST_SKILL_ROOTS.map((root) => discoveryPath(root, name));
    const buffers: Buffer[] = [];
    for (const p of paths) {
      assert.ok(existsSync(p), `missing ${p}`);
      buffers.push(readFileSync(p));
    }
    const first = buffers[0];
    assert.ok(first);
    for (let i = 1; i < buffers.length; i++) {
      const other = buffers[i];
      assert.ok(other);
      assert.ok(other.equals(first), `${paths[i]} differs from ${paths[0]} after resolving links`);
    }
    for (const p of paths) {
      assert.ok(realpathSync(p).endsWith("SKILL.md"));
    }
  });

  test("every flag and env key the skill names appears in live meat -h", () => {
    const result = spawnSync(process.execPath, [mainModulePath, "-h"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, `meat -h failed:\n${result.stderr}`);
    const help = `${result.stdout}${result.stderr}`;
    for (const flag of MODE_FLAGS) {
      assert.ok(help.includes(flag), `meat -h missing ${flag} (skill names it)`);
    }
    for (const key of ENV_KEYS) {
      assert.ok(help.includes(key), `meat -h missing ${key} (skill cites it)`);
    }
  });
});
