import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";
import { upsertEnvLine } from "./secrets.js";
import { runTool, type ToolOptions } from "./tools.js";

async function project() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cb-secrets-")));
  return cwd;
}

function base(cwd: string, answer: string | null): Omit<ToolOptions, "name" | "args"> {
  return {
    cwd,
    turnId: "t",
    checkpoints: new Checkpoints(path.join(cwd, ".cb")),
    allows: new Set(),
    askPermission: async () => "allow",
    askSecret: async () => answer,
    redact: new Set(),
  };
}

describe("ask_secret", () => {
  it("writes and updates the key without returning the value", async () => {
    const cwd = await project();
    const first = await runTool({ ...base(cwd, "mongodb+srv://u:p4ss@x"), name: "ask_secret", args: { name: "MONGODB_URI", hint: "from Atlas", env_path: "server/.env" } });
    expect(first.content).toMatch(/^Saved MONGODB_URI to server\/\.env\./);
    expect(first.content).not.toContain("p4ss");
    expect(first.event).toMatchObject({ name: "ask_secret", secretName: "MONGODB_URI", path: "server/.env" });

    await runTool({ ...base(cwd, "second-value"), name: "ask_secret", args: { name: "MONGODB_URI", hint: "", env_path: "server/.env" } });
    const text = await fs.readFile(path.join(cwd, "server", ".env"), "utf8");
    expect(text).toBe("MONGODB_URI=second-value\n");
  });

  it("reports when the user skips", async () => {
    const cwd = await project();
    const result = await runTool({ ...base(cwd, null), name: "ask_secret", args: { name: "DATABASE_URL", hint: "" } });
    expect(result.content).toBe("The user skipped entering DATABASE_URL.");
    expect(result.event.denied).toBe(true);
  });

  it("adds .env to .gitignore once", async () => {
    const cwd = await project();
    await runTool({ ...base(cwd, "aaaa1"), name: "ask_secret", args: { name: "A", hint: "" } });
    await runTool({ ...base(cwd, "bbbb2"), name: "ask_secret", args: { name: "B", hint: "" } });
    const ignore = await fs.readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(ignore.split("\n").filter((line) => line === ".env")).toHaveLength(1);
  });

  it("uses the nearest existing .gitignore", async () => {
    const cwd = await project();
    await fs.mkdir(path.join(cwd, "client"));
    await fs.writeFile(path.join(cwd, "client", ".gitignore"), "node_modules");
    await runTool({ ...base(cwd, "value1"), name: "ask_secret", args: { name: "A", hint: "", env_path: "client/.env" } });
    expect(await fs.readFile(path.join(cwd, "client", ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
  });

  it("rejects an env_path outside the project", async () => {
    const cwd = await project();
    const result = await runTool({ ...base(cwd, "x"), name: "ask_secret", args: { name: "A", hint: "", env_path: "../.env" } });
    expect(result.content).toBe("env_path must be inside the project.");
  });

  it("quotes values that need it", () => {
    expect(upsertEnvLine("A=1", "B", 'has space "and" quotes')).toBe('A=1\nB="has space \\"and\\" quotes"\n');
    expect(upsertEnvLine("export B=old\nC=2\n", "B", "new")).toBe("B=new\nC=2\n");
  });
});

describe("env_keys", () => {
  it("returns names only", async () => {
    const cwd = await project();
    await fs.writeFile(path.join(cwd, ".env"), "SECRET_KEY=abc123\n# x\nDEBUG=1\n");
    const result = await runTool({ ...base(cwd, null), name: "env_keys", args: { path: ".env" } });
    expect(result.content).toBe("Keys in .env: SECRET_KEY, DEBUG");
    const missing = await runTool({ ...base(cwd, null), name: "env_keys", args: { path: "server/.env" } });
    expect(missing.content).toBe("There is no server/.env yet.");
  });
});
