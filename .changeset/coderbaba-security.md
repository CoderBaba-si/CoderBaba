---
"coderbaba": minor
"@coderbabasi/core": minor
---

CoderBaba Security. `/security` scans the project in phases (threat model, one review per app folder, then dedupe and ranking) and writes `SECURITY_REPORT.md`. `/security validate` reproduces findings against the app on localhost, `/security fix <id>` fixes one and checks the fix, `/security diff [base]` reviews recent changes, and `/security status` lists findings. Edits to `package.json`, lockfiles or `requirements.txt` now run a dependency audit that warns without blocking. The agent follows secure-coding defaults, `npm audit`, `pnpm audit`, `yarn audit`, project-venv `pip-audit` and `git ls-files` run without asking, and requests with your own OpenRouter key only go to providers that don't collect prompt data.
