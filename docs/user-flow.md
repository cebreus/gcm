# User flows

`gcm` has two generation use cases. Flags such as `--model`, `--mode`,
`--exclude`, `--verbose` and `--debug` modify these flows; they do not create
separate ones.

## Staged changes: `gcm`

```mermaid
flowchart TD
  A[Run gcm] --> B{Arguments, repository<br/>and conflicts valid?}
  B -- No --> X[Show reason and stop]
  B -- Yes --> C[Read staged snapshot]
  C --> D{Changes staged?}
  D -- No, interactive --> E[Re-check, show split<br/>proposal, or cancel]
  E -- Re-check --> B
  E -- Cancel --> X
  D -- No, non-interactive --> X
  D -- Yes --> F{Content, API key and<br/>analysed index valid?}
  F -- No --> X
  F -- Yes --> G[Configure unless model<br/>and mode are both fixed]
  G --> H{Multiple atomic scopes?}
  H -- Yes --> I[Show split proposal;<br/>continue or cancel]
  I -- Cancel --> X
  I -- Continue --> J[Generate with Gemini]
  H -- No --> J
  J --> K{Generated result valid?}
  K -- No --> X
  K -- Yes --> L{Review action}
  L -- Copy or edit --> L
  L -- Regenerate, hint,<br/>or switch model --> J
  L -- Cancel --> Z[Exit without writing]
  L -- Commit --> M{Excluded staged paths<br/>confirmed?}
  M -- No --> Z
  M -- Yes or none --> N{Index and action<br/>still unchanged?}
  N -- No --> X
  N -- Yes --> O[Create commit and save session]
```

## Existing commit: `gcm --commit <hash>`

```mermaid
flowchart TD
  A[Run gcm --commit hash] --> B{Arguments, repository,<br/>target and conflicts valid?}
  B -- No --> X[Show reason and stop]
  B -- Yes --> C[Read target diff]
  C --> C2{Changes and<br/>API key valid?}
  C2 -- No --> X
  C2 -- Yes --> C3{Inspect Git capability}
  C3 -- Amend HEAD or amend! --> D[Configure unless model<br/>and mode are both fixed]
  C3 -- No safe write action --> D
  D --> E[Generate with Gemini]
  E --> F{Generated result valid?}
  F -- No --> X
  F -- Yes --> G{Review action}
  G -- Copy or edit --> G
  G -- Regenerate, hint,<br/>or switch model --> E
  G -- Cancel --> Z[Exit without writing]
  G -- Available Git action --> H{Capability found<br/>during inspection}
  H -- Unpublished HEAD --> I{HEAD, target and index<br/>still unchanged?}
  I -- Yes --> J[Amend HEAD and save session]
  I -- No --> X
  H -- Published HEAD or<br/>reachable older commit --> K{Target, HEAD and index<br/>still unchanged?}
  K -- Yes --> L[Create amend! and save session]
  L --> M[Print manual rebase command;<br/>never run it]
  K -- No --> X
```

The exact write-action matrix and edge cases remain in the
[Commit Safety](../README.md#commit-safety) table.
