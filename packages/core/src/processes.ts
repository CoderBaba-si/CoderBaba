import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { baseCommandEnv } from "./command-env.js";
import { redact, stripAnsi } from "./output.js";
import { killTree, killTreeSync, shellSpawn } from "./platform.js";

export type ProcessStatus = "starting" | "running" | "exited" | "stopped";

export type ProcessInfo = {
  id: string;
  name: string;
  command: string;
  /** Folder shown to the user, relative to the project. */
  folder: string;
  pid?: number;
  url?: string;
  port?: number;
  status: ProcessStatus;
  exitCode?: number | null;
  startedAt: number;
  external?: boolean;
};

export type WaitFor = { port?: number; text?: string };

export type StartOptions = {
  command: string;
  cwd: string;
  folder?: string;
  name?: string;
  waitFor?: WaitFor;
  env?: NodeJS.ProcessEnv;
  /** Values to hide in stored output, such as secrets loaded from env_file. */
  secrets?: string[];
  onOutput?: (chunk: string) => void;
  /** Override the readiness wait, mainly for tests. */
  waitMs?: number;
};

export type StartResult = {
  id: string;
  name: string;
  ready: boolean;
  url?: string;
  port?: number;
  exited?: { code: number | null };
  portInUse?: number | true;
  timedOut?: boolean;
  output: string;
  error?: string;
};

const MAX_LINES = 200;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"<>)]*/i;
const PORT_PHRASE = /\b(?:port|listening on|running on|started on|serving on)\s*:?\s*(\d{2,5})\b/i;
const IN_USE = /EADDRINUSE|address already in use|That port is already in use/i;
const IN_USE_PORT = /(?:EADDRINUSE|address already in use)[^\n]*?:(\d{2,5})\b/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** True when something accepts connections on the port (IPv4 or IPv6 loopback). */
export async function portOpen(port: number): Promise<boolean> {
  return (await tryConnect("127.0.0.1", port)) || (await tryConnect("::1", port));
}

function urlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url.replace("0.0.0.0", "localhost"));
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch {
    return undefined;
  }
}

class Managed {
  info: ProcessInfo;
  lines: string[] = [];
  partial = "";
  child?: ChildProcess;
  listener?: (chunk: string) => void;
  stopping = false;
  closed: Promise<void> = Promise.resolve();
  spec?: StartOptions;
  stopExternal?: () => Promise<void>;

  constructor(info: ProcessInfo) {
    this.info = info;
  }

  append(raw: string, secrets?: string[]): void {
    const text = redact(stripAnsi(raw), secrets);
    const parts = (this.partial + text).split(/\r?\n|\r/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  output(count = MAX_LINES): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-count).join("\n");
  }
}

export class ProcessManager {
  private items: Managed[] = [];
  private counter = 0;
  private listeners = new Set<() => void>();

  /** Subscribe to status changes (start, ready, exit, stop). Returns an unsubscribe function. */
  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  find(nameOrId: string): Managed | undefined {
    const live = this.items.filter((item) => item.info.status === "starting" || item.info.status === "running");
    return (
      live.find((item) => item.info.name === nameOrId || item.info.id === nameOrId) ??
      [...this.items].reverse().find((item) => item.info.name === nameOrId || item.info.id === nameOrId)
    );
  }

  list(): ProcessInfo[] {
    return this.items.map((item) => ({ ...item.info }));
  }

  running(): ProcessInfo[] {
    return this.list().filter((info) => info.status === "running" || info.status === "starting");
  }

  ownsPort(port: number): boolean {
    return this.running().some((info) => info.port === port);
  }

