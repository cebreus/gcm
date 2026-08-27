# gcm

## 0.11.0

> Providers now discover and validate their model catalogue at runtime, eliminating the hard-coded model list and the edge-case failures that came with it. A GitHub Actions pipeline was added to catch regressions before they reach the main branch.

### Minor Changes

- **core:** Providers now fetch their model catalogue at runtime with validated token limits, so the model picker is always current; Gemini paginates the full API catalogue and filters non-text models, FreeLLMAPI and LM Studio require a published context window, generation fails fast on no response instead of silently producing a placeholder, amend! commits rejected by hooks are rolled back automatically, git status is parsed in NUL-delimited format to handle paths with special characters, branch names are sanitised against edge cases, dist/ is excluded from analysis by default, and retry variables were renamed to GCM_MAX_RETRIES / GCM_RETRY_BASE_MS / GCM_RETRY_MAX_MS (old GCM_GEMINI_* names remain as aliases).

### Patch Changes

- **workflow:** Added a GitHub Actions pipeline that runs type-checking, linting, the full test suite and a binary build on every push and pull request, so regressions are caught before they reach the main branch.

## 0.10.0

> CLI automation and provider selection are expanded: GCM introduces non-interactive execution,
> commit-range batch processing, generation hints, and direct provider selection. The OpenAI-compatible
> provider is renamed to FreeLLMAPI with updated configuration variables, and provider reachability
> can now be inspected directly with `--list-providers`.

### Minor Changes

- feat(cli)!: Replace `openai` provider with `freellmapi` and migrate configuration environment variables to `GCM_FREELLMAPI_URL`, `GCM_FREELLMAPI_MODEL`, and `GCM_FREELLMAPI_TOKEN`.
- feat(cli): Add `--list-providers` flag to check provider status and reachability without loading models.
- feat(cli): Add `--provider` CLI flag for active model backend selection (`gemini`, `lm-studio`, `freellmapi`).
- feat(cli): Add `--hint` (`-H`) flag to pass contextual generation hints to the model prompt.
- feat(cli): Support `--non-interactive` execution to run without interactive prompts, optionally executing Git actions with `--apply`.
- feat(cli): Support `--commit-range` batch processing to generate additive `amend!` commits across first-parent revisions.
- feat(provider): Add OpenAI-compatible provider adapter and FreeLLMAPI support.

### Patch Changes

- fix(api): Bound Gemini model discovery pagination and request limits.
- refactor(core): Generalize model services and decouple repository context interfaces.

## 0.9.0

> Local LLMs are now first-class: GCM connects directly to LM Studio for offline model
> discovery and commit generation. The core architecture introduces a provider boundary,
> flattens configuration dialogues, redacts Authorization headers, and rejects malformed
> control tokens or invalid subjects.

### Minor Changes

- feat(core): Added LM Studio provider support with local model discovery, Gemma fallback, and chat completions.
- feat(core): Rejected control markup, bidirectional control characters, and invalid subjects in commit parser.
- feat(core): Redacted Authorization header credentials in text and prompt redaction utilities.

### Patch Changes

- refactor(core): Introduced language model provider boundary to abstract models, token limits, and error handling.
- refactor(core): Modularized generation workflow and decoupled generation from provider-specific adapters.
- refactor(dialogue): Flattened settings menu options to configure model, mode, and provider directly.
- refactor(core): Updated commit body prompt rules.
- fix(tooling): Enforced typed lint boundaries across source files and tests.

## 0.8.1

> Generation now stops when the staged snapshot can no longer be verified, while unfinished
> Git operations still allow safe read-only use. Runtime limits reject invalid values instead
> of leaking them into Git or Gemini, and the packaged binary follows the same Bun-native
> boundaries as the source.

### Patch Changes

