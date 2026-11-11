import fs from "node:fs/promises";
import path from "node:path";
import { checkPage, describePageCheck, isLocalPageUrl, problemCount, type BrowserSession, type PageCheck } from "./browser.js";
import { applyExactEdit } from "./edit.js";
import type { Checkpoints } from "./checkpoints.js";
import { buildCommandEnv, secretValues, type CommandEnv } from "./command-env.js";
import { OutputBuffer, createProgressReporter, redact } from "./output.js";
import { CONFIG_EDIT_KEY, permissionKey, type PermissionDecision, type PermissionRequest } from "./permissions.js";
import { resolveInProject } from "./paths.js";
import { killTree, shellSpawn } from "./platform.js";
import type { ProcessManager, StartResult, WaitFor } from "./processes.js";
import { isSafeCommand } from "./safe-commands.js";
import { SECRET_NAME, ensureEnvIgnored, envKeys, setEnvValue, type AskSecret } from "./secrets.js";
import { fetchPublicPage, isDocsHost, pageSlice, type FetchOptions, type FetchedPage } from "./web.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);
const MAX_READ = 100_000;
const MAX_MATCHES = 40;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;

export type ToolEvent = {
  name: string;
  path?: string;
  command?: string;
  pattern?: string;
  added?: number;
  removed?: number;
  diffLines?: { kind: "add" | "del" | "ctx"; text: string }[];
  denied?: boolean;
  /** Folder a command ran in, relative to the project. Empty for the project root. */
  cwd?: string;
  processName?: string;
  url?: string;
  port?: number;
  ready?: boolean;
  exited?: boolean;
  secretName?: string;
  /** Absolute path of a file edit_file changed. */
  file?: string;
  /** Result of an automatic check. */
  passed?: boolean;
  /** The check was a dependency audit, which warns the user instead of failing the turn. */
  advisory?: boolean;
  /** Short extra detail, such as why a check was skipped. */
  note?: string;
};

export type ToolOptions = {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  turnId: string;
  checkpoints: Checkpoints;
  allows: Set<string>;
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  processes?: ProcessManager;
  askSecret?: AskSecret;
  /** The user's own safe-command rules (global, plus trusted project rules). */
  userRules?: string[];
  /** Secret values entered this session; they are replaced in every tool result. */
  redact?: Set<string>;
  onProgress?: (line: string) => void;
  /** Overrides for read_url's fetch and DNS lookup. */
  web?: FetchOptions;
  /** Headless browser for check_page. */
  browser?: BrowserSession;
  /** The session's todo list; write_todos replaces items. */
  todos?: { items: Todo[] };
};

type Outcome = { content: string; event: ToolEvent };

export async function runTool(opts: ToolOptions): Promise<Outcome> {
  const name = opts.name;
  try {
    const outcome = await dispatch(opts);
    return { ...outcome, content: redact(outcome.content, opts.redact) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool failed";
    return { content: redact(message, opts.redact), event: { name } };
  }
}

function dispatch(opts: ToolOptions): Promise<Outcome> {
  switch (opts.name) {
    case "read_file":
      return readFile(opts);
    case "list_dir":
      return listDir(opts);
    case "grep":
      return grep(opts);
    case "edit_file":
      return editFile(opts);
    case "shell":
      return shell(opts);
    case "start_process":
      return startProcess(opts);
    case "read_process_output":
      return readProcessOutput(opts);
    case "stop_process":
      return stopProcess(opts);
    case "restart_process":
      return restartProcess(opts);
    case "ask_secret":
      return askSecret(opts);
    case "env_keys":
      return envKeysTool(opts);
    case "read_url":
      return readUrl(opts);
    case "check_page":
      return checkPageTool(opts);
    case "write_todos":
      return writeTodos(opts);
    default:
      return Promise.resolve({ content: `Unknown tool ${opts.name}`, event: { name: opts.name, denied: true } });
  }
}

async function permit(opts: ToolOptions, request: PermissionRequest, safe?: () => Promise<boolean>): Promise<boolean> {
  const key = permissionKey(request);
  const remember = key !== CONFIG_EDIT_KEY;
  if (remember && opts.allows.has(key)) return true;
  if (safe && (await safe())) return true;
  const decision = await opts.askPermission(request);
  if (decision === "always" && remember) opts.allows.add(key);
  return decision === "allow" || decision === "always";
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readFile(opts: ToolOptions): Promise<Outcome> {
  const input = String(opts.args.path ?? "");
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to read a file outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "read_file", path: input, denied: true } };
  }
  const raw = await fs.readFile(resolved.full, "utf8");
  const content = raw.length > MAX_READ ? `${raw.slice(0, MAX_READ)}\n… truncated` : raw;
  return { content, event: { name: "read_file", path: displayPath(resolved.root, resolved.full) } };
}