  async start(opts: StartOptions): Promise<StartResult> {
    const name = opts.name?.trim() || `proc${this.counter + 1}`;
    const existing = this.find(name);
    if (existing && (existing.info.status === "running" || existing.info.status === "starting")) {
      return {
        id: existing.info.id,
        name,
        ready: false,
        output: "",
        error: `A process named ${name} is already running. Stop or restart it, or pick another name.`,
      };
    }
    this.counter += 1;
    const item = new Managed({
      id: `p${this.counter}`,
      name,
      command: opts.command,
      folder: opts.folder ?? ".",
      status: "starting",
      startedAt: Date.now(),
      port: opts.waitFor?.port,
    });
    item.spec = opts;
    this.items.push(item);

    let child: ChildProcess;
    try {
      child = shellSpawn(opts.command, { cwd: opts.cwd, env: opts.env ?? baseCommandEnv() });
    } catch (error) {
      item.info.status = "exited";
      item.info.exitCode = 1;
      this.changed();
      return { id: item.info.id, name, ready: false, exited: { code: 1 }, output: error instanceof Error ? error.message : "Could not start." };
    }
    item.child = child;
    item.info.pid = child.pid;
    item.listener = opts.onOutput;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      item.append(text, opts.secrets);
      item.listener?.(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    item.closed = new Promise((resolve) => child.once("close", () => resolve()));
    child.once("exit", (code) => {
      item.info.exitCode = code;
      item.info.status = item.stopping ? "stopped" : "exited";
      this.changed();
    });
    child.once("error", (error) => {
      item.append(`${error.message}\n`);
      item.info.status = "exited";
      item.info.exitCode = 1;
      this.changed();
    });
    this.changed();

    const result = await this.waitReady(item, opts);
    item.listener = undefined;
    this.changed();
    return result;
  }

  private async waitReady(item: Managed, opts: StartOptions): Promise<StartResult> {
    const waitFor = opts.waitFor;
    const deadline = Date.now() + (opts.waitMs ?? (waitFor?.port ? 60_000 : 20_000));
    const base = { id: item.info.id, name: item.info.name };
    const done = (extra: Partial<StartResult>): StartResult => ({
      ...base,
      ready: false,
      url: item.info.url,
      port: item.info.port,
      output: item.output(40),
      ...extra,
    });

    for (;;) {
      const text = item.output();
      const url = URL_PATTERN.exec(text)?.[0]?.replace(/[.,;]+$/, "");
      if (url && !item.info.url) {
        item.info.url = url;
        item.info.port ??= urlPort(url);
      }

      if (item.info.status === "exited" || item.info.status === "stopped") {
        await Promise.race([item.closed, sleep(500)]);
        const inUse = IN_USE.test(item.output());
        return done({
          exited: { code: item.info.exitCode ?? null },
          output: item.output(40),
          portInUse: inUse ? this.inUsePort(item.output(), waitFor) : undefined,
        });
      }

      if (IN_USE.test(text)) {
        return done({ portInUse: this.inUsePort(text, waitFor) });
      }

      let ready = false;
      if (waitFor?.port) {
        ready = await portOpen(waitFor.port);
      } else if (waitFor?.text) {
        ready = text.includes(waitFor.text);
      } else if (item.info.url) {
        ready = true;
      } else {
        const phrase = PORT_PHRASE.exec(text);
        if (phrase) {
          const port = Number(phrase[1]);
          if (await portOpen(port)) {
            item.info.port = port;
            ready = true;
          }
        }
      }

      if (ready) {
        item.info.status = "running";
        return done({ ready: true });
      }
      if (Date.now() >= deadline) {
        if (item.info.status === "starting") item.info.status = "running";
        return done({ timedOut: true });
      }
      await sleep(250);
    }
  }

  private inUsePort(text: string, waitFor?: WaitFor): number | true {
    const match = IN_USE_PORT.exec(text);
    if (match) return Number(match[1]);
    if (waitFor?.port) return waitFor.port;
    const phrase = PORT_PHRASE.exec(text);
    return phrase ? Number(phrase[1]) : true;
  }

  logs(nameOrId: string, count = 80): { info: ProcessInfo; output: string } | undefined {
    const item = this.find(nameOrId);
    if (!item) return undefined;
    return { info: { ...item.info }, output: item.output(count) };
  }

  async stop(nameOrId: string): Promise<ProcessInfo | undefined> {
    const item = this.find(nameOrId);
    if (!item) return undefined;
    if (item.info.status !== "running" && item.info.status !== "starting") return { ...item.info };
    item.stopping = true;
    if (item.info.external) {
      await item.stopExternal?.();
      item.info.status = "stopped";
      this.changed();
      return { ...item.info };
    }
    const grace = /^\s*docker\s/.test(item.info.command) ? 15_000 : 3_000;
    await killTree(item.info.pid, grace);
    await Promise.race([item.closed, sleep(5_000)]);
    item.info.status = "stopped";
    this.changed();
    return { ...item.info };
  }

  async restart(nameOrId: string, onOutput?: (chunk: string) => void): Promise<StartResult | undefined> {
    const item = this.find(nameOrId);
    if (!item?.spec) return undefined;
    await this.stop(nameOrId);
    return this.start({ ...item.spec, name: item.info.name, onOutput });
  }

  private cleanups = new Set<() => Promise<void>>();

  /** Run fn on stopAll, for helpers such as the page-check browser. Returns a function that removes it. */
  addCleanup(fn: () => Promise<void>): () => void {
    this.cleanups.add(fn);
    return () => this.cleanups.delete(fn);
  }

  async stopAll(): Promise<void> {
    await Promise.all([
      ...this.running().map((info) => this.stop(info.id)),
      ...[...this.cleanups].map((fn) => fn().catch(() => undefined)),
    ]);
  }

  /** For process "exit" handlers: kill everything right away. */
  stopAllSync(): void {
    for (const item of this.items) {
      if (item.info.external) continue;
      if (item.info.status === "running" || item.info.status === "starting") {
        item.stopping = true;
        killTreeSync(item.info.pid);
      }
    }
  }

  /** Track something CoderBaba didn't start, such as a database container left from an earlier session. */
  registerExternal(opts: { name: string; command: string; port?: number; stop: () => Promise<void> }): ProcessInfo {
    this.counter += 1;
    const item = new Managed({
      id: `p${this.counter}`,
      name: opts.name,
      command: opts.command,
      folder: ".",
      status: "running",
      startedAt: Date.now(),
      port: opts.port,
      external: true,
    });
    item.stopExternal = opts.stop;
    this.items.push(item);
    this.changed();
    return { ...item.info };
  }
}
