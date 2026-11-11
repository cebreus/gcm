> Historical pilot, preserved during consolidation on 2026-11-11. These scores do not establish a production default: the evaluation research records possible recent-history leakage and only two cases were sampled. Current runtime defaults remain documented in README.md.

# Model benchmarks

## 2026-11-09 — initial local CLI sample (superseded)

Input: one anonymised synthetic diff adding optional Codex and Claude CLI providers,
90-second timeout, existing CLI authentication, no API fallback, and provider tests.
Fable intentionally excluded from default-model comparison.

| Candidate                                               | Result                                                                          | Latency | Decision                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------: | ------------------------------------------------------ |
| Codex configured default (`gpt-5.6-sol`, Headroom, low) | Correct subject; covered hidden missing CLIs, auth, read-only mode, timeout     |  15.1 s | Rejected: machine-specific and not reproducible        |
| Codex `gpt-6.1-terra`                                   | Correct subject; covered auth, read-only mode, no fallback, timeout, model list |  17.0 s | Superseded by two-commit Luna/Sol comparison           |
| Claude `haiku`                                          | Not run: Claude CLI reported `loggedIn:false`                                   |       — | Provisional default for low latency; rerun after login |

Both Codex candidates used `--no-daemon`, `--ephemeral`, read-only sandbox, and no
approval. No repository diff was sent; attempted private-diff benchmark was blocked before
execution. One synthetic sample cannot establish broad quality superiority.

## 2026-11-09 — two-commit provider comparison

Public commits:

- `85303e6`: error recovery across generation, dialogue, commit actions, and tests.
- `2b12aed`: opt-in automatic Changesets across configuration, generation, Git safety,
  cleanup, trailers, documentation, and tests.

Initial direct Codex prompt follows below. Final scored Codex runs were replayed through GCM,
using the same `SYSTEM_INSTRUCTIONS`, repository summary, recent history, and serialized diff
context as Gemini and FreeLLMAPI:

```text
You generate concise, evidence-grounded Conventional Commit messages from git diffs.
Output only the commit message. Subject format: type(scope): summary. Allowed types:
feat, fix, refactor, perf, style, docs, test, build, ci, chore. Subject starts lowercase
after colon, imperative, no trailing period, max 60 characters. Optional body only when
needed, at least two distinct single-line bullets. Use only diff facts; never invent
motivation, performance, security, migration, or breaking status.
```

Score: type/scope 2, subject intent 3, material behaviour 3, grounding 1, format 1.
Latency is wall time from one run; provider congestion makes it directional, not absolute.

| Provider   | Model                   | Commit 1 | Commit 2 | Mean quality | Observed latency | Result                                                 |
| ---------- | ----------------------- | -------: | -------: | -----------: | ---------------: | ------------------------------------------------------ |
| Google     | `gemini-3.5-flash-lite` |     10.0 |     10.0 |     **10.0** |        1.1–1.3 s | Overall winner; reproduced reference intent and bodies |
| Google     | `gemini-3.5-flash`      |      9.5 |      9.5 |          9.5 |        7.0–9.4 s | Strong fallback                                        |
| Google     | `gemini-3.8-flash`      |        — |        — |            — |            >90 s | Timed out                                              |
| Google     | `gemini-pro-latest`     |        — |        — |            — |            8.3 s | HTTP 429                                               |
| Google     | `gemini-4-argon`        |        — |        — |            — |            8.2 s | HTTP 429                                               |
| FreeLLMAPI | `free-router`           |      7.5 |      7.5 |          7.5 |       5.8–15.1 s | Correct subjects; omitted complex body detail          |
| FreeLLMAPI | `kilo-auto`             |      9.5 |     10.0 |     **9.75** |      15.2–17.7 s | Provider quality winner; high reasoning output         |
| FreeLLMAPI | `claude-haiku-4-5`      |  timeout |      8.0 |            — |        7.6–>30 s | One good result, one incomplete run                    |
| FreeLLMAPI | `claude-sonnet-4-5`     |      9.0 |      9.5 |     **9.25** |        9.3–9.6 s | Routed Anthropic quality winner                        |
| Codex CLI  | `gpt-6-luna`            |      7.5 |      7.5 |          7.5 |        8.1–8.2 s | Correct subjects; omitted complex body detail          |
| Codex CLI  | `gpt-6.1-sol`           |      9.5 |      9.5 |      **9.5** |        8.4–8.6 s | Codex quality winner and fallback                      |
| Codex CLI  | `gpt-6.1-terra`         |      9.0 |      9.0 |          9.0 |       8.2–10.8 s | Strong, but less complete than Sol                     |
| Claude CLI | `haiku` / `sonnet`      |        — |        — |            — |                — | Not run: CLI reported `loggedIn:false`                 |

