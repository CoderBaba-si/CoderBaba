import fs from "node:fs/promises";
import path from "node:path";
import { resolveInProject } from "./paths.js";

export type SafeContext = {
  root: string;
  cwd: string;
  via: "shell" | "start_process";
  userRules?: string[];
  processes?: { ownsPort(port: number): boolean };
  /** Environment the command will run with (after venv activation). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

type Ctx = Required<Pick<SafeContext, "root" | "cwd" | "via" | "platform">> & SafeContext;
type Rule = (args: string[], ctx: Ctx) => boolean | Promise<boolean>;
type Word = { value: string; glob: boolean };

const UNIX_META = /[;&|`$()<>\n\r\\]/;
const WINDOWS_META = /[;&|`$()<>\n\r^%]/;
const GLOB = /[*?[\]{}~]/;

export function hasShellMeta(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return (platform === "win32" ? WINDOWS_META : UNIX_META).test(command);
}

/** Split into words, honoring quotes. Returns null on unbalanced quotes. */
export function splitWords(command: string, platform: NodeJS.Platform = process.platform): Word[] | null {
  const words: Word[] = [];
  let current = "";
  let inWord = false;
  let glob = false;
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || (ch === "'" && platform !== "win32")) {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push({ value: current, glob });
      current = "";
      inWord = false;
      glob = false;
      continue;
    }
    if (GLOB.test(ch)) glob = true;
    current += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push({ value: current, glob });
  return words;
}

