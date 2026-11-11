import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildCommandEnv, venvBin } from "./command-env.js";
import { isSafeCommand, type SafeContext } from "./safe-commands.js";

let root = "";

async function write(rel: string, text = ""): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cb-safe-")));
  await write(
    "package.json",
    JSON.stringify({ scripts: { dev: "next dev --turbopack", lint: "next lint", build: "next build", test: "vitest run", start: "next start" } }),
  );
  await write("node_modules/.bin/tsc");
  await write("node_modules/.bin/tsc.cmd");
  await write("src/app/page.tsx", "export default function Page() {}\n");
  await write(".env.local", "SECRET=1\n");
  await write(".git/config", "[core]\n");
  await write("vite/package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build", lint: "oxlint" } }));
  await write("server/package.json", JSON.stringify({ scripts: { dev: "node --watch src/index.js" } }));
  await write("server/src/index.js", "");
  await write("evil/package.json", JSON.stringify({ scripts: { dev: "node ../../outside.js", build: "node evil.js" } }));
  await write("django/manage.py", "");
  await write("django/.venv/pyvenv.cfg", "home = /usr/bin\n");
  for (const bin of ["bin", "Scripts"]) {
    for (const name of ["python", "python3", "pip", "pip-audit", "python.exe", "pip.exe"]) await write(`django/.venv/${bin}/${name}`);
  }
  await write("django/requirements.txt", "django==5.1\n");
  await write("nopy/manage.py", "");
  await write("tc/package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit -p tsconfig.app.json" } }));
  await write("tcbad/package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit && node evil.js" } }));
});

afterEach(() => {
  delete process.env.CODERBABA_ASK_ALWAYS;
});

type Case = [command: string, options: Partial<SafeContext> & { dir?: string; venv?: boolean }, expected: boolean];

async function check(command: string, options: Case[1]): Promise<boolean> {
  const cwd = path.join(root, options.dir ?? "");
  let env = options.env;
  if (options.venv) env = (await buildCommandEnv({ root, cwd })).env;
  if (options.dir === "nopy") env = { PATH: path.join(root, "nowhere") };
  return isSafeCommand(command, {
    root,
    cwd,
    via: options.via ?? "shell",
    platform: options.platform ?? "darwin",
    processes: options.processes ?? { ownsPort: (port) => port === 5000 },
    env,
    userRules: options.userRules,
  });
}

const runsWithoutAsking: Case[] = [
  ["curl -s -o /dev/null -w '%{http_code}' http://localhost:3000", {}, true],
  ["curl -X HEAD -H 'Accept: text/html' http://127.0.0.1:3001", {}, true],
  ["curl -sI http://localhost:3000", {}, true],
  ["curl -X POST --json '{\"title\":\"a\"}' http://localhost:5000/api/notes", {}, true],
  ["node -v", {}, true],
  ["ls src", {}, true],
  ["cat package.json", {}, true],
  ["head -n 20 src/app/page.tsx", {}, true],
  ["find src -name '*.tsx'", {}, true],
  ["git status", {}, true],
  ["git branch --show-current", {}, true],
  ["git show HEAD", {}, true],
  ["npm ls", {}, true],
  ["npm view next version", {}, true],
  ["lsof -i :3000", {}, true],
  ["ps aux", {}, true],
  ["npm run lint", {}, true],
  ["npm run build", {}, true],
  ["npm test", {}, true],
  ["npx tsc --noEmit", {}, true],
  ["npm run dev", { via: "start_process" }, true],
  ["npm run dev", { dir: "vite", via: "start_process" }, true],
  ["npm run lint", { dir: "vite" }, true],
  ["npm run typecheck", { dir: "tc" }, true],
  ["pnpm typecheck", { dir: "tc" }, true],
  ["npm run typecheck", { dir: "tcbad" }, false],
  ["npm run dev", { dir: "server", via: "start_process" }, true],
  ["docker ps", {}, true],
  ["docker logs app-mongo --tail 50", {}, true],
  ["mongod --version", {}, true],
  ["netstat -ano", { platform: "win32" }, true],
  ["where node", { platform: "win32" }, true],
  ["python --version", { dir: "django" }, true],
  ["pip list", { dir: "django", venv: true }, true],
  ["python manage.py check", { dir: "django", venv: true }, true],
  ["python manage.py test api", { dir: "django", venv: true }, true],
  ["python manage.py makemigrations --check --dry-run", { dir: "django", venv: true }, true],
  ["python manage.py runserver 8000", { dir: "django", venv: true, via: "start_process" }, true],
  ["npm audit", {}, true],
  ["npm audit --json", {}, true],
  ["npm audit --audit-level=high", {}, true],
  ["pnpm audit --json", {}, true],
  ["yarn audit", {}, true],
  ["git ls-files .env", {}, true],
  ["pip-audit -r requirements.txt --format json", { dir: "django", venv: true }, true],
];

