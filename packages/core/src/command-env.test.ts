import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";
import { buildCommandEnv, parseDotenv, venvBin } from "./command-env.js";
import { runTool } from "./tools.js";

async function tmp(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function makeVenv(dir: string, withCfg = true): Promise<string> {
  await fs.mkdir(venvBin(dir), { recursive: true });
  if (withCfg) await fs.writeFile(path.join(dir, "pyvenv.cfg"), "home = /usr/bin\n");
  return dir;
}

function pathOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return env[key] ?? "";
}

describe("buildCommandEnv", () => {
  it("activates a .venv found in a parent folder", async () => {
    const root = await tmp("cb-env-");
    const venv = await makeVenv(path.join(root, ".venv"));
    const cwd = path.join(root, "server", "app");
    await fs.mkdir(cwd, { recursive: true });
    const result = await buildCommandEnv({ root, cwd });
    expect(result.venv).toBe(venv);
    expect(result.env.VIRTUAL_ENV).toBe(venv);
    expect(pathOf(result.env).split(path.delimiter)[0]).toBe(venvBin(venv));
    expect(result.env.PYTHONUNBUFFERED).toBe("1");
    expect(result.env.CI).toBe("1");
  });

  it("ignores folders without pyvenv.cfg", async () => {
    const root = await tmp("cb-env-");
    await makeVenv(path.join(root, "venv"), false);
    const result = await buildCommandEnv({ root, cwd: root });
    expect(result.venv).toBeUndefined();
    expect(result.env.VIRTUAL_ENV).toBe(process.env.VIRTUAL_ENV);
  });

  it("does not look above the project root", async () => {
    const outer = await tmp("cb-env-");
    await makeVenv(path.join(outer, ".venv"));
    const root = path.join(outer, "project");
    await fs.mkdir(root);
    expect((await buildCommandEnv({ root, cwd: root })).venv).toBeUndefined();
  });

  it("loads env_file values and rejects files outside the project", async () => {
    const outer = await tmp("cb-env-");
    const root = path.join(outer, "project");
    await fs.mkdir(path.join(root, "server"), { recursive: true });
    await fs.writeFile(path.join(root, "server", ".env"), '# comment\nA=1\nB="two words"\nexport C=\'x y\'\nD=plain # note\n');
    await fs.writeFile(path.join(outer, "outside.env"), "X=1\n");
    const result = await buildCommandEnv({ root, cwd: root, envFile: "server/.env" });
    expect(result.env).toMatchObject({ A: "1", B: "two words", C: "x y", D: "plain" });
    expect(Object.keys(result.loaded?.values ?? {})).toEqual(["A", "B", "C", "D"]);
    await expect(buildCommandEnv({ root, cwd: root, envFile: "../outside.env" })).rejects.toThrow(/inside the project/);
  });

  it("parses dotenv edge cases", () => {
    expect(parseDotenv('K="a\\nb"\n=bad\n  # skip\nE=\n')).toEqual({ K: "a\nb", E: "" });
  });
});

describe("env_file in tools", () => {
  it("never shows secret values in the tool result", async () => {
    const root = await tmp("cb-env-tool-");
    await fs.writeFile(path.join(root, ".env"), "X=secret\nAPI_TOKEN=supersecretvalue123\n");
    await fs.writeFile(path.join(root, "check.cjs"), "process.exit(process.env.X === 'secret' ? 0 : 1);\n");
    await fs.writeFile(path.join(root, "leak.cjs"), "console.log('token is ' + process.env.API_TOKEN);\n");
    const base = {
      cwd: root,
      turnId: "t",
      checkpoints: new Checkpoints(path.join(root, ".cb")),
      allows: new Set<string>(),
      askPermission: async () => "allow" as const,
    };
    const ok = await runTool({ ...base, name: "shell", args: { command: "node check.cjs", env_file: ".env" } });
    expect(ok.content).toBe("(loaded 2 variables from .env)\n(exit 0)");
    expect(ok.content).not.toContain("secret");

    const redactions = new Set<string>();
    const leak = await runTool({ ...base, redact: redactions, name: "shell", args: { command: "node leak.cjs", env_file: ".env" } });
    expect(leak.content).toContain("token is ••••");
    expect(leak.content).not.toContain("supersecretvalue123");
    expect(redactions.has("supersecretvalue123")).toBe(true);
  });
});
