---
'gcm': minor
---

Rename provider variables to `GCM_<PROVIDER>_API_KEY`, `GCM_<PROVIDER>_MODEL` and `GCM_<PROVIDER>_URL`. `GOOGLE_GEMINI_API_KEY` becomes `GCM_GEMINI_API_KEY`, `GCM_MODEL` becomes `GCM_GEMINI_MODEL`, `GCM_FREELLMAPI_TOKEN` becomes `GCM_FREELLMAPI_API_KEY` and `LM_API_TOKEN` becomes `GCM_LM_STUDIO_API_KEY`. The old names are no longer read. Every `GCM_*_API_KEY` variable is removed from Git and local CLI environments.
