import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";
import type { PermissionRequest } from "./permissions.js";
import { runTool } from "./tools.js";

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
