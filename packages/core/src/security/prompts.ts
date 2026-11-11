import type { Finding } from "./store.js";

const RULES = `Rules for every security step:
- Never print, copy, or record secret values. Name the variable and where it is set instead.
- Don't install packages, don't run audit fix, and don't change code unless this step says so.
- Record only issues you confirmed by reading the code: trace where the input comes from and where it ends up, across files. Skip style nits and theoretical issues nobody can reach.`;

const CHECKLIST = `What to look for:
- Injection: SQL built with string concatenation or template strings, Mongo filters taken straight from req.body or req.query (operator injection such as {"$ne": null}), user input passed to exec, spawn with shell, eval, or subprocess with shell=True.
- Missing auth: routes that create, change, or delete data without an auth check.
- Broken access control: records loaded by an id from the URL or body without checking that they belong to the current user.
- Secrets: hardcoded API keys, passwords, tokens, or connection strings in source files. .env files missing from .gitignore or tracked by git (git ls-files).
- Config: CORS origin * together with credentials, Django DEBUG on outside .env, a hardcoded or weak SECRET_KEY, ALLOWED_HOSTS ["*"], cookies without httpOnly or secure, JWTs signed with a guessable secret or never verified.
- Passwords stored or compared without bcrypt, argon2, or Django's auth.
- XSS: dangerouslySetInnerHTML, innerHTML, v-html, or Django |safe and mark_safe with user data.
- SSRF: the server fetching a URL the user controls.
- Missing validation of request bodies that reach the database or the file system, including path traversal in file reads and uploads.
- Dependencies: run npm audit --json (or pnpm audit --json, yarn audit --json, matching the lockfile) in the folder, and pip-audit -r requirements.txt --format json only if the project's virtual environment already has pip-audit. Record each high or critical advisory as one finding with category dependency, naming the package and the fixed version.`;

export function threatModelTask(folders: string[]): string {
  const list = folders.map((folder) => folder || "(project root)").join(", ");
  return `Security scan, step 1 of 3: build a threat model of this project.
App folders found: ${list}.
Read the code (entry points, route files, middleware, settings, models, package.json or requirements.txt). Don't start servers.
Then call save_threat_model once with short Markdown sections:
## Apps (each folder, its stack, how it starts)
## Entry points (routes and pages, marked public or logged-in)
## Auth (how users log in, where sessions or tokens are checked)
## Data (databases, file storage, external APIs)
## Secrets (variable names only)
## Trust boundaries (where untrusted input enters)
Pass not_checked for what you can't see from the code, such as hosting settings.
${RULES}
Finish with one sentence saying the threat model is saved.`;
}

export function investigateTask(opts: { folder: string; index: number; total: number; threatModel: string; skip: string[] }): string {
  const where = opts.folder ? `the ${opts.folder}/ folder` : "the project root";
  const skip = opts.skip.length ? `\nOther folders are reviewed separately; skip ${opts.skip.map((folder) => `${folder}/`).join(", ")}.` : "";
  return `Security scan, step 2 of 3 (folder ${opts.index} of ${opts.total}): review ${where} for security issues.${skip}
Threat model:
${opts.threatModel || "(none saved)"}

${CHECKLIST}

Call record_finding for each issue with folder "${opts.folder}", the file, and the line. Use high when an outsider can read or change other people's data, run code, or take over accounts; medium when it needs special conditions or a logged-in user; low for hardening.
${RULES}
Finish with one sentence: how many findings you recorded for this folder.`;
}

function findingJson(findings: Finding[]): string {
  return JSON.stringify(
    findings.map(({ id, title, severity, category, folder, file, line, risk, status, chain }) => ({ id, title, severity, category, folder, file, line, risk, status, chain })),
    null,
    1,
  );
}

export function aggregateTask(findings: Finding[], threatModel: string): string {
  return `Security scan, step 3 of 3: review all findings together.
Threat model:
${threatModel || "(none saved)"}

Findings:
${findingJson(findings)}

Use update_finding to:
- Mark repeats: status duplicate with duplicate_of the one to keep.
- Link findings that combine into one bigger attack with the same chain label, such as "account takeover".
- Raise or lower severity using the threat model (for example, an issue only reachable by admins is lower).
- Set priority 1, 2, 3, ... on the remaining findings, most urgent first.
Read code again only when you need to settle a question. Don't record new findings unless two findings combine into a new issue.
${RULES}
Finish with a short summary for the user: the three most urgent findings by id, in plain language.`;
}

export function validateTask(findings: Finding[], threatModel: string): string {
  return `Security validation: check whether these findings are real by reproducing them against the app running on this machine.
Threat model:
${threatModel || "(none saved)"}

Findings:
${findingJson(findings)}

How:
- Start what you need with start_process (as described in AGENTS.md or the threat model) and wait for the port.
- Reproduce each finding with curl against http://localhost or 127.0.0.1 only, or check_page for browser issues. Never send requests to any other host.
- Use test data you create, such as a throwaway user. Never delete or overwrite existing records, and never run destructive database commands.
- For findings that can't be shown with a request (hardcoded secrets, weak config, dependencies), confirm by reading the code or audit output instead.
- Then call update_finding for each: status confirmed (it reproduced), false_positive (it didn't, and the code shows why), or needs_review (you couldn't tell). Put the command you ran and a short response excerpt in evidence.
- Stop any processes you started for this when you're done, unless they were already running.
${RULES}
Finish with one line per finding: id, result, and why.`;
}

export function fixTask(finding: Finding): string {
  const reproduce = finding.evidence
    ? `It was reproduced like this:\n${finding.evidence}\nAfter the fix, run the same reproduction again against localhost and check that it no longer works.`
    : "If you can show it with a localhost request, do so before and after the fix.";
  return `Fix security finding ${finding.id}: ${finding.title}.
Where: ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : finding.folder || "project"}
Risk: ${finding.risk}
Suggested fix: ${finding.fix}

Make the smallest change that fixes the root cause with edit_file, and keep the app working. ${reproduce}
Then call update_finding ${finding.id} with status fixed and evidence describing what changed and how you checked it. If you couldn't fix it, explain why and leave the status as it is.
Never print or record secret values.`;
}

export function diffReviewTask(base?: string): string {
  const scope = base
    ? `the changes on this branch: run git diff ${base}...HEAD`
    : "the uncommitted changes: run git diff, git diff --cached, and git status --porcelain to find new untracked files, then read those";
  return `Security review of recent changes. Review only ${scope}.
Read enough surrounding code to know where the changed code's inputs come from.

${CHECKLIST}

Run the dependency audit only if package.json, a lockfile, or requirements.txt changed.
Call record_finding for each issue in the changed code, with the file and line.
${RULES}
Finish with a short verdict: safe to commit, or the findings to fix first by id.`;
}
