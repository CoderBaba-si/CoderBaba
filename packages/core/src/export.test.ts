import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@coderbabasi/shared";
import { SUMMARY_PREFIX } from "./context.js";
import { chatMarkdown, exportChat } from "./export.js";

const messages: ChatMessage[] = [
  { role: "user", content: `${SUMMARY_PREFIX}\nGoal: a notes app.` },
  { role: "user", content: "Connect it to Atlas" },
  {
    role: "assistant",
    content: "I'll ask for the connection string.",
    tool_calls: [
      { id: "1", type: "function", function: { name: "ask_secret", arguments: '{"name":"MONGODB_URI","hint":"Atlas"}' } },
      { id: "2", type: "function", function: { name: "shell", arguments: '{"command":"npm install mongoose","cwd":"server"}' } },
      { id: "3", type: "function", function: { name: "edit_file", arguments: '{"path":"server/src/db.js"}' } },
    ],
  },
  { role: "tool", tool_call_id: "1", content: "Saved MONGODB_URI to server/.env." },
  { role: "tool", tool_call_id: "2", content: "added 20 packages, using mongodb+srv://user:hunter2pass@cluster" },
  { role: "assistant", content: "Connected. The URI is mongodb+srv://user:hunter2pass@cluster." },
];

describe("chatMarkdown", () => {
  it("shows messages, one line per tool call, no tool output, and redacts secrets", () => {
    const markdown = chatMarkdown(messages, { title: "Notes app", secrets: ["hunter2pass"], now: new Date("2026-11-11T10:30:00Z") });
    expect(markdown).toContain("# Notes app");
    expect(markdown).toContain("_Exported 2026-11-11 10:30 UTC_");
    expect(markdown).toContain("## Earlier in this chat (summary)\n\nGoal: a notes app.");
    expect(markdown).toContain("## You\n\nConnect it to Atlas");
    expect(markdown).toContain("- Asked for MONGODB_URI\n- Ran `npm install mongoose` (in server/)\n- Edited server/src/db.js");
    expect(markdown).not.toContain("added 20 packages");
    expect(markdown).not.toContain("hunter2pass");
    expect(markdown).toContain("mongodb+srv://user:••••@cluster");
  });
});

describe("exportChat", () => {
  it("never overwrites an existing export", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-export-"));
    const now = new Date(2026, 10, 11, 9, 5);
    const first = await exportChat(dir, "one", now);
    const second = await exportChat(dir, "two", now);
    expect(path.basename(first)).toBe("coderbaba-chat-2026-11-11-0905.md");
    expect(path.basename(second)).toBe("coderbaba-chat-2026-11-11-0905-2.md");
    expect(await fs.readFile(first, "utf8")).toBe("one");
  });
});
