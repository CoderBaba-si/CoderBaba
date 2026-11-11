import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Checkpoints } from "../checkpoints.js";
import type { Llm, LlmResult } from "../llm.js";
import { runSecurityFix, runSecurityScan, runSecurityValidate, type SecurityTurnBase } from "./scan.js";
import { SecurityStore } from "./store.js";

let root = "";

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cb-scan-")));
  await fs.mkdir(path.join(root, "client"));
  await fs.mkdir(path.join(root, "server"));
  await fs.writeFile(path.join(root, "client", "package.json"), "{}");
  await fs.writeFile(path.join(root, "server", "package.json"), "{}");
});

type Call = { task: string; messageCount: number; tools: string[] };

function call(name: string, args: Record<string, unknown>, id = name): LlmResult {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}
const done = (text = "Done."): LlmResult => ({ content: text, finishReason: "stop", toolCalls: [] });

/** Replays responses and records the task and history size each turn started with. */
function scripted(results: LlmResult[], calls: Call[]): Llm {
  return {
    async chat(input) {
      const users = input.messages.filter((message) => message.role === "user");
      if (users.length === 1 && input.messages.at(-1)?.role === "user") {
        calls.push({
          task: String(users[0]!.content),
          messageCount: input.messages.length,
          tools: (input.tools as { function: { name: string } }[]).map((tool) => tool.function.name),
        });
      }
      const next = results.shift();
      if (!next) throw new Error("no scripted response");
      return next;
    },
  };
}

function base(llm: Llm): SecurityTurnBase {
  return {
    cwd: root,
    model: "fast",
    llm,
    askPermission: async () => "deny",
    allows: new Set(),
    checkpoints: new Checkpoints(path.join(root, ".checkpoints")),
    maxSteps: 6,
    onEvent: () => undefined,
  };
}

const finding = (title: string, folder: string, line: number) => ({
  title,
  severity: "high",
  category: "auth",
  folder,
  file: `${folder}/index.js`,
  line,
  risk: "Anyone can change data.",
  fix: "Add an auth check.",
});

describe("runSecurityScan", () => {
  it("runs threat model, one investigation per folder, then aggregation, each with a fresh history", async () => {
    const calls: Call[] = [];
    const phases: string[] = [];
    const llm = scripted(
      [
        call("save_threat_model", { text: "## Apps\nclient, server" }),
        done(),
        call("record_finding", finding("Client stores token in localStorage", "client", 3)),
        done(),
        call("record_finding", finding("Notes API has no auth check", "server", 12)),
        done(),
        call("update_finding", { id: "S2", priority: 1 }),
        done("S2 first."),
      ],
      calls,
    );
    const result = await runSecurityScan(base(llm), { onPhase: (phase) => phases.push(`${phase.index}/${phase.total} ${phase.label}`) });

    expect(phases).toEqual([
      "1/4 building a threat model",
      "2/4 investigating client/",
      "3/4 investigating server/",
      "4/4 removing duplicates and ranking findings",
    ]);
    expect(calls.map((item) => item.task.split("\n")[0])).toEqual([
      "Security scan, step 1 of 3: build a threat model of this project.",
      "Security scan, step 2 of 3 (folder 1 of 2): review the client/ folder for security issues.",
      "Security scan, step 2 of 3 (folder 2 of 2): review the server/ folder for security issues.",
      "Security scan, step 3 of 3: review all findings together.",
    ]);
    expect(calls.every((item) => item.messageCount === 2)).toBe(true);
    expect(calls[0]!.tools).toContain("record_finding");
    expect(calls[1]!.task).toContain("## Apps\nclient, server");

    const store = await SecurityStore.open(root);
    expect(store.get("S2")).toMatchObject({ priority: 1 });
    expect(result.summary).toMatch(/^2 open security findings \(2 high, 0 medium, 0 low\)/);
    expect(result.summary.split("\n")[1]).toContain("S2 high: Notes API has no auth check");
  });

  it("stops at the first failed request and keeps what was found", async () => {
    const llm: Llm = {
      async chat() {
        const { CoderBabaError } = await import("../errors.js");
        throw new CoderBabaError("RATE_LIMITED", "Slow down.");
      },
    };
    const result = await runSecurityScan(base(llm));
    expect(result.stopCode).toBe("RATE_LIMITED");
    expect(result.summary).toContain("stopped early");
  });
});

describe("validate and fix", () => {
  it("skips the model when there is nothing to do", async () => {
    const llm: Llm = { chat: async () => { throw new Error("should not be called"); } };
    expect(await runSecurityValidate(base(llm))).toMatchObject({ ranModel: false, summary: expect.stringContaining("No findings yet") });
    expect(await runSecurityFix(base(llm), "S1")).toMatchObject({ ranModel: false, summary: expect.stringContaining("There is no finding S1") });
  });

  it("validates open findings and marks a fix", async () => {
    const store = await SecurityStore.open(root);
    await store.record({ ...finding("Notes API has no auth check", "server", 12), severity: "high" });
    const calls: Call[] = [];
    const llm = scripted(
      [
        call("update_finding", { id: "S1", status: "confirmed", evidence: "curl -X DELETE localhost:5000/api/notes/1 -> 200" }),
        done(),
        call("update_finding", { id: "S1", status: "fixed", evidence: "Added requireAuth; same curl now returns 401." }),
        done(),
      ],
      calls,
    );
    const validated = await runSecurityValidate(base(llm));
    expect(validated.summary).toContain("S1: confirmed");
    expect(calls[0]!.task).toContain("http://localhost or 127.0.0.1 only");

    const fixed = await runSecurityFix(base(llm), "s1");
    expect(fixed.summary).toBe("S1 is fixed. Type /undo to revert the change. Report: SECURITY_REPORT.md");
    expect(calls[1]!.task).toContain("curl -X DELETE localhost:5000/api/notes/1 -> 200");
  });
});
