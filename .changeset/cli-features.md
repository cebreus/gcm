---
'gcm': minor
---

feat(cli): Add `--provider` CLI flag for active model backend selection (`gemini`, `lm-studio`, `freellmapi`).
feat(cli): Add `--hint` (`-H`) flag to pass contextual generation hints to the model prompt.
feat(cli): Support `--non-interactive` execution to run without interactive prompts, optionally executing Git actions with `--apply`.
feat(cli): Support `--commit-range` batch processing to generate additive `amend!` commits across first-parent revisions.
feat(provider): Add OpenAI-compatible provider adapter and FreeLLMAPI support.
