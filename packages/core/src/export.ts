import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ToolCall } from "@coderbabasi/shared";
import { SUMMARY_PREFIX } from "./context.js";
import { redact } from "./output.js";

function callLine(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  const pick = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const cwd = pick("cwd") ? ` (in ${pick("cwd")}/)` : "";
  switch (call.function.name) {
    case "shell":
      return `Ran \`${pick("command")}\`${cwd}`;
    case "start_process":
      return `Started ${pick("name")}: \`${pick("command")}\`${cwd}`;
    case "edit_file":
      return `Edited ${pick("path")}`;
    case "read_file":
      return `Read ${pick("path")}`;
    case "list_dir":
      return `Listed ${pick("path") || "."}`;
    case "grep":
      return `Searched for \`${pick("pattern")}\``;
    case "read_url":
    case "check_page":
      return `${call.function.name === "read_url" ? "Read" : "Checked page"} ${pick("url")}`;
    case "ask_secret":
      return `Asked for ${pick("name")}`;
    case "stop_process":
    case "restart_process":
    case "read_process_output":
      return `${call.function.name.replace(/_/g, " ")} ${pick("name")}`;
    default:
      return call.function.name.replace(/_/g, " ");
  }
}

/** The chat as Markdown: user and assistant messages in full, tool calls as one line each, tool output left out. */
export function chatMarkdown(messages: ChatMessage[], opts: { title?: string; secrets?: Iterable<string>; now?: Date } = {}): string {
  const parts = [`# ${opts.title || "CoderBaba chat"}`, `_Exported ${(opts.now ?? new Date()).toISOString().slice(0, 16).replace("T", " ")} UTC_`];
  for (const message of messages) {
    const content = (message.content ?? "").trim();
    if (message.role === "user") {
      if (content.startsWith(SUMMARY_PREFIX)) parts.push(`## Earlier in this chat (summary)\n\n${content.slice(SUMMARY_PREFIX.length).trim()}`);
      else if (content) parts.push(`## You\n\n${content}`);
    } else if (message.role === "assistant") {
      const lines: string[] = [];
      if (content) lines.push(content);
      if (message.tool_calls?.length) lines.push(message.tool_calls.map((call) => `- ${callLine(call)}`).join("\n"));
      if (lines.length) parts.push(`## CoderBaba\n\n${lines.join("\n\n")}`);
    }
  }
  return redact(`${parts.join("\n\n")}\n`, new Set(opts.secrets ?? []));
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Write the chat to coderbaba-chat-YYYY-MM-DD-HHMM.md in dir without overwriting anything. Returns the path. */
export async function exportChat(dir: string, markdown: string, now = new Date()): Promise<string> {
  const base = `coderbaba-chat-${stamp(now)}`;
  for (let attempt = 1; ; attempt++) {
    const file = path.join(dir, `${base}${attempt > 1 ? `-${attempt}` : ""}.md`);
    try {
      await fs.writeFile(file, markdown, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
    }
  }
}
