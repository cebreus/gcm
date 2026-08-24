# 4. Redact known secret shapes before text leaves the machine

Date: 2026-08-22

## Status

Accepted

## Context

The staged diff is the payload of every request to the active language model provider. A developer who
stages a secret by accident transmits it to a third party, and the same text
also reaches the local debug log. The logger already redacted a set of key
shapes for its own output; the outbound request did not.

Refusing to send when a secret is detected was considered and rejected. Secret
detection is heuristic: a false positive would block a legitimate commit, and
the decision to abandon a commit belongs to the user, not to a pattern match.

## Decision

The redaction patterns live in one shared helper. Text leaving the machine, in
a request or in a log, passes through it. Detection is by shape: `AQ.` and
`AIza` Google keys, `AKIA`, `ghp_`, `github_pat_`, `xoxb-`, `sk-` prefixes,
JWTs and PEM blocks.

The outbound path uses stricter thresholds than the log path. A log entry that
over-redacts costs nothing, whereas replacing an ordinary identifier such as
`sk-optional-flag` in the diff hides real code from the model and degrades the
message it generates.

## Consequences

A secret of a known shape no longer reaches Google or the debug log intact.

Redaction remains pattern-based and cannot recognise a secret that has no
recognisable shape — a password in a config file, a private URL, a customer
name. `.debug.log` still contains the analysed diff and is documented as
sensitive. `--exclude` remains the way to keep a file out of the request
entirely, and the tool asks for confirmation before committing excluded paths.

Because redaction happens after the diff is assembled, the model sees
`[REDACTED-KEY]` where a key stood. A commit that genuinely rotates a key is
therefore described in general terms rather than by its value, which is the
intended outcome.
