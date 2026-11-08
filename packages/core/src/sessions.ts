import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@coderbabasi/shared";
import { dataDir } from "./auth.js";

export type Session = {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  title?: string;
};

function sessionsDir(): string {
  return path.join(dataDir(), "sessions");
}

export async function createSession(cwd: string, model: string): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = {
    id: crypto.randomUUID(),
    cwd,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await saveSession(session);
  return session;
}

export async function saveSession(session: Session): Promise<void> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, `${session.id}.json`), JSON.stringify(session), "utf8");
}

export async function listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
  const dir = sessionsDir();
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const session = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Session;
      rows.push({ id: session.id, title: session.title || "New chat", updatedAt: session.updatedAt });
    } catch {
      // skip broken files
    }
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
}
