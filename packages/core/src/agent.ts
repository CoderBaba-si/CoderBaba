import type { ChatMessage, ToolCall } from "@coderbabasi/shared";
import { Checkpoints } from "./checkpoints.js";
import { CoderBabaError } from "./errors.js";
import type { Llm } from "./llm.js";
import type { PermissionDecision, PermissionRequest } from "./permissions.js";
import type { ProcessManager } from "./processes.js";
import { buildSystemPrompt } from "./prompt.js";
import type { AskSecret } from "./secrets.js";
import { TOOL_DEFINITIONS, runTool, type ToolEvent } from "./tools.js";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; event: ToolEvent }
  | { type: "progress"; text: string }
  | { type: "error"; code: string; message: string; resetAt?: string }
  | { type: "done"; seconds: number };

const MAX_CONTINUES = 3;

export async function runTurn(opts: {
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
}): Promise<{ messages: ChatMessage[]; stopCode?: string }> {
  const started = Date.now();
  const messages = opts.messages.slice();
  messages.push({ role: "user", content: opts.task });
  let continues = 0;

  for (let step = 0; step < opts.maxSteps; step++) {
    let result;
    try {
      const system = buildSystemPrompt({ root: opts.cwd, running: opts.processes?.running() });
      result = await opts.llm.chat({
        taskId: opts.taskId,
        model: opts.model,
        messages: [{ role: "system", content: system }, ...messages],
        tools: TOOL_DEFINITIONS,
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
        onProgress: (text) => opts.onEvent({ type: "progress", text }),
      });
      opts.onEvent({ type: "tool", event: outcome.event });
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
  }

  opts.onEvent({ type: "error", code: "STEP_LIMIT", message: "Stopped after the step limit." });
  opts.onEvent({ type: "done", seconds: elapsed(started) });
  return { messages };
}

function elapsed(started: number): number {
  return Math.max(1, Math.round((Date.now() - started) / 1000));
}