- fix(cli): Checked unresolved conflicts and staged-snapshot drift before generation.
- fix(cli): Allowed read-only generation during conflict-free unfinished Git operations.
- fix(cli): Documented separate staged-change and target-commit user flows.
- refactor(core): Kept only the short `GCM_MODEL` and `GCM_TEMP` configuration names.
- fix(config): Validated numeric environment values and coupled retry limits at their boundary.
- fix(core): Clamped model output, retry, timeout and debug limits before Gemini calls.
- fix(git): Bounded process output in bytes and decoded split UTF-8 streams correctly.
- fix(core): Enforced Bun-native file and process I/O while preserving valid `path` and `os` use.
- fix(tooling): Updated Bun dependencies and aligned ESLint with Bun runtime globals.

## 0.8.0

> Secrets are far less likely to leave your machine: the API key now travels in a header
> rather than a URL, and known key shapes are removed from the text sent to Gemini and from
> the logs. Commits are safer too — paths with accented or unusual characters can no longer
> slip past --exclude, a merge commit is finally summarised instead of reported as empty,
> and a published commit is never quietly amended. Longer answers are allowed by default, so
> fewer messages arrive cut off.

### Minor Changes

- feat(core): Set the default model to gemini-3.7-flash and updated the model registry.
- feat(core): Migrated sessions still pinned to legacy 2.5 models to the current default.
- feat(core): Reported the detailed message and response snippet when a Gemini call fails.
- feat(core): Stopped wrapping commit messages by hand, which broke markdown and bullet lists.
- feat(core): Amended an unpublished HEAD directly when --commit targets it.
- feat(core): Wrote an amend! commit for any other reachable target, leaving history intact.
- feat(core): Blocked both actions while changes are staged, as they would sweep those in.
- feat(core): Never amended a commit that a remote branch already holds.
- feat(core): Refused a target HEAD cannot reach, whose amend! commit would be stranded.
- feat(core): Refused to act on a detached HEAD, where the new commit would be orphaned.
- feat(core): Printed the exact rebase base and warned when an older commit was targeted.
- feat(core): Repeated the decision immediately before the write, so a moved HEAD is caught.
- feat(core): Refused a commit whose message no longer matches the staged index.
- feat(core): Tracked excluded staged paths alongside the analysed snapshot.
- feat(core): Asked for explicit confirmation before committing excluded files.
- feat(core): Refused commit actions while excluded staged paths stay unacknowledged.
- feat(core): Refused to write the debug log through a symlink and tightened its permissions.

### Patch Changes

