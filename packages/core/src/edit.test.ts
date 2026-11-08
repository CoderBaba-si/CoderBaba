import { describe, expect, it } from "vitest";
import { applyExactEdit } from "./edit.js";

describe("applyExactEdit", () => {
  it("replaces one exact match and counts lines", () => {
    const result = applyExactEdit("alpha\nbeta\ngamma\n", "beta", "beta\nextra");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("alpha\nbeta\nextra\ngamma\n");
    expect(result.diff.added).toBe(1);
    expect(result.diff.removed).toBe(0);
  });

  it("lists removed lines before added lines", () => {
    const result = applyExactEdit("hello\n", "hello", "hello world");
    if (!result.ok) throw new Error(result.error);
    expect(result.diff.lines.map((line) => line.kind)).toEqual(["del", "add", "ctx"]);
  });

  it("rejects a missing or repeated match", () => {
    expect(applyExactEdit("one\n", "missing", "x").ok).toBe(false);
    expect(applyExactEdit("same\nsame\n", "same", "other").ok).toBe(false);
  });

  it("creates a file only when old_string is empty and the file is empty", () => {
    const created = applyExactEdit("", "", "hello\n");
    expect(created.ok).toBe(true);
    expect(applyExactEdit("already\n", "", "nope").ok).toBe(false);
  });
});
