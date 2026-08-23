# 1. Remove the telemetry subsystem

Date: 2026-08-22

## Status

Accepted

## Context

`src/logger.ts` carried opt-in telemetry feature: `info` and `error`
records were queued in memory and appended to file named by
`GCM_TELEMETRY_FILE`, flushed on timer, on byte budget, and from process
exit and signal handlers. It was off by default.

adversarial review, plus direct probes against running runtime, found:

- asynchronous flush used `Bun.file(path).writer()`, which truncates. Each
  flush replaced file, so every record but last was lost. feature
  never did what its name and its README row promised.
- byte-budget flush was fire-and-forget, so two flushes could race and
  leave file that was not valid NDJSON.
- queue was cleared Before write, so any write failure discarded the
  records permanently.
- Only first logger instance ever created was flushed at exit.
- flush timer was never cancelled, so explicit flush still left CLI
  alive for up to further interval.
- one correct path, synchronous flush, used `appendFileSync` from
  `node:fs`, which project rules forbid.

That last point had no clean resolution. Bun offers no append-by-path API,
synchronous or otherwise. Measured on Bun 1.4.0: `Bun.file().writer()` and
`Bun.write()` both truncate, `writer({ append: true })` is accepted and
ignored, and there is no `Bun.appendFile`. Appending natively is possible only
with descriptor already opened `O_APPEND`, which Bun cannot produce from a
path, or by spawning `tee -a`, which is external POSIX tool rather than a
Bun API — and running process from signal handler is what produced this
file's earlier shell-injection hole.

No code in repository read these files. No documentation described how to
collect, analyse, or retain them. tests largely replaced `Bun.file` with a
mock, so they could not observe truncation at all.

## Decision

Delete telemetry subsystem: queue, byte budget, timer, the
exit and signal handlers, both flush paths, and `GCM_TELEMETRY_FILE`
setting.

Console logging, level filtering, secret redaction, and separate debug log
behind `GCM_DEBUG_API` are unaffected.

## Consequences

Roughly 87 of 233 lines leave `logger.ts`, along with last `node:fs`
dependency there and CLI's shutdown delay. Six defects are resolved by
removal rather than by six fixes plus tests for feature nobody used.

Anyone wanting local event records can redirect CLI's own output. If a
real collection workflow appears later, it should be designed with stated
reader, retention policy, and durability contract — and append problem
above will have to be solved on its own terms first.