- docs(memories): Documented the development pitfalls that keep recurring.
- docs(core): Refined the Gemini model context document.
- refactor(cli): Removed the unused --dry-run flag.
- fix(core): Restricted the staged diff to the filtered file list, so excluded files stayed out.
- fix(core): Appended telemetry through a file write instead of shelling out.
- refactor(core): Removed the telemetry subsystem after proving that Bun file writers truncated its event log; console and bounded API debug logging remain.
- fix(core): Captured the index tree with git write-tree and compared it before committing.
- fix(core): Treated a MAX_TOKENS finish reason as truncation rather than a complete answer.
- fix(core): Counted every fixed prompt section against the budget, including the user hint.
- fix(core): Normalised MAX_HUNKS to a positive integer and guarded the glob conversion.
- fix(core): Rejected unknown flags and flags whose required value is missing.
- fix(cli): Reported argument validation failures without a stack dump.
- chore(agents): Documented the working rules that apply to any agent in this repository.
- refactor(core): Dropped four configuration values that nothing read.
- refactor(core): Dropped a second git execution path that duplicated the streaming one.
- refactor(core): Dropped a scope-detector wrapper whose behaviour the caller already had.
- refactor(core): Dropped the eager module-level Gemini client and its default export.
- refactor(core): Dropped three unused logging and truncation helpers.
- refactor(core): Dropped a duplicate default model constant; the effective default is in config.
- refactor(core): Dropped a truncation note that was built and never read.
- refactor(core): Dropped unread fields from the runner's service and argument records.
- refactor(core): Dropped an orphan test runner whose assertions live in the suite already.
- refactor(core): Extracted atomic commit planning out of the runner.
- fix(core): Separated paths from options in the split proposal, so a leading dash is safe.
- fix(core): Made every reduction pass return a strictly shorter prompt.
- fix(core): Used a summary only when it is genuinely shorter than the diff it replaces.
- fix(core): Stopped slicing the user hint in half; the whole hint survives or none of it.
- fix(core): Stopped building the same summary twice while assembling one prompt.
- build(dist): Rebuilt the packaged binary.
- refactor(core): Rewrote argument validation from nested branching into a declarative table.
- refactor(core): Removed the last thirteen lint errors, all of them untyped values.
- refactor(core): Stopped exporting six symbols that nothing outside their module used.
- refactor(core): Dropped a manifest entry pointing at a file that does not exist.
- docs(core): Documented the twelve environment variables the tool actually reads.
- test(core): Pinned the missing-value rule for every flag that takes a value.
- fix(cli): Rejected an invalid or repeated flag value instead of guessing what was meant.
- build(dist): Rebuilt the packaged binary.
- test(utils): Pinned and documented what the --exclude glob syntax matches.
- chore: Ignored the scratch directory used for analysis runs.
- refactor(logger): Checked path existence through Bun's file stat, which reports a directory.
- refactor(logger): Imported the manifest statically instead of reading it at runtime.
- refactor(core): Extracted the interactive generation dialogue from the runner.
- test(binary): Made error paths exit non-zero; a missing API key used to report success.
- test(binary): Honoured the -- terminator in parsing as well as in validation.
- test(binary): Stopped waiting on a prompt with nothing staged and no terminal attached.
- fix(core): Listed staged files NUL-separated, so a quoted non-ASCII path no longer escaped --exclude.
- fix(core): Refused a truncated staged file listing instead of analysing a partial one.
- fix(core): Passed log messages through the sanitiser that previously covered only metadata.
- fix(core): Taught the sanitiser two key shapes it did not know, including current Google keys.
- fix(core): Applied the debug size cap to every payload written, not only the first.
- fix(core): Clamped a server-supplied retry delay, which could otherwise sleep for a day.
- fix(core): Reported a failure and exited 1 instead of leaking an unhandled rejection.
- fix(core): Raised the default output budget to 8192 tokens and the hunk limit to 40.
- fix(core): Stopped calling worktree files "staged" in the split proposal when nothing is staged.
- build(dist): Rebuilt the packaged binary.
- fix(security): Sent the API key for --list-models as a header rather than in the URL.
- fix(security): Redacted known key shapes from the prompt before it leaves the machine.
- fix(security): Stripped terminal escape sequences from model output, API errors and commit subjects.
- fix(security): Named the extra paths when a pre-commit hook adds files during the commit.
- fix(security): Compared a merge commit against its first parent, which used to report no changes.
- fix(security): Measured the debug size cap in bytes, as its name promised, not code units.
- fix(security): Stopped truncating log messages at 256 characters, a limit meant for metadata.
- chore(agents): Consolidated architecture, stack and guidelines into one agent document.
- chore(agents): Pointed the assistant documents at that one source and removed the obsolete one.
- fix(core): Redacted the outbound prompt strictly, so ordinary code is no longer mangled.
- fix(core): Skipped a truncation retry that cannot raise the model's output ceiling.
- fix(core): Treated a commit as published when the local clone cannot answer the question.
- fix(core): Told an aborted git command apart from one killed by the output cap.
- fix(core): Stripped whole escape sequences from displayed and copied text, not just control bytes.
- refactor(dialogue): Split the action handler and covered the paths where a user escapes.
- test(core): Drove git asynchronously in the tests, removing a deadlock that could hang the suite.
- chore(changesets): Stopped tracking the config and changelog formatter that the release tooling owns.

## 0.7.1

### Patch Changes

- f8bf965: Removed manual line wrapping from `formatCommitMessage` to prevent broken markdown and bullet points.
  Restored length constraints in AI prompt but with strict instructions against manual line breaking.
  Ensured there is an empty line between the subject and body in `formatCommitMessage`.

## 0.7.0

### Minor Changes

