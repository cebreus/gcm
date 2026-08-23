# 2. Preserve porcelain hooks for commit-action consistency

Date: 2026-08-22

## Status

Accepted

## Context

generated commit message is safe to apply only when it still describes the
Git state that eventual commit consumes. action menu can remain open
long enough for another process or user to alter index or move `HEAD`.

## Decision

For staged changes, capture index tree immediately before and immediately
after reading diff. If either observation changes, retry once; if the
second read is also unstable, refuse action. verified tree and index
entries travel with generated message.

Before action, compare current index tree with that captured snapshot.
For target actions, preserve resolved target hash and `HEAD` hash, then
re-read both Before write. delegated Git writer repeats these checks
immediately before it invokes `git commit`.

invariant is: write is attempted only when message, captured
index snapshot, and commit target observations agree at each check.

## Consequences

This closes long interactive window and rejects unstable or indeterminate
observations. It also makes changed path names safe for terminal display.

residual race remains after final check and before porcelain starts
`git commit`: another process can still change index or move `HEAD` in
that interval. Porcelain cannot atomically compare tree and advance ref.

Using `git commit-tree` followed by `update-ref` would close that interval,
but is rejected. It bypasses user's `pre-commit`, `commit-msg`, and
`post-commit` hooks, silently removing workflow and policy checks. That is a
worse regression than remaining millisecond-scale race.

Closing gap would require hook-preserving Git interface that can make
tree/ref update conditional atomically, or explicit product decision
to replace porcelain and reproduce hook contract. Neither exists today.