async function listDir(opts: ToolOptions): Promise<Outcome> {
  const input = String(opts.args.path ?? ".");
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to list a folder outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "list_dir", path: input, denied: true } };
  }
  const entries = await fs.readdir(resolved.full, { withFileTypes: true });
  const lines = entries.slice(0, 200).map((entry) => `${entry.isDirectory() ? "dir" : "file"}  ${entry.name}`);
  return { content: lines.join("\n") || "(empty)", event: { name: "list_dir", path: displayPath(resolved.root, resolved.full) } };
}

async function grep(opts: ToolOptions): Promise<Outcome> {
  const pattern = String(opts.args.pattern ?? "");
  const input = String(opts.args.path ?? ".");
  if (!pattern) return { content: "pattern is required", event: { name: "grep", pattern } };
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return { content: "Invalid regular expression", event: { name: "grep", pattern } };
  }
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to search outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "grep", pattern, denied: true } };
  }
  const matches: string[] = [];
  await walk(resolved.full, async (file) => {
    if (matches.length >= MAX_MATCHES) return;
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i]!)) matches.push(`${displayPath(resolved.root, file)}:${i + 1}: ${lines[i]}`);
    }
  });
  return {
    content: matches.join("\n") || "No matches.",
    event: { name: "grep", pattern, path: displayPath(resolved.root, resolved.full) },
  };
}

async function editFile(opts: ToolOptions): Promise<Outcome> {
  const input = String(opts.args.path ?? "");
  const oldString = String(opts.args.old_string ?? "");
  const newString = String(opts.args.new_string ?? "");
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to edit a file outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "edit_file", path: input, denied: true } };
  }
  const shown = displayPath(resolved.root, resolved.full);
  const rel = path.relative(resolved.root, resolved.full);
  const config = resolved.inside && rel.split(path.sep)[0] === ".coderbaba";
  const ok = await permit(opts, {
    kind: "edit",
    path: resolved.full,
    config,
    summary: config
      ? `CoderBaba wants to edit ${shown}, which controls what runs without asking. Allow?`
      : `CoderBaba wants to edit ${shown}. Allow?`,
  });
  if (!ok) return { content: "The user denied the edit.", event: { name: "edit_file", path: shown, denied: true } };

  let current = "";
  let exists = true;
  try {
    current = await fs.readFile(resolved.full, "utf8");
  } catch {
    exists = false;
  }
  if (!exists && oldString !== "") {
    return { content: "File does not exist. Use an empty old_string to create it.", event: { name: "edit_file", path: shown } };
  }
  const edited = applyExactEdit(exists ? current : "", oldString, newString);
  if (!edited.ok) return { content: edited.error, event: { name: "edit_file", path: shown } };
  await opts.checkpoints.remember(opts.turnId, resolved.full);
  await fs.mkdir(path.dirname(resolved.full), { recursive: true });
  await fs.writeFile(resolved.full, edited.content, "utf8");
  return {
    content: `Updated ${shown}`,
    event: {
      name: "edit_file",
      path: shown,
      file: resolved.full,
      added: edited.diff.added,
      removed: edited.diff.removed,
      diffLines: edited.diff.lines,
    },
  };
}

type Folder = { root: string; full: string; rel: string; label: string };

/** Resolve the cwd argument for commands. Outside the project asks first. */
async function commandFolder(opts: ToolOptions, input: unknown): Promise<Folder | { error: string; denied?: boolean }> {
  const requested = optString(input) ?? ".";
  const resolved = await resolveInProject(opts.cwd, requested);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to run a command in a folder outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { error: "The user denied access outside the project.", denied: true };
  }
  try {
    if (!(await fs.stat(resolved.full)).isDirectory()) return { error: `${requested} is not a folder.` };
  } catch {
    return { error: `Folder ${requested} does not exist.` };
  }
  const rel = relDisplay(resolved.root, resolved.full);
  return { root: resolved.root, full: resolved.full, rel, label: rel ? ` (in ${rel}/)` : "" };
}

