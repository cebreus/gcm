# GCM

Generate Conventional Commit messages from staged changes or existing commits with Gemini, OpenAI-compatible APIs, or LM Studio.

Default: GCM generate commit message. `full` mode also generate branch name, PR title, PR description. Review every result before any Git write.

## Requirements

- [Bun](https://bun.sh/) 1.4+
- Git
- [Google Gemini API key](https://aistudio.google.com/app/apikey), or LM Studio running locally

## Install

```bash
git clone https://github.com/cebreus/scripts.git
cd scripts
bun install
export GOOGLE_GEMINI_API_KEY="your_api_key_here"
bun run ./gcm.ts --help
```

Create key in [Google AI Studio](https://aistudio.google.com/app/apikey), replace `your_api_key_here` with it, run `export` command. Applies only to current terminal; add same line to `~/.zshrc` to keep after restart. Never commit or share key.

## Use

```bash
# Generate from staged changes
gcm

# Generate all four artifacts
gcm --mode full

# Review an existing commit
gcm --commit HEAD

# Process a frozen first-parent range, one commit at a time
gcm --commit-range 'd803946^..HEAD' --mode commit-only --non-interactive --apply

# Process only a narrower inclusive range from abc123 through def456
gcm --commit-range 'abc123^..def456' --mode commit-only --non-interactive --apply

# Generate without prompts; add --apply to perform the available Git action
gcm --commit HEAD --mode commit-only --model gemini-3.7-flash --non-interactive

# Exclude generated files from Gemini analysis
gcm --exclude 'dist/*'

# List models available to your API key
gcm --list-models

# Use local LM Studio
GCM_PROVIDER=lm-studio gcm
```

From source checkout, replace `gcm` with `bun run ./gcm.ts`.

Interactive flow lets you configure model and mode, regenerate, add hint, switch models, edit or copy message, select available Git action. Selected model and mode saved only after successful Git action.

Choose a provider in interactive Settings, or set `GCM_PROVIDER` before running `gcm`. Supported values: `gemini`, `openai`, `freellmapi`, `lm-studio`.

See [user-flow diagrams](docs/user-flow.md) for all generation flows.

## Options

| Option                    | Description                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `-c, --commit <hash>`     | Analyse a commit. Default: staged changes.                                                  |
| `--commit-range <range>`  | Analyse a first-parent Git revision range, oldest first; requires `--non-interactive`.      |
| `-e, --exclude <pattern>` | Exclude matching paths; repeat or comma-separate patterns. Default: none.                   |
| `-m, --mode <mode>`       | Use `commit-only` or `full`. Default: last successfully used mode, initially `commit-only`. |
| `--model <name>`          | Select a model from the active provider.                                                    |
| `--list-models`           | List available text-generation models and exit.                                             |
| `--non-interactive`       | Generate without prompts; read-only unless `--apply` is also set.                           |
| `--apply`                 | Perform the available Git action; requires `--non-interactive`.                             |
| `-v, --verbose`           | Show debug-level console logs. Default: off.                                                |
| `-d, --debug`             | Write bounded API traces to `.debug.log`. Default: off.                                     |
| `-h, --help`              | Show built-in help.                                                                         |
| `--version`               | Show the version.                                                                           |

`--exclude` patterns case-sensitive, match whole path, support `*` and `?`. Excluded files stay staged, will commit; GCM asks confirmation before writing. Merge commit analysed against first parent.

If Gemini returns no text after retries, GCM shows deterministic four-artifact diagnostic fallback, offers no write action.

LM Studio uses `gemma-4-e4b-it-mlx` by default and waits for LM Studio to load it. If Gemma is unavailable or cannot load, GCM visibly reports the fallback and selects an already loaded model, then the first compatible model. An explicit `GCM_LM_STUDIO_MODEL` is strict: if it is missing or cannot load, GCM stops instead of silently changing models. In the interactive flow you can then select another provider; non-interactive use exits with an error.

## Git safety

- **Staged changes:** create normal commit.
- **Unpublished `HEAD` with clean index:** amend `HEAD`.
- **Published `HEAD` or older reachable commit with clean index:** create `amend!` commit, print exact manual rebase command.
- **Autosquash targeting:** identify `amend!` targets by commit hash, so duplicate subjects remain unambiguous.
- **Commit range:** freeze targets before generation, create only additive `amend!` commits, skip existing exact amendments, stop on the first failure, and never run rebase.
- **Unreachable target, detached `HEAD`, staged index, or Git operation in progress:** generate read-only mode.
- **Conflicts or unverifiable snapshot:** stop before generation or writing.

GCM never runs rebase. Immediately before writing, revalidates repo state, conflicts, analysed index snapshot, capability, `HEAD`, target commit. Pre-commit hook can still mutate committed tree; GCM detects mismatch after, warns about changed paths.

Rationale detail: [commit consistency](docs/adr/0002-commit-action-consistency.md), [first-parent analysis](docs/adr/0003-first-parent-commit-analysis.md).

## Security

Analysed diff is sent to the selected provider. LM Studio stays on the configured loopback URL. Known Google, AWS, GitHub, Slack, OpenAI-style keys, JWTs, PEM blocks redacted, but pattern-based redaction can't recognise every secret.

`--debug` writes capped request/response traces to `.debug.log`. Treat file sensitive, delete after use. See [secret redaction](docs/adr/0004-redact-secrets-leaving-the-machine.md).

## Configuration

`GCM_MODEL`, `GCM_TEMP` only model/temperature names; legacy Gemini aliases not read. Invalid numeric values fall back safely.

| Variable                       | Default                 | Purpose                                                    |
| ------------------------------ | ----------------------- | ---------------------------------------------------------- |
| `GCM_MODEL`                    | `gemini-3.7-flash`      | Gemini model.                                              |
| `GCM_PROVIDER`                 | `gemini`                | Provider: `gemini`, `openai`/`freellmapi`, or `lm-studio`. |
| `GCM_OPENAI_URL`               | `http://127.0.0.1:3001` | OpenAI / FreeLLMAPI endpoint URL.                          |
| `OPENAI_API_KEY`               | none                    | OpenAI / FreeLLMAPI Bearer token.                          |
| `GCM_LM_STUDIO_URL`            | `http://127.0.0.1:1234` | LM Studio loopback URL.                                    |
| `GCM_LM_STUDIO_MODEL`          | Gemma, then fallback    | Strict LM Studio model override.                           |
| `LM_API_TOKEN`                 | none                    | Optional LM Studio API token.                              |
| `GCM_TEMP`                     | `1`                     | Temperature from 0 to 1.                                   |
| `GCM_MAX_BUFFER`               | `50 MiB`                | Maximum Git output.                                        |
| `GCM_PER_FILE_BUFFER`          | `1 MiB`                 | Maximum per-file diff.                                     |
| `GCM_MAX_HUNKS`                | `40`                    | Maximum analysed hunks.                                    |
| `GCM_TOKEN_BYTES_RATIO`        | `3.5`                   | Estimated bytes per input token.                           |
| `GCM_MAX_OUTPUT_TOKENS`        | `8192`                  | Response-token limit, capped by model.                     |
| `GCM_ENABLE_HUNK_WEIGHTS`      | `false`                 | Prefer important files when selecting hunks.               |
| `GCM_LOG_LEVEL`                | `info`                  | Console log level.                                         |
| `GCM_DEBUG_API`                | `false`                 | Enable API trace logging.                                  |
| `GCM_DEBUG_FILE`               | `.debug.log`            | Trace file path.                                           |
| `GCM_DEBUG_MAX_BODY_LOG_BYTES` | `32768`                 | Maximum logged body size.                                  |
| `GCM_GEMINI_MAX_RETRIES`       | `3`                     | Gemini request attempts.                                   |
| `GCM_GEMINI_RETRY_BASE_MS`     | `1000`                  | Initial retry delay.                                       |
| `GCM_GEMINI_RETRY_MAX_MS`      | `60000`                 | Maximum retry delay.                                       |

## Development

```bash
bun run check
bun run lint
bun run test
bun run test:binary-contract
bun run build
```

`bun run test` includes `--isolate`; use script rather than bare `bun test`.

Architecture, maintenance references:

- [Domain glossary](CONTEXT.md)
- [User flows](docs/user-flow.md)
- [Remove telemetry](docs/adr/0001-remove-telemetry.md)
- [Commit-action consistency](docs/adr/0002-commit-action-consistency.md)
- [First-parent commit analysis](docs/adr/0003-first-parent-commit-analysis.md)
- [Redact secrets leaving the machine](docs/adr/0004-redact-secrets-leaving-the-machine.md)
