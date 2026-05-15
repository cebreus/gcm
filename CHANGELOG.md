# gcm

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