async function detectKind(dir: string): Promise<string | undefined> {
  try {
    await fs.access(path.join(dir, "manage.py"));
    return "Django";
  } catch {
    // not Django
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return "Next.js";
    if (deps.vite && deps.react) return "Vite + React";
    if (deps.express) return "Express";
  } catch {
    // no package.json
  }
  return undefined;
}

async function commandNotes(folder: Folder, env: CommandEnv): Promise<string[]> {
  const notes: string[] = [];
  if (folder.rel) {
    const parts = [`ran in ${folder.rel}/`];
    const kind = await detectKind(folder.full);
    if (kind) parts.push(`${/^[AEIOU]/i.test(kind) ? "an" : "a"} ${kind} app`);
    if (env.venv) parts.push(`venv: ${relDisplay(folder.root, env.venv) || "."}`);
    notes.push(`(${parts.join(", ")})`);
  }
  if (env.loaded) {
    const count = Object.keys(env.loaded.values).length;
    notes.push(`(loaded ${count} variable${count === 1 ? "" : "s"} from ${relDisplay(folder.root, env.loaded.file)})`);
  }
  return notes;
}

function rememberSecrets(opts: ToolOptions, env: CommandEnv): string[] {
  const values = env.loaded ? secretValues(env.loaded.values) : [];
  for (const value of values) opts.redact?.add(value);
  return values;
}

type Prepared = { command: string; folder: Folder; env: CommandEnv };

async function prepareCommand(opts: ToolOptions, tool: "shell" | "start_process"): Promise<Prepared | Outcome> {
  const command = String(opts.args.command ?? "").trim();
  if (!command) return { content: "command is required", event: { name: tool, denied: true } };
  const folder = await commandFolder(opts, opts.args.cwd);
  if ("error" in folder) return { content: folder.error, event: { name: tool, command, denied: folder.denied } };
  let env: CommandEnv;
  try {
    env = await buildCommandEnv({ root: folder.root, cwd: folder.full, envFile: optString(opts.args.env_file) });
  } catch (error) {
    return { content: error instanceof Error ? error.message : "Could not load env_file.", event: { name: tool, command } };
  }
  const background = tool === "start_process";
  const ok = await permit(
    opts,
    {
      kind: "shell",
      command,
      summary: background
        ? `CoderBaba wants to start ${command}${folder.label} in the background. Allow?`
        : `CoderBaba wants to run ${command}${folder.label}. Allow?`,
    },
    () =>
      isSafeCommand(command, {
        root: folder.root,
        cwd: folder.full,
        via: tool,
        userRules: opts.userRules,
        processes: opts.processes,
        env: env.env,
      }),
  );
  if (!ok) return { content: "The user denied the command.", event: { name: tool, command, cwd: folder.rel, denied: true } };
  return { command, folder, env };
}

async function shell(opts: ToolOptions): Promise<Outcome> {
  const prepared = await prepareCommand(opts, "shell");
  if ("content" in prepared) return prepared;
  const { command, folder, env } = prepared;
  rememberSecrets(opts, env);
  const requested = Number(opts.args.timeout_seconds);
  const timeoutSeconds = Number.isFinite(requested) && requested > 0 ? Math.min(Math.round(requested), MAX_TIMEOUT_SECONDS) : DEFAULT_TIMEOUT_SECONDS;
  const progress = createProgressReporter(opts.onProgress);
  const result = await runShell(command, folder.full, { timeoutMs: timeoutSeconds * 1000, env: env.env, onOutput: progress.push });
  progress.stop();

  let body = result.output.trim();
  if (result.timedOut) body = `Command timed out after ${timeoutSeconds}s and was stopped.${body ? `\nOutput so far:\n${body}` : ""}`;
  else if (result.code !== 0) body = `${body}${body ? "\n" : ""}(exit ${result.code})`;
  else if (!body) body = "(exit 0)";
  const notes = await commandNotes(folder, env);
  return { content: [...notes, body].join("\n"), event: { name: "shell", command, cwd: folder.rel } };
}

function parseWaitFor(value: unknown): WaitFor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { port?: unknown; text?: unknown };
  const waitFor: WaitFor = {};
  const port = Number(raw.port);
  if (Number.isInteger(port) && port > 0 && port < 65536) waitFor.port = port;
  if (typeof raw.text === "string" && raw.text) waitFor.text = raw.text;
  return waitFor.port || waitFor.text ? waitFor : undefined;
}

