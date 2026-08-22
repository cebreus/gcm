# Agent working rules

Applies to any AI agent working in this repository.

Start every reply with my name: cebreus+gcm

## Scope discipline

- Do exactly what the task states. No refactoring, renaming, reformatting, or dead-code removal that the task did not ask for.
- Use sub-agents only when the task explicitly asks for them.
- Never run a state-mutating git command: no `add`, `commit`, `checkout`, `stash`, `reset`, `rebase`, `push`, `worktree`. Leave changes in the working tree. Git commands inside a throwaway temporary repository you created yourself are fine.

## Test-driven development

Per item, in this order:

1. Write the failing test first. Run it. Confirm it fails for the right reason.
2. Write the minimum production code that makes it pass.
3. Run `bun test`. Everything passes.

Never write the production change before its failing test exists. Refactors of already-covered code are the exception: keep the existing tests green instead of adding new ones.

A green test is not proof of correctness. Before claiming a fix works, break the production change on purpose and confirm the test goes red. Report both observations.

## Code style

- Self-documenting code. No comments explaining *what* the code does. A comment is allowed only for a non-obvious *why* — a git or API quirk — and should be rare.
- YAGNI: no new config knobs, no speculative options, no defensive generality for cases nobody has. Deleting code beats adding it.
- Fix at the shared function every caller routes through, never per call site.
- DRY only where versions actually diverge. Two-line similarities are not duplication.
- Match the surrounding code's existing idiom and naming.
- Never widen a public API purely to make something testable. If a test cannot reach the behaviour, that usually means the seam is in the wrong place — say so rather than adding an export.

## Types

`any` is not acceptable in new code. Narrow `unknown` with a type guard instead. The existing `any` findings in `src/runner.ts` are known technical debt; do not add more.

## Verification before reporting done

Run and report the actual output of:

```
bun test
bunx tsc --noEmit
bun run lint
```

Lint currently reports pre-existing errors in `src/runner.ts`. Confirm you introduced no new ones.

Report per item: the test added (file:line), the production change (file:line), and red-then-green confirmation.

## Commands

- `bun test` — test suite
- `bun run check` — `tsc --noEmit`
- `bun run lint` — eslint
- `bun run build` — build `dist/gcm`
- `fallow` — dead code, duplication, complexity. Deterministic; use it to check a claim about unused code before acting on it.

## What tests do not catch

Four checks have each caught real defects that a green suite missed. Apply them:

- **Read the diff, not the summary.** A truncation signal was placed inside a `try` whose `catch` swallowed it. Tests passed because the happy path worked.
- **Grep before deleting.** An automated report called `callGemini` unused; it had five live references. Only its re-export was dead.
- **Break the fix, prove the test fails.** Otherwise the test may assert nothing.
- **Run the built binary.** Unit tests called `parseArgs` directly and asserted it throws; in the real binary that throw was uncaught and dumped the minified bundle to the user.

## Running the CLI

`gcm` creates and amends commits. Never run it against this repository. Create a throwaway git repository in a temporary directory and run it there.
