# Architecture and engineering audit

Date: 2026-08-23

## Result

`gcm` is a domain-oriented procedural application, not a formal Domain-Driven
Design implementation. Its language and module boundaries follow the product:
staged snapshots, commit capabilities, atomic groups, generation, review and
Git actions. `runner.ts` coordinates the use case, dialogue owns prompts,
services isolate I/O, and pure modules own parsing, limits and planning. This
is appropriate for one CLI; aggregates, repositories and other DDD machinery
would add structure without removing complexity.

## Principles

- **KISS and YAGNI:** Strong. The project uses functions and plain data, Bun
  APIs, three runtime dependencies and no compatibility layer. Unsupported
  configuration and the unused telemetry subsystem were deleted.
- **DRY:** Strong at behavioural boundaries. Configuration validation, model
  limits, Git execution, commit authorization and prompt budgeting each have
  one implementation. Similar-looking tests remain separate when they prove
  different user contracts.
- **SOLID:** Applied selectively. Prompting, Git, Gemini and context I/O are
  injected behind narrow function/object boundaries, while pure policy stays
  independent of I/O. The runner is intentionally an orchestrator rather than
  a hierarchy of single-implementation interfaces.

## Test discipline

The repository requires red-green-refactor for behavioural changes. The suite
covers pure policy, service boundaries, real temporary Git repositories and a
freshly built binary. Binary contracts have the highest value because they
verify exit codes, terminal text and Git history visible to the user. The
interactive `amend!` contract runs when an `expect` PTY executable is
available; other binary contracts do not depend on it.

Strict TDD cannot be proven from the final tree alone. It is a development
process, enforced by the repository workflow and review evidence rather than
by coverage numbers. The durable requirement is that every non-trivial change
leaves a failing regression test that becomes green with the implementation.

## Accepted limit

The final snapshot check and porcelain `git commit` are not one atomic
operation. The project keeps Git hooks instead of replacing porcelain with
`commit-tree`; the bounded residual race and its rationale are recorded in
[ADR 2](./adr/0002-commit-action-consistency.md).
