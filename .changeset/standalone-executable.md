---
'gcm': minor
---

Build `dist/gcm` and the release binaries as standalone executables that ignore `bunfig.toml` and `.env` in the working directory, so a repository cannot inject preload scripts or settings. A project `.env` no longer configures `gcm`; set variables in the shell environment.
