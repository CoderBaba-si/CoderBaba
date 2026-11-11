import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type ShellInvocation = {
  file: string;
  args: string[];
  detached: boolean;
  windowsVerbatimArguments: boolean;
};

export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): ShellInvocation {
  if (platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      detached: false,
      windowsVerbatimArguments: true,
    };
  }
  return { file: "/bin/sh", args: ["-c", command], detached: true, windowsVerbatimArguments: false };
}

/** Spawn a shell command with stdin closed, so prompts fail fast instead of hanging. */
export function shellSpawn(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const shell = shellInvocation(command);
  return spawn(shell.file, shell.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: shell.detached,
    windowsVerbatimArguments: shell.windowsVerbatimArguments,
    windowsHide: true,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop a process and everything it started. */
export async function killTree(pid: number | undefined, graceMs = 3_000): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Synchronous variant for process "exit" handlers, where async work never runs. */
export function killTreeSync(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function osLine(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "You are on Windows; commands run in cmd.exe. Use where instead of which, and the Windows forms of commands.";
  }
  const name = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
  return `You are on ${name}; commands run in sh.`;
}
