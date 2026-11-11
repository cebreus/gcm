---
'gcm': patch
---

Wait for commit hooks without a time limit when committing, amending or creating an `amend!` commit, instead of stopping Git after 120 seconds. Hooks that print more output than the Git output limit no longer abort the commit.