Chosen availability chains:

- Gemini: `gemini-3.5-flash-lite` → `gemini-3.5-flash`.
- FreeLLMAPI: `free-router` → `kilo-auto`.
- Codex CLI: `gpt-6-luna` → `gpt-6.1-sol`.
- Claude CLI: `haiku` → `sonnet`; provisional from routed results until direct login test.

Cost ordering is policy, not measured billing evidence: Lite/Haiku/Luna/router tiers are
treated as cheaper defaults; Flash/Sonnet/Sol/kilo tiers as quality fallbacks. Provider
pricing metadata was unavailable in this run. Revalidate ordering before cost-sensitive
release decisions.

Fallback occurs only for availability-class failures: timeout, overload, capacity, rate
limit, or HTTP 404/408/429/500/502/503/504. Authentication, malformed output, invalid
configuration, and explicitly selected non-default models fail without silent escalation.
Local CLI fallback shares the original 90-second deadline rather than starting a second one.

### Exact outputs

Machine-readable exact messages and measurements: [`model-benchmark-results.json`](model-benchmark-results.json).

`85303e6`:

| Model                   | Exit | Output                                                                                                                              |
| ----------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.5-flash-lite` |    0 | `fix(generation): recover from provider API failures` + retry/model-switch, recoverable commit-hook, non-interactive safety bullets |
| `gemini-3.5-flash`      |    0 | `fix(generation): recover from provider API failures` + interactive retry/model selection and commit-review bullets                 |
| `gemini-3.8-flash`      |    1 | request timeout                                                                                                                     |
| `gemini-pro-latest`     |    1 | HTTP 429                                                                                                                            |
| `gemini-4-argon`        |    1 | HTTP 429                                                                                                                            |
| `free-router`           |    0 | `fix(generation): recover from provider API failures`                                                                               |
| `kilo-auto`             |    0 | `fix(generation): recover from provider API failures` + sanitized interactive recovery and refusal/non-interactive safety bullets   |
| `claude-sonnet-4-5`     |    0 | `fix(generation): recover from provider API failures` + retry/model selection and review bullets                                    |
| `gpt-6-luna`            |    0 | `fix(generation): recover from API and commit failures`                                                                             |
| `gpt-6.1-sol`           |    0 | `fix(generation): recover from interactive failures` + retry/model selection, review, and terminal-safety bullets                   |
| `gpt-6.1-terra`         |    0 | `fix(generation): recover from interactive failures` + retry/model selection and review/safety bullets                              |

`2b12aed`:

| Model                   | Exit | Output                                                                                                                |
| ----------------------- | ---: | --------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.5-flash-lite` |    0 | `feat(release): add automatic changesets for commits` + opt-in, skip-reason, cleanup bullets                          |
| `gemini-3.5-flash`      |    0 | `feat(release): add automatic changesets for commits` + diff evidence, skip-reason, cleanup bullets                   |
| `free-router`           |    0 | `feat(release): add automatic changesets for commits`                                                                 |
| `kilo-auto`             |    0 | `feat(release): add automatic changeset generation` + reviewed snapshot, cleanup, skip-trailer bullets                |
| `claude-haiku-4-5`      |    0 | `feat(release): add automatic changesets for commits` + proposal and review-action bullets                            |
| `claude-sonnet-4-5`     |    0 | `feat(release): support automatic changesets for interactive commits` + opt-in, skip-reason, trailer, cleanup bullets |
| `gpt-6-luna`            |    0 | `feat(release): add automatic changesets for commits`                                                                 |
| `gpt-6.1-sol`           |    0 | `feat(release): add opt-in changesets for staged commits` + skip, snapshot, cleanup bullets                           |
| `gpt-6.1-terra`         |    0 | `feat(release): add automatic changesets for commits` + skip and uncertain-outcome bullets                            |

Provider-reported token usage was retained where available: Gemini Flash Lite used
5,091/41 and 13,194/77 input/output tokens; Gemini Flash used 5,091/36 and 13,194/66;
FreeLLMAPI `free-router` used 4,652/956 and 11,901/540; `kilo-auto` used 4,652/1,817
and 11,901/1,759. Codex Luna used 27,872/14 and 34,728/14; Sol 32,221/47 and
39,077/55; Terra 32,573/36 and 39,429/41. All provider inputs were public commit diffs; no
private worktree diff was transmitted.
