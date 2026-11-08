import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import path from "node:path";
import { ErrorCodes, MODELS, findModel, type UsageResponse } from "@coderbabasi/shared";
import {
  Checkpoints,
  CoderBabaError,
  createLlm,
  createSession,
  dataDir,
  ensureAuth,
  fetchUsage,
  formatStatus,
  friendlyMessage,
  listSessions,
  logoutRemote,
  readAuth,
  runTurn,
  saveSession,
  shortenPath,
  startEmailLogin,
  usesDirectOpenRouter,
  verifyEmailLogin,
  type AgentEvent,
  type AuthFile,
  type PermissionDecision,
  type PermissionRequest,
  type Session,
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
  | { kind: "email"; reason: string; retry?: string }
  | { kind: "code"; email: string; masked: string; tries: number; retry?: string; sentAt: number }
  | { kind: "model" };

const MAX_STEPS = 40;
const RESEND_COOLDOWN_MS = 30_000;

const HELP = [
  "/help      show commands",
  "/new       start a new chat",
  "/history   list recent chats",
  "/usage     show your free usage",
  "/model     pick Fast or Smart",
  "/undo      revert the last turn's file changes",
  "/login     log in with your email (free)",
  "/logout    log out on this machine",
  "/exit      quit",
].join("\n");

export function App() {
  const { exit } = useApp();
  const cwd = process.cwd();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [auth, setAuth] = useState<AuthFile | null>(null);
  const [direct, setDirect] = useState(usesDirectOpenRouter());
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [model, setModel] = useState("fast");
  const [streaming, setStreaming] = useState("");
  const session = useRef<Session | null>(null);
  const allows = useRef(new Set<string>());
  const checkpoints = useRef(new Checkpoints(path.join(dataDir(), "checkpoints", Buffer.from(cwd).toString("base64url"))));

  const push = useCallback((line: Line) => setLines((prev) => [...prev, line]), []);

  const refreshUsage = useCallback(async (current: AuthFile | null) => {
    if (!current) return;
    setUsage(await fetchUsage(current.token));
  }, []);

  useEffect(() => {
    void (async () => {
      await checkpoints.current.load();
      session.current = await createSession(cwd, model);
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

  const runTask = useCallback(
    async (task: string, currentAuth: AuthFile | null) => {
      const current = session.current;
      if (!current) return;
      setMode({ kind: "busy" });
      setStreaming("");
      if (!current.title) current.title = task.slice(0, 60);
      const taskId = crypto.randomUUID();
      let text = "";
      const onEvent = (event: AgentEvent) => {
        if (event.type === "text") {
          text += event.text;
          setStreaming(text);
          return;
        }
        if (text) {
          push({ kind: "assistant", text });
          text = "";
          setStreaming("");
        }
        if (event.type === "tool") {
          const tool = event.event;
          if (tool.name === "read_file") push({ kind: "tool", label: "Read", detail: tool.path ?? "" });
          else if (tool.name === "list_dir") push({ kind: "tool", label: "List", detail: tool.path ?? "" });
          else if (tool.name === "grep") push({ kind: "tool", label: "Search", detail: tool.pattern ?? "" });
          else if (tool.name === "shell") push({ kind: "tool", label: tool.denied ? "Skipped" : "Run", detail: tool.command ?? "" });
          else if (tool.name === "edit_file") {
            push({
              kind: "tool",
              label: tool.denied ? "Skipped edit" : "Edit",
              detail: tool.path ?? "",
              added: tool.added,
              removed: tool.removed,
              diff: tool.diffLines,
            });
          }
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
      });
      if (text) push({ kind: "assistant", text });
      setStreaming("");
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
    [askPermission, cwd, model, push, refreshUsage],
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

  const command = useCallback(
    async (raw: string) => {
      const [name] = raw.trim().split(/\s+/);
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
          exit();
          return;
        default:
          push({ kind: "error", text: `Unknown command ${name}. Type /help` });
      }
    },
    [auth, cwd, direct, exit, model, push],
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
      exit();
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
  const status = formatStatus({ modelLabel: modelInfo.label, project: shortenPath(cwd), direct, usage });

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        CoderBaba
      </Text>
      {lines.map((line, index) => (
        <LineView key={index} line={line} />
      ))}
      {streaming ? <Text>{streaming}</Text> : null}
      <Prompt mode={mode} input={input} />
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

function Prompt({ mode, input }: { mode: Mode; input: string }) {
  if (mode.kind === "loading") return <Text dimColor>Starting…</Text>;
  if (mode.kind === "busy") return <Text dimColor>Working… (Ctrl+C to quit)</Text>;
  if (mode.kind === "permission") {
    return <Text color="yellow">{mode.request.summary.replace(/ Allow\?$/, "")} Allow? (y / always=a / n)</Text>;
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
