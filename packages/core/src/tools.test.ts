import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";
import type { PermissionRequest } from "./permissions.js";
import { ProcessManager } from "./processes.js";
import { buildSystemPrompt } from "./prompt.js";
import { runTool, runUserCommand } from "./tools.js";

async function project() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cb-tools-"));
  return { cwd, checkpoints: new Checkpoints(path.join(cwd, ".cb")) };
}

describe("runTool", () => {
  it("edit_file asks first, writes, and can be undone", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(path.join(cwd, "a.js"), "let x = 1;\n");
    const asked: PermissionRequest[] = [];
    const result = await runTool({
      name: "edit_file",
      args: { path: "a.js", old_string: "1", new_string: "2" },
      cwd,
      turnId: "t1",
      checkpoints,
      allows: new Set(),
      askPermission: async (request) => {
        asked.push(request);
        return "allow";
      },
    });
    expect(asked[0]?.kind).toBe("edit");
    expect(result.event).toMatchObject({ name: "edit_file", path: "a.js", added: 1, removed: 1 });
    expect(await fs.readFile(path.join(cwd, "a.js"), "utf8")).toBe("let x = 2;\n");
    await checkpoints.undoLast();
    expect(await fs.readFile(path.join(cwd, "a.js"), "utf8")).toBe("let x = 1;\n");
  });

  it("blocks reads outside the project unless allowed", async () => {
    const { cwd, checkpoints } = await project();
    const result = await runTool({
      name: "read_file",
      args: { path: "../../etc/hosts" },
      cwd,
      turnId: "t2",
      checkpoints,
      allows: new Set(),
      askPermission: async () => "deny",
    });
    expect(result.event.denied).toBe(true);
    expect(result.content).toContain("denied");
  });

  it("remembers always for shell commands in the session", async () => {
    const { cwd, checkpoints } = await project();
    const allows = new Set<string>();
    let asks = 0;
    const ask = async () => {
      asks += 1;
      return "always" as const;
    };
    for (let i = 0; i < 2; i++) {
      const result = await runTool({ name: "shell", args: { command: "echo hi" }, cwd, turnId: "t3", checkpoints, allows, askPermission: ask });
      expect(result.content).toBe("hi");
    }
    expect(asks).toBe(1);
  });

  it("reports a timeout and stops the command", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(path.join(cwd, "forever.cjs"), "console.log('started'); setInterval(() => {}, 1000);\n");
    const result = await runTool({
      name: "shell",
      args: { command: "node forever.cjs", timeout_seconds: 1 },
      cwd,
      turnId: "t5",
      checkpoints,
      allows: new Set(),
      askPermission: async () => "allow",
    });
    expect(result.content).toContain("Command timed out after 1s and was stopped.");
    expect(result.content).toContain("started");
  });

  it("closes stdin so commands that read it don't hang", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(path.join(cwd, "stdin.cjs"), "process.stdin.on('data', () => {}).on('end', () => console.log('eof'));\n");
    const started = Date.now();
    const result = await runTool({ name: "shell", args: { command: "node stdin.cjs" }, cwd, turnId: "t6", checkpoints, allows: new Set(), askPermission: async () => "allow" });
    expect(result.content).toBe("eof");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("adds the exit code when a command fails", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(path.join(cwd, "fail.cjs"), "console.log('bad'); process.exit(3);\n");
    const result = await runTool({ name: "shell", args: { command: "node fail.cjs" }, cwd, turnId: "t7", checkpoints, allows: new Set(), askPermission: async () => "allow" });
    expect(result.content).toBe("bad\n(exit 3)");
  });

  it("runs in a subfolder and says what kind of app it is", async () => {
    const { cwd, checkpoints } = await project();
    await fs.mkdir(path.join(cwd, "app"));
    await fs.writeFile(path.join(cwd, "app", "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
    await fs.mkdir(path.join(cwd, "server"));
    await fs.writeFile(path.join(cwd, "server", "package.json"), JSON.stringify({ dependencies: { express: "5" } }));
    const asked: PermissionRequest[] = [];
    const ask = async (request: PermissionRequest) => {
      asked.push(request);
      return "allow" as const;
    };
    const app = await runTool({ name: "shell", args: { command: "node -v", cwd: "app" }, cwd, turnId: "t8", checkpoints, allows: new Set(), askPermission: ask });
    expect(app.content.split("\n")[0]).toBe("(ran in app/, a Next.js app)");
    expect(app.event).toMatchObject({ name: "shell", cwd: "app" });
    const server = await runTool({ name: "shell", args: { command: "node -v", cwd: "server" }, cwd, turnId: "t8", checkpoints, allows: new Set(), askPermission: ask });
    expect(server.content.split("\n")[0]).toBe("(ran in server/, an Express app)");
    expect(asked).toEqual([]);
    const missing = await runTool({ name: "shell", args: { command: "node -v", cwd: "nope" }, cwd, turnId: "t8", checkpoints, allows: new Set(), askPermission: ask });
    expect(missing.content).toBe("Folder nope does not exist.");
  });

  it("runs a safe command without asking", async () => {
    const { cwd, checkpoints } = await project();
    const result = await runTool({
      name: "shell",
      args: { command: "node -v" },
      cwd,
      turnId: "t9",
      checkpoints,
      allows: new Set(),
      askPermission: async () => {
        throw new Error("should not ask");
      },
    });
    expect(result.content).toMatch(/^v\d+/);
  });

  it("always asks before editing .coderbaba/ files, even after always", async () => {
    const { cwd, checkpoints } = await project();
    const allows = new Set<string>(["edit:project"]);
    let asks = 0;
    const ask = async () => {
      asks += 1;
      return "always" as const;
    };
    for (const text of ['{"allow":[]}', '{"allow":["make test"]}']) {
      await runTool({
        name: "edit_file",
        args: { path: ".coderbaba/allow.json", old_string: "", new_string: text },
        cwd,
        turnId: "t10",
        checkpoints,
        allows,
        askPermission: ask,
      });
      await fs.rm(path.join(cwd, ".coderbaba", "allow.json"));
    }
    expect(asks).toBe(2);
    await runTool({ name: "edit_file", args: { path: "a.txt", old_string: "", new_string: "x" }, cwd, turnId: "t10", checkpoints, allows, askPermission: ask });
    expect(asks).toBe(2);
  });

  it("grep skips virtual environments", async () => {
    const { cwd, checkpoints } = await project();
    await fs.mkdir(path.join(cwd, ".venv", "lib"), { recursive: true });
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, ".venv", "lib", "x.py"), "needle\n");
    await fs.writeFile(path.join(cwd, "src", "a.py"), "needle\n");
    const result = await runTool({ name: "grep", args: { pattern: "needle" }, cwd, turnId: "t11", checkpoints, allows: new Set(), askPermission: async () => "allow" });
    expect(result.content).toBe("src/a.py:1: needle");
  });

  it("sends the last output line as progress", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(path.join(cwd, "ab.cjs"), "console.log('a'); setTimeout(() => console.log('b'), 300);\n");
    const progress: string[] = [];
    await runTool({
      name: "shell",
      args: { command: "node ab.cjs" },
      cwd,
      turnId: "t12",
      checkpoints,
      allows: new Set(),
      askPermission: async () => "allow",
      onProgress: (line) => progress.push(line),
    });
    expect(progress).toContain("a");
    expect(progress.at(-1)).toBe("b");
  });

  it("starts, reads, and stops a background process", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(
      path.join(cwd, "server.cjs"),
      "const s = require('node:http').createServer((q, r) => r.end('ok')); s.listen(0, () => console.log('http://localhost:' + s.address().port));\n",
    );
    const processes = new ProcessManager();
    const common = { cwd, turnId: "t13", checkpoints, allows: new Set<string>(), askPermission: async () => "allow" as const, processes };
    try {
      const started = await runTool({ ...common, name: "start_process", args: { command: "node server.cjs", name: "web" } });
      expect(started.content).toMatch(/^Started web \(p1\)\. Ready at http:\/\/localhost:\d+\./);
      expect(started.event).toMatchObject({ name: "start_process", processName: "web", ready: true });
      const logs = await runTool({ ...common, name: "read_process_output", args: { name: "web" } });
      expect(logs.content).toMatch(/^web \(p1\) is running at http:\/\/localhost:\d+\./);
      const stopped = await runTool({ ...common, name: "stop_process", args: { name: "web" } });
      expect(stopped.content).toBe("Stopped web.");
      const missing = await runTool({ ...common, name: "stop_process", args: { name: "db" } });
      expect(missing.content).toBe("No process named db. Nothing is running.");
    } finally {
      await processes.stopAll();
    }
  });

  it("write_todos replaces the list and keeps only valid items", async () => {
    const { cwd, checkpoints } = await project();
    const todos = { items: [{ text: "old", status: "done" as const }] };
    const result = await runTool({
      name: "write_todos",
      args: {
        todos: [
          { text: "Scaffold the client", status: "done" },
          { text: "Build the API", status: "in_progress" },
          { text: "  ", status: "pending" },
          { text: "Connect MongoDB", status: "someday" },
        ],
      },
      cwd,
      turnId: "t5",
      checkpoints,
      allows: new Set(),
      askPermission: async () => "deny",
      todos,
    });
    expect(todos.items).toEqual([
      { text: "Scaffold the client", status: "done" },
      { text: "Build the API", status: "in_progress" },
      { text: "Connect MongoDB", status: "pending" },
    ]);
    expect(result.content).toBe("Todos updated:\n[x] Scaffold the client\n[>] Build the API\n[ ] Connect MongoDB");
    expect(result.event).toMatchObject({ name: "write_todos", note: "1 of 3 done" });
    expect(buildSystemPrompt({ root: cwd, todos: todos.items })).toContain("[>] Build the API");
  });

  it("runUserCommand runs in the project with the venv on PATH", async () => {
    const { cwd } = await project();
    await fs.writeFile(path.join(cwd, "hello.cjs"), "console.log('hi from ' + require('path').basename(process.cwd()))\n");
    await fs.mkdir(path.join(cwd, ".venv"));
    await fs.writeFile(path.join(cwd, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
    await fs.writeFile(path.join(cwd, "env.cjs"), "console.log(process.env.VIRTUAL_ENV ? 'venv on' : 'venv off')\n");
    const lines: string[] = [];
    const result = await runUserCommand('node "hello.cjs"', { cwd, onOutput: (chunk) => lines.push(chunk) });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.output.trim()).toBe(`hi from ${path.basename(cwd)}`);
    expect(lines.join("")).toContain("hi from");
    expect((await runUserCommand('node "env.cjs"', { cwd })).output.trim()).toBe("venv on");
  });

  it("does not write when the edit is denied", async () => {
    const { cwd, checkpoints } = await project();
    await fs.writeFile(path.join(cwd, "b.txt"), "keep\n");
    await runTool({
      name: "edit_file",
      args: { path: "b.txt", old_string: "keep", new_string: "gone" },
      cwd,
      turnId: "t4",
      checkpoints,
      allows: new Set(),
      askPermission: async () => "deny",
    });
    expect(await fs.readFile(path.join(cwd, "b.txt"), "utf8")).toBe("keep\n");
  });
});