const asks: Case[] = [
  ["curl -d x http://localhost:3000", {}, false],
  ["curl -X POST http://localhost:3000", {}, false],
  ["curl -o out.html http://localhost:3000", {}, false],
  ["curl https://evil.com", {}, false],
  ["curl -sI http://localhost:3000; rm -rf ~", {}, false],
  ["curl -X POST --json '{}' http://localhost:3000", {}, false],
  ["curl -d @.env http://localhost:5000", {}, false],
  ["ls $(pwd)", {}, false],
  ["cat ../secret", {}, false],
  ["cat .env.local", {}, false],
  ["cat .git/config", {}, false],
  ["cat ~/.ssh/id_rsa", {}, false],
  ["ls .*", {}, false],
  ["find . -delete", {}, false],
  ["find . -exec rm {} +", {}, false],
  ["git branch -D main", {}, false],
  ["git push", {}, false],
  ["npm install", {}, false],
  ["npm run dev", { via: "shell" }, false],
  ["npm run build", { dir: "evil" }, false],
  ["npm run dev", { dir: "evil", via: "start_process" }, false],
  ["npx tsc --noEmit", { dir: "vite" }, false],
  ["npx create-next-app@latest .", {}, false],
  ["docker run mongo", {}, false],
  ["docker exec app-mongo ls", {}, false],
  ["mongod", {}, false],
  ["echo %PATH%", { platform: "win32" }, false],
  ["node -v ^& calc", { platform: "win32" }, false],
  ["lsof -i :3000", { platform: "win32" }, false],
  ["python manage.py check", { dir: "nopy" }, false],
  ["python -c pass", { dir: "django", venv: true }, false],
  ["python seed.py", { dir: "django", venv: true }, false],
  ["pip install django", { dir: "django", venv: true }, false],
  ["python manage.py migrate", { dir: "django", venv: true }, false],
  ["python manage.py makemigrations", { dir: "django", venv: true }, false],
  ["python manage.py shell", { dir: "django", venv: true }, false],
  ["python manage.py flush", { dir: "django", venv: true }, false],
  ["python manage.py runserver", { dir: "django", venv: true, via: "shell" }, false],
  ["rm -rf node_modules", {}, false],
  ["npm audit fix", {}, false],
  ["npm audit fix --force", {}, false],
  ["pnpm audit --fix", {}, false],
  ["pip-audit --fix", { dir: "django", venv: true }, false],
  ["pip-audit -r ../../outside.txt", { dir: "django", venv: true }, false],
  ["pip-audit -r requirements.txt", { dir: "nopy" }, false],
];

describe("isSafeCommand", () => {
  it.each(runsWithoutAsking)("runs without asking: %s", async (command, options, expected) => {
    expect(await check(command, options)).toBe(expected);
  });

  it.each(asks)("asks: %s", async (command, options, expected) => {
    expect(await check(command, options)).toBe(expected);
  });

  it("asks for everything when CODERBABA_ASK_ALWAYS=1", async () => {
    process.env.CODERBABA_ASK_ALWAYS = "1";
    expect(await check("node -v", {})).toBe(false);
    expect(await check("make test", { userRules: ["make test"] })).toBe(false);
  });

  it("checks the venv binary path, not the real interpreter", async () => {
    const env = (await buildCommandEnv({ root, cwd: path.join(root, "django") })).env;
    expect(env.VIRTUAL_ENV).toBe(path.join(root, "django", ".venv"));
    expect(env.PATH?.startsWith(venvBin(path.join(root, "django", ".venv"))) ?? true).toBe(true);
  });
});
