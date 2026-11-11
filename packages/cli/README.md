# coderbaba: free, open-source AI coding agent for your terminal

CoderBaba is a free AI coding agent that runs in your terminal. Describe what you want in plain English, and it reads your project, edits files, runs commands, starts your dev server, tests the page in a real browser, and fixes the errors it finds. It asks before every change, and `/undo` reverts any turn.

```bash
npx coderbaba
```

No sign-in, API key or config file needed: 1,000 free tasks per device on the Fast model. Log in with your email and a 6-digit code (also free) to unlock the Smart model.

## Features

- **Builds apps from a description:** Next.js, MERN (MongoDB, Express, React, Node), Django + React, Python and Node.js projects.
- **Checks its own work:** runs your TypeScript type checks, ESLint, Django checks and dependency audits after every edit, and fixes what they report.
- **Real browser testing:** opens your app in headless Chrome or Edge to catch console errors, crashes and failed requests.
- **AI security scanner:** `/security` finds vulnerabilities such as missing auth checks, injection and XSS, writes `SECURITY_REPORT.md`, reproduces findings, fixes them, and reviews diffs before you push.
- **Dev server management:** starts, restarts and watches background processes and databases.
- **Safe by design:** asks before edits and commands, stays in your project folder, keeps secrets out of chat, and `/undo` reverts changes.
- **Open models only:** Cohere North Mini Code (Fast) and Qwen3-Coder-Next (Smart), with provider data collection denied.
- **Works everywhere:** macOS, Linux and Windows, with Node.js 20+.

Full documentation: [github.com/CoderBaba-si/coderbaba](https://github.com/CoderBaba-si/coderbaba#readme) · Website: [coderbaba.si](https://coderbaba.si) · [YouTube](https://www.youtube.com/@CoderBabaSI) · [X](https://x.com/coderbabasi)

MIT licensed.
