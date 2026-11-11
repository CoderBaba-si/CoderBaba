import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./auth.js";
import { hasShellMeta } from "./safe-commands.js";

export type AllowConfig = {
  globalRules: string[];
  projectRules: string[];
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

function parseRules(raw: string | undefined, file: string, warnings: string[]): string[] {
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as { allow?: unknown };
    if (parsed.allow === undefined) return [];
    if (!Array.isArray(parsed.allow)) throw new Error("allow is not a list");
    return parsed.allow.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "" && !hasShellMeta(rule));
  } catch {
    warnings.push(`Ignored ${file}: it is not valid JSON with an "allow" list.`);
    return [];
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
  const globalRules = parseRules(await readMaybe(globalConfigPath()), globalConfigPath(), warnings);
  const projectFile = projectAllowPath(root);
  const projectRaw = await readMaybe(projectFile);
  const projectRules = parseRules(projectRaw, projectFile, warnings);
  if (projectRaw === undefined || projectRules.length === 0) {
    return { globalRules, projectRules, projectFile, trusted: true, warnings };
  }
  const projectHash = createHash("sha256").update(projectRaw).digest("hex");
  const trust = await readTrust();
  return { globalRules, projectRules, projectFile, projectHash, trusted: trust[await realRoot(root)] === projectHash, warnings };
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
