# GCM checkout consolidation

Canonical checkout: `/Users/cebreus/www/gcm`.
Common base: `5e9e59a7d5a3bebc48be82120a485c5dd76ef04c`.
Target baseline: `6bb06b8ce294838808b1066e2880dd63d48feca6` (11 commits after base).
Old checkout: `/Users/cebreus/.scripts/gcm`, HEAD `9d96167cb3f0f9df9b0a38f647c8f57c5d43852a`.

## Decisions

| Old change                                                  | Decision and evidence                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 90-second chat timeout                                      | Accepted: confirmed requirement; regression test fails with 60 seconds and passes with 90.                                                                                 |
| Gemini 3.8 default commit, subsequent 3.5 Lite default edit | Not adopted: small historical pilot and recorded history leakage do not justify replacing target's default. Both remain explicitly selectable when advertised by the API.  |
| FreeLLMAPI default `free-router`                            | Keep target's `auto`; enable the reviewed fallback when `free-router` is selected.                                                                                         |
| Gemini and FreeLLMAPI availability fallback                 | Adapted to target's injected Config, with authentication, parsing, cancellation and token-budget guards. Transport timeouts now carry availability metadata.               |
| Local Codex and Claude CLI providers                        | Retained and hardened: completion validation, truncation detection, authentication probes, credential redaction, output bounds, shared deadline, restricted CLI arguments. |
| Provider registration and help                              | Retained: preserve injection precedence, discover installed binaries, show registered provider IDs.                                                                        |
| Tests                                                       | Retained relevant contracts and added failure-path coverage; target's environment isolation remains intact.                                                                |
| Research documents                                          | Preserved; benchmark marked historical and insufficient to select production defaults.                                                                                     |
| Serena project configuration and scratch/cache material     | Machine-specific; retain in recovery archive, not target product.                                                                                                          |

Note: the FreeLLMAPI parts of the `free-router` and availability-fallback rows are superseded by e4a701d, which removed the `free-router` to `kilo-auto` fallback. The Gemini fallback remains.

## Evidence and recovery

Before changes, target passed 501 tests outside the sandbox. Old checkout passed all
481 tests with target's environment-cleaning preload. Earlier runner failures were
caused by environment contamination; sandbox socket failures were not product defects.

Final validation: 535 tests passed, zero failed; TypeScript, ESLint, build and diff
whitespace checks passed. Binary tests exercise both local providers with synthetic
CLI processes, including printing, committing, authentication errors and truncation.
Both installed CLIs reported authenticated; their argument parsers accepted the
configured safety flags. A new shell's `gm --version` returned `gcm 0.13.0`.

The original checkout, including Git history, ignored files and unfinished work, was
moved intact to `/Users/cebreus/.scripts/.archive/gcm-2026-11-11`. Its directory identity
and Git index hash were verified after the move; the original path no longer exists.
Restoring that directory to its original path reverses removal; restore the
`gm` shell function's old path only if intentionally switching back.

No model-generation requests against real providers are required for the automated
checks. Live account/model availability and CLI backend behaviour remain deployment
conditions, not claims established by mocks. Historical experiment outputs are retained
as evidence, not rerun or silently rescored.
