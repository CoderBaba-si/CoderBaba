# CoderBaba: free, open-source AI coding agent for your terminal

**CoderBaba is a free, open-source AI coding agent that runs in your terminal.** Describe what you want in plain English, and CoderBaba reads your project, plans the work, edits files, runs commands, starts your dev server, checks the page in a real browser, and fixes the errors it finds. It asks before every change, and `/undo` reverts any turn.

```bash
npx coderbaba
```

No sign-in, API key, credit card, or config file needed. You get 1,000 free tasks per device on the Fast model. Log in with your email (also free) to unlock the Smart model.

[Website](https://coderbaba.si) · [npm](https://www.npmjs.com/package/coderbaba) · [YouTube](https://www.youtube.com/@CoderBabaSI) · [X (Twitter)](https://x.com/coderbabasi) · [MIT license](LICENSE)

---

## Contents

- [Who CoderBaba is for](#who-coderbaba-is-for)
- [What CoderBaba can do](#what-coderbaba-can-do)
- [CoderBaba Security](#coderbaba-security)
- [Supported stacks](#supported-stacks)
- [Models](#models)
- [Safety and permissions](#safety-and-permissions)
- [Privacy](#privacy)
- [Commands](#commands)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Packages and development](#packages-and-development)

## Who CoderBaba is for

- **Beginners and students** who want to build a real app without learning every tool first. CoderBaba explains each step in plain language before it does it.
- **Developers** who want a terminal coding agent that runs the app, checks it, and fixes it, instead of only writing code.
- **Anyone who wants a free AI coding assistant** built on open models, with no subscription and no API key.

CoderBaba works on **macOS, Linux and Windows**, and needs **Node.js 20 or newer**.

## What CoderBaba can do

### Build apps from a plain-English description

Ask for "a notes app with login" or "a Django API with a React frontend" and CoderBaba scaffolds the project, installs dependencies, writes the code, and starts it. For tasks with more than a few steps it writes a **todo list** first and updates it as it works, so you can follow the plan.

### Read, search and edit your code

CoderBaba lists folders, reads files and searches your code with grep before it changes anything. It edits files with targeted changes rather than rewriting whole files, and it never invents the contents of files it hasn't read.

### Run commands, dev servers and databases

- Runs shell commands such as `npm install`, `pip install` or `git status`, and reads their output.
- Starts **long-running processes** (dev servers, API servers, watchers, databases) in the background, detects their port and URL, and restarts them after changes.
- Notices when a port is already in use and tells you.
- `/ps`, `/stop` and `/restart` let you manage those processes yourself.

### Check its own work automatically

After every edit, CoderBaba runs your project's own checks and fixes what they report, up to two rounds:

- **TypeScript type checks** and **ESLint**.
- **Django's `manage.py check`**.
- **Dependency audits** (`npm audit`, `pnpm audit`, `yarn audit` or `pip-audit`) when you change dependency files. These warn you about known vulnerable packages without blocking your work.

Checks are found per app folder, so a repo with `client/` and `server/` gets the right checks for each.

### Test pages in a real browser

When a web page is running, CoderBaba opens it in **headless Chrome or Edge** and catches uncaught errors, console errors, crashes and failed network requests, which `curl` can't see. It can take a **screenshot** when you want to see the page. If neither browser is installed, it asks before downloading Chromium.

### Read documentation

CoderBaba reads documentation pages with `read_url` when a command fails on changed flags or it needs current package versions. Well-known docs sites open without asking, including:
- nextjs.org, react.dev, vite.dev and tailwindcss.com
- docs.djangoproject.com and docs.python.org
- developer.mozilla.org, nodejs.org, expressjs.com and mongoosejs.com
- npm, PyPI and GitHub

Other sites ask once per host, and private or local addresses are blocked.

### Handle secrets safely

CoderBaba never asks for passwords or API keys in chat. When your app needs a secret, it prompts you for it directly and saves it to `.env`, so the model never sees the value. It keeps `.env` out of git, writes a `.env.example` with names only, and redacts secret values from command output.

### Remember your project

- **`AGENTS.md` project notes:** CoderBaba reads `AGENTS.md` at the start of every turn and keeps its "How to run" section current. `/init` writes a first version for you.
- **Chat history:** chats are saved on your machine, and `/history` lists recent ones.
- **Long chats:** these are summarized automatically when they get too big for the model, and `/compact` does it on demand.
- **`/export`:** saves a chat as Markdown.

### Undo anything

CoderBaba saves a checkpoint of every file it touches. `/undo` reverts the last turn's file changes, even if your project doesn't use git.

## CoderBaba Security

CoderBaba includes an **AI security scanner** that reviews your whole project the way a security engineer would, then helps you fix what it finds.

| Command | What it does |
| --- | --- |
| `/security` | Deep scan. Maps your app first (routes, how login works, where data lives, where untrusted input enters), then reviews each app folder against that map and writes `SECURITY_REPORT.md`. |
| `/security validate [id]` | Tries to reproduce findings against your app running on localhost, and marks each one confirmed or a false positive. |
| `/security fix <id>` | Fixes one finding, runs your checks, and verifies the fix. |
| `/security diff [base]` | Reviews your uncommitted changes, or your branch against a base branch, before you push. |
| `/security status` | Lists findings and their status. |

It looks for the issues that cause most real breaches in small apps:
- Missing authentication or authorization checks, including records loaded by id that don't belong to the current user (IDOR).
- SQL and NoSQL injection, command injection and `eval` of user input.
- Cross-site scripting (XSS) through `dangerouslySetInnerHTML`, `innerHTML`, `v-html` or Django's `|safe`.
- Passwords stored or logged in plain text.
- Hard-coded secrets, unsafe CORS settings, and Django `DEBUG` left on.
- Known vulnerable dependencies.

Findings are stored in `.coderbaba/security/`, which is kept out of git. Secret values are redacted from the report.

**Secure by default:** even without `/security`, CoderBaba writes code with parameterized queries, hashed passwords (bcrypt, argon2 or Django auth), auth checks on routes that change data, and request validation (zod, express-validator or DRF serializers).

## Supported stacks

CoderBaba works with any project it can read and run. It has built-in, tested setup steps for:

- **Next.js** (TypeScript, Tailwind, App Router).
- **MERN:** MongoDB, Express, React (Vite) and Node, with an API proxy so there are no CORS errors.
- **Django + React**, and Django on its own.
- **Python** projects with automatic virtual environments, using `uv` when it's installed and `venv` otherwise. It never runs `pip install` outside the virtual environment.
- **Node.js** projects using npm, pnpm or yarn.

On Windows it runs commands in `cmd.exe` and uses Windows forms of commands. On macOS and Linux it uses `sh`.

## Models

CoderBaba uses open models only, served through CoderBaba's free cloud:

| Model | Runs | Who can use it |
| --- | --- | --- |
| **Fast** | Cohere North Mini Code | Everyone, no sign-in |
| **Smart** | Qwen3-Coder-Next | Free after email login |

Pick a model with `/model`. Contributors can also bring their own [OpenRouter](https://openrouter.ai) key (see [Configuration](#configuration)).

## Safety and permissions

- **Asks before acting.** Before every file edit or command, CoderBaba shows what it wants to do and asks:

  ```
  CoderBaba wants to run npm install. Allow? (y / always / n)
  ```

- **Safe read-only commands run without asking.** Examples are `git status`, `git diff`, version checks, `npm audit` and `curl` to your own localhost. `/allow` shows the full list, and you can add your own.
- **Stays in your project folder.** It won't read or write outside the project unless you allow it.
- **No interactive commands.** stdin is closed, so commands can't hang waiting for input.
- **Undo.** `/undo` reverts the last turn's file changes.
- **Project config needs approval.** If a project's `.coderbaba/allow.json` adds allowed commands or checks, CoderBaba asks you once, and again whenever the file changes. A cloned repo can't silently grant itself permissions.

## Privacy

- The CLI talks only to the CoderBaba API at `https://coderbaba.si`. The model API key lives on that server, never on your machine.
- Requests are sent with OpenRouter's `data_collection: "deny"`, so they only go to model providers whose policy is not to collect or train on your prompts.
- Secret values from `.env` files are redacted from everything CoderBaba's tools return, including file reads and command output, so the model doesn't see them.
- Your login token is stored in `~/.coderbaba/auth.json` with owner-only permissions (mode 600).

## Commands

| Command | |
| --- | --- |
| `/help` | show commands |
| `/new` | start a new chat |
| `/history` | list recent chats |
| `/usage` | show your free usage (also at [coderbaba.si/usage](https://coderbaba.si/usage)) |
| `/model` | pick Fast or Smart |
| `/undo` | revert the last turn's file changes |
| `/compact` | summarize the chat so far to free up room |
| `/init` | write `AGENTS.md`, notes that help CoderBaba understand this project |
| `/security` | scan this project for security issues (see [CoderBaba Security](#coderbaba-security)) |
| `/todos` | show this chat's todo list |
| `/export` | save this chat as a Markdown file in the project |
| `/ps`, `/stop`, `/restart` | list, stop or restart background processes such as dev servers |
| `/allow` | show which commands run without asking, and which checks run |
| `/login`, `/logout` | log in or out on this machine (free) |
| `/exit` | quit |
| `!command` | run a command yourself, such as `!npm test`; CoderBaba sees the output in your next message |

While CoderBaba works you can keep typing: Enter queues your next message and Esc clears the queue.

## Configuration

CoderBaba works with no configuration. To customize it:

### Project notes

Put an `AGENTS.md` at your project root with how to run the app, which checks matter, and your conventions. CoderBaba reads up to 8,000 characters of it every turn.

### Checks and allowed commands

Add a `checks` list to `.coderbaba/allow.json` in your project, or to `~/.coderbaba/config.json` for all projects:

```json
{
  "allow": ["npm test"],
  "checks": [
    { "command": "npm run typecheck", "cwd": "web", "files": "web/src/**/*.ts*" },
    { "command": "python manage.py check", "cwd": "api" }
  ]
}
```

Configured checks replace the detected ones. `files` limits a check to matching edits, and `cwd` is the folder it runs in. Set `"checks": false` to turn checks off.

### Environment variables

```bash
CODERBABA_API_URL=http://localhost:3000 npx coderbaba   # use your own CoderBaba server
OPENROUTER_API_KEY=sk-or-... npx coderbaba              # call OpenRouter directly: no login, no usage tracking
CODERBABA_HOME=~/somewhere-else npx coderbaba           # move local state (default ~/.coderbaba)
```

Local state lives in `~/.coderbaba`: `auth.json`, `sessions/` and `checkpoints/`. Page screenshots go to `.coderbaba/screenshots/` in your project, which has its own `.gitignore`.

## FAQ

### What is CoderBaba?

CoderBaba is a free, open-source AI coding agent for the terminal. You describe a task in plain English, and it edits your code, runs commands, starts your app, tests it in a browser, and fixes errors, asking your permission before each change.

### Is CoderBaba free?

Yes. The CLI is MIT-licensed, and the hosted models are free: 1,000 tasks per device with no sign-in, and more, plus the Smart model, with a free email login. There is no paid plan.

### Do I need an API key or an account?

No. Run `npx coderbaba` and start typing. An account is optional and only unlocks the Smart model. If you prefer, you can use your own OpenRouter key instead.

### Which AI models does CoderBaba use?

Open models only: Cohere North Mini Code for Fast and Qwen3-Coder-Next for Smart, served through OpenRouter with data collection denied.

### Is CoderBaba good for beginners?

Yes, that's who it's designed for. It explains each step in plain language, asks before every change, sets up virtual environments and dev servers for you, handles secrets without showing them in chat, and `/undo` reverts any mistake.

### Can CoderBaba find security vulnerabilities in my code?

Yes. `/security` runs a deep scan and writes `SECURITY_REPORT.md`. `/security validate` reproduces findings against your running app, `/security fix <id>` fixes one, and `/security diff` reviews changes before you push.

### Does CoderBaba work on Windows?

Yes. CoderBaba runs on Windows, macOS and Linux with Node.js 20 or newer.

### Is my code used to train AI models?

No. Requests use OpenRouter's `data_collection: "deny"` setting, which only routes to providers whose policy is not to collect or train on prompts, and secret values from `.env` are redacted before anything reaches the model.

### How is CoderBaba different from an AI chat assistant?

A chat assistant gives you code to copy. CoderBaba is an agent: it works inside your project, makes the changes, runs the app, checks the result with your type checker, linter and a real browser, and fixes problems before it says it's done.

### Can I use CoderBaba with my own server or model key?

Yes. Set `CODERBABA_API_URL` to point at your own CoderBaba server, or `OPENROUTER_API_KEY` to call OpenRouter directly.

## Packages and development

| Package | npm | |
| --- | --- | --- |
| [`packages/cli`](packages/cli) | [`coderbaba`](https://www.npmjs.com/package/coderbaba) | Ink terminal UI and slash commands |
| [`packages/core`](packages/core) | `@coderbabasi/core` | UI-free agent loop, tools, permissions, checks, security scans, `/undo`, API and login client, sessions |
| [`packages/shared`](packages/shared) | `@coderbabasi/shared` | API types, model allowlist, error codes |

`core` emits events and asks for permission through an injected `askPermission()` callback, so other front ends can reuse it.

Development requires Node.js 20+ and pnpm 9:

```bash
pnpm install
pnpm build
pnpm test
node packages/cli/dist/bin.js
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability. Releases go through Changesets; see [.changeset/README.md](.changeset/README.md).

## License

[MIT](LICENSE). Made by [CoderBaba.SI](https://coderbaba.si). Follow along on [YouTube](https://www.youtube.com/@CoderBabaSI) and [X](https://x.com/coderbabasi).
