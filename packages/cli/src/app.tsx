import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import path from "node:path";
import { ErrorCodes, MODELS, findModel, type UsageResponse } from "@coderbabasi/shared";
import {
  Checkpoints,
  CoderBabaError,
  ProcessManager,
  activeRules,
  BrowserSession,
  activeChecks,
  askAlways,
  compact,
  createLlm,
  createSession,
  dataDir,
  ensureAuth,
  INIT_TASK,
  NOTES_FILE,
  SecurityStore,
  isLoginCode,
  runSecurityDiff,
  runSecurityFix,
  runSecurityScan,
  runSecurityValidate,
  statusTable,
  type SecurityRunResult,
  type SecurityTurnBase,
  chatMarkdown,
  exportChat,
  formatTodos,
  redact,
  runUserCommand,
  type Todo,
  fetchUsage,
  formatStatus,
  friendlyMessage,
  lastLine,
  listSessions,
  loadAllowConfig,
  loadProjectNotes,
  logoutRemote,
  projectSlug,
  readAuth,
  runShell,
  runTurn,
  saveSession,
  shortenPath,
  startEmailLogin,
  trustProject,
  usesDirectOpenRouter,
  verifyEmailLogin,
  type AgentEvent,
  type AllowConfig,
  type AuthFile,
  type PermissionDecision,
  type PermissionRequest,
  type ProcessInfo,
  type SecretRequest,
  type Session,
  type StartResult,
  type ToolEvent,
} from "@coderbabasi/core";

type Line =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "tool"; label: string; detail: string; added?: number; removed?: number; diff?: { kind: string; text: string }[] }
  | { kind: "done"; text: string };

type Mode =
  | { kind: "loading" }
  | { kind: "chat" }
  | { kind: "busy" }
  | { kind: "permission"; request: PermissionRequest; resolve: (decision: PermissionDecision) => void }
  | { kind: "secret"; request: SecretRequest; resolve: (value: string | null) => void }
  | { kind: "trust"; rules: string[]; file: string; resolve: (trusted: boolean) => void }
  | { kind: "email"; reason: string; retry?: string }
  | { kind: "code"; email: string; masked: string; tries: number; retry?: string; sentAt: number }
  | { kind: "model" };

const MAX_STEPS = 80;
const RESEND_COOLDOWN_MS = 30_000;

const HELP = [
  "/help      show commands",
  "/new       start a new chat",
  "/history   list recent chats",
  "/usage     show your free usage",
  "/model     pick Fast or Smart",
  "/undo      revert the last turn's file changes",
  "/compact   summarize the chat so far to free up room",
  "/init      write AGENTS.md, notes that help CoderBaba understand this project",
  "/security  scan this project for security issues and write SECURITY_REPORT.md",
  "  /security validate [id]  reproduce findings against your app on localhost",
  "  /security fix <id>       fix a finding, run checks, and check the fix",
  "  /security diff [base]    review uncommitted changes, or your branch against base",
  "  /security status         list findings",
  "/todos     show this chat's todo list",
  "/export    save this chat as a Markdown file in the project",
  "/ps        list background processes (dev servers, databases)",
  "/stop      stop all background processes, or /stop <name>",
  "/restart   restart a background process: /restart <name>",
  "/allow     show which commands run without asking",
  "/login     log in with your email (free)",
  "/logout    log out on this machine",
  "/exit      quit",
  "",
  "!command   run a command yourself, such as !npm test; CoderBaba sees the output next time",
  "While CoderBaba works, type and press Enter to queue your next message (Esc clears the queue).",
].join("\n");

function portLabel(info: { url?: string; port?: number }): string {
  if (info.port) return `:${info.port}`;
  if (info.url) return info.url;
  return "";
}

