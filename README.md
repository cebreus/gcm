# GCM

Generate Conventional Commit messages from staged changes or existing commits with Gemini, OpenRouter, OpenAI-compatible APIs, LM Studio, or local Codex, Claude and GitHub Copilot CLIs.

Review every result before any Git write.

## Requirements

- [Bun](https://bun.sh/) 1.4+ to build or to run from source; the built `dist/gcm` is a standalone executable
- Git
- [Google Gemini API key](https://aistudio.google.com/app/apikey), [OpenRouter API key](https://openrouter.ai/keys), FreeLLMAPI, or LM Studio

## Install

```bash
git clone https://github.com/cebreus/gcm.git
cd gcm
bun install
export GOOGLE_GEMINI_API_KEY="your_api_key_here"
bun run ./gcm.ts --help
```

Create key in [Google AI Studio](https://aistudio.google.com/app/apikey), replace `your_api_key_here` with it, run `export` command. Applies only to current terminal; add same line to `~/.zshrc` to keep after restart. Never commit or share key.

`bun run build` compiles a standalone executable to `dist/gcm`; put it on `PATH` as `gcm`. The executable does not load `bunfig.toml` or `.env` from the working directory, so a repository you run it in cannot inject preload scripts or `GCM_*` settings. A project `.env` therefore does not configure `gcm`; set variables in the shell environment.

Running from source with `bun run ./gcm.ts` is different: Bun still loads `bunfig.toml` and `.env` from the current directory. Do not run GCM that way inside a repository you do not trust.

## Use

```bash
# Generate from staged changes
gcm

# Review an existing commit
gcm --commit HEAD

# Process a frozen first-parent range, one commit at a time
gcm --commit-range 'd803946^..HEAD' --non-interactive --apply

# Process only a narrower inclusive range from abc123 through def456
gcm --commit-range 'abc123^..def456' --non-interactive --apply

# Generate without prompts; add --apply to perform the available Git action
gcm --commit HEAD --model gemini-3.7-flash --non-interactive

# Exclude generated files from analysis
gcm --exclude 'dist/*'

# List models available to your API key
gcm --models-list

# Use local LM Studio
GCM_PROVIDER=lm-studio gcm

# Select FreeLLMAPI and let its router choose a model
gcm --provider freellmapi --model auto

# Add a generation instruction
gcm --hint 'emphasize migration'

# Print only the generated message
gcm --print

# Mark a requested breaking change
gcm --hint 'breaking change: the --foo flag was removed'
```

From source checkout, replace `gcm` with `bun run ./gcm.ts` (see the caveat in [Install](#install)).

Interactive flow lets you configure provider and model, regenerate, add hint, switch models, edit or copy message, select available Git action. Selected provider and model saved only after successful Git action.

The initial model is `--model`, then the provider's model variable (`GCM_MODEL`, `GCM_FREELLMAPI_MODEL`, `GCM_OPENROUTER_MODEL`, `GCM_LM_STUDIO_MODEL`), then the last used model, then the provider default.

The provider is `--provider`, then `GCM_PROVIDER`, then the last used provider, then the first registered provider (`gemini`). GCM does not check readiness when it picks that default. When only the last used provider selected it and that provider cannot be started in a non-interactive run, GCM prints a warning to stderr and tries the first registered provider instead. Any other provider that cannot be started stops a non-interactive run with an error; an interactive run asks you to select another provider.

Scope suggestions come from recent commit subjects and from paths: in a monorepo only `apps/<name>/` and `packages/<name>/` are workspace folders and suggest `<name>`; `.github/` suggests `ci`; root `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` and `tsconfig.json` suggest `build`; `src/<dir>/` suggests `<dir>`. Split proposals use the same two workspace folders and put `package.json` and lockfiles into one dependency group proposed as `build(deps)`; other paths follow the documentation, CI, test and top-level-directory rules.

Choose a provider in interactive Settings, or set `GCM_PROVIDER` before running `gcm`. Built-in values: `gemini`, `freellmapi`, `openrouter`, `lm-studio`; installed CLIs also enable `codex-cli`, `claude-cli` and `copilot-cli`.

Model catalogues must publish authoritative limits. Gemini exposes separate input/output limits;
FreeLLMAPI, OpenRouter and LM Studio expose a shared context window.

`openrouter` calls `https://openrouter.ai/api/v1` with `OPENROUTER_API_KEY` and needs no
local server. A key with a credit limit rejects a request whose `max_tokens` it cannot
afford, with HTTP 402; lower `GCM_MAX_OUTPUT_TOKENS` to fit that limit.

See [user-flow diagrams](docs/user-flow.md) for all generation flows.

## Options

| Option                    | Description                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-c, --commit <hash>`     | Analyse a commit. Default: staged changes.                                                                   |
| `--commit-range <range>`  | Analyse a first-parent Git revision range, oldest first; requires `--non-interactive`.                       |
| `-e, --exclude <pattern>` | Exclude matching paths; repeat or comma-separate patterns. For built-in excludes, see [Security](#security). |
| `--model <name>`          | Select a model from the active provider.                                                                     |
| `--provider <name>`       | Select an available API or local CLI provider.                                                               |
| `--hint <text>`           | Add an instruction for generation.                                                                           |
| `--models-list`           | List available text-generation models and exit.                                                              |
| `--providers-list`        | Actively check available AI providers and exit.                                                              |
| `--non-interactive`       | Generate without prompts; read-only unless `--apply` is also set.                                            |
| `--print`                 | Print only the generated message to stdout; implies `--non-interactive`.                                     |
| `--apply`                 | Perform the available Git action; requires `--non-interactive`.                                              |
| `-v, --verbose`           | Show debug-level console logs. Default: off.                                                                 |
| `-d, --debug`             | Log redacted API request and response bodies. Default: off. Implies debug-level logs.                        |
| `-h, --help`              | Show built-in help.                                                                                          |
| `--version`               | Show the version.                                                                                            |

Local CLI providers are registered when `codex`, `claude` or `copilot` is on PATH.
Codex and Claude check existing CLI login status before use. Copilot CLI does not expose
a read-only login-status command, so an unavailable login fails its first generation.
GCM does not switch to an API provider when CLI authentication fails. Codex offers Luna,
Sol and Terra, with Luna as default and Sol as its availability fallback. Claude offers
Sonnet, Haiku, Opus and Fable, with Sonnet as default and Haiku as its availability
fallback. Copilot offers GPT-6 Luna as default, then Claude Sonnet 5.5, Gemini 4
Hydrogen, Gemini 3.8 Flash and Claude Haiku 5.5, without a fallback. Model access
still depends on the CLI version, account and configured backend.

CLI generation is ephemeral, runs outside the repository, disables CLI tools and
customizations where supported, redacts recognised credentials, and bounds output.
Copilot runs with a fresh temporary `COPILOT_HOME`, no custom instructions, no MCP
servers and an empty tool allowlist; its keychain login remains available.
Primary and fallback CLI attempts share a 90-second deadline. Unsupported safety flags
fail the request; GCM does not retry without them.

For API generation, selecting `gemini-4-hydrogen` enables an availability fallback
to `gemini-3.5-flash`. The fallback
must exist in the provider catalogue and cover the primary model's token limits.
Authentication and malformed responses do not trigger model switching. Default models
follow the [model defaults decision](docs/adr/0008-model-defaults-from-gcm-model-comparison.md).
Each API chat request has a 90-second timeout, including its transport retries; an API
model fallback starts a new request deadline.

`--providers-list` returns `0` when all providers are available, `1` when only some are
available, and `2` when none are available. Checks do not load LM Studio models.

`--print` cannot be combined with `--apply`, `--commit-range`, `--models-list`, or `--providers-list`. A message truncated by the output limit is refused with a non-zero exit. Errors, warnings, logs, the generation banner and progress are written to stderr. With `--print`, stdout carries only the generated message, so scripts can capture it directly. Without `--print`, stdout also carries the generated-message box, notes, lists (`--models-list`, `--providers-list`), `--help`, `--version` and the interactive prompts, so do not parse it.

`--exclude` patterns case-sensitive, match whole path, support `*` and `?`. Excluded files stay staged, will commit; GCM asks confirmation before writing, and `--non-interactive --apply` refuses to write. Secret-bearing files (see [Security](#security)) are handled the same way. `dist` files are omitted from analysis but commit normally, without that confirmation. Merge commit analysed against first parent.

If a provider returns empty or whitespace-only text, GCM reports an error and performs no write action; such a reply is not retried.

Without `GCM_LM_STUDIO_MODEL`, LM Studio uses the first loaded model in alphabetical order; if none is loaded, GCM loads the first compatible model in that order and stops if that load fails. An explicit `GCM_LM_STUDIO_MODEL` is strict: if it is missing or cannot load, GCM stops instead of silently changing models. In the interactive flow you can then select another provider; non-interactive use exits with an error.

## Git hook

This `prepare-commit-msg` hook runs only for a plain `git commit`. When generation fails, the editor opens with its usual empty message.

```sh
#!/bin/sh
[ -z "$2" ] || exit 0
message=$(gcm --print) && printf '%s\n' "$message" > "$1"
exit 0
```

## Git safety

- **Staged changes:** create normal commit.
- **Unpublished `HEAD` with clean index:** amend `HEAD`.
- **Published `HEAD` or older reachable commit with clean index:** create `amend!` commit, print exact manual rebase command.
- **Autosquash targeting:** identify `amend!` targets by commit hash, so duplicate subjects remain unambiguous.
- **Commit range:** freeze targets before generation, create only additive `amend!` commits, skip existing exact amendments, stop on the first failure, and never run rebase.
- **Unreachable target, detached `HEAD`, staged index, or Git operation in progress:** generate read-only mode.
- **Conflicts or unverifiable snapshot:** stop before generation or writing.

GCM never runs rebase. Before writing, it revalidates repository state. Hook changes in a normal commit are reported; an unsafe `amend!` is rolled back only when its verified parent is unchanged, preserving hook changes in the index. GCM waits for commit hooks without a time limit, and hook output larger than the Git output limit (`GCM_MAX_BUFFER`) no longer interrupts the commit: GCM keeps reading and discards the excess.

Rationale detail: [commit consistency](docs/adr/0002-commit-action-consistency.md), [first-parent analysis](docs/adr/0003-first-parent-commit-analysis.md).

## Security

Analysed diff is sent to the selected provider. Whitespace noise is ignored when a change has other content; a whitespace-only change is analysed as is. LM Studio stays on the configured loopback URL. Known Google, AWS, GitHub, GitLab, npm, Stripe, Slack, OpenAI-style keys, JWTs, PEM blocks, URL passwords, secret-named environment assignments and quoted secret literals redacted. Redaction also covers `Bearer` tokens, Google OAuth `ya29.` tokens, Stripe test keys, unquoted `key: value` / `key = value` pairs with a secret-like name, and a private key block cut off before its end marker. Redaction is best-effort and pattern-based: it can't recognise every secret, for example an unquoted `password: value` whose value contains no digit.

Files that usually hold secrets are excluded from analysis by default, next to `dist/**` and nested `dist` directories: `.env` and `.env.*` in any directory, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.tfvars`, `*.tfstate`, and `.netrc`, `.npmrc`, `id_rsa*` / `id_ed25519*` in any directory. `.env.example` and `.env.sample` match `.env.*` and are excluded too. Excluded files are neither sent nor listed in the request. They stay staged; committing them needs explicit confirmation, and `--non-interactive --apply` refuses. When every staged file is excluded, GCM reports `Only excluded files are staged` and stops.

Local CLI providers are started without `GOOGLE_GEMINI_API_KEY`, `GCM_FREELLMAPI_TOKEN`, `OPENROUTER_API_KEY` and `LM_API_TOKEN` in their environment.

The diff is untrusted, so the model's reply is too. After the subject line, GCM drops every line that starts with a denylisted trailer (`Co-authored-by`, `Signed-off-by`, `Reviewed-by`, `Acked-by`, `Tested-by`, `Skip-checks`, `Release-As`, `Co-developed-by`, `Reported-by`, `Suggested-by`, `Helped-by`, `Cc`, `Change-Id`) and every line that contains a closing keyword with an issue reference (`Closes #12`, `fixes owner/repo#3`, `Resolves https://...`), wherever it sits. CI skip markers (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, `***NO_CI***`) are removed from the whole reply, nested ones included. `BREAKING CHANGE:` footers and ordinary prose such as `Note:` lines are kept.

`--debug` prints redacted request/response traces to the console, each body capped at 32 KiB. Traces cover the HTTP providers (Gemini, FreeLLMAPI, OpenRouter, LM Studio); local CLI providers produce none. No trace file is written. The traces contain the analysed diff, so avoid `--debug` where the output is kept: a shared terminal, a recorded session or CI logs. See [secret redaction](docs/adr/0004-redact-secrets-leaving-the-machine.md).

## Configuration

`GCM_MODEL`, `GCM_TEMP` only model/temperature names. Invalid or out-of-range numeric values and an unknown `GCM_LOG_LEVEL` stop GCM with an `Invalid <NAME>` error.

| Variable                | Default                    | Purpose                                                |
| ----------------------- | -------------------------- | ------------------------------------------------------ |
| `GCM_MODEL`             | `gemini-4-hydrogen`        | Gemini model.                                          |
| `GCM_PROVIDER`          | none                       | Provider; unset: last used, then `gemini`.             |
| `GCM_FREELLMAPI_URL`    | `http://127.0.0.1:3001`    | FreeLLMAPI endpoint URL.                               |
| `GCM_FREELLMAPI_MODEL`  | `auto`                     | FreeLLMAPI routing model.                              |
| `GCM_FREELLMAPI_TOKEN`  | none                       | FreeLLMAPI Bearer token.                               |
| `GCM_OPENROUTER_MODEL`  | `google/gemini-4-hydrogen` | OpenRouter model.                                      |
| `OPENROUTER_API_KEY`    | none                       | OpenRouter API key.                                    |
| `GCM_LM_STUDIO_URL`     | `http://127.0.0.1:1234`    | LM Studio loopback URL.                                |
| `GCM_LM_STUDIO_MODEL`   | Loaded, else first         | Strict LM Studio model override.                       |
| `LM_API_TOKEN`          | none                       | Optional LM Studio API token.                          |
| `GCM_TEMP`              | `1`                        | Temperature from 0 to 1.                               |
| `GCM_MAX_BUFFER`        | `50 MiB`                   | Maximum Git output.                                    |
| `GCM_PER_FILE_BUFFER`   | `1 MiB`                    | Maximum per-file diff when a large diff is summarised. |
| `GCM_MAX_HUNKS`         | `40`                       | Maximum hunks when a large diff is summarised.         |
| `GCM_TOKEN_BYTES_RATIO` | `3.5`                      | Estimated bytes per input token.                       |
| `GCM_MAX_OUTPUT_TOKENS` | `8192`                     | Response-token policy; the model cap also applies.     |
| `GCM_LOG_LEVEL`         | `info`                     | Console log level: `debug`, `info`, `warn`, `error`.   |
| `GCM_DEBUG_API`         | `false`                    | Enable API trace logging.                              |
| `GCM_AUTO_CHANGESET`    | `false`                    | Prepare a Changeset during interactive staged commits. |
| `GCM_MAX_RETRIES`       | `3`                        | Retries for transient provider failures.               |
| `GCM_RETRY_BASE_MS`     | `1000`                     | Initial retry delay.                                   |
| `GCM_RETRY_MAX_MS`      | `60000`                    | Maximum retry delay.                                   |

Set `GCM_AUTO_CHANGESET=true` to prepare a Changeset after generating an interactive
staged commit message. Review the proposed note, then choose **Commit with changeset**
or **Commit without changeset**. The second choice asks for a reason and adds the
`Changeset: none` and `Changeset-Reason` trailers. The first writes and stages only
the new note, verifies the updated index, and commits without skip trailers.

This supports one root package with tracked `.changeset/config.json`, including
private packages with `privatePackages.version: true`. Workspaces, major bumps,
partial diffs and uncertain outcomes need manual review. Drafts are not written
until selected. A failed commit removes an unchanged generated note while `HEAD`
is unchanged; changed or ambiguously committed notes are kept for recovery.
Non-interactive commands and commit-history generation keep their existing behaviour.

## Project configuration

Repositories can define commit conventions in `.gcmrc.json` at repository root.

| Key            | Type       | Purpose                                                    |
| -------------- | ---------- | ---------------------------------------------------------- |
| `types`        | `string[]` | Guide model instead of built-in Conventional Commit types. |
| `scopes`       | `string[]` | Guide model toward listed scopes or no scope.              |
| `exclude`      | `string[]` | Add paths omitted from prompt analysis.                    |
| `instructions` | `string`   | Add project instructions to system prompt.                 |

```json
{
  "types": ["feat", "fix", "docs"],
  "scopes": ["cli", "config"],
  "exclude": ["generated/**"],
  "instructions": "Prefer user-visible outcomes."
}
```

Project configuration is untrusted repository input. It cannot select provider,
model, URL or token. `types` and `scopes` guide prompt; generated results are not
enforced. Arrays must contain 1–50 items, with 1–100 characters per item. `types`
and `scopes` use lowercase letters, digits and hyphens, starting with a letter.
`instructions` accepts up to 2000 characters. Unknown keys are rejected, and an
invalid file stops gcm. File `exclude` paths are committed normally without
confirmation and omitted from analysis; GCM logs how many files it excluded; `--exclude` also requires confirmation before a Git write.

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
- [Language model provider boundary](docs/adr/0005-language-model-provider-boundary.md)
- [One chat transport for every provider](docs/adr/0006-one-chat-transport-for-every-provider.md)
- [Strip metadata from model replies](docs/adr/0007-strip-metadata-from-model-replies.md)
