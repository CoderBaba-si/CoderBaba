import fs from "node:fs/promises";
import path from "node:path";

export type CheckpointFile = { path: string; existed: boolean; content?: string };

export type TurnCheckpoint = { turnId: string; files: CheckpointFile[] };

export class Checkpoints {
  private turns: TurnCheckpoint[] = [];

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.dir, "turns.json"), "utf8");
      this.turns = JSON.parse(raw) as TurnCheckpoint[];
    } catch {
      this.turns = [];
    }
  }

  async remember(turnId: string, filePath: string): Promise<void> {
    let turn = this.turns.find((item) => item.turnId === turnId);
    if (!turn) {
      turn = { turnId, files: [] };
      this.turns.push(turn);
    }
    if (turn.files.some((file) => file.path === filePath)) return;
    let existed = false;
    let content: string | undefined;
    try {
      content = await fs.readFile(filePath, "utf8");
      existed = true;
    } catch {
      existed = false;
    }
    turn.files.push({ path: filePath, existed, content });
    await this.persist();
  }

  lastTurnId(): string | undefined {
    return this.turns.at(-1)?.turnId;
  }

  async undoLast(): Promise<{ restored: string[] } | null> {
    const turn = this.turns.pop();
    if (!turn) return null;
    for (const file of [...turn.files].reverse()) {
      if (!file.existed) {
        await fs.rm(file.path, { force: true });
      } else {
        await fs.mkdir(path.dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, file.content ?? "", "utf8");
      }
    }
    await this.persist();
    return { restored: turn.files.map((file) => file.path) };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, "turns.json"), JSON.stringify(this.turns), "utf8");
  }
}
