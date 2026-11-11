import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, ToolCall } from "@coderbabasi/shared";
import type { BrowserSession } from "./browser.js";
import { Checkpoints } from "./checkpoints.js";
import { failureMessage, planChecks, runChecks, type CheckSettings } from "./checks.js";
import { fitContext } from "./context.js";
import { createProgressReporter, redact } from "./output.js";
import { CoderBabaError } from "./errors.js";
import type { Llm } from "./llm.js";
import type { PermissionDecision, PermissionRequest } from "./permissions.js";
import type { ProcessManager } from "./processes.js";
import { loadProjectNotes } from "./project-notes.js";
import { buildSystemPrompt } from "./prompt.js";
import type { AskSecret } from "./secrets.js";
import { TOOL_DEFINITIONS, runTool, type Todo, type ToolEvent } from "./tools.js";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; event: ToolEvent }
  | { type: "progress"; text: string }
  | { type: "compacted"; before: number; after: number; summarized: boolean }
  | { type: "error"; code: string; message: string; resetAt?: string }
  | { type: "done"; seconds: number };

/** Tools that exist only for one kind of turn, such as the security tools. */
export type ExtraTools = {
  definitions: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  run(name: string, args: Record<string, unknown>): Promise<{ content: string; event: ToolEvent }>;
};

const MAX_CONTINUES = 3;
const MAX_CHECK_ROUNDS = 2;

export type TurnOptions = {
  task: string;
  cwd: string;
  model: string;
  taskId: string;
  messages: ChatMessage[];
  llm: Llm;
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  allows: Set<string>;
  checkpoints: Checkpoints;
  maxSteps: number;
  onEvent: (event: AgentEvent) => void;
  processes?: ProcessManager;
  askSecret?: AskSecret;
  userRules?: string[];
  redact?: Set<string>;
  /** Automatic checks after edits. Detection is on when omitted. */
  checks?: CheckSettings;
  browser?: BrowserSession;
  /** The session's todo list, shown to the model and replaced by write_todos. */
  todos?: { items: Todo[] };
  extraTools?: ExtraTools;
};

export async function runTurn(opts: TurnOptions): Promise<{ messages: ChatMessage[]; stopCode?: string }> {
  const started = Date.now();
  const messages = opts.messages.slice();
  messages.push({ role: "user", content: opts.task });
  let continues = 0;
  const edited = new Set<string>();
  let checkRounds = 0;
  const root = realRoot(opts.cwd);
  const extraNames = new Set(opts.extraTools?.definitions.map((definition) => definition.function.name));
  const tools = opts.extraTools ? [...TOOL_DEFINITIONS, ...opts.extraTools.definitions] : TOOL_DEFINITIONS;

  for (let step = 0; step < opts.maxSteps; step++) {
    const fitted = await fitContext(messages, { llm: opts.llm, taskId: opts.taskId, model: opts.model, task: opts.task });
    messages.splice(0, messages.length, ...fitted.messages);
    if (fitted.compacted) {
      opts.onEvent({ type: "compacted", before: fitted.compacted.before, after: fitted.compacted.after, summarized: fitted.compacted.summarized });
    }
    let result;
    try {
      const system = buildSystemPrompt({
        root: opts.cwd,
        running: opts.processes?.running(),
        notes: loadProjectNotes(opts.cwd),
        todos: opts.todos?.items,
      });
      result = await opts.llm.chat({
        taskId: opts.taskId,
        model: opts.model,
        messages: [{ role: "system", content: system }, ...messages],
        tools,
        onText: (text) => opts.onEvent({ type: "text", text }),
      });
    } catch (error) {
      const known = error instanceof CoderBabaError ? error : new CoderBabaError("BAD_REQUEST", "The model request failed. Try again.");
      opts.onEvent({ type: "error", code: known.code, message: known.message, resetAt: known.resetAt });
      if (step === 0) return { messages: opts.messages, stopCode: known.code };
      return { messages, stopCode: known.code };
    }

    if (result.finishReason === "length" && result.toolCalls.length === 0 && continues < MAX_CONTINUES) {
      continues += 1;
      messages.push({ role: "assistant", content: result.content });
      messages.push({ role: "user", content: "Continue from where you left off." });
      continue;
    }

    if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: result.content });
      if (edited.size && checkRounds <= MAX_CHECK_ROUNDS) {
        const failed = await runEndChecks(opts, root, [...edited]);
        if (failed && checkRounds < MAX_CHECK_ROUNDS) {
          checkRounds += 1;
          messages.push({ role: "user", content: failed });
          continue;
        }
        checkRounds = MAX_CHECK_ROUNDS + 1;
      }
      opts.onEvent({ type: "done", seconds: elapsed(started) });
      return { messages };
    }

    const toolCalls: ToolCall[] = result.toolCalls.map((call, index) => ({
      id: call.id || `call_${step}_${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    messages.push({ role: "assistant", content: result.content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Arguments were not valid JSON." });
        continue;
      }
      if (opts.extraTools && extraNames.has(call.function.name)) {
        let extra: { content: string; event: ToolEvent };
        try {
          extra = await opts.extraTools.run(call.function.name, args);
        } catch (error) {
          extra = { content: error instanceof Error ? error.message : "Tool failed", event: { name: call.function.name, denied: true } };
        }
        opts.onEvent({ type: "tool", event: extra.event });
        messages.push({ role: "tool", tool_call_id: call.id, content: redact(extra.content, opts.redact) });
        continue;
      }
      const outcome = await runTool({
        name: call.function.name,
        args,
        cwd: opts.cwd,
        turnId: opts.taskId,
        checkpoints: opts.checkpoints,
        allows: opts.allows,
        askPermission: opts.askPermission,
        processes: opts.processes,
        askSecret: opts.askSecret,
        userRules: opts.userRules,
        redact: opts.redact,
        browser: opts.browser,
        todos: opts.todos,
        onProgress: (text) => opts.onEvent({ type: "progress", text }),
      });
      opts.onEvent({ type: "tool", event: outcome.event });
      if (outcome.event.name === "edit_file" && outcome.event.file && !outcome.event.denied) edited.add(outcome.event.file);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
  }

  opts.onEvent({ type: "error", code: "STEP_LIMIT", message: "Stopped after the step limit." });
  opts.onEvent({ type: "done", seconds: elapsed(started) });
  return { messages };
}

function realRoot(cwd: string): string {
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

/** Run the checks for the edited files. Returns the message for the model when any failed. */
async function runEndChecks(opts: TurnOptions, root: string, files: string[]): Promise<string | undefined> {
  const planned = await planChecks(root, files, opts.checks ?? { configured: [], disabled: false });
  if (!planned.length) return undefined;
  const progress = createProgressReporter((text) => opts.onEvent({ type: "progress", text }));
  const results = await runChecks(planned, {
    root,
    userRules: opts.userRules,
    processes: opts.processes,
    onOutput: progress.push,
    onResult: (result) =>
      opts.onEvent({
        type: "tool",
        event: {
          name: "check",
          command: result.command,
          cwd: result.rel,
          passed: result.passed,
          denied: Boolean(result.skipped),
          note: result.skipped,
          advisory: result.advisory,
        },
      }),
  });
  progress.stop();
  const failed = results.some((result) => !result.passed && !result.advisory);
  return failed ? redact(failureMessage(results), opts.redact) : undefined;
}

function elapsed(started: number): number {
  return Math.max(1, Math.round((Date.now() - started) / 1000));
}
