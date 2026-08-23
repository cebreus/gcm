# 3. Analyse a target commit against its first parent

Date: 2026-08-22

## Status

Accepted

## Context

`gcm --commit <sha>` reads target commit through `git show`. For commit
with two or more parents, `git show` prints no diff and no file names at all:
Git cannot express "change" of merge without being told which parent to
compare against. tool therefore reported "No changes found in commit
<sha>" for every ordinary merge, which reads as defect rather than as the
absence of answer.

## Decision

Both file listing and diff pass `--first-parent`, so merge is
compared against branch it was merged into. Root, ordinary and rename
commits are unaffected by flag and keep their current behaviour, verified
against real Git for all five shapes including octopus merge.

## Consequences

merge commit now yields set of changes it brought into mainline,
which matches what person means when they ask what merge did.

Changes contributed by second and later parents of octopus merge are
not analysed. generated message describes merge from mainline's
point of view only. Anyone needing full picture of such merge has to
inspect it manually; tool does not claim to summarise every parent.

conflict resolution recorded in merge commit is visible under
`--first-parent`, because it differs from first parent's tree. That is
usually interesting part of merge and is further argument for this
choice over `-m`, which would emit one diff per parent and multiply input
sent to model.