function uptime(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function describeRestart(result: StartResult): string {
  if (result.error) return result.error;
  if (result.portInUse) return `${result.name} could not start: ${result.portInUse === true ? "the port" : `port ${result.portInUse}`} is already in use.`;
  if (result.exited) return `${result.name} exited with code ${result.exited.code ?? "unknown"}.`;
  if (result.ready) return `Restarted ${result.name}${result.url ? ` at ${result.url}` : result.port ? ` on port ${result.port}` : ""}.`;
  return `Restarted ${result.name}; it hasn't reported ready yet.`;
}

function toolLine(tool: ToolEvent): Line | null {
  const where = tool.cwd ? ` (in ${tool.cwd}/)` : "";
  switch (tool.name) {
    case "read_file":
      return { kind: "tool", label: "Read", detail: tool.path ?? "" };
    case "list_dir":
      return { kind: "tool", label: "List", detail: tool.path ?? "" };
    case "grep":
      return { kind: "tool", label: "Search", detail: tool.pattern ?? "" };
    case "shell":
      return { kind: "tool", label: tool.denied ? "Skipped" : "Run", detail: `${tool.command ?? ""}${where}` };
    case "start_process":
    case "restart_process": {
      const verb = tool.name === "start_process" ? "Started" : "Restarted";
      if (tool.denied) return { kind: "tool", label: "Skipped", detail: `${tool.command ?? tool.processName ?? ""}${where}` };
      if (tool.exited) return { kind: "tool", label: "Failed to start", detail: `${tool.processName ?? ""}  ${tool.command ?? ""}${where}` };
      const target = tool.url ?? (tool.port ? `:${tool.port}` : "");
      return { kind: "tool", label: verb, detail: `${tool.processName ?? ""}  ${tool.ready ? target : "(not ready yet)"}` };
    }
    case "read_process_output":
      return { kind: "tool", label: "Logs", detail: tool.processName ?? "" };
    case "stop_process":
      return { kind: "tool", label: tool.denied ? "Not found" : "Stopped", detail: tool.processName ?? "" };
    case "ask_secret":
      return { kind: "tool", label: tool.denied ? "Skipped secret" : "Saved secret", detail: `${tool.secretName ?? ""} → ${tool.path ?? ""}` };
    case "env_keys":
      return { kind: "tool", label: "Checked", detail: tool.path ?? "" };
    case "read_url":
      return { kind: "tool", label: tool.denied ? "Could not read" : "Read", detail: `${tool.url ?? ""}${tool.note ? ` (${tool.note})` : ""}` };
    case "write_todos":
      return { kind: "tool", label: "Todos", detail: tool.note ?? "" };
    case "save_threat_model":
      return { kind: "tool", label: tool.denied ? "Skipped" : "Saved", detail: "threat model" };
    case "record_finding":
      return { kind: "tool", label: tool.denied ? "Skipped finding" : "Finding", detail: tool.note ?? "" };
    case "update_finding":
      return { kind: "tool", label: tool.denied ? "Not updated" : "Updated", detail: tool.note ?? "" };
    case "check_page": {
      if (tool.denied) return { kind: "tool", label: "Skipped page check", detail: tool.url ?? "" };
      const result = tool.passed ? "no errors" : (tool.note ?? "problems found");
      return { kind: "tool", label: tool.passed ? "Checked page" : "Page problems", detail: `${tool.url ?? ""}  ${result}${tool.path ? `, screenshot ${tool.path}` : ""}` };
    }
    case "check":
      if (tool.denied) return { kind: "tool", label: "Skipped check", detail: `${tool.command ?? ""}${where}${tool.note ? `: ${tool.note}` : ""}` };
      if (tool.advisory && !tool.passed) {
        return {
          kind: "tool",
          label: "Audit warning",
          detail: `${tool.command ?? ""} found high-severity issues${tool.cwd ? ` in ${tool.cwd}/` : ""}. Type /security for details.`,
        };
      }
      return { kind: "tool", label: tool.passed ? "Checked" : "Check failed", detail: `${tool.command ?? ""}${where}` };
    case "edit_file":
      return {
        kind: "tool",
        label: tool.denied ? "Skipped edit" : "Edit",
        detail: tool.path ?? "",
        added: tool.added,
        removed: tool.removed,
        diff: tool.diffLines,
      };
    default:
      return null;
  }
}

const BANG_SHOWN_LINES = 60;
const BANG_KEPT_CHARS = 8_000;

function tailLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.length > count ? `… (${lines.length - count} earlier lines)\n${lines.slice(-count).join("\n")}` : text;
}

function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… output cut …\n${text.slice(-half)}`;
}

function thousands(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}k` : String(chars);
}

function compactedText(before: number, after: number, summarized: boolean): string {
  const how = summarized ? "Compacted the chat" : "Trimmed older messages from the chat";
  return `${how}: ${thousands(before)} -> ${thousands(after)} characters.`;
}

function processSegment(running: ProcessInfo[]): string {
  return running
    .filter((info) => info.status === "running")
    .map((info) => `${info.name} ${portLabel(info)}`.trim())
    .join(" · ");
}

