# 2. Preserve porcelain hooks for commit-action consistency

Date: 2026-08-22

## Status

Accepted

## Context

A generated commit message is safe to apply only when it still describes the
Git state that the eventual commit consumes. The action menu can remain open
long enough for another process or user to alter the index or move `HEAD`.

## Decision

For staged changes, capture the index tree immediately before and immediately
after reading the diff. If either observation changes, retry once; if the
second read is also unstable, refuse the action. The verified tree and index
entries travel with the generated message.

Before an action, compare the current index tree with that captured snapshot.
For target actions, preserve the resolved target hash and `HEAD` hash, then
re-read both before the write. The delegated Git writer repeats these checks
immediately before it invokes `git commit`.

The invariant is: a write is attempted only when the message, the captured
index snapshot, and the commit target observations agree at each check.

## Consequences

This closes the long interactive window and rejects unstable or indeterminate
observations. It also makes changed path names safe for terminal display.

A residual race remains after the final check and before porcelain starts
`git commit`: another process can still change the index or move `HEAD` in
that interval. Porcelain cannot atomically compare a tree and advance a ref.

Using `git commit-tree` followed by `update-ref` would close that interval,
but is rejected. It bypasses the user's `pre-commit`, `commit-msg`, and
`post-commit` hooks, silently removing workflow and policy checks. That is a
worse regression than the remaining millisecond-scale race.

Closing the gap would require a hook-preserving Git interface that can make
the tree/ref update conditional atomically, or an explicit product decision
to replace porcelain and reproduce the hook contract. Neither exists today.
