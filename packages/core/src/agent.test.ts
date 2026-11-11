import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTurn } from "./agent.js";
import { Checkpoints } from "./checkpoints.js";
import { CoderBabaError } from "./errors.js";
import type { Llm, LlmResult } from "./llm.js";
import { consumeSse } from "./sse.js";

function scripted(results: LlmResult[]): Llm {
  return {
    async chat(input) {
      const next = results.shift();
      if (!next) throw new Error("no scripted response");
      if (next.content) input.onText?.(next.content);
      return next;
    },
  };
}

describe("sse", () => {
  it("joins text and tool-call deltas", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"a\"}" } }] }, finish_reason: "tool_calls" }] },
      { usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.001 } },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const parsed = await consumeSse(stream);
    expect(parsed.content).toBe("Hi");
    expect(parsed.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }]);
    expect(parsed.usage?.costUsd).toBe(0.001);
  });
});

describe("sse cut-off", () => {
  function streamOf(frames: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
  }

  it("treats a stream that ends without a finish reason as cut off", async () => {
    const parsed = await consumeSse(streamOf([`data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}\n\n`]));
    expect(parsed.finishReason).toBe("length");
  });

  it("drops a tool call whose arguments were cut mid-way", async () => {
    const partial = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "edit_file", arguments: '{"path":"a' } }] } }] };
    const ending = { choices: [{ delta: {}, finish_reason: "length" }] };
    const parsed = await consumeSse(streamOf([`data: ${JSON.stringify(partial)}\n\n`, `data: ${JSON.stringify(ending)}\n\ndata: [DONE]\n\n`]));
    expect(parsed.finishReason).toBe("length");
    expect(parsed.toolCalls).toEqual([]);
  });
});

describe("runTurn", () => {
  it("edits a file after permission and stops when the model is done", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cb-agent-"));
    await fs.writeFile(path.join(cwd, "app.txt"), "hello\n");
    const events: string[] = [];
    const result = await runTurn({
      task: "change hello",
      cwd,
      model: "fast",
      taskId: "task-1",
      messages: [],
      llm: scripted([
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "1", name: "edit_file", arguments: JSON.stringify({ path: "app.txt", old_string: "hello", new_string: "hello there" }) }],
        },
        { content: "Done.", finishReason: "stop", toolCalls: [] },
      ]),
      askPermission: async () => "allow",
      allows: new Set(),
      checkpoints: new Checkpoints(path.join(cwd, ".checkpoints")),
      maxSteps: 5,
      onEvent: (event) => events.push(event.type),
    });
    expect(await fs.readFile(path.join(cwd, "app.txt"), "utf8")).toBe("hello there\n");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "Done." });
    expect(events).toContain("tool");
    expect(events).toContain("done");
  });

  it("asks again when a response is cut off", async () => {
    let calls = 0;
    const llm: Llm = {
      async chat() {
        calls += 1;
        return calls === 1
          ? { content: "partial", finishReason: "length", toolCalls: [] }
          : { content: " finished", finishReason: "stop", toolCalls: [] };
      },
    };
    const result = await runTurn({
      task: "write",
      cwd: os.tmpdir(),
      model: "fast",
      taskId: "task-2",
      messages: [],
      llm,
      askPermission: async () => "deny",
      allows: new Set(),
      checkpoints: new Checkpoints(path.join(os.tmpdir(), "cb-empty-checkpoints")),
      maxSteps: 4,
      onEvent: () => undefined,
    });
    expect(calls).toBe(2);
    expect(result.messages.some((message) => message.content === "Continue from where you left off.")).toBe(true);
  });

  it("offers extra tools only when given and dispatches them before the built-in tools", async () => {
    const seen: string[][] = [];
    const ran: unknown[] = [];
    const responses: LlmResult[] = [
      { content: "", finishReason: "tool_calls", toolCalls: [{ id: "1", name: "note_it", arguments: JSON.stringify({ text: "hi" }) }] },
      { content: "Done.", finishReason: "stop", toolCalls: [] },
    ];
    const llm: Llm = {
      async chat(input) {
        seen.push((input.tools as { function: { name: string } }[]).map((tool) => tool.function.name));
        return responses.shift()!;
      },
    };
    const events: string[] = [];
    const result = await runTurn({
      task: "note",
      cwd: os.tmpdir(),
      model: "fast",
      taskId: "task-extra",
      messages: [],
      llm,
      askPermission: async () => "deny",
      allows: new Set(),
      checkpoints: new Checkpoints(path.join(os.tmpdir(), "cb-extra-checkpoints")),
      maxSteps: 3,
      onEvent: (event) => {
        if (event.type === "tool") events.push(event.event.name);
      },
      redact: new Set(["secret-value"]),
      extraTools: {
        definitions: [{ type: "function", function: { name: "note_it", description: "Note something.", parameters: { type: "object" } } }],
        async run(name, args) {
          ran.push(args);
          return { content: "Noted secret-value.", event: { name } };
        },
      },
    });
    expect(seen[0]).toContain("note_it");
    expect(seen[0]).toContain("read_file");
    expect(ran).toEqual([{ text: "hi" }]);
    expect(events).toEqual(["note_it"]);
    expect(result.messages.find((message) => message.role === "tool")?.content).toBe("Noted ••••.");
  });

  it("returns the trial error without keeping the prompt", async () => {
    const result = await runTurn({
      task: "sixth try",
      cwd: os.tmpdir(),
      model: "fast",
      taskId: "task-3",
      messages: [],
      llm: { async chat() { throw new CoderBabaError("TRIAL_EXHAUSTED", "You've used your 5 free tries."); } },
      askPermission: async () => "deny",
      allows: new Set(),
      checkpoints: new Checkpoints(path.join(os.tmpdir(), "cb-empty-checkpoints-2")),
      maxSteps: 2,
      onEvent: () => undefined,
    });
    expect(result.stopCode).toBe("TRIAL_EXHAUSTED");
    expect(result.messages).toEqual([]);
  });
});