export function App() {
  const { exit } = useApp();
  const cwd = process.cwd();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [auth, setAuth] = useState<AuthFile | null>(null);
  const [direct, setDirect] = useState(usesDirectOpenRouter());
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [model, setModel] = useState("fast");
  const [streaming, setStreaming] = useState("");
  const [progress, setProgress] = useState("");
  const [toolStartedAt, setToolStartedAt] = useState<number | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState(Date.now());
  const [, setTick] = useState(0);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const session = useRef<Session | null>(null);
  const allows = useRef(new Set<string>());
  const secrets = useRef(new Set<string>());
  const processes = useRef(new ProcessManager());
  const browser = useRef(new BrowserSession());
  const allowConfig = useRef<AllowConfig | null>(null);
  const quitting = useRef(false);
  const checkpoints = useRef(new Checkpoints(path.join(dataDir(), "checkpoints", Buffer.from(cwd).toString("base64url"))));

  const push = useCallback((line: Line) => setLines((prev) => [...prev, line]), []);

  const refreshUsage = useCallback(async (current: AuthFile | null) => {
    if (!current) return;
    setUsage(await fetchUsage(current.token));
  }, []);

  useEffect(() => processes.current.on(() => setTick((tick) => tick + 1)), []);
  useEffect(() => processes.current.addCleanup(() => browser.current.close()), []);

  useEffect(() => {
    const stopNow = () => processes.current.stopAllSync();
    const onSignal = () => {
      stopNow();
      process.exit(130);
    };
    process.on("exit", stopNow);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    return () => {
      process.off("exit", stopNow);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    };
  }, []);

  useEffect(() => {
    if (mode.kind !== "busy") return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [mode.kind]);

  const quit = useCallback(async () => {
    if (quitting.current) {
      processes.current.stopAllSync();
      process.exit(130);
    }
    quitting.current = true;
    if (processes.current.running().length) push({ kind: "info", text: "Stopping background processes…" });
    await processes.current.stopAll();
    exit();
  }, [exit, push]);

  const checkLeftoverContainers = useCallback(async () => {
    const slug = projectSlug(cwd);
    const known = [
      { name: `${slug}-mongo`, label: "MongoDB", port: 27017 },
      { name: `${slug}-postgres`, label: "Postgres", port: 5432 },
    ];
    const result = await runShell(`docker ps --filter name=${known[0]!.name} --filter name=${known[1]!.name} --format {{.Names}}`, cwd, {
      timeoutMs: 5_000,
    });
    if (result.code !== 0) return;
    const names = new Set(result.output.split(/\r?\n/).map((line) => line.trim()));
    for (const container of known) {
      if (!names.has(container.name)) continue;
      const procName = processes.current.running().some((info) => info.name === "db") ? `${container.label.toLowerCase()}-db` : "db";
      processes.current.registerExternal({
        name: procName,
        command: `docker container ${container.name}`,
        port: container.port,
        stop: async () => {
          await runShell(`docker stop ${container.name}`, cwd, { timeoutMs: 30_000 });
        },
      });
      push({ kind: "info", text: `A ${container.label} container from an earlier session is still running (${container.name}). It will be reused.` });
    }
  }, [cwd, push]);

  useEffect(() => {
    void (async () => {
      await checkpoints.current.load();
      session.current = await createSession(cwd, model);

      const config = await loadAllowConfig(cwd);
      for (const warning of config.warnings) push({ kind: "error", text: warning });
      if ((config.projectRules.length || config.projectChecks.length) && !config.trusted && config.projectHash) {
        const rules = [...config.projectRules, ...config.projectChecks.map((check) => `${check.command} (as a check after edits)`)];
        const trusted = await new Promise<boolean>((resolve) =>
          setMode({ kind: "trust", rules, file: shortenPath(config.projectFile), resolve }),
        );
        if (trusted) {
          await trustProject(cwd, config.projectHash);
          config.trusted = true;
          push({ kind: "info", text: "Trusted this project's command rules." });
        } else {
          push({ kind: "info", text: "Ignoring this project's command rules. Those commands will ask first." });
        }
        setMode({ kind: "loading" });
      }
      allowConfig.current = config;
      void checkLeftoverContainers();

      try {
        const result = await ensureAuth();
        if (!result.ok) {
          setMode({ kind: "email", reason: result.message });
          return;
        }
        setDirect(result.direct);
        setAuth(result.auth);
        await refreshUsage(result.auth);
        setMode({ kind: "chat" });
      } catch (error) {
        push({ kind: "error", text: error instanceof Error ? error.message : "Could not start." });
        setMode({ kind: "chat" });
      }
    })();
  }, []);

  const askPermission = useCallback(
    (request: PermissionRequest) =>
      new Promise<PermissionDecision>((resolve) => {
        setMode({ kind: "permission", request, resolve });
      }),
    [],
  );

  const askSecret = useCallback(
    (request: SecretRequest) =>
      new Promise<string | null>((resolve) => {
        setSecretInput("");
        setMode({ kind: "secret", request, resolve });
      }),
    [],
  );

  /** Streams agent events into the transcript; flush() pushes any half-streamed reply. */
  const eventHandler = useCallback(
    (todoList?: { items: Todo[] }) => {
      let text = "";
      const onEvent = (event: AgentEvent) => {
        if (event.type === "text") {
          text += event.text;
          setStreaming(text);
          return;
        }
        if (event.type === "progress") {
          setProgress(event.text);
          setToolStartedAt((prev) => prev ?? Date.now());
          return;
        }
        if (text) {
          push({ kind: "assistant", text });
          text = "";
          setStreaming("");
        }
        if (event.type === "compacted") {
          push({ kind: "info", text: compactedText(event.before, event.after, event.summarized) });
        } else if (event.type === "tool") {
          setProgress("");
          setToolStartedAt(null);
          if (event.event.name === "write_todos" && todoList) setTodos([...todoList.items]);
          const line = toolLine(event.event);
          if (line) push(line);
        } else if (event.type === "done") {
          push({ kind: "done", text: `Worked for ${event.seconds}s` });
        } else if (event.type === "error" && event.code !== ErrorCodes.TRIAL_EXHAUSTED) {
          push({ kind: "error", text: friendlyMessage(event.code, event.message, event.resetAt) });
        }
      };
      const flush = () => {
        if (text) push({ kind: "assistant", text });
        text = "";
        setStreaming("");
        setProgress("");
        setToolStartedAt(null);
      };
      return { onEvent, flush };
    },
    [push],
  );

  /** The options every turn shares: permissions, processes, checkpoints, redaction, checks, and the browser. */
  const turnBase = useCallback(
    (currentAuth: AuthFile | null, onEvent: (event: AgentEvent) => void): SecurityTurnBase => ({
      cwd,
      model,
      llm: createLlm(currentAuth?.token),
      askPermission,
      allows: allows.current,
      checkpoints: checkpoints.current,
      maxSteps: MAX_STEPS,
      onEvent,
      processes: processes.current,
      askSecret,
      userRules: activeRules(allowConfig.current),
      redact: secrets.current,
      checks: activeChecks(allowConfig.current),
      browser: browser.current,
    }),
    [askPermission, askSecret, cwd, model],
  );

  const startBusy = useCallback(() => {
    setMode({ kind: "busy" });
    setStreaming("");
    setProgress("");
    setToolStartedAt(null);
    setTurnStartedAt(Date.now());
  }, []);

  const runTask = useCallback(
    async (task: string, currentAuth: AuthFile | null) => {
      const current = session.current;
      if (!current) return;
      startBusy();
      if (!current.title) current.title = task.slice(0, 60);
      const todoList = { items: current.todos ?? [] };
      const { onEvent, flush } = eventHandler(todoList);
      const result = await runTurn({
        ...turnBase(currentAuth, onEvent),
        task,
        taskId: crypto.randomUUID(),
        messages: current.messages,
        todos: todoList,
      });
      current.todos = todoList.items;
      flush();
      current.messages = result.messages;
      current.model = model;
      await saveSession(current);
      await refreshUsage(currentAuth);
      if (result.stopCode === ErrorCodes.TRIAL_EXHAUSTED) {
        setMode({ kind: "email", reason: "You've used all the free tasks on this device. Enter your email to keep going (still free)", retry: task });
        return;
      }
      if (result.stopCode === ErrorCodes.TRIAL_UNAVAILABLE || result.stopCode === ErrorCodes.UNAUTHORIZED) {
        setMode({ kind: "email", reason: "Enter your email to keep going (still free)", retry: task });
        return;
      }
      setMode({ kind: "chat" });
    },
    [eventHandler, model, refreshUsage, startBusy, turnBase],
  );

  const runSecurity = useCallback(
    async (sub: string | undefined, arg: string | undefined) => {
      const current = session.current;
      if (!current) return;
      const action = sub?.toLowerCase() ?? "scan";
      if (action === "status") {
        const store = await SecurityStore.open(cwd, secrets.current);
        push({ kind: "info", text: statusTable(store.findings()) });
        return;
      }
      if (!["scan", "validate", "fix", "diff"].includes(action)) {
        push({ kind: "error", text: `Unknown option ${sub}. Use /security, /security validate, /security fix <id>, /security diff, or /security status.` });
        return;
      }
      if (action === "fix" && !arg) {
        push({ kind: "info", text: "Which one? Type /security fix S1. /security status lists the findings." });
        return;
      }
      const currentAuth = auth ?? (await readAuth());
      if (!direct && !currentAuth) {
        push({ kind: "info", text: "CoderBaba couldn't start a free session. Check your connection and try again, or type /login" });
        return;
      }
      const label = ["/security", sub, arg].filter(Boolean).join(" ");
      push({ kind: "user", text: label });
      if (!current.title) current.title = label;
      startBusy();
      const { onEvent, flush } = eventHandler();
      const base = turnBase(currentAuth, onEvent);
      let result: SecurityRunResult;
      try {
        if (action === "scan") {
          push({ kind: "info", text: "Scanning this project for security issues. CoderBaba reads the code and runs a dependency audit; it doesn't change files." });
          result = await runSecurityScan(base, {
            onPhase: (phase) => {
              flush();
              push({ kind: "info", text: `Phase ${phase.index} of ${phase.total}: ${phase.label}` });
            },
          });
        } else if (action === "validate") {
          push({ kind: "info", text: "Reproducing findings against your app on localhost only, with test data." });
          result = await runSecurityValidate(base, arg);
        } else if (action === "fix") {
          result = await runSecurityFix(base, arg!);
        } else {
          result = await runSecurityDiff(base, arg);
        }
      } catch (error) {
        flush();
        push({ kind: "error", text: error instanceof Error ? error.message : "The security run failed." });
        setMode({ kind: "chat" });
        return;
      }
      flush();
      push({ kind: "info", text: result.summary });
      if (result.ranModel) {
        current.messages.push({ role: "user", content: label }, { role: "assistant", content: result.summary });
        current.model = model;
        await saveSession(current);
        await refreshUsage(currentAuth);
      }
      if (result.stopCode && isLoginCode(result.stopCode)) {
        setMode({ kind: "email", reason: "Enter your email to keep going (still free)" });
        return;
      }
      setMode({ kind: "chat" });
    },
    [auth, cwd, direct, eventHandler, model, push, refreshUsage, startBusy, turnBase],
  );

  const sendCode = useCallback(
    async (email: string, retry?: string) => {
      try {
        const { masked } = await startEmailLogin(email);
        setMode({ kind: "code", email, masked, tries: 0, retry, sentAt: Date.now() });
      } catch (error) {
        push({ kind: "error", text: error instanceof Error ? error.message : "Could not send a code." });
        setMode({ kind: "email", reason: "What's your email?", retry });
      }
    },
    [push],
  );

  const verifyCode = useCallback(
    async (state: Extract<Mode, { kind: "code" }>, code: string) => {
      try {
        const trial = auth?.type === "anonymous" ? auth.token : undefined;
        const next = await verifyEmailLogin(state.email, code, trial);
        setAuth(next);
        push({ kind: "info", text: `You're logged in as ${state.email}.` });
        await refreshUsage(next);
        if (state.retry) {
          await runTask(state.retry, next);
          return;
        }
        setMode({ kind: "chat" });
      } catch (error) {
        const codeName = error instanceof CoderBabaError ? error.code : "INVALID_CODE";
        if (codeName === ErrorCodes.CODE_EXPIRED) {
          push({ kind: "error", text: "Code expired, sending a new one" });
          await sendCode(state.email, state.retry);
          return;
        }
        const tries = state.tries + 1;
        if (tries >= 3) {
          push({ kind: "error", text: "That code didn't match three times. Type r to get a new code." });
          setMode({ ...state, tries });
          return;
        }
        push({ kind: "error", text: friendlyMessage(codeName, error instanceof Error ? error.message : undefined) });
        setMode({ ...state, tries });
      }
    },
    [auth, push, refreshUsage, runTask, sendCode],
  );

  const showAllowRules = useCallback(() => {
    const config = allowConfig.current;
    const rows = [
      "Built in: version checks, read-only file and git commands, localhost curl, npm and pip read-only commands, docker ps and logs, lsof and ps, and known dev, lint, build, and test scripts.",
    ];
    rows.push(config?.globalRules.length ? `Yours (global): ${config.globalRules.join(", ")}` : "Yours (global): none. Add them to ~/.coderbaba/config.json as { \"allow\": [...] }.");
    if (config?.projectRules.length) {
      rows.push(`This project (${config.trusted ? "trusted" : "ignored"}): ${config.projectRules.join(", ")}`);
    }
    const checks = activeChecks(config);
    if (checks.disabled) rows.push("Checks after edits: off (\"checks\": false).");
    else if (checks.configured.length) rows.push(`Checks after edits: ${checks.configured.map((check) => check.command).join(", ")}`);
    else rows.push("Checks after edits: detected per app folder (typecheck, lint, and Django's manage.py check).");
    if (!checks.disabled) {
      rows.push("Dependency audits: npm, pnpm, or yarn audit (and pip-audit when it's in the venv) after package.json, lockfile, or requirements.txt changes. They warn you and never block.");
    }
    if (askAlways()) rows.push("CODERBABA_ASK_ALWAYS=1 is set, so every command asks first.");
    push({ kind: "info", text: rows.join("\n") });
  }, [push]);

  const command = useCallback(
    async (raw: string) => {
      const [name, arg, extra] = raw.trim().split(/\s+/);
      switch (name) {
        case "/help":
          push({ kind: "info", text: HELP });
          return;
        case "/new":
          session.current = await createSession(cwd, model);
          setLines([]);
          setTodos([]);
          push({ kind: "info", text: "Started a new chat." });
          return;
        case "/history": {
          const rows = await listSessions();
          push({ kind: "info", text: rows.length ? rows.map((row) => `${row.updatedAt.slice(0, 16).replace("T", " ")}  ${row.title}`).join("\n") : "No chats yet." });
          return;
        }
        case "/usage": {
          const latest = auth ? await fetchUsage(auth.token) : null;
          setUsage(latest);
          if (direct) push({ kind: "info", text: "Using your own OPENROUTER_API_KEY, so usage is not tracked here." });
          else if (latest?.type === "anonymous") {
            push({
              kind: "info",
              text: `${latest.triesLeft} of ${latest.triesLimit} free tasks left on this device. No sign-in needed; /login (free) unlocks the Smart model.`,
            });
          }
          else if (latest?.type === "user") {
            push({
              kind: "info",
              text: `Today: $${latest.daily.usedUsd.toFixed(3)} of $${latest.daily.limitUsd.toFixed(2)} (${latest.daily.percentLeft}% left, resets ${latest.daily.resetAt})\nMore at https://coderbaba.si/usage`,
            });
          } else push({ kind: "info", text: "Usage is not available right now." });
          return;
        }
        case "/model":
          if (auth?.type === "anonymous") {
            push({ kind: "info", text: "Model choice unlocks after you log in (free). Type /login" });
            return;
          }
          setMode({ kind: "model" });
          return;
        case "/undo": {
          const undone = await checkpoints.current.undoLast();
          push({ kind: "info", text: undone ? `Undid changes to ${undone.restored.length} file(s).` : "Nothing to undo." });
          return;
        }
        case "/ps": {
          const all = processes.current.list();
          if (!all.length) {
            push({ kind: "info", text: "No background processes." });
            return;
          }
          push({
            kind: "info",
            text: all
              .map((info) => {
                const status = info.status === "exited" ? `exited (${info.exitCode ?? "?"})` : info.status;
                const folder = info.folder !== "." ? ` (in ${info.folder}/)` : "";
                return `${info.name.padEnd(8)} ${status.padEnd(12)} ${(info.url ?? portLabel(info) ?? "").padEnd(24)} ${info.command}${folder}  ${info.status === "running" ? uptime(info.startedAt) : ""}`.trimEnd();
              })
              .join("\n"),
          });
          return;
        }
        case "/stop": {
          if (arg) {
            const info = await processes.current.stop(arg);
            push({ kind: "info", text: info ? `Stopped ${info.name}.` : `No process named ${arg}. Type /ps to see them.` });
            return;
          }
          if (!processes.current.running().length) {
            push({ kind: "info", text: "Nothing is running." });
            return;
          }
          await processes.current.stopAll();
          push({ kind: "info", text: "Stopped all background processes." });
          return;
        }
        case "/restart": {
          if (!arg) {
            push({ kind: "info", text: "Which one? Type /restart <name>. /ps lists them." });
            return;
          }
          const existing = processes.current.logs(arg)?.info;
          if (!existing) {
            push({ kind: "info", text: `No process named ${arg}. Type /ps to see them.` });
            return;
          }
          if (existing.external) {
            push({ kind: "info", text: `${existing.name} wasn't started by CoderBaba, so it can't be restarted here.` });
            return;
          }
          setMode({ kind: "busy" });
          setTurnStartedAt(Date.now());
          const result = await processes.current.restart(arg, (chunk) => {
            const line = lastLine(chunk);
            if (line) setProgress(line);
          });
          setProgress("");
          push({ kind: "info", text: result ? describeRestart(result) : `Could not restart ${arg}.` });
          setMode({ kind: "chat" });
          return;
        }
        case "/allow":
          showAllowRules();
          return;
        case "/todos": {
          const items = session.current?.todos ?? [];
          push({ kind: "info", text: items.length ? formatTodos(items) : "No todos in this chat yet. CoderBaba writes them for bigger tasks." });
          return;
        }
        case "/export": {
          const current = session.current;
          if (!current?.messages.length) {
            push({ kind: "info", text: "Nothing to export yet." });
            return;
          }
          const file = await exportChat(cwd, chatMarkdown(current.messages, { title: current.title, secrets: secrets.current }));
          push({ kind: "info", text: `Saved this chat to ${path.relative(cwd, file)}.` });
          return;
        }
        case "/init": {
          const currentAuth = auth ?? (await readAuth());
          if (!currentAuth && !direct) {
            setMode({ kind: "email", reason: "Enter your email to keep going (still free)", retry: INIT_TASK });
            return;
          }
          push({ kind: "info", text: `${loadProjectNotes(cwd) ? "Updating" : "Writing"} ${NOTES_FILE} with notes about this project…` });
          await runTask(INIT_TASK, currentAuth);
          return;
        }
        case "/security":
          await runSecurity(arg, extra);
          return;
        case "/compact": {
          const current = session.current;
          const currentAuth = auth ?? (await readAuth());
          if (!current || !current.messages.length) {
            push({ kind: "info", text: "Nothing to compact yet." });
            return;
          }
          if (!currentAuth && !direct) {
            push({ kind: "info", text: "Log in first (free). Type /login" });
            return;
          }
          setMode({ kind: "busy" });
          setTurnStartedAt(Date.now());
          setProgress("summarizing the chat");
          const result = await compact(current.messages, {
            llm: createLlm(currentAuth?.token),
            taskId: crypto.randomUUID(),
            model,
            force: true,
          });
          setProgress("");
          if (!result) {
            push({ kind: "info", text: "The chat is already as short as it can be." });
          } else {
            current.messages = result.messages;
            await saveSession(current);
            push({ kind: "info", text: compactedText(result.before, result.after, result.summarized) });
          }
          setMode({ kind: "chat" });
          return;
        }
        case "/login":
          setMode({ kind: "email", reason: "What's your email?" });
          return;
        case "/logout":
          if (auth) await logoutRemote(auth.token);
          setAuth(null);
          setUsage(null);
          push({ kind: "info", text: "Logged out on this machine." });
          setMode({ kind: "email", reason: "What's your email?" });
          return;
        case "/exit":
          await quit();
          return;
        default:
          push({ kind: "error", text: `Unknown command ${name}. Type /help` });
      }
    },
    [auth, cwd, direct, model, push, quit, runSecurity, runTask, showAllowRules],
  );

  const runBang = useCallback(
    async (commandText: string) => {
      if (!commandText) {
        push({ kind: "info", text: "Type a command after !, such as !npm test." });
        return;
      }
      push({ kind: "user", text: `!${commandText}` });
      setMode({ kind: "busy" });
      setTurnStartedAt(Date.now());
      setProgress("");
      const result = await runUserCommand(commandText, {
        cwd,
        onOutput: (chunk) => {
          const line = lastLine(chunk);
          if (line) setProgress(line);
        },
      });
      setProgress("");
      const output = redact(result.output.trim(), secrets.current);
      const status = result.timedOut ? "Timed out after 600s and was stopped." : `(exit ${result.code})`;
      push({ kind: "info", text: [tailLines(output, BANG_SHOWN_LINES), status].filter(Boolean).join("\n") });
      const current = session.current;
      if (current) {
        current.messages.push({ role: "user", content: `I ran: ${commandText}\n${cutMiddle(output, BANG_KEPT_CHARS)}\n${status}` });
        await saveSession(current);
      }
      setMode({ kind: "chat" });
    },
    [cwd, push],
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (mode.kind === "email") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
          push({ kind: "error", text: "That doesn't look like an email. Try again." });
          return;
        }
        await sendCode(text, mode.retry);
        return;
      }
      if (mode.kind === "code") {
        if (text.toLowerCase() === "r") {
          const wait = RESEND_COOLDOWN_MS - (Date.now() - mode.sentAt);
          if (wait > 0) {
            push({ kind: "info", text: `Wait ${Math.ceil(wait / 1000)}s before sending a new code.` });
            return;
          }
          await sendCode(mode.email, mode.retry);
          return;
        }
        if (mode.tries >= 3) {
          push({ kind: "info", text: "Type r to get a new code." });
          return;
        }
        if (!/^\d{6}$/.test(text)) {
          push({ kind: "error", text: "Enter the 6-digit code from the email, or r to resend." });
          return;
        }
        await verifyCode(mode, text);
        return;
      }
      if (mode.kind === "model") {
        const picked = findModel(text) ?? MODELS[Number(text) - 1];
        if (picked) {
          setModel(picked.id);
          push({ kind: "info", text: `Using ${picked.label}.` });
        }
        setMode({ kind: "chat" });
        return;
      }
      if (!text || mode.kind !== "chat") return;
      if (text.startsWith("/")) {
        await command(text);
        return;
      }
      if (text.startsWith("!")) {
        await runBang(text.slice(1).trim());
        return;
      }
      push({ kind: "user", text });
      const current = auth ?? (await readAuth());
      if (!current && !direct) {
        setMode({ kind: "email", reason: "Enter your email to keep going (still free)", retry: text });
        return;
      }
      await runTask(text, current);
    },
    [auth, command, direct, mode, push, runBang, runTask, sendCode, verifyCode],
  );

  useEffect(() => {
    if (mode.kind !== "chat" || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next!);
  }, [mode.kind, queue, submit]);

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      void quit();
      return;
    }
    if (mode.kind === "permission") {
      const answer = char.toLowerCase();
      if (answer === "y" || answer === "a" || answer === "n") {
        const decision: PermissionDecision = answer === "y" ? "allow" : answer === "a" ? "always" : "deny";
        mode.resolve(decision);
        setMode({ kind: "busy" });
      }
      return;
    }
    if (mode.kind === "trust") {
      const answer = char.toLowerCase();
      if (answer === "y" || answer === "n") mode.resolve(answer === "y");
      return;
    }
    if (mode.kind === "secret") {
      if (key.return || key.escape) {
        const value = key.escape ? null : secretInput || null;
        setSecretInput("");
        setMode({ kind: "busy" });
        mode.resolve(value);
        return;
      }
      if (key.backspace || key.delete) {
        setSecretInput((prev) => prev.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && char) setSecretInput((prev) => prev + char.replace(/[\r\n]/g, ""));
      return;
    }
    if (mode.kind === "loading") return;
    if (mode.kind === "busy") {
      if (key.return) {
        const text = input.trim();
        if (text) setQueue((prev) => [...prev, text]);
        setInput("");
      } else if (key.escape) {
        setQueue([]);
        setInput("");
      } else if (key.backspace || key.delete) setInput((prev) => prev.slice(0, -1));
      else if (!key.ctrl && !key.meta && char) setInput((prev) => prev + char);
      return;
    }
    if (key.return) {
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInput("");
      if (mode.kind === "model") setMode({ kind: "chat" });
      return;
    }
    if (!key.ctrl && !key.meta && char) setInput((prev) => prev + char);
  });

  const modelInfo = findModel(model) ?? MODELS[0]!;
  const servers = processSegment(processes.current.running());
  const status = formatStatus({ modelLabel: modelInfo.label, project: shortenPath(cwd), direct, usage }) + (servers ? ` · ${servers}` : "");
  const busySeconds = Math.max(0, Math.round((Date.now() - (toolStartedAt ?? turnStartedAt)) / 1000));

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        CoderBaba
      </Text>
      {lines.map((line, index) => (
        <LineView key={index} line={line} />
      ))}
      {streaming ? <Text>{streaming}</Text> : null}
      <Prompt mode={mode} input={input} secretLength={secretInput.length} progress={progress} seconds={busySeconds} todos={todos} queue={queue} />
      <Text dimColor>{status}</Text>
    </Box>
  );
}

