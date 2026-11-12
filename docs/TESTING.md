# Testing standard

This file is copied verbatim from the Repository Observer etalon. Add
project-specific rules in a separate document that links here.

## Workflow

1. Run the full suite before changing code. Record existing failures as the
   baseline, so a later failure is attributed to the right change.
1. Read the source, the test config, and one nearby test before adding a test.
1. Write a failing test first. Confirm it fails for the expected reason.
1. Implement the minimum change, then run the focused test.
1. Run the full suite, typecheck, and lint.
1. For a bug fix, break the fix once and confirm the test fails.

## Rules

- Assert observable behaviour, not implementation details.
- Mock only external boundaries or expensive side effects: network, process,
  file system, clocks, environment variables, and external SDKs. Never mock the
  unit under test, pure helpers, or domain logic.
- Run code in the runtime it ships in. Pure logic without I/O may run anywhere.
- Await every async assertion.
- Keep tests isolated. Share no mutable state. Restore globals, timers, mocks,
  and environment variables after each test.
- Prefer a precise assertion over a snapshot or an existence check.
- Name a test after the behaviour it proves.
- Use one Arrange, Act, Assert sequence per test.
- Never commit `.only` or `.skip`.
- Isolate a shared I/O boundary, such as a logger that posts over the network,
  once in the test setup file, not in each spec.
- Never assert source formatting, such as a regex over a source file.
- Run every test project in the full suite and in the push hook. A script that
  chains projects with `&&` stops at the first failure and hides the rest; run
  each project and report all failures.

## Lint profile

Tests follow the production lint rules with these exceptions, each with its
reason:

| Rule                           | Reason                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `no-magic-numbers`             | Expected values read best as literals in assertions.                                               |
| `no-empty-function`            | No-op test doubles implement interfaces.                                                           |
| `require-await`                | Async test doubles implement async interfaces.                                                     |
| `await-thenable`               | Bun types declare `rejects` matchers as `void`, but they return a promise that must be awaited.    |
| `no-confusing-void-expression` | Same Bun typing gap as `await-thenable`.                                                           |
| `no-unsafe-type-assertion`     | Test doubles and parsed fixtures are cast to the type under test; assertions then check the shape. |
| `unbound-method`               | Tests save a method such as `process.stdout.write` to restore it, never to call it unbound.        |
| `require-atomic-updates`       | Restoring a saved global or environment value after `await` is test isolation, not a race.         |
| `no-await-in-loop`             | Fixture setup runs dependent Git commands in order.                                                |
| `max-lines`                    | A suite mirrors one module; splitting it by length scatters related cases.                         |

Tests also reject `.only` and `.skip` calls.
