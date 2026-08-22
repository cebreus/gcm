# 3. Analyse a target commit against its first parent

Date: 2026-08-22

## Status

Accepted

## Context

`gcm --commit <sha>` reads the target commit through `git show`. For a commit
with two or more parents, `git show` prints no diff and no file names at all:
Git cannot express "the change" of a merge without being told which parent to
compare against. The tool therefore reported "No changes found in commit
<sha>" for every ordinary merge, which reads as a defect rather than as the
absence of an answer.

## Decision

Both the file listing and the diff pass `--first-parent`, so a merge is
compared against the branch it was merged into. Root, ordinary and rename
commits are unaffected by the flag and keep their current behaviour, verified
against real Git for all five shapes including an octopus merge.

## Consequences

A merge commit now yields the set of changes it brought into the mainline,
which matches what a person means when they ask what a merge did.

Changes contributed by the second and later parents of an octopus merge are
not analysed. The generated message describes the merge from the mainline's
point of view only. Anyone needing the full picture of such a merge has to
inspect it manually; the tool does not claim to summarise every parent.

A conflict resolution recorded in a merge commit is visible under
`--first-parent`, because it differs from the first parent's tree. That is
usually the interesting part of a merge and is a further argument for this
choice over `-m`, which would emit one diff per parent and multiply the input
sent to the model.