function LineView({ line }: { line: Line }) {
  if (line.kind === "user") return <Text color="cyan">❯ {line.text}</Text>;
  if (line.kind === "assistant") return <Text>{line.text}</Text>;
  if (line.kind === "info") return <Text dimColor>{line.text}</Text>;
  if (line.kind === "error") return <Text color="red">{line.text}</Text>;
  if (line.kind === "done") return <Text dimColor>{line.text}</Text>;
  const counts = line.added !== undefined ? ` +${line.added} -${line.removed ?? 0}` : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="yellow">{line.label}</Text>
        {counts ? (
          <>
            <Text color="green"> +{line.added}</Text>
            <Text color="red"> -{line.removed ?? 0}</Text>
          </>
        ) : null}{" "}
        <Text dimColor>{line.detail}</Text>
      </Text>
      {line.diff?.map((diffLine, index) => (
        <Text key={index} color={diffLine.kind === "add" ? "green" : diffLine.kind === "del" ? "red" : undefined} dimColor={diffLine.kind === "ctx"}>
          {"  "}
          {diffLine.kind === "add" ? "+" : diffLine.kind === "del" ? "-" : " "} {diffLine.text}
        </Text>
      ))}
    </Box>
  );
}

function fitWidth(text: string): string {
  const max = Math.max(20, (process.stdout.columns || 80) - 1);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const TODOS_SHOWN = 8;

function TodoList({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const done = todos.filter((todo) => todo.status === "done");
  const open = todos.filter((todo) => todo.status !== "done");
  const shown = todos.length <= TODOS_SHOWN ? todos : open.slice(0, TODOS_SHOWN - 1);
  return (
    <Box flexDirection="column">
      {todos.length > TODOS_SHOWN ? <Text dimColor>{done.length} of {todos.length} done</Text> : null}
      {shown.map((todo, index) => (
        <Text key={index} dimColor={todo.status === "done"} color={todo.status === "in_progress" ? "cyan" : undefined}>
          {fitWidth(`${todo.status === "done" ? "✓" : todo.status === "in_progress" ? "›" : "·"} ${todo.text}`)}
        </Text>
      ))}
    </Box>
  );
}

function Prompt({
  mode,
  input,
  secretLength,
  progress,
  seconds,
  todos,
  queue,
}: {
  mode: Mode;
  input: string;
  secretLength: number;
  progress: string;
  seconds: number;
  todos: Todo[];
  queue: string[];
}) {
  if (mode.kind === "loading") return <Text dimColor>Starting…</Text>;
  if (mode.kind === "busy") {
    return (
      <Box flexDirection="column">
        <TodoList todos={todos} />
        {queue.map((item, index) => (
          <Text key={index} dimColor>
            {fitWidth(`Queued: ${item}`)}
          </Text>
        ))}
        <Text dimColor>{fitWidth(`Working… ${seconds}s${progress ? `  ${progress}` : "  (type to queue a message, Ctrl+C to quit)"}`)}</Text>
        {input ? (
          <Text>
            <Text color="green">❯ </Text>
            {input}
            <Text inverse> </Text>
            <Text dimColor>  Enter to queue, Esc to clear</Text>
          </Text>
        ) : null}
      </Box>
    );
  }
  if (mode.kind === "permission") {
    return <Text color="yellow">{mode.request.summary.replace(/ Allow\?$/, "")} Allow? (y / always=a / n)</Text>;
  }
  if (mode.kind === "secret") {
    const hint = mode.request.hint ? `${mode.request.hint}, ` : "";
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          Paste {mode.request.name} ({hint}input hidden, Esc to skip):
        </Text>
        <Text dimColor>It will be saved to {mode.request.envPath}. CoderBaba's AI never sees it.</Text>
        <Text>
          {"•".repeat(secretLength)}
          <Text inverse> </Text>
        </Text>
      </Box>
    );
  }
  if (mode.kind === "trust") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">This project ({mode.file}) lets these commands run without asking:</Text>
        {mode.rules.map((rule) => (
          <Text key={rule}>  {rule}</Text>
        ))}
        <Text color="yellow">Trust them? (y / n)</Text>
      </Box>
    );
  }
  if (mode.kind === "model") {
    return (
      <Box flexDirection="column">
        {MODELS.map((item, index) => (
          <Text key={item.id}>
            {index + 1}. {item.label} <Text dimColor>{item.openrouterId}</Text>
          </Text>
        ))}
        <Text>
          Pick a model (number or name): {input}
        </Text>
      </Box>
    );
  }
  if (mode.kind === "email") {
    return (
      <Box flexDirection="column">
        <Text>{mode.reason}</Text>
        <Text>
          Email: {input}
          <Text inverse> </Text>
        </Text>
      </Box>
    );
  }
  if (mode.kind === "code") {
    return (
      <Box flexDirection="column">
        <Text>We sent a 6-digit code to {mode.masked}. Enter it (r to resend):</Text>
        <Text>
          Code: {input}
          <Text inverse> </Text>
        </Text>
      </Box>
    );
  }
  return (
    <Text>
      <Text color="green">❯ </Text>
      {input ? input : <Text dimColor>Enter a coding task or / for commands</Text>}
      <Text inverse> </Text>
    </Text>
  );
}