function describeStart(result: StartResult, verb: string): string {
  const { name, id } = result;
  if (result.error) return result.error;
  if (result.portInUse) {
    const port = result.portInUse === true ? "the port" : `port ${result.portInUse}`;
    const tail = result.exited
      ? ` It exited with code ${result.exited.code ?? "unknown"}.`
      : ` It is still running; stop it with stop_process ${name}.`;
    const hint = result.portInUse === true ? "" : ` Run lsof -i :${result.portInUse} (netstat -ano on Windows) to see what is using it, or pick another port.`;
    return `${name} could not start: ${port} is already in use.${hint}${tail}`;
  }
  if (result.exited) return `${name} exited with code ${result.exited.code ?? "unknown"}.`;
  if (result.ready) {
    const where = result.url ? ` at ${result.url}` : result.port ? ` on port ${result.port}` : "";
    return `${verb} ${name} (${id}). Ready${where}.`;
  }
  return `${verb} ${name} (${id}), but it did not report ready in time. It is still running; check read_process_output ${name}.`;
}

function startOutcome(result: StartResult, notes: string[], tool: string, command: string, cwd: string, verb: string): Outcome {
  const output = result.output.trim();
  const lines = [...notes, describeStart(result, verb)];
  if (!result.error) lines.push(output ? `Recent output:\n${output}` : "(no output yet)");
  return {
    content: lines.join("\n"),
    event: {
      name: tool,
      command,
      cwd,
      processName: result.name,
      url: result.url,
      port: result.port,
      ready: result.ready,
      exited: Boolean(result.exited) || Boolean(result.error),
    },
  };
}

async function startProcess(opts: ToolOptions): Promise<Outcome> {
  if (!opts.processes) return { content: "Background processes are not available here.", event: { name: "start_process", denied: true } };
  const prepared = await prepareCommand(opts, "start_process");
  if ("content" in prepared) return prepared;
  const { command, folder, env } = prepared;
  const secrets = rememberSecrets(opts, env);
  const progress = createProgressReporter(opts.onProgress);
  const result = await opts.processes.start({
    command,
    cwd: folder.full,
    folder: folder.rel || ".",
    name: optString(opts.args.name),
    waitFor: parseWaitFor(opts.args.wait_for),
    env: env.env,
    secrets,
    onOutput: progress.push,
  });
  progress.stop();
  const notes = await commandNotes(folder, env);
  return startOutcome(result, notes, "start_process", command, folder.rel, "Started");
}

function processName(opts: ToolOptions): string {
  return String(opts.args.name ?? opts.args.id ?? "").trim();
}

function notFound(opts: ToolOptions, name: string, tool: string): Outcome {
  const running = opts.processes?.running().map((info) => info.name) ?? [];
  return {
    content: `No process named ${name || "(empty)"}. ${running.length ? `Running: ${running.join(", ")}.` : "Nothing is running."}`,
    event: { name: tool, processName: name, denied: true },
  };
}

async function readProcessOutput(opts: ToolOptions): Promise<Outcome> {
  if (!opts.processes) return { content: "Background processes are not available here.", event: { name: "read_process_output", denied: true } };
  const name = processName(opts);
  const logs = opts.processes.logs(name);
  if (!logs) return notFound(opts, name, "read_process_output");
  const { info } = logs;
  const status =
    info.status === "exited" ? `exited with code ${info.exitCode ?? "unknown"}` : info.status === "stopped" ? "stopped" : "running";
  const where = info.url ? ` at ${info.url}` : info.port ? ` on port ${info.port}` : "";
  return {
    content: `${info.name} (${info.id}) is ${status}${where}.\n${logs.output.trim() || "(no output)"}`,
    event: { name: "read_process_output", processName: info.name },
  };
}

async function stopProcess(opts: ToolOptions): Promise<Outcome> {
  if (!opts.processes) return { content: "Background processes are not available here.", event: { name: "stop_process", denied: true } };
  const name = processName(opts);
  const info = await opts.processes.stop(name);
  if (!info) return notFound(opts, name, "stop_process");
  return { content: `Stopped ${info.name}.`, event: { name: "stop_process", processName: info.name } };
}

