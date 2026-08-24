# Context

Glossary for `gcm`. Terms only — no implementation notes, no specification.

## Git state

**Staged snapshot** — set of staged files and their diff read at start
of run. generated message describes this snapshot, not whatever the
index holds later.

**Commit capability** — what repository permits right now: ordinary
commit, amending HEAD, or rewording via `amend!` commit. Carries reason
when action is not permitted.

**In-progress operation** — merge, rebase, cherry-pick, revert or bisect
detected from marker files in git directory. Blocks actions that would
write to commit.

## Commit splitting

**Atomic group** — classification of staged file path, such as `deps`,
`docs-formatting`, `tests` or workspace name, used to propose splitting
unrelated changes into separate commits.

**Split proposal** — copy-pasteable commands for turning atomic groups into
separate commits. `gcm` displays them but never runs them.

## Filtering

**Exclude pattern** — `--exclude` glob deciding which staged files stay out
of prompt. Supports `*` (any characters, including `/`) and `?` (exactly
one character); case-sensitive; matches whole path.

## Language models

**Language model provider** — backend used for generation. Owns its model
catalogue and model limits; a saved model belongs to that provider identity.
