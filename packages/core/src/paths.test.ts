import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInProject } from "./paths.js";

describe("resolveInProject", () => {
  it("allows paths inside the project and blocks parents", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cb-sandbox-")));
    await fs.writeFile(path.join(root, "note.txt"), "hi");
    const inside = await resolveInProject(root, "note.txt");
    expect(inside.inside).toBe(true);
    expect(inside.full).toBe(path.join(root, "note.txt"));
    const outside = await resolveInProject(root, "../secret.txt");
    expect(outside.inside).toBe(false);
  });

  it("blocks a symlink that points outside the project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cb-out-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "nope");
    await fs.symlink(outside, path.join(root, "linked"));
    const resolved = await resolveInProject(root, "linked/secret.txt");
    expect(resolved.inside).toBe(false);
  });
});