async function restartProcess(opts: ToolOptions): Promise<Outcome> {
  if (!opts.processes) return { content: "Background processes are not available here.", event: { name: "restart_process", denied: true } };
  const name = processName(opts);
  const existing = opts.processes.logs(name)?.info;
  if (!existing) return notFound(opts, name, "restart_process");
  if (existing.external) {
    return { content: `${existing.name} was not started by CoderBaba, so it can't be restarted here.`, event: { name: "restart_process", processName: name, denied: true } };
  }
  const progress = createProgressReporter(opts.onProgress);
  const result = await opts.processes.restart(name, progress.push);
  progress.stop();
  if (!result) return notFound(opts, name, "restart_process");
  return startOutcome(result, [], "restart_process", existing.command, existing.folder === "." ? "" : existing.folder, "Restarted");
}

async function checkPageTool(opts: ToolOptions): Promise<Outcome> {
  const url = String(opts.args.url ?? "").trim();
  if (!isLocalPageUrl(url)) {
    return {
      content: "check_page only opens local pages, such as http://localhost:5173/. Use read_url for public pages.",
      event: { name: "check_page", url, denied: true },
    };
  }
  if (!opts.browser) return { content: "Page checks are not available here. Use curl instead.", event: { name: "check_page", url, denied: true } };
  let browser = await opts.browser.get();
  if (!browser) {
    const ok = await permit(opts, {
      kind: "download",
      what: "chromium",
      summary: "CoderBaba needs a browser to check the page, and Chrome and Edge were not found. Download Chromium (about 150 MB) with Playwright? Allow?",
    });
    if (!ok) return { content: "No browser is available and the user declined the download. Check the page with curl instead.", event: { name: "check_page", url, denied: true } };
    const progress = createProgressReporter(opts.onProgress);
    const installed = await opts.browser.install(progress.push);
    progress.stop();
    browser = installed.ok ? await opts.browser.get() : undefined;
    if (!browser) {
      const tail = installed.output.trim().split(/\r?\n/).slice(-5).join("\n");
      return { content: `Could not set up a browser. Check the page with curl instead.${tail ? `\n${tail}` : ""}`, event: { name: "check_page", url, denied: true } };
    }
  }
  const resolved = await resolveInProject(opts.cwd, ".");
  let screenshotPath: string | undefined;
  if (opts.args.screenshot === true) {
    const dir = path.join(resolved.root, ".coderbaba", "screenshots");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".gitignore"), "*\n", "utf8");
    screenshotPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  }
  const progress = createProgressReporter(opts.onProgress);
  progress.push(`opening ${url} in ${opts.browser.kind ?? "the browser"}`);
  let check: PageCheck;
  try {
    check = await checkPage(browser, { url, waitForText: optString(opts.args.wait_for_text), screenshotPath });
  } catch (error) {
    progress.stop();
    const message = error instanceof Error ? error.message.split("\n")[0]! : "The page could not be loaded.";
    return { content: `Could not load ${url}: ${message}. Is the dev server running? Check read_process_output.`, event: { name: "check_page", url, passed: false, note: "did not load" } };
  }
  progress.stop();
  if (check.screenshot) check.screenshot = displayPath(resolved.root, check.screenshot);
  const problems = problemCount(check);
  return {
    content: describePageCheck(check),
    event: { name: "check_page", url: check.url, passed: problems === 0, note: problems ? `${problems} problem${problems === 1 ? "" : "s"}` : undefined, path: check.screenshot },
  };
}

export type TodoStatus = "pending" | "in_progress" | "done";
export type Todo = { text: string; status: TodoStatus };
const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "done"]);
const MAX_TODOS = 30;

export function formatTodos(todos: Todo[]): string {
  return todos.map((todo) => `${todo.status === "done" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]"} ${todo.text}`).join("\n");
}

async function writeTodos(opts: ToolOptions): Promise<Outcome> {
  if (!opts.todos) return { content: "Todos are not available here.", event: { name: "write_todos", denied: true } };
  const raw = opts.args.todos;
  if (!Array.isArray(raw)) return { content: "todos must be a list of { text, status }.", event: { name: "write_todos", denied: true } };
  const todos: Todo[] = [];
  for (const item of raw.slice(0, MAX_TODOS)) {
    const { text, status } = (item ?? {}) as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || !text.trim()) continue;
    const state = typeof status === "string" && TODO_STATUSES.has(status as TodoStatus) ? (status as TodoStatus) : "pending";
    todos.push({ text: text.trim().slice(0, 200), status: state });
  }
  opts.todos.items = todos;
  const done = todos.filter((todo) => todo.status === "done").length;
  return {
    content: todos.length ? `Todos updated:\n${formatTodos(todos)}` : "Todos cleared.",
    event: { name: "write_todos", note: todos.length ? `${done} of ${todos.length} done` : "cleared" },
  };
}

