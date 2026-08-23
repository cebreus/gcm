# GCM: Gemini Commit Message Helper

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/cebreus/scripts)
[![Version](https://img.shields.io/badge/version-0.8.0-blue)](https://github.com/cebreus/scripts)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-000000.svg?logo=bun&logoColor=white)](https://bun.sh/)

A CLI tool that uses Google's Gemini AI to automatically generate conventional commit messages from your git diff.

## Description

GCM (Gemini Commit Message Helper) analyses staged changes or a target commit and asks Gemini for a Conventional Commit message. The initial `commit-only` mode generates the commit message; `full` mode also generates a branch name, PR title, and PR description. A successful Git action saves the selected model and mode for later runs.

This project was created to streamline the commit process, enforce a consistent style, and leverage cutting-edge AI to handle the cognitive load of summarizing code changes.

### Key Features

- **AI-Powered Generation:** Uses Google's Gemini models to generate high-quality commit artifacts.
- **Optional Full Artifact Suite:** `full` mode also creates a conventional branch name, PR title, and PR description.
- **Conventional Commits:** Enforces the Conventional Commits specification for a clean and readable git history.
- **Conventional Formatting:** Enforces a blank line between subject and body and keeps bullets on single lines. Hard-wrapping is deliberately not applied: it used to break Markdown lists.
- **Context-Aware Analysis:** Analyzes staged `git diff` output or a specific commit hash.
- **Handles Large Diffs:** Intelligently summarizes large changes to fit within the model's context window.

## Installation

### Prerequisites

- [Bun](https://bun.sh/) (v1.4 or higher)
- [Git](https://git-scm.com/)
- A Google Gemini API Key. You can get one from [Google AI Studio](https://aistudio.google.com/app/apikey).

### Instructions

1.  **Clone the Repository:**

    ```bash
    git clone https://github.com/cebreus/scripts.git
    cd scripts
    ```

2.  **Install Dependencies:**

    ```bash
    bun install
    ```

3.  **Set Environment Variable:**
    You need to set your Google Gemini API key as an environment variable.

    ```bash
    export GOOGLE_GEMINI_API_KEY="your_api_key_here"
    ```

    For persistent access, add this line to your shell's configuration file (e.g., `~/.zshrc`, `~/.bashrc`).

4.  **Verification:**
    Run the help command to ensure the script is working.
    ```bash
    bun run ./gcm.ts --help
    ```

## Quick Start

The easiest way to use `gcm` is to stage your changes and run the script.

### Process

There are two generation use cases: analyse staged changes with `gcm`, or analyse an existing commit with `gcm --commit <hash>`. See the separate [user flow diagrams](docs/user-flow.md) for their inputs, decisions and outcomes. Informational commands such as `--help`, `--version` and `--list-models` exit before generation.

Common paths:

```bash
# Generate a commit message from staged changes
gcm

# Also generate a branch name, PR title, and PR description
gcm --mode full

# Review a new message for HEAD; amend is offered only when safe
gcm --commit HEAD

# Review an older reachable commit; amend! is created only after confirmation
# and gcm prints, but never runs, the required rebase command
gcm --commit a1b2c3d

# Keep generated files out of the Gemini prompt
gcm --exclude 'dist/*'

# Inspect models available to the configured API key
gcm --list-models

# Show verbose output and write bounded API traces to .debug.log
gcm --verbose --debug
```

From a source checkout, replace `gcm` with `bun run ./gcm.ts`.

1.  **Make some code changes.**

2.  **Stage your files:**

    ```bash
    # Stage all changes
    git add .

    # Or stage specific files
    git add src/runner.ts
    ```

3.  **Run the tool:**
    ```bash
    bun run ./gcm.ts
    ```

The tool analyses the diff, lets you review the generated commit message, and offers only Git actions that are safe for the current repository state.

### Example Output

Use `--mode full` to include every artifact shown below:

```bash
bun run ./gcm.ts --mode full
```

```
BRANCH:
docs/align-project-documentation

COMMIT_MESSAGE:
docs(core): align documentation with current behaviour

- Document the default commit-only mode and optional full output
- Document the staged-change and target-commit user flows
- Remove stale commands and unsupported project links

PR_TITLE:
docs(core): align project documentation with current behaviour

PR_DESCRIPTION:
This updates the project documentation to match the current CLI.

- The default and full output modes are described accurately.
- Separate diagrams show the staged-change and target-commit journeys.
- Obsolete commands, links, and build notes have been removed.
```

## Usage

`gcm` offers several command-line flags to customize its behavior.

| Flag                  | Alias | Description                                                         |
| --------------------- | ----- | ------------------------------------------------------------------- |
| `--help`              | `-h`  | Show the help message.                                              |
| `--version`           |       | Show the package version and exit.                                  |
| `--commit <hash>`     | `-c`  | Target a specific commit instead of staged changes.                 |
| `--verbose`           | `-v`  | Show detailed logs (debug level) in the console.                    |
| `--debug`             | `-d`  | Save bounded API request/response traces to `.debug.log`.           |
| `--exclude <pattern>` | `-e`  | Exclude matching files. Comma-separated or repeated.                |
| `--mode <mode>`       | `-m`  | Output mode: `full` or `commit-only`.                               |
| `--model <name>`      |       | Specify an alternative Gemini model to use.                         |
| `--list-models`       |       | List available Gemini text-generation models from the API and exit. |

`--exclude` supports `*` (any number of characters, including `/`) and `?` (exactly one character).
Patterns are case-sensitive and match the complete file path.

Excluded paths are dropped from the diff that is analysed, but they stay in the index: `git commit` still
commits them. When the staged set contains an excluded path, `gcm` says so and asks for confirmation
before writing the commit.

If the staged file listing itself exceeds `GCM_MAX_BUFFER`, `gcm` refuses to continue rather than
analysing a partial list: a truncated listing would hide files from both the message and the exclusion
check while `git commit` committed them anyway. Raise the buffer or split the change.

`--commit <hash>` compares a merge commit against its first parent, which is what "what did this merge
bring in" usually means. Ordinary, root and rename commits are unaffected.

`--debug` writes size-capped API request and response traces to `.debug.log`, and the request contains the diff
being analysed. If a staged file holds an unrecognised secret, that secret can land in the log file. Known key shapes
(Google, AWS, GitHub, Slack, OpenAI-style keys, JWTs and PEM blocks) are redacted from both the log and
the request sent to Gemini, but redaction is pattern-based and cannot recognise every secret. Treat
`.debug.log` as sensitive and delete it when you are done.

If a pre-commit hook stages further files while the commit is being written, the committed tree no longer
matches the analysed diff. `gcm` cannot prevent that without disabling your hooks, so it compares the
committed tree afterwards and warns you which paths ended up in the commit beyond what it analysed.

`--list-models` queries the live Gemini API, so the output reflects the models currently available to your API key instead of a hard-coded list.

### Interactive Menu

Before generation, the interactive dialogue lets you generate, configure the model and output mode, or exit. Supplying both `--model` and `--mode` skips that setup; supplying only one keeps the other setting reviewable. If staged paths span multiple scopes, `gcm` offers a copy-pasteable split proposal before generation.

After generation, the review menu offers:

- **Commit**: Commit the staged changes with the generated message.
- **Amend HEAD**: Shown instead when `--commit` targets the current HEAD and that commit has not been published. Replaces its message.
- **Reword via amend! commit; manual rebase required**: Shown for a reachable older commit or published HEAD when the index and repository are write-safe. Selecting it confirms creation of an `amend!` commit carrying the new message. `gcm` never runs the required rebase automatically.
- **Copy to clipboard**: Copy the commit message to your system clipboard for later use
- **Edit message**: Manually edit the commit message before committing
- **Regenerate**: Generate another result with the same model.
- **Regenerate with Hint**: Add guidance and generate another result.
- **Switch Model & Regenerate**: Choose a different AI model and regenerate the message. The menu prefers the live Gemini API model list and falls back to a built-in shortlist if the API list is unavailable.
- **Cancel**: Exit without committing

### Commit Safety

| Input and Git state                                                                       | Offered write action                                 | Result after selection                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Staged changes, no `--commit`                                                             | **Commit**                                           | Creates a normal commit.                                                                       |
| `--commit HEAD`, unpublished HEAD, clean index                                            | **Amend HEAD**                                       | Replaces the message of HEAD immediately.                                                      |
| `--commit <hash>`, published HEAD or older reachable commit, clean index                  | **Reword via amend! commit; manual rebase required** | Creates an `amend!` commit and prints the exact manual rebase command. It does not run rebase. |
| Target unreachable from HEAD, detached HEAD, staged changes, or Git operation in progress | No write action                                      | Generation remains read-only; copy, edit, and regenerate stay available.                       |
| Unresolved conflicts                                                                      | No generation                                        | Stops before Gemini and before any write.                                                      |

- Amend is offered only for a HEAD that no remote branch contains, so published history is never rewritten behind your back. When that cannot be determined, the additive path is taken instead.
- That answer comes from the remote-tracking refs in your clone, and no fetch is made. When a remote exists but has no tracking refs, `gcm` conservatively treats the commit as published. Run `git fetch` first when the branch may have moved elsewhere.
- Nothing is offered when the index has staged changes. Both amend and `amend!` would carry them into the target commit, which the generated message does not describe.
- Nothing is offered for a commit that HEAD cannot reach, or while HEAD is detached. The `amend!` commit is created where HEAD points, so it would never reach a target on another branch, and a commit made on a detached HEAD is orphaned by the next checkout.
- The reword result prints the exact rebase base to use. When an older commit shares the target's subject, that base is mandatory: `--autosquash` folds into the first subject match in its range, so a wider base hands the new message to the wrong commit.
- The decision is taken again immediately before the action, so a repository that moved during regeneration stops the run instead of writing into the wrong commit.
- All actions are disabled when the index has unresolved conflicts, or while a merge, rebase, cherry-pick, revert or bisect is in progress.

### Debugging

For more detailed console output, use the `--verbose` flag. To inspect bounded traces of data sent to and received from the Gemini API, use the `--debug` flag, which creates a `.debug.log` file.

```bash
bun run ./gcm.ts -v -d
```

## Configuration

The tool can be configured using environment variables. These are defined in `gcm.config.ts`.

| Variable                       | Description                                                              | Default            |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------ |
| `GCM_MODEL`                    | The Gemini model used to generate messages.                              | `gemini-3.7-flash` |
| `GCM_TEMP`                     | Model creativity from 0.0 to 1.0; lower values are more consistent.      | `1`                |
| `GCM_MAX_BUFFER`               | Git output limit from 1 byte to 1 GiB.                                   | `50 MiB`           |
| `GCM_PER_FILE_BUFFER`          | Per-file diff limit from 1 byte to 1 GiB.                                | `1 MiB`            |
| `GCM_MAX_HUNKS`                | Diff hunks to analyse, from 1 to 10,000.                                 | `40`               |
| `GCM_TOKEN_BYTES_RATIO`        | Estimated bytes per input token, from 0.1 to 100.                        | `3.5`              |
| `GCM_MAX_OUTPUT_TOKENS`        | Positive whole response-token limit, capped by the selected model.       | `8192`             |
| `GCM_ENABLE_HUNK_WEIGHTS`      | Set to `true` to favour important files when choosing diff hunks.        | `false`            |
| `GCM_LOG_LEVEL`                | Default console logging level; set `debug` when investigating a problem. | `info`             |
| `GCM_DEBUG_API`                | Set to `true` to save API logs to a file while debugging.                | `false`            |
| `GCM_DEBUG_FILE`               | File path for API debug logs; change it to store logs elsewhere.         | `.debug.log`       |
| `GCM_DEBUG_MAX_BODY_LOG_BYTES` | Debug body limit from 1 byte to 10 MiB.                                  | `32768`            |
| `GCM_GEMINI_MAX_RETRIES`       | Gemini retry attempts, from 1 to 10.                                     | `3`                |
| `GCM_GEMINI_RETRY_BASE_MS`     | Initial retry delay, from 1 ms up to the retry maximum.                  | `1000`             |
| `GCM_GEMINI_RETRY_MAX_MS`      | Retry delay ceiling, from 1 to 300,000 ms.                               | `60000`            |

## Development

Follow these steps to set up a local development environment.
The [architecture and engineering audit](docs/architecture-audit.md) records the current domain boundaries, design-principle assessment, test discipline and accepted consistency limit.

1.  **Setup:**
    Follow the [Installation](#installation) steps to clone the repository and install dependencies.

2.  **Running Tests:**
    The project uses `bun:test` for testing.

    ```bash
    bun run test
    ```

    Run it through the script, not as a bare `bun test`. The script passes `--isolate`, which gives
    each test file its own module registry. Several files install `mock.module` stubs that are
    otherwise process-wide and leak into every file that runs after them, which makes the result
    depend on file order: without the flag, reversing the file order turns one passing test red.

    The compiled-binary contract suite also builds `gcm` outside the repository and runs it in temporary repositories:

    ```bash
    bun run test:binary-contract
    ```

3.  **Building the Project:**
    You can bundle the entire application into a single, executable file.

    ```bash
    bun run build
    ```

    This command compiles the TypeScript, bundles all modules, and places a minified, executable file at `./dist/gcm`.

4.  **Linting and Formatting:**
    The project uses ESLint for linting and Prettier for formatting.

    ```bash
    # Check for linting errors
    bun run lint

    # Fix lint issues where possible and format all files
    bun run format
    ```
