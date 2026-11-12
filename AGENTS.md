## Project

`gcm` generates Conventional Commit messages from staged changes or existing commits using Gemini, FreeLLMAPI, LM Studio, or the local `codex-cli` / `claude-cli`.
Start every reply with `cebreus+gcm`.

## Stack

- Bun (v1.4+), TypeScript, `minimist`, ESLint, Prettier.
- Use Bun APIs (`Bun.file`, `Bun.spawn`) for file and process I/O; Node utilities such as `path` and `os` are allowed.
- Use Bun for dependency installation; Never mix npm or pnpm installs into same `node_modules`.

## Commands

- Dev: `bun run ./gcm.ts`
- Build: `bun run build` (outputs `dist/gcm`)
- Test: `bun run test` (`--isolate` is required)
- Typecheck: `bunx tsc --noEmit`
- Lint: `bun run lint`

## Architecture

- `gcm.ts` is argv/exit-code entry point; `src/runner.ts` loads initial session state, selects the provider, and dispatches; `src/runner-services.ts` composes adapters and `src/active-provider.ts` runs one provider. `src/generation.ts` is the entry to both generation use cases; `src/generation-workflow.ts` runs the loop and `src/generation-attempt.ts` runs one attempt and saves session state only after successful Git action.
- `src/interactive-generation-dialogue.ts` owns prompts, with review actions in `src/interactive-review-actions.ts`; `src/commit-action-service.ts` authorizes actions.
- `src/services/` isolates Git and context I/O; `src/openai-compatible-client.ts` is the one chat transport for every HTTP provider, `src/local-cli-provider.ts` runs `codex-cli` / `claude-cli`, and `src/gemini-models.ts` fetches Gemini's model catalogue.
- Core modules include summarization, scope detection, atomic planning, model limits, CLI parsing, Git process boundaries, and log redaction.
- `src/runner.ts` calls `loadConfig` once per run and passes resolved settings down; `src/project-config.ts` purely parses repository `.gcmrc.json`. Most tests are named after the module or behaviour they cover; binary tests require fresh build.
- `CONTEXT.md` owns domain glossary; `docs/user-flow.md` owns behavioral flow diagrams; accepted design decisions live in `docs/adr/`.

## Rules

- IMPORTANT: Code must be strictly testable. Isolate I/O and APIs at boundaries; core logic must be pure and deterministic.
- IMPORTANT: Never guess. If context is missing, say `I don't know`.
- Follow [testing standard](docs/TESTING.md); report red/green results. Refactors of covered code may preserve existing tests.
- Handle errors at risk-prone boundaries. Use `unknown` with type guards; Never add `any`.
- IMPORTANT: Before destructive Git operations, validate inputs and repository state; stop rather than risk data loss.
- Match local style, avoid speculative abstractions, and fix shared functions rather than call sites.
- Prefer standard library and existing dependencies; add code or dependencies only when they remove real complexity.
- Every non-trivial change needs runnable validation. Prefer deletion and smallest correct solution.
- Accepted ADRs in `docs/adr/` and README claims checked by `test/readme-contract.test.ts` are owner decisions. Never reverse them without explicit user approval; a reversal needs a new ADR.
- Project history uses Conventional Commits.
- Commits are forbidden by default. Exception: commit only after the user approves a proposal with `YES` (e.g. via `/cebreus-commit`), or to safeguard a fully verified atomic chunk before a risky change.

## Workflow

1. Read owning implementation before editing.
2. Use `apply_patch` for edits. Keep scope minimal; use sub-agents only when requested.
3. For each item: failing test, minimal implementation, focused check, then `bun run test`, `bunx tsc --noEmit`, and `bun run lint`. Report actual output and pre-existing lint errors.
4. Read diff, grep before deleting, run built binary, and test error paths. Run CLI experiments only in temporary repository.

## Out of scope

- Node API migrations/polyfills; changes to `package.json`, config, or linter settings unless explicitly requested.
- Refactoring multiple files or changing architecture without user approval.
- Stage only files changed in the current task; preserve other staged changes. Correct earlier commits only with `fixup!` / `amend!` commits; never rewrite history.
- Never run destructive operations without explicit user approval and a verified target.
- Other state-mutating Git commands (`checkout`, `stash`, `rebase`, `reset`, `push`, `worktree`) in this repository.
