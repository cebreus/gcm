---
"gcm": patch
---

Analyse whitespace-only changes, such as re-indented YAML or Python, instead of sending the model an empty diff; whitespace noise is still ignored when a change has other content.
