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

| Command | |
| --- | --- |
| `/help` | show commands |
| `/new` | start a new chat |
| `/history` | list recent chats |
| `/usage` | show your free usage (also at [coderbaba.si/usage](https://coderbaba.si/usage)) |
| `/model` | pick Fast or Smart (after login) |
| `/undo` | revert the last turn's file changes |
| `/login`, `/logout` | sign in or out on this machine |
| `/exit` | quit |

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

Local state lives in `~/.coderbaba` (override with `CODERBABA_HOME`): `auth.json` (mode 600), `sessions/` and `checkpoints/`.

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
