# GCM: Gemini Commit Message Helper

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/cebreus/scripts)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/cebreus/scripts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-000000.svg?logo=bun&logoColor=white)](https://bun.sh/)

A CLI tool that uses Google's Gemini AI to automatically generate conventional commit messages from your git diff.

## Description

GCM (Gemini Commit Message Helper) is a command-line interface that analyzes your staged code changes and uses the power of Large Language Models to generate a complete set of artifacts for your development workflow. It automates the often tedious process of writing good, consistent, and conventional commit messages, helping you save time and improve your git history.

This project was created to streamline the commit process, enforce a consistent style, and leverage cutting-edge AI to handle the cognitive load of summarizing code changes.

### Key Features

- **AI-Powered Generation:** Uses Google's Gemini models to generate high-quality commit artifacts.
- **Full Artifact Suite:** Creates not just a commit message, but also a conventional branch name, PR title, and PR description.
- **Conventional Commits:** Enforces the Conventional Commits specification for a clean and readable git history.
- **Conventional Formatting:** Enforces a blank line between subject and body and keeps bullets on single lines. Hard-wrapping is deliberately not applied: it used to break Markdown lists.
- **Context-Aware Analysis:** Analyzes staged `git diff` output or a specific commit hash.
- **Handles Large Diffs:** Intelligently summarizes large changes to fit within the model's context window.

## Installation

### Prerequisites

- [Bun](https://bun.sh/) (v1.0 or higher)
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

The tool will then analyze the diff and print the generated artifacts to your console.

### Example Output

```
BRANCH:
feat/refactor-gemini-client-logging

COMMIT_MESSAGE:
feat(logging): centralize and improve debug logging

- Refactor Gemini client to use a dedicated debug logger
- Ensure `--debug` flag activates API logging to `.debug.log`
- Prevent general telemetry from polluting the debug log file

PR_TITLE:
feat(logging): centralize and improve debug logging

PR_DESCRIPTION:
This refactors the logging mechanism for the Gemini API client.

- A dedicated debug logger has been introduced in the `gemini-client` to handle raw API request/response logging.
- The `--debug` CLI flag now correctly activates this logger by setting `CONFIG.DEBUG_API`.
- The main application logger is now prevented from writing general telemetry data to the `.debug.log` file, ensuring it only contains relevant API trace information.
```

## Usage

`gcm` offers several command-line flags to customize its behavior.

| Flag                  | Alias | Description                                                         |
| --------------------- | ----- | ------------------------------------------------------------------- |
| `--help`              | `-h`  | Show the help message.                                              |
| `--version`           |       | Show the package version and exit.                                  |
| `--commit <hash>`     | `-c`  | Target a specific commit instead of staged changes.                 |
| `--verbose`           | `-v`  | Show detailed logs (debug level) in the console.                    |
| `--debug`             | `-d`  | Save raw API request/response logs to `.debug.log`.                 |
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

`--debug` writes the raw API request and response to `.debug.log`, and the request contains the diff
being analysed. If a staged file holds a secret, that secret lands in the log file. Known key shapes
(Google, AWS, GitHub, Slack, OpenAI-style keys, JWTs and PEM blocks) are redacted from both the log and
the request sent to Gemini, but redaction is pattern-based and cannot recognise every secret. Treat
`.debug.log` as sensitive and delete it when you are done.

If a pre-commit hook stages further files while the commit is being written, the committed tree no longer
matches the analysed diff. `gcm` cannot prevent that without disabling your hooks, so it compares the
committed tree afterwards and warns you which paths ended up in the commit beyond what it analysed.

`--list-models` queries the live Gemini API, so the output reflects the models currently available to your API key instead of a hard-coded list.

### Interactive Menu

After generating a commit message, you'll be presented with an interactive menu. The first entry depends on what you targeted:

- **Commit**: Commit the staged changes with the generated message.
- **Amend HEAD**: Shown instead when `--commit` targets the current HEAD and that commit has not been published. Replaces its message.
- **Reword via amend! commit**: Shown for any other `--commit` target. Adds an `amend!` commit carrying the new message.
- **Copy to clipboard**: Copy the commit message to your system clipboard for later use
- **Edit message**: Manually edit the commit message before committing
- **Switch Model & Regenerate**: Choose a different AI model and regenerate the message. The menu prefers the live Gemini API model list and falls back to a built-in shortlist if the API list is unavailable.
- **Cancel**: Exit without committing

### Commit Safety

- Amend is offered only for a HEAD that no remote branch contains, so published history is never rewritten behind your back. When that cannot be determined, the additive path is taken instead.
- That answer comes from the remote-tracking refs in your clone, and no fetch is made. A commit that reached the remote another way, or whose remote-tracking ref was pruned or deleted, reads as unpublished and can be amended. Run `git fetch` first when the branch may have moved elsewhere.
- Every other target gets an `amend!` commit. That is an ordinary commit: nothing is rewritten until you fold it in yourself.

  ```bash
  git rebase --autosquash <target>~1
  ```

- Nothing is offered when the index has staged changes. Both amend and `amend!` would carry them into the target commit, which the generated message does not describe.
- Nothing is offered for a commit that HEAD cannot reach, or while HEAD is detached. The `amend!` commit is created where HEAD points, so it would never reach a target on another branch, and a commit made on a detached HEAD is orphaned by the next checkout.
- The reword result prints the exact rebase base to use. When an older commit shares the target's subject, that base is mandatory: `--autosquash` folds into the first subject match in its range, so a wider base hands the new message to the wrong commit.
- The decision is taken again immediately before the action, so a repository that moved during regeneration stops the run instead of writing into the wrong commit.
- All actions are disabled when the index has unresolved conflicts, or while a merge, rebase, cherry-pick, revert or bisect is in progress.

### Target a Past Commit

To regenerate the message of a commit that has already been made:

```bash
bun run ./gcm.ts -c a1b2c3d
```

When the hash is the current HEAD, the menu offers a direct amend. Otherwise it offers an `amend!` commit that a later `git rebase --autosquash` folds in.

### Debugging

For more detailed console output, use the `--verbose` flag. To inspect the raw data sent to and received from the Gemini API, use the `--debug` flag, which creates a `.debug.log` file.

```bash
bun run ./gcm.ts -v -d
```

## Configuration

The tool can be configured using environment variables. These are defined in `gcm.config.ts`.

| Variable                                | Description                                                                 | Default            |
| --------------------------------------- | --------------------------------------------------------------------------- | ------------------ |
| `GCM_MODEL` or `GEMINI_MODEL`           | The Gemini model used to generate messages; change it to use another model. | `gemini-3.7-flash` |
| `GCM_TEMPERATURE` or `GEMINI_TEMP`      | The model creativity from 0.0 to 1.0; lower it for more consistent messages. | `1`                |
| `GCM_MAX_BUFFER`                        | Maximum memory for git output; raise it only for very large changes.        | `50 MiB`           |
| `GCM_PER_FILE_BUFFER`                   | Maximum diff size read from one file; raise it when large files are cut off. | `1 MiB`            |
| `GCM_MAX_HUNKS`                         | Maximum number of git diff hunks to analyse; raise it for broader coverage. | `40`               |
| `GCM_ENABLE_THINKING`                   | Set to `true` to enable Gemini thinking; use it only with a supporting model. | `false`            |
| `GCM_TOKEN_BYTES_RATIO`                 | Bytes assumed per input token; adjust it only if context sizing is inaccurate. | `3.5`              |
| `GCM_MAX_OUTPUT_TOKENS`                 | Maximum tokens for Gemini's response; raise it if responses are cut off.    | `8192`             |
| `GCM_ENABLE_HUNK_WEIGHTS`               | Set to `true` to favour important files when choosing diff hunks.           | `false`            |
| `GCM_LOG_LEVEL`                         | Default console logging level; set `debug` when investigating a problem.    | `info`             |
| `GCM_DEBUG_API`                         | Set to `true` to save API logs to a file while debugging.                   | `false`            |
| `GCM_DEBUG_FILE`                        | File path for API debug logs; change it to store logs elsewhere.            | `.debug.log`       |
| `GCM_DEBUG_MAX_BODY_LOG_BYTES`          | Maximum API body bytes written to debug logs; lower it for smaller logs.    | `32768`            |
| `GCM_GEMINI_MAX_RETRIES`                | Maximum Gemini retry attempts after failures; raise it for transient errors. | `3`                |
| `GCM_GEMINI_RETRY_BASE_MS`              | Initial wait before a Gemini retry; raise it to slow retry attempts.        | `1000`             |
| `GCM_GEMINI_RETRY_MAX_MS`               | Longest wait between Gemini retries; raise it for a higher backoff ceiling. | `60000`            |
| `GCM_ADD_RESPONSE_MARKERS`              | Set to `false` to omit response markers; keep enabled for reliable extraction. | `true`             |

## Development

Follow these steps to set up a local development environment.

1.  **Setup:**
    Follow the [Installation](#installation) steps to clone the repository and install dependencies.

2.  **Running Tests:**
    The project uses `bun:test` for testing.

    ```bash
    bun test
    ```

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

    # Automatically fix linting errors
    bun run lint:fix

    # Format all files
    bun run format
    ```

## Roadmap

- [ ] Add more CLI flags for runtime configuration (e.g., `--temperature`, `--max-hunks`).
- [ ] Improved handling of binary files in diffs.

## Contributing

Contributions are welcome! If you have an idea for a new feature or have found a bug, please open an issue. Pull requests are greatly appreciated.

Please read `CONTRIBUTING.md` for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License. See the `LICENSE` file for more details.
