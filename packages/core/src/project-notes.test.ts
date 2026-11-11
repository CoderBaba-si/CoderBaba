import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectNotes } from "./project-notes.js";
import { buildSystemPrompt } from "./prompt.js";

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cb-notes-"));
}

describe("project notes", () => {
  it("is empty without AGENTS.md and ignores other agents' files", async () => {
    const root = await tempProject();
    await fs.writeFile(path.join(root, "CLAUDE.md"), "use the Bash tool");
    expect(loadProjectNotes(root)).toBe("");
  });

  it("reads AGENTS.md and picks up changes", async () => {
    const root = await tempProject();
    const file = path.join(root, "AGENTS.md");
    await fs.writeFile(file, "## How to run\nnpm run dev on 3000\n");
    expect(loadProjectNotes(root)).toBe("## How to run\nnpm run dev on 3000");
    await fs.writeFile(file, "## How to run\nnpm run dev on 4000, with more detail\n");
    expect(loadProjectNotes(root)).toContain("4000");
  });

  it("caps long notes", async () => {
    const root = await tempProject();
    await fs.writeFile(path.join(root, "AGENTS.md"), "a".repeat(20_000));
    const notes = loadProjectNotes(root);
    expect(notes.length).toBeLessThan(8_100);
    expect(notes).toContain("read the file for the rest");
  });

  it("appears at the end of the system prompt", () => {
    const prompt = buildSystemPrompt({ root: "/tmp/demo", notes: "Use pnpm." });
    expect(prompt.endsWith("## Project notes (AGENTS.md, written by the user or earlier sessions)\nUse pnpm.")).toBe(true);
    expect(buildSystemPrompt({ root: "/tmp/demo" })).not.toContain("(AGENTS.md, written by");
  });
});
