import fs from "node:fs";
import path from "node:path";

export const NOTES_FILE = "AGENTS.md";
const MAX_NOTES = 8_000;

const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

export function projectNotesPath(root: string): string {
  return path.join(root, NOTES_FILE);
}

/** The project's AGENTS.md, cut to a size that fits the system prompt. Empty when there is none. */
export function loadProjectNotes(root: string): string {
  const file = projectNotesPath(root);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(file);
    return "";
  }
  if (!stat.isFile()) return "";
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
  if (text.length > MAX_NOTES) text = `${text.slice(0, MAX_NOTES)}\n… (AGENTS.md is longer; read the file for the rest)`;
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

export const INIT_TASK = `Create or update ${NOTES_FILE} at the project root so future sessions understand this project.
First look around: list the root and app folders, read package.json, pyproject.toml, requirements.txt, manage.py, README, and config files as needed. Do not run installs or start servers.
${NOTES_FILE} should be short (under 60 lines) and use these sections:
## Overview (what the app is, the stack, the main folders)
## How to run (per app folder: install command, start command, port, database, env files by variable name)
## Checks (the lint, typecheck, and test commands that exist)
## Conventions (code style and patterns you can see in the code)
If ${NOTES_FILE} already exists, keep what the user wrote and update only what is wrong or missing.
Never write secret values; name the variables only. When done, summarize what you wrote.`;
