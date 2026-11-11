import type { ChatMessage } from "@coderbabasi/shared";
import type { Llm } from "./llm.js";

/** Stays well under the proxy's 400,000-character and 500-message limits, and inside both models' context windows. */
export const CONTEXT_BUDGET = { chars: 240_000, messages: 400 };

const KEEP_RECENT_OUTPUTS = 6;
const SHORTEN_OVER = 1_500;
const KEEP_EACH_END = 400;
const SHORTENED = "(older output shortened)";
const KEEP_RECENT_SHARE = 0.4;
const TRANSCRIPT_MAX = 150_000;
const TRANSCRIPT_TOOL_MAX = 2_000;
export const SUMMARY_PREFIX = "Summary of the conversation so far:";
const DROPPED_NOTE = "(Earlier messages were removed to fit the model's context. Ask the user if you need details from them.)";

const SUMMARY_PROMPT = `You summarize a coding session between a user and CoderBaba, a coding agent, so the session can continue with less context.
Write plain text, at most 400 words, with these headings: Goal, Decisions, Files changed, Running processes, Open problems, Next steps.
Keep exact file paths, commands, ports, URLs, and error messages that still matter. Drop anything finished and irrelevant.
Never include secret values (passwords, API keys, tokens, connection strings), even if they appear in the transcript.`;

type Budget = { chars: number; messages: number };

export function contextSize(messages: ChatMessage[]): number {
  return JSON.stringify(messages).length;
}

function fits(messages: ChatMessage[], budget: Budget): boolean {
  return messages.length <= budget.messages && contextSize(messages) <= budget.chars;
}

/** Cut long tool results, except the most recent ones, down to their first and last part. */
export function shortenOldOutputs(messages: ChatMessage[], keepRecent = KEEP_RECENT_OUTPUTS): ChatMessage[] {
  const toolIndexes = messages.flatMap((message, index) => (message.role === "tool" ? [index] : []));
  const old = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)));
  return messages.map((message, index) => {
    const content = message.content ?? "";
    if (!old.has(index) || content.length <= SHORTEN_OVER) return message;
    return {
      ...message,
      content: `${content.slice(0, KEEP_EACH_END)}\n… ${SHORTENED} …\n${content.slice(-KEEP_EACH_END)}`,
    };
  });
}

/** Indexes where the history can be split without separating an assistant's tool calls from their results. */
export function cutPoints(messages: ChatMessage[]): number[] {
  const points: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    const previous = messages[i - 1]!;
    if (message.role === "tool") continue;
    if (previous.role === "assistant" && previous.tool_calls?.length) continue;
    points.push(i);
  }
  return points;
}

function chooseCut(messages: ChatMessage[], budget: Budget, force: boolean): number | undefined {
  const points = cutPoints(messages);
  if (!points.length) return undefined;
  if (force) {
    const lastUser = [...points].reverse().find((index) => messages[index]!.role === "user");
    return lastUser ?? points[points.length - 1];
  }
  const keepChars = budget.chars * KEEP_RECENT_SHARE;
  const keepMessages = Math.floor(budget.messages * KEEP_RECENT_SHARE);
  const earliest = points.find((index) => {
    const kept = messages.slice(index);
    return kept.length <= keepMessages && contextSize(kept) <= keepChars;
  });
  return earliest ?? points[points.length - 1];
}

function transcript(messages: ChatMessage[]): string {
  const lines = messages.map((message) => {
    let content = message.content ?? "";
    if (message.role === "tool" && content.length > TRANSCRIPT_TOOL_MAX) {
      content = `${content.slice(0, TRANSCRIPT_TOOL_MAX / 2)}\n…\n${content.slice(-TRANSCRIPT_TOOL_MAX / 2)}`;
    }
    const calls = message.tool_calls?.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 300)})`).join(", ");
    const label = message.role === "tool" ? "Tool result" : message.role === "assistant" ? "CoderBaba" : "User";
    return `${label}: ${content}${calls ? `\n[called ${calls}]` : ""}`;
  });
  const text = lines.join("\n\n");
  return text.length > TRANSCRIPT_MAX ? `…\n${text.slice(-TRANSCRIPT_MAX)}` : text;
}

export type CompactOptions = {
  llm: Llm;
  taskId: string;
  model: string;
  /** Summarize even when the chat fits, keeping only the latest exchange. */
  force?: boolean;
  /** The request being worked on; restated when its message ends up in the summarized part. */
  task?: string;
  budget?: Budget;
};

export type CompactResult = { messages: ChatMessage[]; before: number; after: number; summarized: boolean };

/** Replace the older part of the chat with a model-written summary. Returns null when there is nothing to do. */
export async function compact(messages: ChatMessage[], opts: CompactOptions): Promise<CompactResult | null> {
  const budget = opts.budget ?? CONTEXT_BUDGET;
  const before = contextSize(messages);
  if (!opts.force && fits(messages, budget)) return null;
  const cut = chooseCut(messages, budget, Boolean(opts.force));
  if (cut === undefined || cut <= 0) return null;
  const old = messages.slice(0, cut);
  const kept = messages.slice(cut);

  let summary = "";
  try {
    const result = await opts.llm.chat({
      taskId: opts.taskId,
      model: opts.model,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript(old) },
      ],
      tools: [],
    });
    summary = result.content.trim();
  } catch {
    summary = "";
  }

  const taskKept = opts.task !== undefined && kept.some((message) => message.role === "user" && message.content === opts.task);
  const restated = opts.task !== undefined && !taskKept ? `\n\nThe user's current request: ${opts.task}` : "";
  const head: ChatMessage = summary
    ? { role: "user", content: `${SUMMARY_PREFIX}\n${summary}${restated}` }
    : { role: "user", content: `${DROPPED_NOTE}${restated}` };
  let next = [head, ...kept];
  if (!fits(next, budget)) next = shortenOldOutputs(next, 1);
  return { messages: next, before, after: contextSize(next), summarized: Boolean(summary) };
}

/** Run before every model step: shorten old outputs for free, then summarize only if still over budget. */
export async function fitContext(
  messages: ChatMessage[],
  opts: Omit<CompactOptions, "force">,
): Promise<{ messages: ChatMessage[]; compacted?: CompactResult }> {
  const budget = opts.budget ?? CONTEXT_BUDGET;
  const shortened = shortenOldOutputs(messages);
  if (fits(shortened, budget)) return { messages: shortened };
  const compacted = await compact(shortened, opts);
  if (!compacted) return { messages: shortenOldOutputs(shortened, 1) };
  return { messages: compacted.messages, compacted: { ...compacted, before: contextSize(messages) } };
}