- Added a safety check that warns you if some changed files are not ready to be committed. This helps you avoid missing parts of your work.
- Improved the way the tool asks about unstaged files by grouping them together. This makes the confirmation process much quicker.
- Enhanced the commit message generation by including your recent commit history. This helps the tool match your personal writing style.
- Updated the system to automatically select the most suitable model for generating messages. It now remembers your chosen settings for future use.

## 0.6.1

### Patch Changes

- Refined the app structure by breaking down large tasks into smaller, simpler pieces. This makes the code easier to read and maintain.
- Improved how the app handles data by adding stricter rules for information types. This helps prevent hidden errors.
- Added stronger checks for code quality. This ensures the app stays reliable as it grows.

## 0.6.0

### Minor Changes

- Added an interactive menu to let you commit, copy, or edit the message without typing more commands.
- Added session memory so the app remembers your preferred AI model and avoids repetitive setup.
- Added a hint feature so you can tell the AI exactly how to improve a draft message.
- Added a "commit-only" mode to give you shorter messages when you do not need a full description.
- Improved the message cleaner to remove internal markers and fix messages that were cut off.
- Updated the system configuration and tools to ensure smoother development and faster startup.

## 0.5.0

### Minor Changes

- Introduced intelligent scope detection to provide contextually relevant commit suggestions.
- Integrated `@clack/prompts` to deliver a premium, interactive terminal experience.
- Enhanced model selection with a new `--list-models` flag and a registry of curated defaults.
- Optimised the interactive menu with a direct "copy to clipboard" feature for seamless integration.
- Refined the commit-only output formatting to ensure compatibility with standard git workflows.
- Initialised advanced output selection allowing users to choose between direct commits or message drafting.
- Initialised the core foundation with a modular TypeScript architecture.
- Streamed git command outputs to improve performance and responsiveness.
- Optimised large diff summarisation to ensure model context limits are respected.
- Integrated verbose and debug logging modes to enhance system observability.
- Refined configuration and error handling mechanisms to provide a more robust experience.
- Implemented a build system to produce minified executables.
- Added --version flag to verify the package version
- Fixed message truncation by enforcing clearer response markers
- Added version information to the introductory header
- Fixed formatting script errors and improved file exclusion patterns
- Implemented automatic commit message line wrapping to ensure standard git terminal readability.
- Introduced the `--exclude-file` option to allow users to filter out specific files from diff analysis.
- Hardened the Gemini client with robust retry logic, token truncation, and response sanitisation.
- Standardised typographic and formatting constants to ensure visual consistency across all outputs.
- Optimised the model registry and filtering logic to improve reliability and performance.
- Initialised a stricter linting and formatting regime using Prettier and updated dependencies.
- Integrated a comprehensive test suite covering CLI, runner, and scope detection logic.

## 0.4.0

- Implemented automatic commit message line wrapping to ensure standard git terminal readability
- Introduced the `--exclude-file` option to allow users to filter out specific files from diff analysis
- Hardened the Gemini client with robust retry logic, token truncation, and response sanitisation
- Standardised typographic and formatting constants to ensure visual consistency across all outputs
- Optimised the model registry and filtering logic to improve reliability and performance
- Initialised a stricter linting and formatting regime using Prettier and updated dependencies
- Integrated a comprehensive test suite covering CLI, runner, and scope detection logic

## 0.3.0

- Introduced intelligent scope detection to provide contextually relevant commit suggestions
- Integrated `@clack/prompts` to deliver a premium, interactive terminal experience
- Enhanced model selection with a new `--list-models` flag and a registry of curated defaults
- Optimised the interactive menu with a direct "copy to clipboard" feature for seamless integration
- Refined the commit-only output formatting to ensure compatibility with standard git workflows
- Initialised advanced output selection allowing users to choose between direct commits or message drafting

## 0.2.0

- Initialised the core foundation with a modular TypeScript architecture
- Streamed git command outputs to improve performance and responsiveness
- Optimised large diff summarisation to ensure model context limits are respected
- Integrated verbose and debug logging modes to enhance system observability
- Refined configuration and error handling mechanisms to provide a more robust experience
- Implemented a build system to produce minified executables
