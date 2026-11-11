import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./auth.js";
import { hasShellMeta } from "./safe-commands.js";

/** A check from config: run command (in cwd, relative to the project) when an edited file matches files. */
export type CheckSpec = { command: string; files?: string; cwd?: string };

export type AllowConfig = {
  globalRules: string[];
  projectRules: string[];
  globalChecks: CheckSpec[];
  projectChecks: CheckSpec[];
  /** "checks": false in either file turns automatic checks off. */
  checksDisabled: boolean;
  projectFile: string;
  projectHash?: string;
  trusted: boolean;
  warnings: string[];
};

export function globalConfigPath(): string {
  return path.join(dataDir(), "config.json");
}

export function projectAllowPath(root: string): string {
  return path.join(root, ".coderbaba", "allow.json");
}

function trustFile(): string {
  return path.join(dataDir(), "trusted-projects.json");
}

async function readMaybe(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

type Parsed = { rules: string[]; checks: CheckSpec[]; checksDisabled: boolean };

function parseChecks(value: unknown): { checks: CheckSpec[]; disabled: boolean } {
  if (value === undefined) return { checks: [], disabled: false };
  if (value === false) return { checks: [], disabled: true };
  if (!Array.isArray(value)) throw new Error("checks is not a list");
  const checks = value.flatMap((item): CheckSpec[] => {
    if (!item || typeof item !== "object") return [];
    const { command, files, cwd } = item as Record<string, unknown>;
    if (typeof command !== "string" || !command.trim() || hasShellMeta(command)) return [];
    return [
      {
        command: command.trim(),
        files: typeof files === "string" && files.trim() ? files.trim() : undefined,
        cwd: typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined,
      },
    ];
  });
  return { checks, disabled: false };
}

function parseConfig(raw: string | undefined, file: string, warnings: string[]): Parsed {
  const empty: Parsed = { rules: [], checks: [], checksDisabled: false };
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw) as { allow?: unknown; checks?: unknown };
    let rules: string[] = [];
    if (parsed.allow !== undefined) {
      if (!Array.isArray(parsed.allow)) throw new Error("allow is not a list");
      rules = parsed.allow.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "" && !hasShellMeta(rule));
    }
    const { checks, disabled } = parseChecks(parsed.checks);
    return { rules, checks, checksDisabled: disabled };
  } catch {
    warnings.push(`Ignored ${file}: it is not valid JSON with an "allow" list and an optional "checks" list.`);
    return empty;
  }
}

async function readTrust(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(trustFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function realRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return path.resolve(root);
  }
}

export async function loadAllowConfig(root: string): Promise<AllowConfig> {
  const warnings: string[] = [];
  const global = parseConfig(await readMaybe(globalConfigPath()), globalConfigPath(), warnings);
  const projectFile = projectAllowPath(root);
  const projectRaw = await readMaybe(projectFile);
  const project = parseConfig(projectRaw, projectFile, warnings);
  const base = {
    globalRules: global.rules,
    projectRules: project.rules,
    globalChecks: global.checks,
    projectChecks: project.checks,
    checksDisabled: global.checksDisabled || project.checksDisabled,
    projectFile,
    warnings,
  };
  if (projectRaw === undefined || (project.rules.length === 0 && project.checks.length === 0)) {
    return { ...base, trusted: true };
  }
  const projectHash = createHash("sha256").update(projectRaw).digest("hex");
  const trust = await readTrust();
  return { ...base, projectHash, trusted: trust[await realRoot(root)] === projectHash };
}

export async function trustProject(root: string, hash: string): Promise<void> {
  const trust = await readTrust();
  trust[await realRoot(root)] = hash;
  await fs.mkdir(path.dirname(trustFile()), { recursive: true });
  await fs.writeFile(trustFile(), JSON.stringify(trust, null, 2), "utf8");
}

export function activeRules(config: AllowConfig | null | undefined): string[] {
  if (!config) return [];
  return config.trusted ? [...config.globalRules, ...config.projectRules] : [...config.globalRules];
}

export function activeChecks(config: AllowConfig | null | undefined): { configured: CheckSpec[]; disabled: boolean } {
  if (!config) return { configured: [], disabled: false };
  const configured = config.trusted ? [...config.globalChecks, ...config.projectChecks] : [...config.globalChecks];
  return { configured, disabled: config.checksDisabled };
}
