import fs from "node:fs/promises";
import path from "node:path";
import { resolveInProject } from "./paths.js";

export type CommandEnv = {
  env: NodeJS.ProcessEnv;
  /** Path of the activated virtual environment, if any. */
  venv?: string;
  /** Variables loaded from env_file. Values never go into tool results. */
  loaded?: { file: string; values: Record<string, string> };
};

const SECRET_KEY = /SECRET|PASSWORD|PASSWD|TOKEN|KEY|URI|URL|DSN|AUTH|PRIVATE|CREDENTIAL/i;

export function baseCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: "1",
    npm_config_yes: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    PYTHONUNBUFFERED: "1",
  };
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Find .venv/ or venv/ (with pyvenv.cfg) in cwd or a parent, stopping at the project root. */
export async function findVenv(root: string, cwd: string): Promise<string | undefined> {
  let dir = cwd;
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    for (const name of [".venv", "venv"]) {
      const candidate = path.join(dir, name);
      if (await exists(path.join(candidate, "pyvenv.cfg"))) return candidate;
    }
    if (rel === "") return undefined;
    dir = path.dirname(dir);
  }
}

export function venvBin(venv: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(venv, platform === "win32" ? "Scripts" : "bin");
}

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      value = value.slice(1, end > 0 ? end : undefined).replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
    } else if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      value = value.slice(1, end > 0 ? end : undefined);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]!] = value;
  }
  return values;
}

/** Values worth hiding from output: secret-looking keys with non-trivial values. */
export function secretValues(values: Record<string, string>): string[] {
  return Object.entries(values)
    .filter(([key, value]) => SECRET_KEY.test(key) && value.length >= 8)
    .map(([, value]) => value);
}

export async function buildCommandEnv(opts: {
  root: string;
  cwd: string;
  envFile?: string;
  base?: NodeJS.ProcessEnv;
}): Promise<CommandEnv> {
  const env = baseCommandEnv(opts.base);
  const result: CommandEnv = { env };

  const venv = await findVenv(opts.root, opts.cwd);
  if (venv) {
    const key = pathKey(env);
    env[key] = [venvBin(venv), env[key]].filter(Boolean).join(path.delimiter);
    env.VIRTUAL_ENV = venv;
    delete env.PYTHONHOME;
    result.venv = venv;
  }

  if (opts.envFile) {
    const resolved = await resolveInProject(opts.root, opts.envFile);
    if (!resolved.inside) throw new Error("env_file must be inside the project.");
    let text: string;
    try {
      text = await fs.readFile(resolved.full, "utf8");
    } catch {
      throw new Error(`env_file ${opts.envFile} does not exist.`);
    }
    const values = parseDotenv(text);
    Object.assign(env, values);
    result.loaded = { file: resolved.full, values };
  }

  return result;
}
