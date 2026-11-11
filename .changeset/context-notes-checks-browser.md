---
"coderbaba": minor
"@coderbabasi/core": minor
---

Long chats are summarized automatically, and `/compact` does it on demand. A project's `AGENTS.md` is read every turn, and `/init` writes one. After edits, CoderBaba runs the project's typecheck, lint or Django checks and fixes failures. The new `read_url` tool reads documentation pages, and the new `check_page` tool loads local pages in headless Chrome or Edge to catch browser errors. Bigger tasks get a todo list. Also new: `!command` runs a command yourself, messages typed while CoderBaba works are queued, and `/export` saves the chat as Markdown.
