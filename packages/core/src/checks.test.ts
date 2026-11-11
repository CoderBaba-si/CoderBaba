import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "./agent.js";
import { activeChecks, loadAllowConfig, trustProject } from "./allow-config.js";
import { Checkpoints } from "./checkpoints.js";
import { failureMessage, globToRegExp, planChecks, runChecks } from "./checks.js";
import type { Llm, LlmResult } from "./llm.js";

let root = "";
let home = "";
const previousHome = process.env.CODERBABA_HOME;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cb-checks-")));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cb-checks-home-"));
  process.env.CODERBABA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODERBABA_HOME;
  else process.env.CODERBABA_HOME = previousHome;
});

async function write(rel: string, text: string): Promise<string> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
  return full;
}

describe("globToRegExp", () => {
  it("matches folders, names, and alternatives", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/c.ts")).toBe(false);
    expect(globToRegExp("**/*.{ts,tsx}").test("client/App.tsx")).toBe(true);
    expect(globToRegExp("server/**").test("server/api/views.py")).toBe(true);
    expect(globToRegExp("*.py").test("a.pyc")).toBe(false);
  });
});

describe("planChecks", () => {
  beforeEach(async () => {
    await write("client/package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } }));
    await write("server/manage.py", "");
    await write("web/package.json", JSON.stringify({ scripts: { lint: "eslint . --fix" } }));
  });

  it("picks detected checks per app folder for code files only", async () => {
    const files = [
      await write("client/src/App.tsx", ""),
      await write("client/src/main.tsx", ""),
      await write("server/api/views.py", ""),
      await write("README.md", ""),
    ];
    const planned = await planChecks(root, files, { configured: [], disabled: false });
    expect(planned.map((check) => [check.rel, check.command])).toEqual([
      ["client", "npm run typecheck"],
      ["client", "npm run lint"],
      ["server", "python manage.py check"],
    ]);
  });

  it("skips docs, lint scripts that fix files, and dependency folders", async () => {
    const files = [await write("README.md", ""), await write("web/src/a.js", ""), await write("client/node_modules/x/index.js", "")];
    expect(await planChecks(root, files, { configured: [], disabled: false })).toEqual([]);
  });

  it("uses configured checks instead of detection, matched by glob", async () => {
    const files = [await write("client/src/App.tsx", "")];
    const planned = await planChecks(root, files, {
      configured: [
        { command: "make check", files: "client/**/*.tsx", cwd: "client" },
        { command: "make py", files: "**/*.py" },
      ],
      disabled: false,
    });
    expect(planned).toEqual([{ command: "make check", folder: path.join(root, "client"), rel: "client", source: "config" }]);
  });

  it("runs nothing when checks are off", async () => {
    const files = [await write("client/src/App.tsx", "")];
    expect(await planChecks(root, files, { configured: [], disabled: true })).toEqual([]);
    const deps = [await write("client/package-lock.json", "{}")];
    expect(await planChecks(root, deps, { configured: [], disabled: true })).toEqual([]);
  });

  it("plans an advisory audit when dependency files change", async () => {
    await write("web/pnpm-lock.yaml", "");
    const files = [await write("client/package.json", "{}"), await write("client/package-lock.json", "{}"), path.join(root, "web/pnpm-lock.yaml")];
    const planned = await planChecks(root, files, { configured: [], disabled: false });
    expect(planned.map((check) => [check.rel, check.command, check.advisory])).toEqual([
      ["client", "npm audit --audit-level=high", true],
      ["web", "pnpm audit --audit-level=high", true],
    ]);
  });

  it("adds audits next to configured checks, and only pip-audit from the venv", async () => {
    const files = [await write("client/package.json", "{}"), await write("server/requirements.txt", "django\n")];
    const planned = await planChecks(root, files, { configured: [{ command: "make check" }], disabled: false });
    expect(planned.map((check) => check.command)).toEqual(["npm audit --audit-level=high"]);

    await write("server/.venv/pyvenv.cfg", "home = /usr/bin\n");
    await write(`server/.venv/${process.platform === "win32" ? "Scripts/pip-audit.exe" : "bin/pip-audit"}`, "");
    const withVenv = await planChecks(root, files, { configured: [], disabled: false });
    expect(withVenv.map((check) => [check.rel, check.command])).toEqual([
      ["client", "npm audit --audit-level=high"],
      ["server", "pip-audit -r requirements.txt"],
    ]);
  });
});

describe("runChecks", () => {
  it("runs configured checks, skips unsafe detected ones, and reports failures", async () => {
    await write("fail.js", "console.error('Type error in App.tsx'); process.exit(1);\n");
    const results = await runChecks(
      [
        { command: "node fail.js", folder: root, rel: "", source: "config" },
        { command: "rm -rf build", folder: root, rel: "", source: "detected" },
      ],
      { root },
    );
    expect(results[0]).toMatchObject({ passed: false });
    expect(results[0]!.output).toContain("Type error in App.tsx");
    expect(results[1]).toMatchObject({ passed: true, skipped: "it is not on the safe-command list" });
    const message = failureMessage(results);
    expect(message).toContain("$ node fail.js");
    expect(message).not.toContain("rm -rf");
  });

  it("keeps failed audits out of the message for the model", async () => {
    await write("fail.js", "process.exit(1);\n");
    await write("audit.js", "console.log('3 high severity vulnerabilities'); process.exit(1);\n");
    const results = await runChecks(
      [
        { command: "node fail.js", folder: root, rel: "", source: "config" },
        { command: "node audit.js", folder: root, rel: "", source: "config", advisory: true },
      ],
      { root },
    );
    expect(results[1]).toMatchObject({ passed: false, advisory: true });
    const message = failureMessage(results);
    expect(message).toContain("$ node fail.js");
    expect(message).not.toContain("node audit.js");
  });

  it("treats an audit that can't reach the registry as skipped", async () => {
    await write("offline.js", "console.error('npm error code ENOTFOUND'); process.exit(1);\n");
    const [result] = await runChecks([{ command: "node offline.js", folder: root, rel: "", source: "config", advisory: true }], { root });
    expect(result).toMatchObject({ passed: true, skipped: "the package registry couldn't be reached" });
  });
});

describe("checks after edits in runTurn", () => {
  function scripted(results: LlmResult[]): Llm {
    return {
      async chat() {
        const next = results.shift();
        if (!next) throw new Error("no scripted response");
        return next;
      },
    };
  }

  const edit = (id: string, oldString: string, newString: string): LlmResult => ({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id, name: "edit_file", arguments: JSON.stringify({ path: "app.js", old_string: oldString, new_string: newString }) }],
  });
  const finish: LlmResult = { content: "Done.", finishReason: "stop", toolCalls: [] };

  async function turn(results: LlmResult[]) {
    await write("app.js", "ok\n");
    await write("check.js", "const t = require('fs').readFileSync('app.js','utf8'); if (t.includes('bug')) { console.error('found bug'); process.exit(1); }\n");
    const events: string[] = [];
    const result = await runTurn({
      task: "change app",
      cwd: root,
      model: "fast",
      taskId: "t",
      messages: [],
      llm: scripted(results),
      askPermission: async () => "allow",
      allows: new Set(),
      checkpoints: new Checkpoints(path.join(root, ".checkpoints")),
      maxSteps: 12,
      onEvent: (event) => {
        if (event.type === "tool" && event.event.name === "check") events.push(event.event.passed ? "pass" : "fail");
      },
      checks: { configured: [{ command: "node check.js" }], disabled: false },
    });
    return { result, events };
  }

  it("feeds failures back and finishes once the checks pass", async () => {
    const { result, events } = await turn([edit("1", "ok", "bug"), finish, edit("2", "bug", "fixed"), finish]);
    expect(events).toEqual(["fail", "pass"]);
    const feedback = result.messages.find((message) => message.content?.startsWith("Checks failed after your edits"));
    expect(feedback?.content).toContain("found bug");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "Done." });
  });

  it("stops after two fix rounds", async () => {
    const { events } = await turn([edit("1", "ok", "bug"), finish, finish, finish]);
    expect(events).toEqual(["fail", "fail", "fail"]);
  });

  it("does not run checks when nothing was edited", async () => {
    const { events } = await turn([finish]);
    expect(events).toEqual([]);
  });
});

describe("checks in config", () => {
  it("needs trust for project checks and honors checks: false", async () => {
    await write(".coderbaba/allow.json", JSON.stringify({ checks: [{ command: "npm run typecheck", files: "src/**" }] }));
    let config = await loadAllowConfig(root);
    expect(config.trusted).toBe(false);
    expect(activeChecks(config).configured).toEqual([]);
    await trustProject(root, config.projectHash!);
    config = await loadAllowConfig(root);
    expect(activeChecks(config).configured).toEqual([{ command: "npm run typecheck", files: "src/**", cwd: undefined }]);

    await write(".coderbaba/allow.json", JSON.stringify({ checks: false }));
    config = await loadAllowConfig(root);
    expect(activeChecks(config)).toEqual({ configured: [], disabled: true });
  });
});
