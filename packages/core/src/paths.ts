import fs from "node:fs/promises";
import path from "node:path";

export type ResolvedPath = { inside: boolean; full: string; root: string };

async function realOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    const parent = path.dirname(target);
    try {
      const realParent = await fs.realpath(parent);
      return path.join(realParent, path.basename(target));
    } catch {
      return target;
    }
  }
}

/** Resolve a user path and report whether it stays inside the project root. */
export async function resolveInProject(cwd: string, inputPath: string): Promise<ResolvedPath> {
  const root = await realOrSelf(path.resolve(cwd));
  const target = path.resolve(root, inputPath);
  const full = await realOrSelf(target);
  const rel = path.relative(root, full);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return { inside, full, root };
}
