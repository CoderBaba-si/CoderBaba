import fs from "node:fs/promises";
import path from "node:path";
import type { CheckSpec } from "./allow-config.js";
import { buildCommandEnv } from "./command-env.js";
import type { ProcessManager } from "./processes.js";
import { isSafeCommand } from "./safe-commands.js";
import { runShell } from "./tools.js";

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|py)$/i;
const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".venv", "venv", "__pycache__"]);
const APP_MARKERS = ["package.json", "manage.py", "pyproject.toml"];
const CHECK_TIMEOUT_MS = 120_000;
const FAILURE_HEAD = 1_500;
const FAILURE_TAIL = 2_500;

export type CheckSettings = { configured: CheckSpec[]; disabled: boolean };

export type PlannedCheck = {
  command: string;
  /** Absolute folder to run in. */
  folder: string;
  /** Folder relative to the project with forward slashes; "" for the root. */
  rel: string;
  source: "config" | "detected";
};

export type CheckResult = PlannedCheck & { passed: boolean; skipped?: string; output: string };

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function relative(root: string, full: string): string | undefined {
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** Minimal glob: ** spans folders, * and ? stay inside one, {a,b} picks one. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) source += "\\{";
      else {
        source += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function appFolder(root: string, file: string): Promise<string | undefined> {
  let dir = path.dirname(file);
  for (;;) {
    if (relative(root, dir) === undefined) return undefined;
    for (const marker of APP_MARKERS) if (await exists(path.join(dir, marker))) return dir;
    if (path.resolve(dir) === path.resolve(root)) return undefined;
    dir = path.dirname(dir);
  }
}

async function packageScripts(dir: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function packageManager(dir: string, root: string): Promise<"npm" | "pnpm" | "yarn"> {
  for (const base of [dir, root]) {
    if (await exists(path.join(base, "pnpm-lock.yaml"))) return "pnpm";
    if (await exists(path.join(base, "yarn.lock"))) return "yarn";
  }
  return "npm";
}

async function detectedFor(dir: string, root: string, kinds: { js: boolean; py: boolean }): Promise<string[]> {
  const commands: string[] = [];
  if (kinds.js && (await exists(path.join(dir, "package.json")))) {
    const scripts = await packageScripts(dir);
    const pm = await packageManager(dir, root);
    if (scripts.typecheck) commands.push(`${pm} run typecheck`);
    else if (
      (await exists(path.join(dir, "tsconfig.json"))) &&
      (await exists(path.join(dir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc")))
    ) {
      commands.push("npx tsc --noEmit");
    }
    if (scripts.lint && !/--fix\b/.test(scripts.lint)) commands.push(`${pm} run lint`);
  }
  if (kinds.py && (await exists(path.join(dir, "manage.py")))) commands.push("python manage.py check");
  return commands;
}

function inSkippedDir(rel: string): boolean {
  return rel.split("/").some((part) => SKIPPED_DIRS.has(part));
}

/** Pick the checks for the files edited this turn: configured checks first, otherwise detected ones per app folder. */
export async function planChecks(root: string, editedFiles: string[], settings: CheckSettings): Promise<PlannedCheck[]> {
  if (settings.disabled) return [];
  const files = editedFiles.flatMap((file) => {
    const rel = relative(root, file);
    return rel && !inSkippedDir(rel) ? [{ full: file, rel }] : [];
  });
  if (!files.length) return [];

  const planned: PlannedCheck[] = [];
  const seen = new Set<string>();
  const add = (check: PlannedCheck) => {
    const key = `${check.folder}\0${check.command}`;
    if (seen.has(key)) return;
    seen.add(key);
    planned.push(check);
  };

  if (settings.configured.length) {
    for (const spec of settings.configured) {
      const pattern = spec.files ? globToRegExp(spec.files) : undefined;
      if (pattern ? !files.some((file) => pattern.test(file.rel)) : !files.some((file) => CODE_FILE.test(file.rel))) continue;
      const folder = path.resolve(root, spec.cwd ?? ".");
      const rel = relative(root, folder);
      if (rel === undefined) continue;
      add({ command: spec.command, folder, rel, source: "config" });
    }
    return planned;
  }

  const byFolder = new Map<string, { js: boolean; py: boolean }>();
  for (const file of files) {
    if (!CODE_FILE.test(file.rel)) continue;
    const dir = await appFolder(root, file.full);
    if (!dir) continue;
    const kinds = byFolder.get(dir) ?? { js: false, py: false };
    if (JS_FILE.test(file.rel)) kinds.js = true;
    else kinds.py = true;
    byFolder.set(dir, kinds);
  }
  for (const [dir, kinds] of byFolder) {
    for (const command of await detectedFor(dir, root, kinds)) {
      add({ command, folder: dir, rel: relative(root, dir) ?? "", source: "detected" });
    }
  }
  return planned;
}

export type RunChecksOptions = {
  root: string;
  userRules?: string[];
  processes?: ProcessManager;
  onOutput?: (chunk: string) => void;
  onResult?: (result: CheckResult) => void;
};

/** Run planned checks. Detected checks must pass the safe-command rules; configured ones were trusted by the user. */
export async function runChecks(planned: PlannedCheck[], opts: RunChecksOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of planned) {
    let result: CheckResult;
    try {
      const { env } = await buildCommandEnv({ root: opts.root, cwd: check.folder });
      const safe =
        check.source === "config" ||
        (await isSafeCommand(check.command, {
          root: opts.root,
          cwd: check.folder,
          via: "shell",
          userRules: opts.userRules,
          processes: opts.processes,
          env,
        }));
      if (!safe) {
        result = { ...check, passed: true, skipped: "it is not on the safe-command list", output: "" };
      } else {
        const run = await runShell(check.command, check.folder, { timeoutMs: CHECK_TIMEOUT_MS, env, onOutput: opts.onOutput });
        const output = run.timedOut ? `Timed out after ${CHECK_TIMEOUT_MS / 1000}s.\n${run.output}` : run.output;
        result = { ...check, passed: run.code === 0 && !run.timedOut, output };
      }
    } catch (error) {
      result = { ...check, passed: true, skipped: error instanceof Error ? error.message : "it could not run", output: "" };
    }
    results.push(result);
    opts.onResult?.(result);
  }
  return results;
}

function cut(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= FAILURE_HEAD + FAILURE_TAIL) return trimmed;
  return `${trimmed.slice(0, FAILURE_HEAD)}\n… output cut …\n${trimmed.slice(-FAILURE_TAIL)}`;
}

/** The message fed back to the model when checks fail. */
export function failureMessage(results: CheckResult[]): string {
  const failed = results.filter((result) => !result.passed);
  const blocks = failed.map((result) => `$ ${result.command}${result.rel ? ` (in ${result.rel}/)` : ""}\n${cut(result.output) || "(no output)"}`);
  return `Checks failed after your edits:\n\n${blocks.join("\n\n")}\n\nFix the cause, then finish. The checks run again automatically.`;
}
