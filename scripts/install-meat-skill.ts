// Portable skill installation points at this checkout, without copying engines
// or credentials. Importing this module never installs anything.
import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutRoot = fileURLToPath(new URL("..", import.meta.url));
export type SkillHost = "codex" | "claude";

function linked(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function independentFolder(folder: string, canonical: string): void {
  if (linked(folder)) throw new Error(`Refusing to overwrite linked skill directory: ${folder}. Use a regular skill directory.`);
  mkdirSync(folder, { recursive: true });
  if (realpathSync(folder) === realpathSync(dirname(canonical))) {
    throw new Error(`Refusing to overwrite the canonical skill through ${folder}`);
  }
}

export function installMeatSkill(host: SkillHost, userRoot = homedir(), meatRoot = checkoutRoot): string {
  const folder = join(userRoot, host === "codex" ? ".agents" : ".claude", "skills", "meat");
  const canonicalPath = join(meatRoot, ".claude", "skills", "meat", "SKILL.md");
  const canonical = readFileSync(canonicalPath, "utf8");
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(canonical)?.[0];
  if (!frontmatter) throw new Error(`Canonical skill lacks frontmatter: ${canonicalPath}`);
  // Paths are JSON data in prose, not interpolated shell command text.
  const entry = resolve(meatRoot, "src", "cli", "main.ts").replaceAll("\\", "/");
  const skillPath = resolve(canonicalPath).replaceAll("\\", "/");
  const text = frontmatter + "\n# meat\n\n" +
    "Before selecting commands, read the canonical skill below and follow its\n" +
    "current instructions. This launcher keeps business logic in that one file.\n" +
    "If the file cannot be read, report the missing checkout and stop.\n\n" +
    `Canonical skill (JSON path): ${JSON.stringify(skillPath)}\n\n` +
    `Absolute CLI entry (JSON path): ${JSON.stringify(entry)}\n\n` +
    "Invoke Node with that path as one argument, keeping the working directory\n" +
    "in the repository being reviewed. This installation depends on the meat\n" +
    "checkout. Instruction changes are read directly; rerun the installer after\n" +
    "moving the checkout or changing the skill's discovery metadata.\n";
  independentFolder(folder, canonicalPath);
  const destination = join(folder, "SKILL.md");
  if (linked(destination)) throw new Error(`Refusing to overwrite linked skill file: ${destination}. Use a regular SKILL.md file.`);
  writeFileSync(destination, text, "utf8");
  return destination;
}

export function syncProjectSkills(meatRoot = checkoutRoot): void {
  const canonicalPath = join(meatRoot, ".claude", "skills", "meat", "SKILL.md");
  const canonical = readFileSync(canonicalPath);
  for (const host of [".agents", ".grok"]) {
    const folder = join(meatRoot, host, "skills", "meat");
    independentFolder(folder, canonicalPath);
    const destination = join(folder, "SKILL.md");
    // Replace the discovery link itself, never write through to its target.
    if (linked(destination)) unlinkSync(destination);
    writeFileSync(destination, canonical);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const target = args[0];
  if (args.length !== 1 || !["codex", "claude", "all", "sync"].includes(target ?? "")) {
    process.stderr.write("Usage: npm run skill:install -- codex|claude|all\n       npm run skill:sync\n");
    process.exitCode = 2;
    return;
  }
  if (target === "sync") {
    syncProjectSkills();
    process.stdout.write("Updated project Codex/Grok meat copies from the canonical Claude skill.\n");
    return;
  }
  const hosts: SkillHost[] = target === "all" ? ["codex", "claude"] : [target as SkillHost];
  for (const host of hosts) process.stdout.write(`${host}: ${installMeatSkill(host)}\n`);
  process.stdout.write("Open a new CLI session to discover the installed skill.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
