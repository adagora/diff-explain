import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIError } from "./errors.ts";

export const setupAgents = ["codex", "claude", "both"] as const;
type SetupAgent = typeof setupAgents[number];
type Host = "codex" | "claude";
type Action = "create" | "unchanged" | "bundled" | "conflict";

export interface SetupOptions {
  readonly project: string;
  readonly agent: SetupAgent;
  readonly apply: boolean;
}

interface SetupFile {
  readonly agent: Host;
  readonly skill: string;
  readonly path: string;
  readonly action: Action;
  readonly reason: string;
}

const skills = ["columbo", "meat", "show-me"] as const;
const hostRoots: Record<Host, string> = { codex: ".agents", claude: ".claude" };

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function setupLauncher(): string {
  const main = new URL(import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js", import.meta.url);
  return `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(main))}`;
}

async function inspect(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parentPaths(project: string, path: string): string[] {
  const parts = relative(project, dirname(path)).split(sep).filter(Boolean);
  const paths: string[] = [];
  let current = project;
  for (const part of parts) { current = join(current, part); paths.push(current); }
  return paths;
}

async function blockedParent(project: string, path: string): Promise<string | null> {
  for (const parent of parentPaths(project, path)) {
    const stat = await inspect(parent);
    if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) return parent;
  }
  return null;
}

function renderSkill(text: string, launcher: string): string {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---\n") || end < 0) throw new CLIError("setup_assets", "A bundled skill has invalid frontmatter", "Reinstall columbo from a complete package, then rerun columbo setup.");
  const fenceLength = Math.max(3, ...Array.from(launcher.matchAll(/`+/g), match => match[0].length + 1));
  const fence = "`".repeat(fenceLength);
  const runtime = `\n\n## Project installation\n\nUse this exact launch line for this installation. Append columbo commands and\nkeep the shell in the repository being examined. Generic checkout examples\nbelow describe the arguments; this absolute launch line identifies the CLI.\n\n${fence}sh\n${launcher}\n${fence}\n`;
  return text.slice(0, end + 4) + runtime + text.slice(end + 4);
}

async function classify(project: string, path: string, source: string, bundled: string, content: string): Promise<{ action: Action; reason: string }> {
  const blocked = await blockedParent(project, path);
  if (blocked !== null) return { action: "conflict", reason: `Parent is a symlink or non-directory: ${blocked}` };
  const existing = await inspect(path);
  if (existing === null) return { action: "create", reason: "File does not exist" };
  if ((existing.isFile() || existing.isSymbolicLink()) && await realpath(path).catch(() => "") === source) {
    return { action: "bundled", reason: "Already resolves to this installation's bundled skill" };
  }
  if (existing.isFile() && !existing.isSymbolicLink() && existing.size === Buffer.byteLength(bundled) && (await readFile(path)).equals(Buffer.from(bundled))) {
    return { action: "bundled", reason: "Matches this installation's bundled skill" };
  }
  if (existing.isFile() && !existing.isSymbolicLink() && existing.size === Buffer.byteLength(content) && (await readFile(path)).equals(Buffer.from(content))) {
    return { action: "unchanged", reason: "Already matches the requested installation" };
  }
  return { action: "conflict", reason: "An existing file, directory, or symlink would be replaced" };
}

async function ensureParents(project: string, path: string): Promise<void> {
  for (const parent of parentPaths(project, path)) {
    try { await mkdir(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CLIError("setup_changed", `Unsafe parent encountered during setup: ${parent}`, "Rerun columbo setup --dry-run and resolve the conflicting path.");
    }
  }
}

export async function setupProject(options: SetupOptions) {
  let project: string;
  try {
    project = await realpath(resolve(options.project));
    if (!(await lstat(project)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CLIError("setup_path", `Project is not an accessible directory: ${options.project}`, "Choose an existing project directory: columbo setup --project /path/to/project --dry-run.");
  }
  const agents: readonly Host[] = options.agent === "both" ? ["codex", "claude"] : [options.agent];
  const launcher = setupLauncher();
  const assets = await Promise.all(skills.map(async skill => {
    const path = fileURLToPath(new URL(`../../.claude/skills/${skill}/SKILL.md`, import.meta.url));
    try {
      const source = await realpath(path);
      const text = await readFile(source, "utf8");
      return { skill, source, bundled: text, content: skill === "show-me" ? text : renderSkill(text, launcher) };
    } catch {
      throw new CLIError("setup_assets", `Cannot load the bundled ${skill} skill`, "Reinstall columbo from a complete package, then rerun columbo setup.");
    }
  }));
  const files: SetupFile[] = [];
  const content = new Map<string, { source: string; bundled: string; content: string }>();
  for (const agent of agents) {
    for (const asset of assets) {
      const path = join(project, hostRoots[agent], "skills", asset.skill, "SKILL.md");
      files.push({ agent, skill: asset.skill, path, ...await classify(project, path, asset.source, asset.bundled, asset.content) });
      content.set(path, asset);
    }
  }
  const conflicts = files.filter(file => file.action === "conflict");
  const ready = conflicts.length === 0;
  const applyCommand = `columbo setup --project ${shellQuote(project)} --agent ${options.agent} --yes`;
  if (options.apply && !ready) {
    throw new CLIError("setup_conflict", `Setup would replace existing content at: ${conflicts.map(file => file.path).join(", ")}. Nothing was written.`, "Preserve or move the conflicting files yourself, then rerun columbo setup --dry-run. Existing skills are never overwritten.");
  }
  const created: string[] = [];
  if (options.apply) {
    try {
      for (const file of files) {
        const asset = content.get(file.path)!;
        const current = await classify(project, file.path, asset.source, asset.bundled, asset.content);
        if (current.action === "conflict" || (file.action !== "create" && current.action === "create")) {
          throw new CLIError("setup_changed", `Setup target changed after preview: ${file.path}`, "Rerun columbo setup --dry-run before applying again.");
        }
        if (current.action !== "create") continue;
        await ensureParents(project, file.path);
        const handle = await open(file.path, "wx", 0o644);
        created.push(file.path);
        try { await handle.writeFile(asset.content, "utf8"); }
        finally { await handle.close(); }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof CLIError ? error.kind : (error as NodeJS.ErrnoException).code === "EEXIST" ? "setup_changed" : "setup_write";
      throw new CLIError(kind, `Setup stopped: ${message}. Files created before stopping: ${created.length === 0 ? "none" : created.join(", ")}. Existing files were not overwritten.`, "Inspect the reported paths and rerun columbo setup --dry-run. Setup may have created some files or directories before stopping.");
    }
  }
  return {
    kind: "columbo.setup", schema_version: 1, project, agents,
    mode: options.apply ? "apply" : "preview", ready,
    launcher, files, created,
    next_action: !ready ? "Resolve the listed conflicts, then rerun columbo setup --dry-run."
      : !options.apply ? applyCommand
        : "Open a fresh agent session in this project and ask: Use columbo to audit this repository. If discovery is stale, run the absolute launcher with prime audit --json and read data.instructions.",
  };
}

export function parseSetupOptions(args: readonly string[]): SetupOptions {
  let project = process.cwd();
  let agent: SetupAgent = "both";
  let projectSet = false, agentSet = false, apply = false, dryRun = false;
  const usage = () => new CLIError("usage", "Use one agent (codex, claude, or both), one project directory, and either --dry-run or --yes", "columbo setup --project /path/to/project --agent both --dry-run", 2);
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--json") continue;
    if (token === "--yes") { apply = true; continue; }
    if (token === "--dry-run") { dryRun = true; continue; }
    const eq = token.indexOf("=");
    const name = eq < 0 ? token : token.slice(0, eq);
    if (name === "--project" || name === "--agent") {
      const value = eq < 0 ? args[++i] : token.slice(eq + 1);
      if (!value || value.startsWith("--")) throw usage();
      if (name === "--project") {
        if (projectSet) throw usage();
        project = value; projectSet = true;
      } else {
        if (agentSet || !setupAgents.includes(value as SetupAgent)) throw usage();
        agent = value as SetupAgent; agentSet = true;
      }
    } else if (setupAgents.includes(token as SetupAgent) && !agentSet) {
      agent = token as SetupAgent; agentSet = true;
    } else throw usage();
  }
  if (apply && dryRun) throw usage();
  return { project, agent, apply };
}
