import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@coderbabasi/shared";
import { SUMMARY_PREFIX, compact, contextSize, cutPoints, fitContext, shortenOldOutputs } from "./context.js";
import type { Llm } from "./llm.js";

function toolGroup(id: string, output: string): ChatMessage[] {
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: output },
  ];
}

function summarizer(reply: string, seen: { taskId?: string; tools?: unknown[]; prompt?: string }[] = []): Llm {
  return {
    async chat(input) {
      seen.push({ taskId: input.taskId, tools: input.tools, prompt: input.messages.at(-1)?.content ?? "" });
      return { content: reply, finishReason: "stop", toolCalls: [] };
    },
  };
}

const failing: Llm = {
  async chat() {
    throw new Error("offline");
  },
};

describe("shortenOldOutputs", () => {
  it("cuts long tool results except the most recent ones", () => {
    const long = `start${"x".repeat(5000)}end`;
    const messages = Array.from({ length: 8 }, (_, i) => toolGroup(`c${i}`, long)).flat();
    const shortened = shortenOldOutputs(messages);
    const tools = shortened.filter((message) => message.role === "tool");
    expect(tools.slice(0, 2).every((message) => message.content!.includes("(older output shortened)"))).toBe(true);
    expect(tools[0]!.content!.startsWith("start")).toBe(true);
    expect(tools[0]!.content!.endsWith("end")).toBe(true);
    expect(tools.slice(2).every((message) => message.content === long)).toBe(true);
    expect(shortenOldOutputs(shortened)).toEqual(shortened);
  });

  it("leaves short results alone", () => {
    const messages = Array.from({ length: 10 }, (_, i) => toolGroup(`c${i}`, "ok")).flat();
    expect(shortenOldOutputs(messages)).toEqual(messages);
  });
});

describe("cutPoints", () => {
  it("never splits an assistant's tool calls from their results", () => {
    const multi: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "shell", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "shell", arguments: "{}" } },
      ],
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "task" },
      multi,
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "2" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ];
    expect(cutPoints(messages)).toEqual([1, 4, 5]);
  });
});

describe("compact", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "build a todo app" },
    ...toolGroup("c1", "x".repeat(3000)),
    { role: "assistant", content: "Built it." },
    { role: "user", content: "add dark mode" },
    ...toolGroup("c2", "ok"),
    { role: "assistant", content: "Added." },
  ];

  it("summarizes the older part with the same task id and no tools", async () => {
    const seen: { taskId?: string; tools?: unknown[]; prompt?: string }[] = [];
    const result = await compact(history, { llm: summarizer("Goal: todo app", seen), taskId: "t1", model: "fast", force: true });
    expect(result?.summarized).toBe(true);
    expect(result!.messages[0]).toEqual({ role: "user", content: `${SUMMARY_PREFIX}\nGoal: todo app` });
    expect(result!.messages.slice(1)).toEqual(history.slice(4));
    expect(seen[0]).toMatchObject({ taskId: "t1", tools: [] });
    expect(seen[0]!.prompt).toContain("build a todo app");
    expect(result!.after).toBeLessThan(result!.before);
  });

  it("does nothing when the chat fits and is not forced", async () => {
    expect(await compact(history, { llm: summarizer("x"), taskId: "t", model: "fast" })).toBeNull();
  });

  it("drops the older part with a note when the summary fails", async () => {
    const result = await compact(history, { llm: failing, taskId: "t", model: "fast", force: true });
    expect(result?.summarized).toBe(false);
    expect(result!.messages[0]!.content).toContain("Earlier messages were removed");
  });

  it("restates the current request when its message was summarized", async () => {
    const turn: ChatMessage[] = [{ role: "user", content: "make an mvp" }];
    for (let i = 0; i < 30; i++) turn.push(...toolGroup(`c${i}`, "y".repeat(1000)));
    const result = await compact(turn, {
      llm: summarizer("Progress so far"),
      taskId: "t",
      model: "fast",
      task: "make an mvp",
      budget: { chars: 10_000, messages: 400 },
    });
    expect(result!.messages[0]!.content).toContain("The user's current request: make an mvp");
    expect(result!.messages[1]!.role).toBe("assistant");
    expect(contextSize(result!.messages)).toBeLessThanOrEqual(10_000);
  });
});

describe("fitContext", () => {
  it("only shortens when that is enough", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => toolGroup(`c${i}`, "z".repeat(4000))).flat();
    const fitted = await fitContext(messages, { llm: failing, taskId: "t", model: "fast", budget: { chars: 40_000, messages: 400 } });
    expect(fitted.compacted).toBeUndefined();
    expect(contextSize(fitted.messages)).toBeLessThan(contextSize(messages));
  });

  it("summarizes when shortening is not enough", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 40; i++) messages.push(...toolGroup(`c${i}`, "w".repeat(1400)), { role: "assistant", content: "step" });
    const fitted = await fitContext(messages, { llm: summarizer("short"), taskId: "t", model: "fast", budget: { chars: 20_000, messages: 400 } });
    expect(fitted.compacted?.summarized).toBe(true);
    expect(contextSize(fitted.messages)).toBeLessThanOrEqual(20_000);
  });
});
