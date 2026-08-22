## Project
`gcm` generates conventional commits, PR titles, and branch names from `git diff` using Google Gemini.
Start every reply with `cebreus+gcm`.

## Stack
- Bun (v1.0+), TypeScript, `minimist`, ESLint, Prettier.
- Use Bun APIs (`Bun.file`, `Bun.spawn`); never use Node core modules (`fs`, `child_process`).

## Commands
- Dev: `bun run ./gcm.ts`
- Build: `bun run build` (outputs `dist/gcm`)
- Test: `bun test`
- Typecheck: `bunx tsc --noEmit`
- Lint: `bun run lint`
- Dead-code check: `fallow`

## Architecture
- `gcm.ts` is argv/exit-code entry point; `src/runner.ts` orchestrates sessions.
- `src/interactive-generation-dialogue.ts` owns prompts; `src/commit-action-service.ts` authorizes actions.
- `src/services/` isolates Git, Gemini, and context I/O; `src/gemini-client/` handles requests, retries, and parsing.
- Core modules include summarization, scope detection, atomic planning, model limits, CLI parsing, Git process boundaries, and log redaction.
- `gcm.config.ts` exports `CONFIG`, overridable by `GCM_` environment variables. Tests mirror `src/`; binary tests require fresh build.

## Rules
- IMPORTANT: Code must be strictly testable. Isolate I/O and APIs at boundaries; core logic must be pure and deterministic.
- IMPORTANT: Never guess. If context is missing, say `I don't know`.
- Write failing test first, confirm reason, implement minimum, then run full test suite. Refactors of covered code may preserve existing tests. Break fix to prove test fails; report red/green results.
- Handle errors at risk-prone boundaries. Use `unknown` with type guards; Never add `any`.
- IMPORTANT: Before destructive Git operations, validate inputs and repository state; stop rather than risk data loss.
- Match local style, avoid speculative abstractions, and fix shared functions rather than call sites.
- Prefer standard library and existing dependencies; add code or dependencies only when they remove real complexity.
- Every non-trivial change needs runnable validation. Prefer deletion and smallest correct solution.
- Project history uses Conventional Commits.
- Commits are forbidden by default. Exception: commit only fully verified atomic chunk to safeguard it before risky change, and never commit this repository's work.

## Workflow
1. Read relevant files in `memories/` and owning implementation before editing.
2. Use `apply_patch` for edits. Keep scope minimal; use sub-agents only when requested.
3. For each item: failing test, minimal implementation, focused check, then `bun test`, `bunx tsc --noEmit`, and `bun run lint`. Report actual output and pre-existing lint errors.
4. Read diff, grep before deleting, run built binary, and test error paths. Run CLI experiments only in temporary repository.

## Out of scope
- Node API migrations/polyfills; changes to `package.json`, config, or linter settings unless explicitly requested.
- Refactoring multiple files or changing architecture without user approval.
- State-mutating Git commands (`add`, `checkout`, `stash`, `reset`, `rebase`, `push`, `worktree`) in this repository.
