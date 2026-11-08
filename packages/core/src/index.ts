export { SYSTEM_PROMPT } from "./prompt.js";
export { resolveInProject } from "./paths.js";
export { lineDiff } from "./diff.js";
export { applyExactEdit } from "./edit.js";
export { Checkpoints } from "./checkpoints.js";
export { permissionKey } from "./permissions.js";
export type { PermissionDecision, PermissionRequest } from "./permissions.js";
export { CoderBabaError, friendlyMessage, isLoginCode } from "./errors.js";
export { runTool, runShell, TOOL_DEFINITIONS } from "./tools.js";
export type { ToolEvent } from "./tools.js";
export { readSse, consumeSse } from "./sse.js";
export { apiBaseUrl, usesDirectOpenRouter, createLlm } from "./llm.js";
export type { Llm, LlmResult } from "./llm.js";
export {
  dataDir,
  authFilePath,
  readAuth,
  saveAuth,
  clearAuth,
  deviceName,
  maskEmail,
  ensureAuth,
  startEmailLogin,
  verifyEmailLogin,
  logoutRemote,
  fetchUsage,
} from "./auth.js";
export type { AuthFile, EnsureAuthResult } from "./auth.js";
export { createSession, saveSession, listSessions } from "./sessions.js";
export type { Session } from "./sessions.js";
export { runTurn } from "./agent.js";
export type { AgentEvent } from "./agent.js";

export function formatStatus(input: {
  modelLabel: string;
  project: string;
  direct: boolean;
  usage: import("@coderbabasi/shared").UsageResponse | null;
}): string {
  const where = `${input.modelLabel} · ${input.project}`;
  if (input.direct) return `${where} · your OpenRouter key`;
  if (input.usage?.type === "anonymous") {
    return `${where} · ${input.usage.triesLeft} of ${input.usage.triesLimit} free tries left · /login to keep going (free)`;
  }
  if (input.usage?.type === "user") {
    return `${where} · ${input.usage.daily.percentLeft}% of today's free usage left`;
  }
  return where;
}

export function shortenPath(cwd: string, home = process.env.HOME || ""): string {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}