const pageCache = new Map<string, FetchedPage>();
const PAGE_CACHE_SIZE = 5;

async function readUrl(opts: ToolOptions): Promise<Outcome> {
  const input = String(opts.args.url ?? "").trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { content: `${input || "(empty)"} is not a valid URL. Pass a full https:// address.`, event: { name: "read_url", url: input, denied: true } };
  }
  const host = url.hostname.toLowerCase();
  if (!isDocsHost(host)) {
    const ok = await permit(opts, { kind: "url", host, summary: `CoderBaba wants to read ${url.toString()}. Allow?` });
    if (!ok) return { content: `The user denied reading ${host}.`, event: { name: "read_url", url: url.toString(), denied: true } };
  }
  const requested = Number(opts.args.offset);
  const offset = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  let page = offset ? pageCache.get(url.toString()) : undefined;
  if (!page) {
    try {
      page = await fetchPublicPage(url.toString(), opts.web);
    } catch (error) {
      return { content: error instanceof Error ? error.message : "Could not read the page.", event: { name: "read_url", url: url.toString(), denied: true } };
    }
    pageCache.delete(url.toString());
    pageCache.set(url.toString(), page);
    if (pageCache.size > PAGE_CACHE_SIZE) pageCache.delete(pageCache.keys().next().value!);
  }
  const status = page.status >= 400 ? ` (HTTP ${page.status})` : "";
  const header = `${page.url}${status}${page.truncated ? " (cut at 2 MB)" : ""}`;
  return {
    content: `${header}\n\n${pageSlice(page.text, offset) || "(empty page)"}`,
    event: { name: "read_url", url: page.url, note: offset ? `from ${offset}` : undefined },
  };
}

async function askSecret(opts: ToolOptions): Promise<Outcome> {
  const name = String(opts.args.name ?? "").trim();
  if (!SECRET_NAME.test(name)) return { content: "name must look like an environment variable, such as MONGODB_URI.", event: { name: "ask_secret" } };
  const resolved = await resolveInProject(opts.cwd, optString(opts.args.env_path) ?? ".env");
  if (!resolved.inside) return { content: "env_path must be inside the project.", event: { name: "ask_secret", secretName: name, denied: true } };
  const shown = displayPath(resolved.root, resolved.full);
  if (!opts.askSecret) {
    return {
      content: `Secret input isn't available here. Ask the user to add ${name} to ${shown} themselves.`,
      event: { name: "ask_secret", secretName: name, path: shown, denied: true },
    };
  }
  const value = await opts.askSecret({ name, hint: String(opts.args.hint ?? ""), envPath: shown });
  if (!value) return { content: `The user skipped entering ${name}.`, event: { name: "ask_secret", secretName: name, path: shown, denied: true } };
  await setEnvValue(resolved.full, name, value);
  opts.redact?.add(value);
  const gitignore = await ensureEnvIgnored(resolved.root, resolved.full);
  const extra = gitignore ? ` Added ${path.basename(resolved.full)} to ${displayPath(resolved.root, gitignore)}.` : "";
  return { content: `Saved ${name} to ${shown}.${extra}`, event: { name: "ask_secret", secretName: name, path: shown } };
}

async function envKeysTool(opts: ToolOptions): Promise<Outcome> {
  const resolved = await resolveInProject(opts.cwd, optString(opts.args.path) ?? ".env");
  if (!resolved.inside) return { content: "path must be inside the project.", event: { name: "env_keys", denied: true } };
  const shown = displayPath(resolved.root, resolved.full);
  let text: string;
  try {
    text = await fs.readFile(resolved.full, "utf8");
  } catch {
    return { content: `There is no ${shown} yet.`, event: { name: "env_keys", path: shown } };
  }
  const keys = envKeys(text);
  return {
    content: keys.length ? `Keys in ${shown}: ${keys.join(", ")}` : `${shown} has no keys.`,
    event: { name: "env_keys", path: shown },
  };
}

export type RunShellOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
};

