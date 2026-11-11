import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager, portOpen } from "./processes.js";

const managers: ProcessManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
});

function manager(): ProcessManager {
  const created = new ProcessManager();
  managers.push(created);
  return created;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function script(name: string, body: string): Promise<{ dir: string; command: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-proc-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, body);
  return { dir, command: `node "${file}"` };
}

const server = (port: number | "0", log: string) => `
const http = require("node:http");
const s = http.createServer((req, res) => res.end("ok"));
s.listen(${port}, () => { const port = s.address().port; ${log} });
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ProcessManager", () => {
  it("detects a printed localhost URL", async () => {
    const { dir, command } = await script("url.cjs", server("0", 'console.log("ready at http://localhost:" + port);'));
    const result = await manager().start({ command, cwd: dir, name: "web" });
    expect(result.ready).toBe(true);
    expect(result.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(result.port).toBe(Number(result.url!.split(":").pop()));
  });

  it("waits for a port when the server prints nothing", async () => {
    const port = await freePort();
    const { dir, command } = await script("silent.cjs", server(port, ""));
    const result = await manager().start({ command, cwd: dir, name: "api", waitFor: { port } });
    expect(result).toMatchObject({ ready: true, port });
  });

  it("detects a 'listening on' phrase and confirms the port", async () => {
    const port = await freePort();
    const { dir, command } = await script("phrase.cjs", server(port, 'console.log("Server listening on " + port);'));
    const result = await manager().start({ command, cwd: dir, name: "server" });
    expect(result).toMatchObject({ ready: true, port });
  });

  it("reports a crash with its output", async () => {
    const { dir, command } = await script("crash.cjs", 'console.log("boom"); process.exit(3);');
    const result = await manager().start({ command, cwd: dir, name: "bad" });
    expect(result.ready).toBe(false);
    expect(result.exited).toEqual({ code: 3 });
    expect(result.output).toContain("boom");
  });

  it("explains when the port is already in use", async () => {
    const port = await freePort();
    const pm = manager();
    const first = await script("first.cjs", server(port, ""));
    expect((await pm.start({ command: first.command, cwd: first.dir, name: "one", waitFor: { port } })).ready).toBe(true);
    const second = await script("second.cjs", server(port, ""));
    const result = await pm.start({ command: second.command, cwd: second.dir, name: "two" });
    expect(result.portInUse).toBe(port);
    expect(result.ready).toBe(false);
  });

  it("recognizes Django's port-in-use message", async () => {
    const { dir, command } = await script("django.cjs", 'console.error("Error: That port is already in use."); process.exit(1);');
    const result = await manager().start({ command, cwd: dir, name: "server", waitFor: { port: 8000 }, waitMs: 3_000 });
    expect(result.portInUse).toBe(8000);
  });

  it("restarts with a new pid, and stop and stopAll leave nothing running", async () => {
    const port = await freePort();
    const pm = manager();
    const { dir, command } = await script("restart.cjs", server(port, 'console.log("listening on " + port);'));
    await pm.start({ command, cwd: dir, name: "api" });
    const firstPid = pm.logs("api")!.info.pid!;
    const restarted = await pm.restart("api");
    expect(restarted?.ready).toBe(true);
    const secondPid = pm.logs("api")!.info.pid!;
    expect(secondPid).not.toBe(firstPid);
    expect(alive(firstPid)).toBe(false);

    await pm.stop("api");
    expect(pm.logs("api")!.info.status).toBe("stopped");
    expect(await portOpen(port)).toBe(false);

    const other = await freePort();
    const extra = await script("extra.cjs", server(other, ""));
    await pm.start({ command: extra.command, cwd: extra.dir, name: "extra", waitFor: { port: other } });
    await pm.stopAll();
    expect(pm.running()).toEqual([]);
    expect(await portOpen(other)).toBe(false);
  });

  it("rejects a duplicate name while the first is running", async () => {
    const pm = manager();
    const { dir, command } = await script("idle.cjs", 'console.log("http://localhost:1"); setInterval(() => {}, 1000);');
    await pm.start({ command, cwd: dir, name: "web" });
    const again = await pm.start({ command, cwd: dir, name: "web" });
    expect(again.error).toMatch(/already running/);
  });

  it("stops a reloader parent and the server child it restarts", async () => {
    const port = await freePort();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-proc-"));
    await fs.writeFile(path.join(dir, "child.cjs"), server(port, ""));
    await fs.writeFile(
      path.join(dir, "reloader.cjs"),
      `
const { spawn } = require("node:child_process");
const path = require("node:path");
function run() {
  const child = spawn(process.execPath, [path.join(__dirname, "child.cjs")], { stdio: "inherit" });
  child.on("exit", () => setTimeout(run, 100));
}
run();
setInterval(() => {}, 1000);
`,
    );
    const pm = manager();
    const result = await pm.start({ command: `node "${path.join(dir, "reloader.cjs")}"`, cwd: dir, name: "server", waitFor: { port } });
    expect(result.ready).toBe(true);
    await pm.stop("server");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await portOpen(port)).toBe(false);
  });

  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!hasPython || process.platform === "win32")("reads Python output right away (PYTHONUNBUFFERED)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-proc-"));
    const started = Date.now();
    const result = await manager().start({
      command: `python3 -c "import time; print('http://127.0.0.1:9'); time.sleep(5)"`,
      cwd: dir,
      name: "py",
    });
    expect(result.ready).toBe(true);
    expect(result.url).toBe("http://127.0.0.1:9");
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
