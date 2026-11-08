export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

export type LineDiff = { added: number; removed: number; lines: DiffLine[] };

const MAX_CELLS = 400_000;
const MAX_SHOWN = 40;

export function lineDiff(before: string, after: string): LineDiff {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_CELLS) {
    return { added: b.length, removed: a.length, lines: [] };
  }

  const rows: number[][] = [new Array(b.length + 1).fill(0)];
  for (let i = 1; i <= a.length; i++) {
    const prev = rows[i - 1]!;
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    rows.push(cur);
  }

  const ops: DiffLine[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "ctx", text: a[i - 1]! });
      i--;
      j--;
    } else if (rows[i]![j - 1]! >= rows[i - 1]![j]!) {
      ops.push({ kind: "add", text: b[j - 1]! });
      j--;
    } else {
      ops.push({ kind: "del", text: a[i - 1]! });
      i--;
    }
  }
  while (i > 0) {
    ops.push({ kind: "del", text: a[i - 1]! });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: "add", text: b[j - 1]! });
    j--;
  }
  ops.reverse();

  const added = ops.filter((line) => line.kind === "add").length;
  const removed = ops.filter((line) => line.kind === "del").length;
  return { added, removed, lines: compact(ops) };
}

function compact(ops: DiffLine[]): DiffLine[] {
  const changed = ops.some((line) => line.kind !== "ctx");
  if (!changed) return [];
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === "ctx") continue;
    for (let k = Math.max(0, i - 1); k <= Math.min(ops.length - 1, i + 1); k++) keep[k] = true;
  }
  const shown = ops.filter((_, index) => keep[index]);
  return shown.slice(0, MAX_SHOWN);
}
