# gcm

Generate conventional commit messages, branch names and PR descriptions using Google Gemini (Generative Language API).

Usage:

```bash
GEMINI_API_KEY=... bun run ./gcm.ts
```

Run tests:

```bash
bun test
```

Notes:

- Make sure to set the environment variable `GOOGLE_GEMINI_API_KEY` before running the script.
- Prefer `bun` to install dependencies: `bun install` then `bun run ./gcm.ts`.
