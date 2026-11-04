---
'gcm': major
---

Remove the `GCM_ENABLE_HUNK_WEIGHTS` setting and the file-importance weighting it controlled.

- Hunk selection now scores every hunk by its changed-line count alone (`added + removed`). Previously, setting `GCM_ENABLE_HUNK_WEIGHTS=true` added a per-file bonus so that code files outranked markup, markup outranked stylesheets, and binaries were pushed down. Anyone who had set the variable will see a different set of hunks in the analysed summary, and therefore a differently worded commit message for an oversized diff. Unset or `false` — the shipped default — behaves exactly as before.
- The variable no longer appears in the environment table in `README.md`. Remove it from any shell profile or wrapper script that exported it; an unrecognised `GCM_` variable is ignored, so a stale export is harmless but has no effect.
