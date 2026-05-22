# Gemini Context: GCM (Gemini Commit Message Helper)

## Project Overview

This project is a CLI tool named `gcm` (Gemini Commit Message Helper) designed to run exclusively on the Bun runtime. Its primary purpose is to automate the creation of conventional commit messages by analyzing `git diff` output with the Google Gemini API. It generates a full suite of artifacts: a branch name, a PR title, a PR description, and a formatted conventional commit message.

### Technologies

- **Runtime:** Bun (v1.0+)
- **Language:** TypeScript
- **Dependency Management:** Bun
- **CLI Argument Parsing:** `minimist`
- **Code Quality:** ESLint (using `eslint-config-love`) and Prettier

### Architecture

The project is structured into several key modules to separate concerns:

- `gcm.ts`: The main executable entry point that initializes the process.
- `src/runner.ts`: The core orchestrator of the application. It handles argument parsing, loading git changes, calling the summarizer and scope detector, preparing the prompt, and invoking the Gemini client.
- `src/cli.ts`: Defines and parses all command-line arguments and options (e.g., `--verbose`, `--commit`).
- `src/gemini-client/`: A dedicated module for all interactions with the Google Gemini API. It includes robust retry logic with exponential backoff.
- `gcm.config.ts`: A central configuration file that exports a `CONFIG` object. All settings are configurable via environment variables, providing flexibility.
- `src/summarizer.ts`: A module responsible for handling very large diffs. It creates a concise summary by analyzing the importance of different code "hunks" to fit within the model's context window.
- `src/scope-detector.ts`: An intelligent module that provides commit scope suggestions. It analyzes git history and the project's directory structure (detecting monorepo vs. single-repo patterns) to give the AI contextually relevant scope hints.
- `src/utils.ts`: Contains miscellaneous helper functions, including the logic to detect the repository type.

## Building and Running

All key tasks are managed via `bun` scripts defined in `package.json`.

- **Prerequisites:**
  - Bun v1.0+
  - Git
  - `GOOGLE_GEMINI_API_KEY` environment variable must be set.

- **Install Dependencies:**

  ```bash
  bun install
  ```

- **Run the Tool:**
  To execute the script against staged git changes:

  ```bash
  bun run ./gcm.ts
  ```

  Or, after building, run the distributable:

  ```bash
  ./dist/gcm
  ```

- **Run Tests:**
  The project uses `bun:test` for its test suite.

  ```bash
  bun test
  ```

- **Build for Distribution:**
  To create a single, minified, executable file:

  ```bash
  bun run build
  ```

  The output will be located at `./dist/gcm`.

- **Linting & Formatting:**

  ```bash
  # Check for linting issues
  bun run lint

  # Format all code
  bun run format
  ```

## Development Conventions

- **Bun-first Runtime:** The code is written to be executed by Bun and explicitly avoids Node.js-specific modules (e.g., uses `Bun.spawn` and `Bun.file` instead of `child_process` and `fs`).
- **Conventional Commits:** As a tool that generates conventional commits, this project's own git history must follow the same standard.
- **Configuration via Environment:** All configuration is managed through the `CONFIG` object in `gcm.config.ts` and can be overridden with `GCM_` prefixed environment variables.
- **Error Handling:** Functions are expected to handle errors gracefully, often wrapping logic in `try...catch` blocks to prevent the application from crashing unexpectedly (e.g., `scope-detector` and `gemini-client`).
- **Modularity:** New functionality should be placed in its own module to maintain separation of concerns.

## Memories (Lazy Load)

- For logic/correctness gotchas, read `memories/logic-gotchas.md`.
- For build/typecheck gotchas, read `memories/build-gotchas.md`.
- For dependency gotchas, read `memories/dependency-gotchas.md`.
