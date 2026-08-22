# 1. Remove the telemetry subsystem

Date: 2026-08-22

## Status

Accepted

## Context

`src/logger.ts` carried an opt-in telemetry feature: `info` and `error`
records were queued in memory and appended to the file named by
`GCM_TELEMETRY_FILE`, flushed on a timer, on a byte budget, and from process
exit and signal handlers. It was off by default.

An adversarial review, plus direct probes against the running runtime, found:

- The asynchronous flush used `Bun.file(path).writer()`, which truncates. Each
  flush replaced the file, so every record but the last was lost. The feature
  never did what its name and its README row promised.
- The byte-budget flush was fire-and-forget, so two flushes could race and
  leave a file that was not valid NDJSON.
- The queue was cleared before the write, so any write failure discarded the
  records permanently.
- Only the first logger instance ever created was flushed at exit.
- The flush timer was never cancelled, so an explicit flush still left the CLI
  alive for up to a further interval.
- The one correct path, the synchronous flush, used `appendFileSync` from
  `node:fs`, which the project rules forbid.

That last point had no clean resolution. Bun offers no append-by-path API,
synchronous or otherwise. Measured on Bun 1.4.0: `Bun.file().writer()` and
`Bun.write()` both truncate, `writer({ append: true })` is accepted and
ignored, and there is no `Bun.appendFile`. Appending natively is possible only
with a descriptor already opened `O_APPEND`, which Bun cannot produce from a
path, or by spawning `tee -a`, which is an external POSIX tool rather than a
Bun API — and running a process from a signal handler is what produced this
file's earlier shell-injection hole.

No code in the repository read these files. No documentation described how to
collect, analyse, or retain them. The tests largely replaced `Bun.file` with a
mock, so they could not observe truncation at all.

## Decision

Delete the telemetry subsystem: the queue, the byte budget, the timer, the
exit and signal handlers, both flush paths, and the `GCM_TELEMETRY_FILE`
setting.

Console logging, level filtering, secret redaction, and the separate debug log
behind `GCM_DEBUG_API` are unaffected.

## Consequences

Roughly 87 of 233 lines leave `logger.ts`, along with the last `node:fs`
dependency there and the CLI's shutdown delay. Six defects are resolved by
removal rather than by six fixes plus tests for a feature nobody used.

Anyone wanting local event records can redirect the CLI's own output. If a
real collection workflow appears later, it should be designed with a stated
reader, retention policy, and durability contract — and the append problem
above will have to be solved on its own terms first.
