# 0009: Name every provider variable `GCM_<PROVIDER>_<FIELD>`

## Status

Accepted (2026-11-14, decided by the project owner)

## Context

Provider settings had grown without a rule: `GOOGLE_GEMINI_API_KEY`,
`GCM_MODEL`, `GCM_FREELLMAPI_TOKEN`, `OPENROUTER_API_KEY` and `LM_API_TOKEN`.
Three credentials had no `GCM_` prefix, so a generic variable meant for other
tools could reach GCM. The credentials that child processes must not see were
listed by hand, and a new provider could be left off that list.

## Decision

- Provider settings are `GCM_<PROVIDER>_API_KEY`, `GCM_<PROVIDER>_MODEL` and
  `GCM_<PROVIDER>_URL`, for example `GCM_GEMINI_API_KEY`.
- Old names are dropped and not read. GCM keeps no compatibility code or
  migration message for them.
- Git and local CLI child processes start without any variable that matches
  `GCM_*_API_KEY`.

## Consequences

- Existing setups must rename their variables; the changeset lists each old
  name and its replacement.
- A key exported for GCM is dedicated to GCM by name and is never read by
  another tool by accident.
- A new provider key is removed from child environments without a code change,
  as long as it follows the pattern.
