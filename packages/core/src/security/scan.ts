import { randomUUID } from "node:crypto";
import path from "node:path";
import { runTurn, type TurnOptions } from "../agent.js";
import { findAppFolders } from "../checks.js";
import { runShell } from "../tools.js";
import { aggregateTask, diffReviewTask, fixTask, investigateTask, threatModelTask, validateTask } from "./prompts.js";
import { sortFindings } from "./report.js";
import { SECURITY_REPORT_FILE, SecurityStore, type Finding } from "./store.js";
import { describeFinding, securityTools } from "./tools.js";

/** Everything a security turn shares with a normal turn; each phase gets its own task, messages, and id. */
export type SecurityTurnBase = Omit<TurnOptions, "task" | "messages" | "taskId" | "extraTools" | "todos">;

export type SecurityPhase = { index: number; total: number; label: string };

export type SecurityRunResult = {
  /** Set when the model request failed (login, limits, offline); the run stopped there. */
  stopCode?: string;
  /** Plain-language result for the user, also added to the chat. */
  summary: string;
  /** False when nothing was sent to the model. */
  ranModel: boolean;
};

const MAX_VALIDATE = 5;
const ACTIVE = new Set<Finding["status"]>(["open", "confirmed", "needs_review"]);

function rel(root: string, dir: string): string {
  const out = path.relative(root, dir);
  return out ? out.split(path.sep).join("/") : "";
}

async function phaseTurn(base: SecurityTurnBase, store: SecurityStore, task: string, source: Finding["source"] = "scan"): Promise<string | undefined> {
  const result = await runTurn({ ...base, task, messages: [], taskId: randomUUID(), extraTools: securityTools(store, { source }) });
  return result.stopCode;
}

export function activeFindings(store: SecurityStore): Finding[] {
  return sortFindings(store.findings().filter((finding) => ACTIVE.has(finding.status)));
}

export function scanSummary(store: SecurityStore): string {
  const active = activeFindings(store);
  if (!active.length) return `No open security findings. Details are in ${SECURITY_REPORT_FILE}.`;
  const high = active.filter((finding) => finding.severity === "high").length;
  const medium = active.filter((finding) => finding.severity === "medium").length;
  const low = active.length - high - medium;
  const top = active.slice(0, 3).map((finding) => `  ${describeFinding(finding)}`);
  return [
    `${active.length} open security finding${active.length === 1 ? "" : "s"} (${high} high, ${medium} medium, ${low} low). Report: ${SECURITY_REPORT_FILE}`,
    ...top,
    `Next: /security validate to reproduce them on localhost, then /security fix ${active[0]!.id}.`,
  ].join("\n");
}

function stopped(store: SecurityStore, stopCode: string): SecurityRunResult {
  return { stopCode, summary: `The security run stopped early. What was found so far is in ${SECURITY_REPORT_FILE}.\n${scanSummary(store)}`, ranModel: true };
}

/** Deep scan: threat model, one investigation per app folder, then dedupe and prioritize. */
export async function runSecurityScan(base: SecurityTurnBase, opts: { onPhase?: (phase: SecurityPhase) => void } = {}): Promise<SecurityRunResult> {
  const root = path.resolve(base.cwd);
  const store = await SecurityStore.open(root, base.redact);
  await store.startScan();
  const folders = (await findAppFolders(root)).map((dir) => rel(root, dir));
  const total = folders.length + 2;

  opts.onPhase?.({ index: 1, total, label: "building a threat model" });
  let stopCode = await phaseTurn(base, store, threatModelTask(folders));
  if (stopCode) return stopped(store, stopCode);

  for (const [i, folder] of folders.entries()) {
    opts.onPhase?.({ index: i + 2, total, label: `investigating ${folder ? `${folder}/` : "the project root"}` });
    const skip = folders.filter((other) => other !== folder && (folder === "" || other.startsWith(`${folder}/`)));
    stopCode = await phaseTurn(
      base,
      store,
      investigateTask({ folder, index: i + 1, total: folders.length, threatModel: store.threatModel(), skip }),
    );
    if (stopCode) return stopped(store, stopCode);
  }

  const found = activeFindings(store);
  opts.onPhase?.({ index: total, total, label: found.length > 1 ? "removing duplicates and ranking findings" : "writing the report" });
  if (found.length > 1) {
    stopCode = await phaseTurn(base, store, aggregateTask(found, store.threatModel()));
    if (stopCode) return stopped(store, stopCode);
  }
  await store.save();
  return { summary: scanSummary(store), ranModel: true };
}

