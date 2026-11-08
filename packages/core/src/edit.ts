import { lineDiff, type LineDiff } from "./diff.js";

export type EditResult =
  | { ok: true; content: string; diff: LineDiff }
  | { ok: false; error: string };

/** Replace one exact occurrence. An empty old string creates a new file. */
export function applyExactEdit(content: string, oldString: string, newString: string): EditResult {
  if (oldString === "") {
    if (content.length > 0) return { ok: false, error: "old_string is empty, but the file already has content" };
    return { ok: true, content: newString, diff: lineDiff("", newString) };
  }
  const parts = content.split(oldString);
  const count = parts.length - 1;
  if (count === 0) return { ok: false, error: "old_string was not found in the file" };
  if (count > 1) return { ok: false, error: "old_string matched more than once. Include more surrounding lines." };
  const next = parts.join(newString);
  return { ok: true, content: next, diff: lineDiff(content, next) };
}
