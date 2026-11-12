---
'gcm': patch
---

Git output caps (`GCM_MAX_BUFFER`, `GCM_PER_FILE_BUFFER`) now keep the first bytes up to the cap instead of sometimes dropping the whole output, which made gcm report an empty diff.