/** Reproduce one finding, or the most urgent high and medium ones, against localhost. */
export async function runSecurityValidate(base: SecurityTurnBase, id?: string): Promise<SecurityRunResult> {
  const store = await SecurityStore.open(path.resolve(base.cwd), base.redact);
  let targets: Finding[];
  if (id) {
    const finding = store.get(id);
    if (!finding) return { summary: `There is no finding ${id}. Type /security status to list them.`, ranModel: false };
    targets = [finding];
  } else {
    targets = activeFindings(store)
      .filter((finding) => finding.status !== "confirmed" && finding.severity !== "low")
      .slice(0, MAX_VALIDATE);
    if (!targets.length) {
      return {
        summary: store.findings().length ? "Nothing left to validate. Type /security status to see the findings." : "No findings yet. Type /security to scan this project first.",
        ranModel: false,
      };
    }
  }
  const stopCode = await phaseTurn(base, store, validateTask(targets, store.threatModel()));
  if (stopCode) return stopped(store, stopCode);
  const results = targets.map((target) => store.get(target.id)!).map((finding) => `  ${finding.id}: ${finding.status.replace("_", " ")}`);
  return { summary: [`Validation finished. Report: ${SECURITY_REPORT_FILE}`, ...results].join("\n"), ranModel: true };
}

export async function runSecurityFix(base: SecurityTurnBase, id: string): Promise<SecurityRunResult> {
  const store = await SecurityStore.open(path.resolve(base.cwd), base.redact);
  const finding = store.get(id);
  if (!finding) return { summary: `There is no finding ${id}. Type /security status to list them.`, ranModel: false };
  if (finding.status === "fixed") return { summary: `${finding.id} is already fixed.`, ranModel: false };
  const stopCode = await phaseTurn(base, store, fixTask(finding));
  if (stopCode) return stopped(store, stopCode);
  const after = store.get(finding.id)!;
  return {
    summary:
      after.status === "fixed"
        ? `${after.id} is fixed. Type /undo to revert the change. Report: ${SECURITY_REPORT_FILE}`
        : `${after.id} is still ${after.status.replace("_", " ")}. See the reply above for why.`,
    ranModel: true,
  };
}

const GIT_REF = /^[\w./@^~-]+$/;

export async function runSecurityDiff(base: SecurityTurnBase, ref?: string): Promise<SecurityRunResult> {
  const root = path.resolve(base.cwd);
  if (ref && (!GIT_REF.test(ref) || ref.startsWith("-"))) return { summary: `${ref} doesn't look like a branch or commit name.`, ranModel: false };
  const repo = await runShell("git rev-parse --is-inside-work-tree", root, { timeoutMs: 10_000 });
  if (repo.code !== 0) return { summary: "This project isn't a git repository, so there is no diff to review. Type /security for a full scan.", ranModel: false };
  if (!ref) {
    const status = await runShell("git status --porcelain", root, { timeoutMs: 10_000 });
    if (status.code === 0 && !status.output.trim()) return { summary: "No uncommitted changes to review. Pass a base branch, such as /security diff main.", ranModel: false };
  }
  const store = await SecurityStore.open(root, base.redact);
  const before = new Set(store.findings().map((finding) => finding.id));
  const stopCode = await phaseTurn(base, store, diffReviewTask(ref), "diff");
  if (stopCode) return stopped(store, stopCode);
  const added = sortFindings(store.findings().filter((finding) => !before.has(finding.id)));
  if (!added.length) return { summary: "No security issues found in these changes.", ranModel: true };
  return {
    summary: [
      `${added.length} security finding${added.length === 1 ? "" : "s"} in these changes. Report: ${SECURITY_REPORT_FILE}`,
      ...added.map((finding) => `  ${describeFinding(finding)}`),
      `Fix with /security fix ${added[0]!.id}.`,
    ].join("\n"),
    ranModel: true,
  };
}
