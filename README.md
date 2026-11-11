# CoderBaba

A beginner-friendly coding agent for your terminal.

```bash
npx coderbaba
```

That's it. You get 5 free tries with no login. After that, type your email and the 6-digit code we send to keep going for free. No browser, password, API key, model choice or config file.

## What it does

Describe a task in plain English. CoderBaba reads your project, explains what it's going to do, edits files and runs commands. Before every edit or command it asks:

```
CoderBaba wants to run npm install. Allow? (y / always / n)
```

- `/undo` reverts the last turn's file changes.
- It stays inside your project folder unless you allow more.
- The status bar shows your model, folder, and how much free usage is left.
- After it edits code, it runs your project's typecheck and lint (and `python manage.py check` for Django) and fixes what they report, up to two rounds.
- After it starts a web server, it opens the page in headless Chrome or Edge to catch console errors, crashes and failed requests. If neither is installed, it asks before downloading Chromium.
- It can read documentation pages with `read_url`. Well-known docs sites open without asking; other sites ask once per host. Private and local addresses are blocked.
- Long chats are summarized automatically when they get too big; `/compact` does it on demand.
- For bigger tasks it keeps a todo list, shown while it works.

| Command | |
| --- | --- |
| `/help` | show commands |
| `/new` | start a new chat |
| `/history` | list recent chats |
| `/usage` | show your free usage (also at [coderbaba.si/usage](https://coderbaba.si/usage)) |
| `/model` | pick Fast or Smart (after login) |
| `/undo` | revert the last turn's file changes |
| `/compact` | summarize the chat so far to free up room |
| `/init` | write `AGENTS.md`, notes that help CoderBaba understand this project |
| `/todos` | show this chat's todo list |
| `/export` | save this chat as a Markdown file in the project |
| `/ps`, `/stop`, `/restart` | list, stop or restart background processes such as dev servers |
| `/allow` | show which commands run without asking, and which checks run |
| `/login`, `/logout` | sign in or out on this machine |
| `/exit` | quit |
| `!command` | run a command yourself, such as `!npm test`; CoderBaba sees the output in your next message |

While CoderBaba works you can keep typing: Enter queues your next message and Esc clears the queue.

### Project notes

If your project has an `AGENTS.md` at its root, CoderBaba reads it at the start of every turn (up to 8,000 characters). Use it for how to run the app, which checks matter and your conventions. `/init` writes a first version for you, and CoderBaba keeps its "How to run" section current.

### Checks and allowed commands

Checks are detected per app folder (the nearest folder with `package.json`, `manage.py` or `pyproject.toml`). To choose them yourself, add a `checks` list to `.coderbaba/allow.json` in your project or to `~/.coderbaba/config.json`:

```json
{
  "allow": ["npm test"],
  "checks": [
    { "command": "npm run typecheck", "cwd": "web", "files": "web/src/**/*.ts*" },
    { "command": "python manage.py check", "cwd": "api" }
  ]
}
```

Configured checks replace the detected ones. `files` limits a check to matching edits, and `cwd` is the folder it runs in. Set `"checks": false` to turn checks off. A project file that adds rules or checks needs your approval once, and again whenever it changes.

## Packages

| Package | npm | |
| --- | --- | --- |
| [`packages/cli`](packages/cli) | `coderbaba` | Ink terminal UI and slash commands |
| [`packages/core`](packages/core) | `@coderbabasi/core` | UI-free agent loop, tools, permissions, `/undo`, API and login client, sessions |
| [`packages/shared`](packages/shared) | `@coderbabasi/shared` | API types, model allowlist, error codes |

`core` emits events and asks for permission through an injected `askPermission()` callback, so a desktop app can reuse it later.

## How it connects

The CLI talks only to the CoderBaba API at `https://coderbaba.si`. The OpenRouter key lives on that server and is never in this package. The server applies free-tier quotas and records usage.

Contributors can point the CLI elsewhere:

```bash
CODERBABA_API_URL=http://localhost:3000 npx coderbaba   # your own server
OPENROUTER_API_KEY=sk-or-... npx coderbaba              # call OpenRouter directly: no login, no usage tracking
```

Local state lives in `~/.coderbaba` (override with `CODERBABA_HOME`): `auth.json` (mode 600), `sessions/` and `checkpoints/`. Page screenshots go to `.coderbaba/screenshots/` in your project, which has its own `.gitignore`.

## Develop

Requires Node.js 20+ and pnpm 9.

```bash
pnpm install
pnpm build
pnpm test
node packages/cli/dist/bin.js
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases go through Changesets; see [.changeset/README.md](.changeset/README.md).

## License

[MIT](LICENSE)
