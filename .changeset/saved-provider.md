---
'gcm': patch
---

Start with the last used provider when neither `--provider` nor `GCM_PROVIDER` is set, and ignore a saved provider that is not known. When the saved provider cannot be started in a non-interactive run, warn on stderr and use the first available provider; a provider set by `--provider` or `GCM_PROVIDER` still fails.
