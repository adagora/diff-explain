// doctor.ts: `meat -doctor` answers "which review workflows can I run here?"
// for a person setting meat up. It reads the environment, checks files and
// asks installed agent CLIs for their local login status. It never calls a
// model, contacts a provider or gateway, reads a diff, or prints a
// credential value: environment variables are reported by name only.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable, loginCommand, subscriptionEnv, subscriptionLogin, type SubscriptionLogin } from "./agent.ts";
import { cacheDir } from "./cache.ts";
import { ResolveModel, isAnthropicModel, isGrokModel } from "../meat/provider.ts";
import { gatewayConfig } from "../meat/gateway.ts";

const checkoutRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const minimumNode = [22, 18] as const;

type SkillInstall = "this_checkout" | "other" | "absent";
type AgentState = "not_installed" | SubscriptionLogin["state"];

export interface DoctorFacts {
  readonly node: string;
  readonly git: string | null;
  readonly repo: string | null;
  readonly meatOnPath: string | null;
  readonly checkout: string;
  readonly dotEnv: boolean;
  readonly skills: { readonly claude: SkillInstall; readonly codex: SkillInstall };
  readonly agents: { readonly codex: AgentState; readonly claude: AgentState };
  readonly api: {
    readonly model: string;
    readonly provider: string;
    readonly providerVars: readonly string[];
    readonly setVars: readonly string[];
    readonly exeDev: boolean;
  };
  readonly cache: string;
}

function gitOutput(args: readonly string[]): string | null {
  try {
    return execFileSync("git", args as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function skillInstall(file: string): SkillInstall {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "absent";
  }
  const entry = resolve(checkoutRoot, "src", "cli", "main.ts").replaceAll("\\", "/");
  return text.includes(`Absolute CLI entry (JSON path): ${JSON.stringify(entry)}`) ? "this_checkout" : "other";
}

function agentState(agent: string, env: NodeJS.ProcessEnv): AgentState {
  if (findExecutable(agent, env) === null) return "not_installed";
  return subscriptionLogin(agent, env).state;
}

const apiVars = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "XAI_API_KEY", "XAI_BASE_URL"];

export function collectDoctorFacts(env: NodeJS.ProcessEnv = process.env): DoctorFacts {
  const model = ResolveModel("");
  const provider = isAnthropicModel(model) ? "Anthropic" : isGrokModel(model) ? "xAI" : "OpenAI";
  const prefix = provider === "Anthropic" ? "ANTHROPIC_" : provider === "xAI" ? "XAI_" : "OPENAI_";
  const home = homedir();
  const loginEnv = subscriptionEnv(env);
  return {
    node: process.versions.node,
    git: gitOutput(["--version"]),
    repo: gitOutput(["rev-parse", "--show-toplevel"]),
    meatOnPath: findExecutable("meat", env),
    checkout: checkoutRoot,
    dotEnv: existsSync(".env"),
    skills: {
      claude: skillInstall(join(home, ".claude", "skills", "meat", "SKILL.md")),
      codex: skillInstall(join(home, ".agents", "skills", "meat", "SKILL.md")),
    },
    agents: { codex: agentState("codex", loginEnv), claude: agentState("claude", loginEnv) },
    api: {
      model,
      provider,
      providerVars: apiVars.filter(name => name.startsWith(prefix)),
      setVars: apiVars.filter(name => (env[name] ?? "") !== ""),
      exeDev: existsSync(gatewayConfig.exeDevMarkerPath),
    },
    cache: cacheDir(),
  };
}

function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > minimumNode[0] || (major === minimumNode[0] && minor >= minimumNode[1]);
}

/** Render facts as an aligned, ASCII-only checklist (PowerShell 5.1 consoles included). */
export function formatDoctor(f: DoctorFacts): string {
  const lines: string[] = ["meat doctor: what you can run here. No model call; no diff is read or sent.", ""];
  const row = (ok: boolean | "maybe", text: string, ...more: string[]) => {
    lines.push(`  ${(ok === "maybe" ? "??" : ok ? "ok" : "no").padEnd(4)}${text}`);
    for (const line of more) lines.push(`      ${line}`);
  };
  const entry = join(f.checkout, "dist", "cli", "main.js");

  lines.push("Setup");
  row(nodeSupported(f.node), `Node ${f.node} (needs ${minimumNode.join(".")} or newer)`);
  row(f.git !== null, f.git ?? "git not found on PATH; install Git");
  row(f.repo !== null, f.repo === null ? "Not inside a Git repository; pipe a diff or cd into a repo" : `Git repository: ${f.repo}`);
  if (f.meatOnPath !== null) row(true, `'meat' command: ${f.meatOnPath}`);
  else row(false, "'meat' command is not on PATH",
    `Fix: run 'npm run setup' in ${f.checkout}`,
    `Until then: node ${entry} <flags> <change>`);

  lines.push("", "Ways to review a change");
  row(true, "Offline view and review packet (no account): meat -look HEAD, meat -prompt HEAD");
  if (f.skills.claude === "this_checkout") row(true, "Claude Code skill: type /meat HEAD in Claude Code");
  else row(false, `Claude Code skill ${f.skills.claude === "absent" ? "not installed" : "installed for another checkout"}`, "Fix: npm run skill:install -- claude");
  if (f.skills.codex === "this_checkout") row(true, "Codex skill: type $meat explain HEAD in Codex");
  else row(false, `Codex skill ${f.skills.codex === "absent" ? "not installed" : "installed for another checkout"}`, "Fix: npm run skill:install -- codex");
  for (const agent of ["codex", "claude"] as const) {
    const state = f.agents[agent];
    const name = agent === "codex" ? "Codex" : "Claude";
    if (state === "subscription") row(true, `${name} subscription review: meat -agent ${agent} HEAD`);
    else if (state === "not_installed") row(false, `${name} subscription review: '${agent}' CLI not found on PATH`);
    else if (state === "missing") row(false, `${name} subscription review: '${agent}' CLI found but could not be run`);
    else row(false, `${name} subscription review: not signed in with a subscription`, `Fix: ${loginCommand(agent)}`);
  }

  const { model, provider, providerVars, setVars, exeDev } = f.api;
  const ready = providerVars.some(name => setVars.includes(name));
  const apiNotes: string[] = [];
  if (!ready) {
    apiNotes.push(`Fix: set ${providerVars.join(" or ")}`);
    const others = setVars.filter(name => !providerVars.includes(name));
    if (others.length > 0) apiNotes.push(`${others.join(", ")} ${others.length === 1 ? "is" : "are"} set; pick a matching model with -model or MEAT_MODEL`);
    if (f.dotEnv) apiNotes.push(`A .env file is here, but meat does not load it. Use: node --env-file=.env ${entry} HEAD`);
  }
  apiNotes.push(f.cache === "" ? "Result cache: disabled (MEAT_CACHE is empty)" : `Result cache: ${f.cache} (a cached result needs no key)`);
  row(ready ? true : exeDev ? "maybe" : false,
    `API abridging (meat HEAD): model ${model} via ${provider}${ready ? "" : exeDev ? "; exe.dev gateway not probed" : "; no key set"}`,
    ...apiNotes);
  lines.push("");
  return lines.join("\n");
}

export function doctorReport(): string {
  return formatDoctor(collectDoctorFacts());
}
