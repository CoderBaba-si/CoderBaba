const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Keeps the start and the end of long output, where commands print what they did and what failed. */
export class OutputBuffer {
  private head = "";
  private tail = "";
  private cut = false;

  constructor(
    private readonly headMax = 6_000,
    private readonly tailMax = 14_000,
  ) {}

  push(chunk: string): void {
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.tailMax) {
      this.tail = this.tail.slice(-this.tailMax);
      this.cut = true;
    }
  }

  text(): string {
    const joined = this.cut ? `${this.head}\n… output cut …\n${this.tail}` : this.head + this.tail;
    return stripAnsi(joined);
  }
}

export function lastLine(text: string): string {
  const lines = stripAnsi(text).split(/[\r\n]+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line;
  }
  return "";
}

/** Turns raw output chunks into throttled "last line" updates. */
export function createProgressReporter(onProgress: ((line: string) => void) | undefined, intervalMs = 150) {
  let pending = "";
  let lastSent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let recent = "";

  const flush = () => {
    timer = undefined;
    if (stopped || !pending) return;
    lastSent = Date.now();
    onProgress?.(pending);
    pending = "";
  };

  return {
    push(chunk: string) {
      if (stopped || !onProgress) return;
      recent = (recent + chunk).slice(-2_000);
      const line = lastLine(recent);
      if (!line) return;
      pending = line;
      const wait = intervalMs - (Date.now() - lastSent);
      if (wait <= 0) flush();
      else if (!timer) timer = setTimeout(flush, wait);
    },
    stop() {
      if (timer) clearTimeout(timer);
      flush();
      stopped = true;
    },
  };
}

/** Replace known secret values so they never reach the model. */
export function redact(text: string, secrets: Iterable<string> | undefined): string {
  if (!secrets) return text;
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("••••");
  }
  return out;
}
