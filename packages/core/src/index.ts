export { SYSTEM_PROMPT, buildSystemPrompt, projectSlug } from "./prompt.js";
export { resolveInProject } from "./paths.js";
export { lineDiff } from "./diff.js";
export { applyExactEdit } from "./edit.js";
export { Checkpoints } from "./checkpoints.js";
export { CONFIG_EDIT_KEY, permissionKey } from "./permissions.js";
export type { PermissionDecision, PermissionRequest } from "./permissions.js";
export { CoderBabaError, friendlyMessage, isLoginCode } from "./errors.js";
export { runTool, runShell, TOOL_DEFINITIONS } from "./tools.js";
export type { ToolEvent, ToolOptions, RunShellOptions } from "./tools.js";
export { shellInvocation, shellSpawn, killTree, killTreeSync, osLine } from "./platform.js";
export { baseCommandEnv, buildCommandEnv, findVenv, parseDotenv, secretValues } from "./command-env.js";
export type { CommandEnv } from "./command-env.js";
export { ProcessManager, portOpen } from "./processes.js";
export type { ProcessInfo, ProcessStatus, StartOptions, StartResult, WaitFor } from "./processes.js";
export { ensureEnvIgnored, envKeys, setEnvValue, upsertEnvLine } from "./secrets.js";
export type { AskSecret, SecretRequest } from "./secrets.js";
export { isSafeCommand, matchesUserRule, hasShellMeta, splitWords, askAlways } from "./safe-commands.js";
export type { SafeContext } from "./safe-commands.js";
export { loadAllowConfig, trustProject, activeRules, globalConfigPath, projectAllowPath } from "./allow-config.js";
export type { AllowConfig } from "./allow-config.js";
export { OutputBuffer, createProgressReporter, lastLine, stripAnsi, redact } from "./output.js";
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
