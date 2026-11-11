import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import path from "node:path";
import { ErrorCodes, MODELS, findModel, type UsageResponse } from "@coderbabasi/shared";
import {
  Checkpoints,
  CoderBabaError,
  ProcessManager,
  activeRules,
  askAlways,
  createLlm,
  createSession,
  dataDir,
  ensureAuth,
  fetchUsage,
  formatStatus,
  friendlyMessage,
  lastLine,
  listSessions,
  loadAllowConfig,
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
  "/ps        list background processes (dev servers, databases)",
  "/stop      stop all background processes, or /stop <name>",
  "/restart   restart a background process: /restart <name>",
  "/allow     show which commands run without asking",
  "/login     log in with your email (free)",
  "/logout    log out on this machine",
  "/exit      quit",
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
  const session = useRef<Session | null>(null);
  const allows = useRef(new Set<string>());
  const secrets = useRef(new Set<string>());
  const processes = useRef(new ProcessManager());
  const allowConfig = useRef<AllowConfig | null>(null);
  const quitting = useRef(false);
  const checkpoints = useRef(new Checkpoints(path.join(dataDir(), "checkpoints", Buffer.from(cwd).toString("base64url"))));

  const push = useCallback((line: Line) => setLines((prev) => [...prev, line]), []);

  const refreshUsage = useCallback(async (current: AuthFile | null) => {
    if (!current) return;
    setUsage(await fetchUsage(current.token));
  }, []);

  useEffect(() => processes.current.on(() => setTick((tick) => tick + 1)), []);

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
    if (processes.current.running().length) {
      push({ kind: "info", text: "Stopping background processes…" });
      await processes.current.stopAll();
    }
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
      if (config.projectRules.length && !config.trusted && config.projectHash) {
        const trusted = await new Promise<boolean>((resolve) =>
          setMode({ kind: "trust", rules: config.projectRules, file: shortenPath(config.projectFile), resolve }),
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

  const runTask = useCallback(
    async (task: string, currentAuth: AuthFile | null) => {
      const current = session.current;
      if (!current) return;
      setMode({ kind: "busy" });
      setStreaming("");
      setProgress("");
      setToolStartedAt(null);
      setTurnStartedAt(Date.now());
      if (!current.title) current.title = task.slice(0, 60);
      const taskId = crypto.randomUUID();
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
        if (event.type === "tool") {
          setProgress("");
          setToolStartedAt(null);
          const line = toolLine(event.event);
          if (line) push(line);
        } else if (event.type === "done") {
          push({ kind: "done", text: `Worked for ${event.seconds}s` });
        } else if (event.type === "error" && event.code !== ErrorCodes.TRIAL_EXHAUSTED) {
          push({ kind: "error", text: friendlyMessage(event.code, event.message, event.resetAt) });
        }
      };
      const result = await runTurn({
        task,
        cwd,
        model,
        taskId,
        messages: current.messages,
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
      });
      if (text) push({ kind: "assistant", text });
      setStreaming("");
      setProgress("");
      setToolStartedAt(null);
      current.messages = result.messages;
      current.model = model;
      await saveSession(current);
      await refreshUsage(currentAuth);
      if (result.stopCode === ErrorCodes.TRIAL_EXHAUSTED) {
        setMode({ kind: "email", reason: "You've used your 5 free tries. Enter your email to keep going (still free)", retry: task });
        return;
      }
      if (result.stopCode === ErrorCodes.TRIAL_UNAVAILABLE || result.stopCode === ErrorCodes.UNAUTHORIZED) {
        setMode({ kind: "email", reason: "Enter your email to keep going (still free)", retry: task });
        return;
      }
      setMode({ kind: "chat" });
    },
    [askPermission, askSecret, cwd, model, push, refreshUsage],
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
    if (askAlways()) rows.push("CODERBABA_ASK_ALWAYS=1 is set, so every command asks first.");
    push({ kind: "info", text: rows.join("\n") });
  }, [push]);

  const command = useCallback(
    async (raw: string) => {
      const [name, arg] = raw.trim().split(/\s+/);
      switch (name) {
        case "/help":
          push({ kind: "info", text: HELP });
          return;
        case "/new":
          session.current = await createSession(cwd, model);
          setLines([]);
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
          else if (latest?.type === "anonymous") push({ kind: "info", text: `${latest.triesLeft} of ${latest.triesLimit} free tries left. /login to keep going (free).` });
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
    [auth, cwd, direct, model, push, quit, showAllowRules],
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
      push({ kind: "user", text });
      const current = auth ?? (await readAuth());
      if (!current && !direct) {
        setMode({ kind: "email", reason: "Enter your email to keep going (still free)", retry: text });
        return;
      }
      await runTask(text, current);
    },
    [auth, command, direct, mode, push, runTask, sendCode, verifyCode],
  );

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
    if (mode.kind === "busy" || mode.kind === "loading") return;
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
      <Prompt mode={mode} input={input} secretLength={secretInput.length} progress={progress} seconds={busySeconds} />
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

function Prompt({
  mode,
  input,
  secretLength,
  progress,
  seconds,
}: {
  mode: Mode;
  input: string;
  secretLength: number;
  progress: string;
  seconds: number;
}) {
  if (mode.kind === "loading") return <Text dimColor>Starting…</Text>;
  if (mode.kind === "busy") {
    return <Text dimColor>{fitWidth(`Working… ${seconds}s${progress ? `  ${progress}` : "  (Ctrl+C to quit)"}`)}</Text>;
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
