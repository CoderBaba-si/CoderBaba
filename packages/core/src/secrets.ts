import fs from "node:fs/promises";
import path from "node:path";
import { parseDotenv } from "./command-env.js";

export type SecretRequest = { name: string; hint: string; envPath: string };

/** Returns the value the user typed, or null when they skipped. */
export type AskSecret = (request: SecretRequest) => Promise<string | null>;

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quote(value: string): string {
  if (/^[\w@%+=:,./~-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${quote(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}${line}\n`;
}

export async function setEnvValue(file: string, key: string, value: string): Promise<void> {
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    current = "";
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, upsertEnvLine(current, key, value), { encoding: "utf8", mode: 0o600 });
}

export function envKeys(text: string): string[] {
  return Object.keys(parseDotenv(text));
}

const ENV_IGNORES = new Set([".env", "/.env", ".env*", "*.env", "**/.env", ".env.*"]);

/** Make sure .env is ignored by git: use the nearest .gitignore, or create one at the project root. */
export async function ensureEnvIgnored(root: string, envFile: string): Promise<string | undefined> {
  const base = path.basename(envFile);
  let dir = path.dirname(envFile);
  let target: string | undefined;
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    const candidate = path.join(dir, ".gitignore");
    try {
      await fs.access(candidate);
      target = candidate;
      break;
    } catch {
      // keep looking
    }
    if (rel === "") break;
    dir = path.dirname(dir);
  }
  target ??= path.join(root, ".gitignore");

  let text = "";
  try {
    text = await fs.readFile(target, "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const covered =
    lines.some((line) => line === base || line === `/${base}`) ||
    (base === ".env" ? lines.some((line) => ENV_IGNORES.has(line)) : lines.some((line) => line === ".env*" || line === ".env.*"));
  if (covered) return undefined;
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  await fs.writeFile(target, `${prefix}${base}\n`, "utf8");
  return target;
}
