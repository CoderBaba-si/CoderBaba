import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";

describe("checkpoints", () => {
  it("restores edited and created files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-undo-"));
    const file = path.join(root, "app.txt");
    await fs.writeFile(file, "before\n");
    const store = new Checkpoints(path.join(root, ".checkpoints"));
    await store.remember("turn-1", file);
    await fs.writeFile(file, "after\n");
    const created = path.join(root, "new.txt");
    await store.remember("turn-1", created);
    await fs.writeFile(created, "fresh\n");

    const undone = await store.undoLast();
    expect(undone?.restored).toEqual([file, created]);
    expect(await fs.readFile(file, "utf8")).toBe("before\n");
    await expect(fs.access(created)).rejects.toThrow();
  });
});
