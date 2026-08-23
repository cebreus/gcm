# Context

Glossary for `gcm`. Terms only — no implementation notes, no specification.

## Git state

**Staged snapshot** — the set of staged files and their diff read at the start
of a run. The generated message describes this snapshot, not whatever the
index holds later.

**Commit capability** — what the repository permits right now: an ordinary
commit, amending HEAD, or rewording via an `amend!` commit. Carries the reason
when an action is not permitted.

**In-progress operation** — a merge, rebase, cherry-pick, revert or bisect
detected from marker files in the git directory. Blocks actions that would
write to a commit.

## Commit splitting

**Atomic group** — a classification of a staged file path, such as `deps`,
`docs-formatting`, `tests` or a workspace name, used to propose splitting
unrelated changes into separate commits.

**Split proposal** — copy-pasteable commands for turning atomic groups into
separate commits. `gcm` displays them but never runs them.

## Filtering

**Exclude pattern** — a `--exclude` glob deciding which staged files stay out
of the prompt. Supports `*` (any characters, including `/`) and `?` (exactly
one character); case-sensitive; matches the whole path.
