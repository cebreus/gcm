---
'gcm': patch
---

Remove model-written metadata from replies: trailers such as `Co-authored-by`, `Signed-off-by`, `Cc`, `Release-As` and `Change-Id`, issue-closing lines and nested CI skip markers anywhere after the subject, including inside `BREAKING CHANGE` blocks. `BREAKING CHANGE` footers and ordinary prose such as `Note:` lines are kept.
