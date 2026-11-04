---
'gcm': major
---

Rename the two listing flags so the noun comes first.

- `--list-models` is now `--models-list`, and `--list-providers` is now `--providers-list`. Behaviour and exit codes are unchanged. The old names are rejected with `Unknown flag`, so update any script or alias that used them.