function normalizeCommand(word: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return word;
  return word.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

const SECRET_FILE = /^\.env(\..*)?$|\.(pem|key)$/i;

/** Path arguments must stay inside the project and must not point at secrets. */
async function pathOk(arg: string, ctx: Ctx): Promise<boolean> {
  const resolved = await resolveInProject(ctx.root, path.resolve(ctx.cwd, arg));
  if (!resolved.inside) return false;
  const rel = path.relative(resolved.root, resolved.full);
  const parts = rel.split(path.sep);
  if (parts.some((part) => part === ".git" || part === ".data")) return false;
  return !SECRET_FILE.test(path.basename(resolved.full));
}

async function allPathsOk(args: string[], ctx: Ctx): Promise<boolean> {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (!(await pathOk(arg, ctx))) return false;
  }
  return true;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH without resolving symlinks (a venv's python links to the system one). */
async function whichOnPath(name: string, ctx: Ctx): Promise<string | undefined> {
  const env = ctx.env ?? process.env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = (env[key] ?? "").split(path.delimiter).filter(Boolean);
  const exts = ctx.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => ext.toLowerCase()) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function projectBinary(name: string, ctx: Ctx): Promise<boolean> {
  const found = await whichOnPath(name, ctx);
  if (!found) return false;
  const rel = path.relative(ctx.root, path.resolve(found));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const VERSION_FLAGS = new Set(["-v", "-V", "--version"]);
const VERSION_COMMANDS = [
  "node", "npm", "npx", "pnpm", "yarn", "git", "tsc", "docker", "mongod", "mongosh",
  "python", "python3", "pip", "pip3", "uv", "django-admin", "postgres",
];

function isVersionCheck(args: string[]): boolean {
  return args.length === 1 && VERSION_FLAGS.has(args[0]!);
}

async function readScripts(ctx: Ctx): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ctx.cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function scriptAllowed(scriptName: string, ctx: Ctx): Promise<boolean> {
  const script = (await readScripts(ctx))[scriptName]?.trim().replace(/\s+/g, " ");
  if (!script) return false;
  switch (scriptName) {
    case "dev": {
      if (ctx.via !== "start_process") return false;
      if (/^next dev(?: (?:--turbopack|--turbo|(?:-p|--port) \d+))*$/.test(script)) return true;
      if (/^vite(?: dev)?(?: (?:--port \d+|--host|--open))*$/.test(script)) return true;
      const watch = /^(?:node --watch|nodemon|tsx watch) (\S+)$/.exec(script);
      return Boolean(watch && (await pathOk(watch[1]!, ctx)));
    }
    case "start": {
      if (ctx.via !== "start_process") return false;
      if (/^next start(?: (?:-p|--port) \d+)*$/.test(script)) return true;
      const node = /^node (\S+)$/.exec(script);
      return Boolean(node && (await pathOk(node[1]!, ctx)));
    }
    case "lint":
      return /^(?:next lint|(?:eslint|oxlint)(?: [\w./*@-]+)*)(?: --fix)?$/.test(script);
    case "build":
      return /^(?:next build(?: --turbopack| --turbo)?|vite build|tsc -b && vite build)$/.test(script);
    case "test":
      return /^(?:vitest(?: run)?|jest)(?: --[\w-]+(?:=\S+)?)*$/.test(script);
    default:
      return false;
  }
}

const SCRIPT_NAMES = new Set(["dev", "start", "lint", "build", "test"]);
const PKG_NAME = /^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~<>=-]+)?$/;

const npmRule: Rule = async (args, ctx) => {
  const [sub, ...rest] = args;
  if (!sub) return false;
  if (sub === "run" || sub === "run-script") return rest.length === 1 && SCRIPT_NAMES.has(rest[0]!) && scriptAllowed(rest[0]!, ctx);
  if (sub === "test" || sub === "t" || sub === "start") return rest.length === 0 && scriptAllowed(sub === "t" ? "test" : sub, ctx);
  if (sub === "ls" || sub === "list" || sub === "outdated") return rest.every((arg) => /^--?[\w-]+(?:=[\w.-]+)?$/.test(arg));
  if (sub === "view" || sub === "info" || sub === "show") {
    const [pkg, ...fields] = rest;
    return Boolean(pkg && PKG_NAME.test(pkg)) && fields.length <= 2 && fields.every((field) => /^[\w.]+$/.test(field));
  }
  return false;
};

const pnpmYarnRule: Rule = async (args, ctx) => {
  const [sub, ...rest] = args;
  if (!sub) return false;
  if (sub === "run") return rest.length === 1 && SCRIPT_NAMES.has(rest[0]!) && scriptAllowed(rest[0]!, ctx);
  if (SCRIPT_NAMES.has(sub)) return rest.length === 0 && scriptAllowed(sub, ctx);
  if (sub === "ls" || sub === "list" || sub === "outdated") return rest.every((arg) => /^--?[\w-]+(?:=[\w.-]+)?$/.test(arg));
  if (sub === "view" || sub === "info") {
    const [pkg, ...fields] = rest;
    return Boolean(pkg && PKG_NAME.test(pkg)) && fields.length <= 2 && fields.every((field) => /^[\w.]+$/.test(field));
  }
  return false;
};

const npxRule: Rule = async (args, ctx) => {
  if (args[0] !== "tsc") return false;
  const rest = args.slice(1);
  if (!rest.includes("--noEmit")) return false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--noEmit") continue;
    if (arg === "-p" || arg === "--project") {
      const target = rest[++i];
      if (!target || !(await pathOk(target, ctx))) return false;
      continue;
    }
    return false;
  }
  const bin = path.join(ctx.cwd, "node_modules", ".bin", ctx.platform === "win32" ? "tsc.cmd" : "tsc");
  return fileExists(bin);
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
const CURL_SWITCHES = new Set(["--silent", "--show-error", "--head", "--include", "--location", "--fail"]);
const CURL_DATA = new Set(["-d", "--data", "--data-raw", "--data-binary", "--json"]);

const curlRule: Rule = (args, ctx) => {
  let method = "GET";
  let api = false;
  const urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      urls.push(arg);
      continue;
    }
    if (/^-[sSIiLf]+$/.test(arg) || CURL_SWITCHES.has(arg)) continue;
    const value = args[i + 1];
    if (arg === "--max-time" || arg === "-m") {
      if (!value || !/^\d+(\.\d+)?$/.test(value)) return false;
      i++;
      continue;
    }
    if (arg === "-o") {
      if (value !== "/dev/null" && !(ctx.platform === "win32" && value?.toUpperCase() === "NUL")) return false;
      i++;
      continue;
    }
    if (arg === "-w" || arg === "--write-out" || arg === "-H" || arg === "--header") {
      if (value === undefined) return false;
      i++;
      continue;
    }
    if (arg === "-X" || arg === "--request") {
      if (!value) return false;
      method = value.toUpperCase();
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
      i++;
      continue;
    }
    if (CURL_DATA.has(arg)) {
      if (value === undefined) return false;
      if (arg !== "--data-raw" && value.startsWith("@")) return false;
      api = true;
      i++;
      continue;
    }
    return false;
  }
  if (urls.length !== 1) return false;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(urls[0]!) ? urls[0]! : `http://${urls[0]}`);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!LOCAL_HOSTS.has(url.hostname)) return false;
  if (method !== "GET" && method !== "HEAD") api = true;
  if (!api) return true;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return Boolean(ctx.processes?.ownsPort(port));
};

const gitRule: Rule = (args) => {
  const [sub, ...rest] = args;
  if (!sub) return false;
  if (["status", "diff", "log", "show", "rev-parse"].includes(sub)) {
    return !rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff");
  }
  if (sub === "branch") {
    const allowed = new Set(["-a", "--all", "-r", "-v", "-vv", "--show-current", "--list"]);
    return rest.every((arg) => allowed.has(arg));
  }
  return false;
};

const FIND_DANGEROUS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

const findRule: Rule = async (args, ctx) => {
  if (args.some((arg) => FIND_DANGEROUS.has(arg))) return false;
  let i = 0;
  while (i < args.length && ["-H", "-L", "-P"].includes(args[i]!)) i++;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-") || arg === "!") break;
    if (!(await pathOk(arg, ctx))) return false;
  }
  return true;
};

const readRule =
  (rejected: string[] = []): Rule =>
  (args, ctx) =>
    !args.some((arg) => rejected.includes(arg)) && allPathsOk(args, ctx);

const DJANGO_LABEL = /^[\w.]+$/;

async function manageRule(args: string[], ctx: Ctx): Promise<boolean> {
  const [script, sub, ...rest] = args;
  if (!script || path.basename(script) !== "manage.py" || !(await pathOk(script, ctx))) return false;
  switch (sub) {
    case "check":
    case "showmigrations":
      return rest.every((arg) => /^--[\w-]+(?:=\S+)?$/.test(arg) || DJANGO_LABEL.test(arg));
    case "makemigrations": {
      const flags = rest.filter((arg) => arg.startsWith("-"));
      const labels = rest.filter((arg) => !arg.startsWith("-"));
      return (
        flags.length === 2 && flags.includes("--check") && flags.includes("--dry-run") && labels.every((arg) => DJANGO_LABEL.test(arg))
      );
    }
    case "test":
      return rest.every((arg) => /^--[\w-]+(?:=\S+)?$/.test(arg) || DJANGO_LABEL.test(arg));
    case "runserver":
      if (ctx.via !== "start_process") return false;
      return (
        rest.filter((arg) => !arg.startsWith("-")).length <= 1 &&
        rest.every(
          (arg) =>
            arg === "--noreload" || arg === "--nothreading" || /^\d{2,5}$/.test(arg) || /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}$/.test(arg),
        )
      );
    default:
      return false;
  }
}

const pythonRule: Rule = async (args, ctx) => {
  if (args[0] !== "manage.py" && !args[0]?.endsWith("/manage.py") && !args[0]?.endsWith("\\manage.py")) return false;
  return manageRule(args, ctx);
};

const pipRule: Rule = (args) => {
  const [sub, ...rest] = args;
  if (sub === "list" || sub === "freeze") return rest.every((arg) => /^--?[\w-]+(?:=[\w.-]+)?$/.test(arg));
  if (sub === "show") return rest.length > 0 && rest.every((arg) => arg === "-f" || arg === "--files" || /^[\w.-]+$/.test(arg));
  return false;
};

const lsofRule: Rule = (args) => {
  let hasInternet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-n", "-P", "-nP", "-Pn"].includes(arg)) continue;
    if (/^-i(?:tcp)?:\d{1,5}$/.test(arg)) {
      hasInternet = true;
      continue;
    }
    if (arg === "-i" && /^(?:tcp)?:\d{1,5}$/.test(args[i + 1] ?? "")) {
      hasInternet = true;
      i++;
      continue;
    }
    return false;
  }
  return hasInternet;
};

const dockerRule: Rule = (args) => {
  const [sub, ...rest] = args;
  if (sub === "version") return rest.length === 0;
  if (sub === "ps") {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "-a" || arg === "--all") continue;
      if (arg === "--filter" && /^name=[\w.-]+$/.test(rest[i + 1] ?? "")) {
        i++;
        continue;
      }
      if (/^--filter=name=[\w.-]+$/.test(arg)) continue;
      if (arg === "--format" && rest[i + 1] !== undefined) {
        i++;
        continue;
      }
      return false;
    }
    return true;
  }
  if (sub === "logs") {
    const names: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if ((arg === "--tail" || arg === "-n") && /^\d+$/.test(rest[i + 1] ?? "")) {
        i++;
        continue;
      }
      if (arg.startsWith("-")) return false;
      names.push(arg);
    }
    return names.length === 1 && /^[\w.-]+$/.test(names[0]!);
  }
  return false;
};

function rules(platform: NodeJS.Platform): Record<string, Rule> {
  const table: Record<string, Rule> = {
    npm: npmRule,
    pnpm: pnpmYarnRule,
    yarn: pnpmYarnRule,
    npx: npxRule,
    curl: curlRule,
    git: gitRule,
    docker: dockerRule,
    pwd: (args) => args.every((arg) => arg === "-P" || arg === "-L"),
    ls: readRule(),
    tree: readRule(["-o"]),
    cat: readRule(),
    head: readRule(),
    tail: readRule(["-f", "-F", "--follow"]),
    wc: readRule(),
    find: findRule,
  };
  if (platform === "win32") {
    table.where = (args) => args.length > 0 && args.every((arg) => /^[\w.-]+$/.test(arg));
    table.netstat = (args) => args.length === 1 && args[0] === "-ano";
    table.tasklist = (args) => args.length === 0;
  } else {
    table.which = (args) => args.length > 0 && args.every((arg) => arg === "-a" || /^[\w.-]+$/.test(arg));
    table.lsof = lsofRule;
    table.ps = (args) => args.length === 0 || (args.length === 1 && ["aux", "ax", "-ef", "-e"].includes(args[0]!));
  }
  return table;
}

async function builtinSafe(words: string[], ctx: Ctx): Promise<boolean> {
  const command = normalizeCommand(words[0]!, ctx.platform);
  const args = words.slice(1);

  if (VERSION_COMMANDS.includes(command) && isVersionCheck(args)) return true;
  if (command === "py" && (isVersionCheck(args) || (args[0] === "-3" && isVersionCheck(args.slice(1))))) return true;

  if (command === "python" || command === "python3") {
    return (await projectBinary(command, ctx)) && pythonRule(args, ctx);
  }
  if (command === "pip" || command === "pip3") {
    return (await projectBinary(command, ctx)) && pipRule(args, ctx);
  }

  const rule = rules(ctx.platform)[command];
  return rule ? rule(args, ctx) : false;
}

export function normalizeSpaces(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** User rules: an exact command, or a prefix ending in " *" that matches any further arguments. */
export function matchesUserRule(command: string, rules: string[] | undefined): boolean {
  if (!rules?.length) return false;
  const normalized = normalizeSpaces(command);
  return rules.some((rule) => {
    const clean = normalizeSpaces(rule);
    if (clean.endsWith(" *")) {
      const prefix = clean.slice(0, -2);
      return normalized === prefix || normalized.startsWith(`${prefix} `);
    }
    return normalized === clean;
  });
}

export function askAlways(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODERBABA_ASK_ALWAYS === "1";
}

/** True when the command can run without asking the user. */
export async function isSafeCommand(command: string, context: SafeContext): Promise<boolean> {
  if (askAlways()) return false;
  const ctx: Ctx = { ...context, platform: context.platform ?? process.platform };
  if (hasShellMeta(command, ctx.platform)) return false;
  const words = splitWords(command, ctx.platform);
  if (!words?.length) return false;
  if (words.some((word) => word.glob)) return false;
  try {
    if (await builtinSafe(words.map((word) => word.value), ctx)) return true;
  } catch {
    return false;
  }
  return matchesUserRule(command, ctx.userRules);
}
