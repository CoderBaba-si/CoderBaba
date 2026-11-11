import fs from "node:fs/promises";
import path from "node:path";
import { parseDotenv, secretValues } from "../command-env.js";
import { redact } from "../output.js";
import { renderReport } from "./report.js";

export const SECURITY_REPORT_FILE = "SECURITY_REPORT.md";

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATUSES = ["open", "confirmed", "false_positive", "needs_review", "fixed", "duplicate", "wont_fix"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export type Finding = {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  /** App folder relative to the project, "" for the root. */
  folder: string;
  file?: string;
  line?: number;
  risk: string;
  fix: string;
  source: "scan" | "diff";
  status: FindingStatus;
  evidence?: string;
  duplicateOf?: string;
  /** Label shared by findings that combine into one attack. */
  chain?: string;
  /** Lower comes first; set by the aggregate phase. */
  priority?: number;
  createdAt: string;
  updatedAt: string;
};

export type SecurityState = {
  version: 1;
  updatedAt: string;
  findings: Finding[];
  notChecked: string[];
};

export type NewFinding = Pick<Finding, "title" | "severity" | "category" | "risk" | "fix"> &
  Partial<Pick<Finding, "folder" | "file" | "line" | "source" | "chain">>;

export type FindingPatch = Partial<Pick<Finding, "status" | "severity" | "evidence" | "duplicateOf" | "chain" | "priority" | "fix" | "risk">>;

const MAX_TEXT = 2_000;
const MAX_EVIDENCE = 4_000;

export function securityDir(root: string): string {
  return path.join(root, ".coderbaba", "security");
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Secret-looking values from .env files at the root and one folder down, so findings never repeat them. */
export async function projectSecrets(root: string): Promise<string[]> {
  const dirs = [root];
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") dirs.push(path.join(root, entry.name));
    }
  } catch {
    // unreadable root: only the root .env is tried
  }
  const values: string[] = [];
  for (const dir of dirs) {
    for (const name of [".env", ".env.local"]) {
      const text = await readText(path.join(dir, name));
      if (text) values.push(...secretValues(parseDotenv(text)));
    }
  }
  return values;
}

function emptyState(): SecurityState {
  return { version: 1, updatedAt: new Date().toISOString(), findings: [], notChecked: [] };
}

function idNumber(id: string): number {
  const match = /^S(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export class SecurityStore {
  private constructor(
    readonly root: string,
    private state: SecurityState,
    private threat: string,
    private readonly secrets: Set<string>,
  ) {}

  static async open(root: string, secrets: Iterable<string> = []): Promise<SecurityStore> {
    const dir = securityDir(root);
    let state = emptyState();
    const raw = await readText(path.join(dir, "findings.json"));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<SecurityState>;
        if (Array.isArray(parsed.findings)) {
          state = { ...state, ...parsed, version: 1, findings: parsed.findings, notChecked: parsed.notChecked ?? [] };
        }
      } catch {
        // a broken file starts over; the next save replaces it
      }
    }
    const threat = (await readText(path.join(dir, "threat-model.md"))) ?? "";
    const all = new Set([...secrets, ...(await projectSecrets(root))]);
    return new SecurityStore(root, state, threat, all);
  }

  get reportPath(): string {
    return path.join(this.root, SECURITY_REPORT_FILE);
  }

  findings(): Finding[] {
    return this.state.findings.slice();
  }

  get(id: string): Finding | undefined {
    const wanted = id.trim().toUpperCase();
    return this.state.findings.find((finding) => finding.id === wanted);
  }

  threatModel(): string {
    return this.threat;
  }

  notChecked(): string[] {
    return this.state.notChecked.slice();
  }

  clean(text: string, max = MAX_TEXT): string {
    const out = redact(text, this.secrets).trim();
    return out.length > max ? `${out.slice(0, max)}…` : out;
  }

  /** Returns the existing finding instead when the same issue is already open. */
  async record(input: NewFinding): Promise<{ finding: Finding; existing: boolean }> {
    const title = this.clean(input.title, 200);
    const file = input.file ? this.clean(input.file, 300) : undefined;
    const existing = this.state.findings.find(
      (finding) =>
        finding.status !== "fixed" &&
        finding.status !== "false_positive" &&
        finding.file === file &&
        finding.line === input.line &&
        finding.title.toLowerCase() === title.toLowerCase(),
    );
    if (existing) return { finding: existing, existing: true };
    const now = new Date().toISOString();
    const next = Math.max(0, ...this.state.findings.map((finding) => idNumber(finding.id))) + 1;
    const finding: Finding = {
      id: `S${next}`,
      title,
      severity: input.severity,
      category: this.clean(input.category, 80) || "other",
      folder: input.folder ?? "",
      file,
      line: input.line && input.line > 0 ? Math.floor(input.line) : undefined,
      risk: this.clean(input.risk),
      fix: this.clean(input.fix),
      source: input.source ?? "scan",
      status: "open",
      chain: input.chain ? this.clean(input.chain, 80) : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.state.findings.push(finding);
    await this.save();
    return { finding, existing: false };
  }

  async update(id: string, patch: FindingPatch): Promise<Finding | undefined> {
    const finding = this.get(id);
    if (!finding) return undefined;
    if (patch.status) finding.status = patch.status;
    if (patch.severity) finding.severity = patch.severity;
    if (patch.evidence !== undefined) finding.evidence = this.clean(patch.evidence, MAX_EVIDENCE);
    if (patch.duplicateOf !== undefined) finding.duplicateOf = this.get(patch.duplicateOf)?.id;
    if (patch.chain !== undefined) finding.chain = this.clean(patch.chain, 80) || undefined;
    if (patch.priority !== undefined) finding.priority = patch.priority;
    if (patch.fix) finding.fix = this.clean(patch.fix);
    if (patch.risk) finding.risk = this.clean(patch.risk);
    finding.updatedAt = new Date().toISOString();
    await this.save();
    return finding;
  }

  async saveThreatModel(text: string, notChecked: string[] = []): Promise<void> {
    this.threat = this.clean(text, 12_000);
    this.state.notChecked = notChecked.map((item) => this.clean(item, 200)).filter(Boolean).slice(0, 20);
    await this.save();
  }

  /** Drop findings from earlier scans so a fresh deep scan starts clean; diff findings and fixed history stay. */
  async startScan(): Promise<void> {
    this.state.findings = this.state.findings.filter((finding) => finding.source === "diff" || finding.status === "fixed");
    await this.save();
  }

  async save(): Promise<void> {
    const dir = securityDir(this.root);
    await fs.mkdir(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    if ((await readText(ignore)) === undefined) await fs.writeFile(ignore, "*\n");
    this.state.updatedAt = new Date().toISOString();
    await fs.writeFile(path.join(dir, "findings.json"), `${JSON.stringify(this.state, null, 2)}\n`);
    if (this.threat) await fs.writeFile(path.join(dir, "threat-model.md"), `${this.threat}\n`);
    await fs.writeFile(this.reportPath, renderReport(this.state, this.threat));
  }
}
