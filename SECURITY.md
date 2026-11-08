# Security

Please report vulnerabilities privately to security@coderbaba.si rather than in a public issue. We aim to reply within three working days.

Relevant design points:

- The CLI never contains our OpenRouter key. It sends only an opaque CoderBaba token to `https://coderbaba.si`.
- Tokens are stored in `~/.coderbaba/auth.json` with file mode 600. The server stores only a SHA-256 hash of each token.
- File edits and shell commands require the user's approval. Paths outside the project folder are blocked unless the user allows them.
