import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { killTree, osLine, shellInvocation, shellSpawn } from "./platform.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("platform", () => {
  it("uses cmd.exe on Windows and sh elsewhere", () => {
    const win = shellInvocation("echo hi", "win32");
    expect(win.file.toLowerCase()).toContain("cmd");
    expect(win.args).toEqual(["/d", "/s", "/c", '"echo hi"']);
    expect(win.detached).toBe(false);
    expect(shellInvocation("echo hi", "linux")).toMatchObject({ file: "/bin/sh", args: ["-c", "echo hi"], detached: true });
  });

  it("names the OS for the system prompt", () => {
    expect(osLine("win32")).toContain("cmd.exe");
    expect(osLine("darwin")).toContain("macOS");
  });

  it("killTree stops a parent and the child it started", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-platform-"));
    const pidFile = path.join(dir, "child.pid");
    await fs.writeFile(path.join(dir, "child.cjs"), "setInterval(() => {}, 1000);\n");
    await fs.writeFile(
      path.join(dir, "parent.cjs"),
      [
        "const { spawn } = require('node:child_process');",
        "const path = require('node:path');",
        "const child = spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { stdio: 'ignore' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const parent = shellSpawn(`node "${path.join(dir, "parent.cjs")}"`, { cwd: dir, env: process.env });
    expect(
      await waitFor(async () => {
        try {
          return (await fs.readFile(pidFile, "utf8")).length > 0;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    const childPid = Number(await fs.readFile(pidFile, "utf8"));
    expect(alive(childPid)).toBe(true);
    await killTree(parent.pid);
    expect(await waitFor(() => !alive(childPid), 4_000)).toBe(true);
  });
});
