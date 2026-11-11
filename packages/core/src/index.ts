export { SYSTEM_PROMPT, buildSystemPrompt, projectSlug } from "./prompt.js";
export type { SystemPromptOptions } from "./prompt.js";
export { INIT_TASK, NOTES_FILE, loadProjectNotes, projectNotesPath } from "./project-notes.js";
export { resolveInProject } from "./paths.js";
export { lineDiff } from "./diff.js";
export { applyExactEdit } from "./edit.js";
export { Checkpoints } from "./checkpoints.js";
export { CONFIG_EDIT_KEY, permissionKey } from "./permissions.js";
export type { PermissionDecision, PermissionRequest } from "./permissions.js";
export { CoderBabaError, friendlyMessage, isLoginCode } from "./errors.js";
export { runTool, runShell, runUserCommand, formatTodos, TOOL_DEFINITIONS } from "./tools.js";
export type { ToolEvent, ToolOptions, RunShellOptions, Todo, TodoStatus } from "./tools.js";
export { chatMarkdown, exportChat } from "./export.js";
export { shellInvocation, shellSpawn, killTree, killTreeSync, osLine } from "./platform.js";
export { baseCommandEnv, buildCommandEnv, findVenv, parseDotenv, secretValues } from "./command-env.js";
export type { CommandEnv } from "./command-env.js";
export { ProcessManager, portOpen } from "./processes.js";
export type { ProcessInfo, ProcessStatus, StartOptions, StartResult, WaitFor } from "./processes.js";
export { ensureEnvIgnored, envKeys, setEnvValue, upsertEnvLine } from "./secrets.js";
export type { AskSecret, SecretRequest } from "./secrets.js";
export { isSafeCommand, matchesUserRule, hasShellMeta, splitWords, askAlways } from "./safe-commands.js";
export type { SafeContext } from "./safe-commands.js";
export { loadAllowConfig, trustProject, activeRules, activeChecks, globalConfigPath, projectAllowPath } from "./allow-config.js";
export type { AllowConfig, CheckSpec } from "./allow-config.js";
export { OutputBuffer, createProgressReporter, lastLine, stripAnsi, redact } from "./output.js";
export { readSse, consumeSse } from "./sse.js";
export { DOCS_HOSTS, blockedHost, fetchPublicPage, htmlToText, isDocsHost, isPrivateAddress, pageSlice } from "./web.js";
export type { FetchOptions, FetchedPage, Lookup } from "./web.js";
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
export { CONTEXT_BUDGET, SUMMARY_PREFIX, compact, contextSize, cutPoints, fitContext, shortenOldOutputs } from "./context.js";
export type { CompactOptions, CompactResult } from "./context.js";
export { BrowserSession, checkPage, describePageCheck, isLocalPageUrl, problemCount } from "./browser.js";
export type { BrowserKind, PageCheck } from "./browser.js";
export { failureMessage, findAppFolders, globToRegExp, planChecks, runChecks } from "./checks.js";
export type { CheckResult, CheckSettings, PlannedCheck, RunChecksOptions } from "./checks.js";
export { runTurn } from "./agent.js";
export type { AgentEvent, ExtraTools, TurnOptions } from "./agent.js";
export * from "./security/index.js";

export function formatStatus(input: {
  modelLabel: string;
  project: string;
  direct: boolean;
  usage: import("@coderbabasi/shared").UsageResponse | null;
}): string {
  const where = `${input.modelLabel} · ${input.project}`;
  if (input.direct) return `${where} · your OpenRouter key`;
  if (input.usage?.type === "anonymous") {
    const { triesLeft } = input.usage;
    return triesLeft > 20 ? `${where} · free, no sign-in needed` : `${where} · ${triesLeft} free tasks left · /login to keep going (free)`;
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