export function runShell(
  command: string,
  cwd: string,
  options: RunShellOptions = {},
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000;
  return new Promise((resolve) => {
    let child;
    try {
      child = shellSpawn(command, { cwd, env: options.env ?? process.env });
    } catch (error) {
      resolve({ code: 1, output: error instanceof Error ? error.message : "Could not run the command.", timedOut: false });
      return;
    }
    const buffer = new OutputBuffer();
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      buffer.push(text);
      options.onOutput?.(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid, 1_000);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: buffer.text(), timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: error.message, timedOut: false });
    });
  });
}

async function walk(dir: string, visit: (file: string) => Promise<void>, depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit, depth + 1);
    else if (entry.isFile()) await visit(full);
  }
}

function displayPath(root: string, full: string): string {
  const rel = path.relative(root, full);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : full;
}

/** Project-relative folder with forward slashes; "" for the root, the full path when outside. */
function relDisplay(root: string, full: string): string {
  const rel = path.relative(root, full);
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return full;
  return rel.split(path.sep).join("/");
}

const cwdProp = { type: "string", description: "Folder to run in, relative to the project. Defaults to the project root." };
const envFileProp = {
  type: "string",
  description: "Optional .env file (relative to the project) to load into the command's environment. Values are never shown to you.",
};
const nameProp = { type: "string", description: "Process name or id." };

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Path is relative to the project.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files in a directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact old_string with new_string. Use an empty old_string to create a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a command that finishes (installs, scaffolding, checks). Never use it for dev servers, watchers, or databases; use start_process. Stdin is closed, so interactive prompts fail.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: cwdProp,
          timeout_seconds: { type: "number", description: "Default 120, max 600. Use about 300 for scaffolding and installs." },
          env_file: envFileProp,
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_process",
      description:
        "Start a long-running process (dev server, API server, database, watcher) in the background. Returns when it is ready, exits, or the wait ends.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: cwdProp,
          name: { type: "string", description: "Short unique name such as web, client, server, or db." },
          wait_for: {
            type: "object",
            description: "How to tell it is ready. Use port when you know it.",
            properties: { port: { type: "number" }, text: { type: "string" } },
          },
          env_file: envFileProp,
        },
        required: ["command", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_process_output",
      description: "Show the status and recent output of a background process.",
      parameters: { type: "object", properties: { name: nameProp }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_process",
      description: "Stop a background process.",
      parameters: { type: "object", properties: { name: nameProp }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "restart_process",
      description: "Restart a background process with the same command, for example after changing server code.",
      parameters: { type: "object", properties: { name: nameProp }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_secret",
      description:
        "Ask the user for a secret (password, API key, connection string) with hidden input and save it to a .env file. You only learn that it was saved, never the value.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Variable name, such as MONGODB_URI." },
          hint: { type: "string", description: "Where the user can find it, such as 'from MongoDB Atlas'." },
          env_path: { type: "string", description: "The .env file to write, relative to the project. Defaults to .env." },
        },
        required: ["name", "hint"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "env_keys",
      description: "List the variable names (not values) in a .env file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_url",
      description:
        "Read a public web page (documentation, npm or PyPI pages, GitHub READMEs) as text. There is no web search, so pass a URL you know. Long pages come in slices; pass offset to read more.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https:// URL." },
          offset: { type: "number", description: "Character offset from a previous (more: offset N) note." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_page",
      description:
        "Open a local page (http://localhost:PORT/...) in a headless browser and report the HTTP status, uncaught errors, console errors, failed requests, and visible text. Use it after a dev server is ready; curl can't see errors that happen in the browser.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Local URL, such as http://localhost:5173/." },
          wait_for_text: { type: "string", description: "Text that should appear on the page, such as a heading." },
          screenshot: { type: "boolean", description: "Save a screenshot for the user under .coderbaba/screenshots/." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_todos",
      description:
        "Replace the todo list the user sees. Use it for tasks with more than three steps: write the plan first, keep exactly one item in_progress, and mark items done as you finish them.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
];

/** Run a command the user typed after !, with the same environment as the agent's commands. */
export async function runUserCommand(
  command: string,
  opts: { cwd: string; onOutput?: (chunk: string) => void; timeoutMs?: number },
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const resolved = await resolveInProject(opts.cwd, ".");
  const { env } = await buildCommandEnv({ root: resolved.root, cwd: resolved.full });
  return runShell(command, resolved.full, { timeoutMs: opts.timeoutMs ?? MAX_TIMEOUT_SECONDS * 1000, env, onOutput: opts.onOutput });
}
