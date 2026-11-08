# Contributing

Thanks for helping make CoderBaba better.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Run the CLI from source against your own OpenRouter key, with no login:

```bash
OPENROUTER_API_KEY=sk-or-... node packages/cli/dist/bin.js
```

Or against a local server:

```bash
CODERBABA_API_URL=http://localhost:3000 node packages/cli/dist/bin.js
```

## Guidelines

- Keep `packages/core` free of UI code. It emits events, and permissions go through `askPermission()`.
- Every write and shell command must go through the permission check. Paths must stay in the project unless the user allows them.
- Add or update Vitest tests next to the code you change.
- Add a changeset (`pnpm changeset`) for any change to a published package.
- Never commit secrets. The CLI must not contain any server key.
