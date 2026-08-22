# Context

Glossary for `gcm`. Terms only — no implementation notes, no specification.

## Logging

**Debug log** — a trace of Gemini API requests and responses, written when
`GCM_DEBUG_API` is on. Path from `GCM_DEBUG_FILE`, `.debug.log` by default.
Exists to inspect what was sent to and received from the model.

Removed in ADR 0001: a separate opt-in **telemetry log** once existed
alongside it. The term is retired; only the debug log remains.

## Git state

**Staged snapshot** — the set of staged files and their diff read at the start
of a run. The generated message describes this snapshot, not whatever the
index holds later.

**Index tree** — the tree object written by `git write-tree`, used to detect
that the index changed between generating a message and acting on it.

**Commit capability** — what the repository permits right now: an ordinary
commit, amending HEAD, or rewording via an `amend!` commit. Carries the reason
when an action is not permitted.

**In-progress operation** — a merge, rebase, cherry-pick, revert or bisect
detected from marker files in the git directory. Blocks actions that would
write to a commit.

## Prompt construction

**Prompt parts** — the prompt carried as structure rather than rendered text:
a prefix (changed files, scope hints, history), the diff body, and a suffix
(the user's hint). Rendering to a single string is the last step.

**Reduction** — shrinking an oversized prompt for a retry. Two modes:
*summary*, replacing the diff body with a top-hunks summary, and *truncation*,
cutting the diff body toward the size target. Reports itself *unreducible*
when nothing can be cut without damaging the preserved context.

## Commit splitting

**Atomic group** — a classification of a staged file path, such as `deps`,
`docs-formatting`, `tests` or a workspace name, used to propose splitting
unrelated changes into separate commits.

**Split proposal** — the rendered, copy-pasteable set of commands that would
carry out that split. Display only; the tool never runs it.

## Filtering

**Exclude pattern** — a `--exclude` glob deciding which staged files stay out
of the prompt. Supports `*` (any characters, including `/`) and `?` (exactly
one character); case-sensitive; matches the whole path.
