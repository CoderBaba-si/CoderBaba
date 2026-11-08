import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { applyExactEdit } from "./edit.js";
import type { Checkpoints } from "./checkpoints.js";
import { permissionKey, type PermissionDecision, type PermissionRequest } from "./permissions.js";
import { resolveInProject } from "./paths.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);
const MAX_READ = 100_000;
const MAX_MATCHES = 40;

export type ToolEvent = {
  name: string;
  path?: string;
  command?: string;
  pattern?: string;
  added?: number;
  removed?: number;
  diffLines?: { kind: "add" | "del" | "ctx"; text: string }[];
  denied?: boolean;
};

export async function runTool(opts: {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  turnId: string;
  checkpoints: Checkpoints;
  allows: Set<string>;
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
}): Promise<{ content: string; event: ToolEvent }> {
  const name = opts.name;
  try {
    if (name === "read_file") return await readFile(opts);
    if (name === "list_dir") return await listDir(opts);
    if (name === "grep") return await grep(opts);
    if (name === "edit_file") return await editFile(opts);
    if (name === "shell") return await shell(opts);
    return { content: `Unknown tool ${name}`, event: { name, denied: true } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool failed";
    return { content: message, event: { name } };
  }
}

async function permit(
  opts: { allows: Set<string>; askPermission: (request: PermissionRequest) => Promise<PermissionDecision> },
  request: PermissionRequest,
): Promise<boolean> {
  const key = permissionKey(request);
  if (opts.allows.has(key)) return true;
  const decision = await opts.askPermission(request);
  if (decision === "always") opts.allows.add(key);
  return decision === "allow" || decision === "always";
}

async function readFile(opts: Parameters<typeof runTool>[0]): Promise<{ content: string; event: ToolEvent }> {
  const input = String(opts.args.path ?? "");
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to read a file outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "read_file", path: input, denied: true } };
  }
  const raw = await fs.readFile(resolved.full, "utf8");
  const content = raw.length > MAX_READ ? `${raw.slice(0, MAX_READ)}\n… truncated` : raw;
  return { content, event: { name: "read_file", path: displayPath(resolved.root, resolved.full) } };
}

async function listDir(opts: Parameters<typeof runTool>[0]): Promise<{ content: string; event: ToolEvent }> {
  const input = String(opts.args.path ?? ".");
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to list a folder outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "list_dir", path: input, denied: true } };
  }
  const entries = await fs.readdir(resolved.full, { withFileTypes: true });
  const lines = entries.slice(0, 200).map((entry) => `${entry.isDirectory() ? "dir" : "file"}  ${entry.name}`);
  return { content: lines.join("\n") || "(empty)", event: { name: "list_dir", path: displayPath(resolved.root, resolved.full) } };
}

async function grep(opts: Parameters<typeof runTool>[0]): Promise<{ content: string; event: ToolEvent }> {
  const pattern = String(opts.args.pattern ?? "");
  const input = String(opts.args.path ?? ".");
  if (!pattern) return { content: "pattern is required", event: { name: "grep", pattern } };
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return { content: "Invalid regular expression", event: { name: "grep", pattern } };
  }
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to search outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "grep", pattern, denied: true } };
  }
  const matches: string[] = [];
  await walk(resolved.full, async (file) => {
    if (matches.length >= MAX_MATCHES) return;
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i]!)) matches.push(`${displayPath(resolved.root, file)}:${i + 1}: ${lines[i]}`);
    }
  });
  return {
    content: matches.join("\n") || "No matches.",
    event: { name: "grep", pattern, path: displayPath(resolved.root, resolved.full) },
  };
}

async function editFile(opts: Parameters<typeof runTool>[0]): Promise<{ content: string; event: ToolEvent }> {
  const input = String(opts.args.path ?? "");
  const oldString = String(opts.args.old_string ?? "");
  const newString = String(opts.args.new_string ?? "");
  const resolved = await resolveInProject(opts.cwd, input);
  if (!resolved.inside) {
    const ok = await permit(opts, {
      kind: "outside",
      path: resolved.full,
      summary: `CoderBaba wants to edit a file outside the project (${resolved.full}). Allow?`,
    });
    if (!ok) return { content: "The user denied access outside the project.", event: { name: "edit_file", path: input, denied: true } };
  }
  const shown = displayPath(resolved.root, resolved.full);
  const ok = await permit(opts, {
    kind: "edit",
    path: resolved.full,
    summary: `CoderBaba wants to edit ${shown}. Allow?`,
  });
  if (!ok) return { content: "The user denied the edit.", event: { name: "edit_file", path: shown, denied: true } };

  let current = "";
  let exists = true;
  try {
    current = await fs.readFile(resolved.full, "utf8");
  } catch {
    exists = false;
  }
  if (!exists && oldString !== "") {
    return { content: "File does not exist. Use an empty old_string to create it.", event: { name: "edit_file", path: shown } };
  }
  const edited = applyExactEdit(exists ? current : "", oldString, newString);
  if (!edited.ok) return { content: edited.error, event: { name: "edit_file", path: shown } };
  await opts.checkpoints.remember(opts.turnId, resolved.full);
  await fs.mkdir(path.dirname(resolved.full), { recursive: true });
  await fs.writeFile(resolved.full, edited.content, "utf8");
  return {
    content: `Updated ${shown}`,
    event: {
      name: "edit_file",
      path: shown,
      added: edited.diff.added,
      removed: edited.diff.removed,
      diffLines: edited.diff.lines,
    },
  };
}

async function shell(opts: Parameters<typeof runTool>[0]): Promise<{ content: string; event: ToolEvent }> {
  const command = String(opts.args.command ?? "").trim();
  if (!command) return { content: "command is required", event: { name: "shell", denied: true } };
  const ok = await permit(opts, {
    kind: "shell",
    command,
    summary: `CoderBaba wants to run ${command}. Allow?`,
  });
  if (!ok) return { content: "The user denied the command.", event: { name: "shell", command, denied: true } };
  const result = await runShell(command, opts.cwd);
  const output = result.output.trim() || `(exit ${result.code})`;
  return { content: output, event: { name: "shell", command } };
}

export function runShell(command: string, cwd: string, timeoutMs = 30_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: process.env });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length > 20_000) return;
      output += chunk.toString("utf8");
      if (output.length > 20_000) output = `${output.slice(0, 20_000)}\n… truncated`;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: error.message });
    });
  });
}

async function walk(dir: string, visit: (file: string) => Promise<void>, depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit, depth + 1);
    else if (entry.isFile()) await visit(full);
  }
}

function displayPath(root: string, full: string): string {
  const rel = path.relative(root, full);
  return rel && !rel.startsWith("..") ? rel : full;
}

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Path is relative to the project.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files in a directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact old_string with new_string. Use an empty old_string to create a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command in the project directory.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];
