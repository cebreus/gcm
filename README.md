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
- **Automatic Formatting:** Automatically wraps commit messages to standard limits (60 chars for subject, 80 chars for body) while preserving Markdown structure.
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

| Flag              | Alias | Description                                                         |
| ----------------- | ----- | ------------------------------------------------------------------- |
| `--help`          | `-h`  | Show the help message.                                              |
| `--commit <hash>` | `-c`  | Analyze a specific commit instead of staged changes.                |
| `--verbose`       | `-v`  | Show detailed logs (debug level) in the console.                    |
| `--debug`         | `-d`  | Save raw API request/response logs to `.debug.log`.                 |
| `--model <name>`  |       | Specify an alternative Gemini model to use.                         |
| `--list-models`   |       | List available Gemini text-generation models from the API and exit. |

`--list-models` queries the live Gemini API, so the output reflects the models currently available to your API key instead of a hard-coded list.

### Interactive Menu

After generating a commit message, you'll be presented with an interactive menu with the following options:

- **Commit**: Directly commit the generated message to your repository
- **Copy to clipboard**: Copy the commit message to your system clipboard for later use
- **Edit message**: Manually edit the commit message before committing
- **Switch Model & Regenerate**: Choose a different AI model and regenerate the message. The menu prefers the live Gemini API model list and falls back to a built-in shortlist if the API list is unavailable.
- **Cancel**: Exit without committing

### Analyze a Past Commit

To generate a message for a commit that has already been made:

```bash
bun run ./gcm.ts -c a1b2c3d
```

### Debugging

For more detailed console output, use the `--verbose` flag. To inspect the raw data sent to and received from the Gemini API, use the `--debug` flag, which creates a `.debug.log` file.

```bash
bun run ./gcm.ts -v -d
```

## Configuration

The tool can be configured using environment variables. These are defined in `gcm.config.ts`.

| Variable                      | Description                                        | Default            |
| ----------------------------- | -------------------------------------------------- | ------------------ |
| `GCM_MODEL` or `GEMINI_MODEL` | The Gemini model to use for generation.            | `gemini-2.5-flash` |
| `GCM_TEMPERATURE`             | The creativity of the model (0.0 to 1.0).          | `0.5`              |
| `GCM_MAX_HUNKS`               | The maximum number of git diff "hunks" to analyze. | `16`               |
| `GCM_LOG_LEVEL`               | The default logging level for the console.         | `info`             |
| `GCM_DEBUG_API`               | Set to `true` to enable API logging to a file.     | `false`            |
| `GCM_DEBUG_FILE`              | The file path for debug logs.                      | `.debug.log`       |

## Development

Follow these steps to set up a local development environment.

1.  **Setup:**
    Follow the [Installation](#installation) steps to clone the repository and install dependencies.

2.  **Running Tests:**
    The project uses `bun:test` for testing.

    ```bash
    bun test
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
- [ ] Support for automatically committing the generated message with an `--apply` flag.
- [ ] Interactive mode to review and edit the generated message before applying.
- [ ] Improved handling of binary files in diffs.

## Contributing

Contributions are welcome! If you have an idea for a new feature or have found a bug, please open an issue. Pull requests are greatly appreciated.

Please read `CONTRIBUTING.md` for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License. See the `LICENSE` file for more details.
