# User flows

`gcm` has three generation use cases. Flags such as `--provider`, `--model`, `--hint`, `--mode`,
`--exclude`, `--verbose` and `--debug` modify these flows; they do not create
separate ones.

`--non-interactive` skips configuration, atomicity, and review prompts. It
stops after generation unless explicit `--apply` requests the available Git
action.

## Provider check: `gcm --list-providers`

```mermaid
flowchart TD
  A[Run gcm --list-providers] --> B{Provider factory set valid?}
  B -- No --> X[Show reason and stop]
  B -- Yes --> C[Check every provider in parallel]
  C --> D[Create provider without loading a model]
  D --> E[Check identity, setup and text-model catalogue]
  E --> F[Show each provider as available or unavailable]
  F --> G{Available providers}
  G -- All --> H[Exit 0]
  G -- Some --> I[Exit 1]
  G -- None --> J[Exit 2]
```

The command ignores the selected provider because it checks all providers. It
does not read Git state, generate text, load an LM Studio model or save a session.

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
  D -- Yes --> D1{Meaningful non-whitespace<br/>changes?}
  D1 -- No --> X
  D1 -- Yes --> D2{Active provider ready?}
  D2 -- No --> X
  D2 -- Yes --> F{Conflicts absent and<br/>analysed snapshot verifiable?}
  F -- No --> X
  F -- Yes --> F2{Git operation<br/>in progress?}
  F2 -- Yes --> R[Keep snapshot;<br/>disable Git write]
  F2 -- No --> G[Write capability available]
  R --> G2[Configure unless model<br/>and mode are both fixed]
  G --> G2
  G2 --> H{Multiple atomic scopes?}
  H -- Yes --> I[Show split proposal;<br/>continue or cancel]
  I -- Cancel --> X
  I -- Continue --> J[Generate with active provider]
  H -- No --> J
  J --> K{Generated result?}
  K -- No text --> Y[Show four-artifact deterministic fallback;<br/>exit without write or session save]
  K -- Invalid --> X
  K -- Valid --> L{Review action}
  L -- Copy or edit --> L
  L -- Regenerate, hint,<br/>or switch model --> J
  L -- Cancel --> Z[Exit without writing]
  L -- Commit --> M{Excluded staged paths<br/>confirmed?}
  M -- No --> Z
  M -- Yes or none --> N{Repository state, index<br/>and capability unchanged?}
  N -- No --> X
  N -- Yes --> O[Create commit and save session]
```

## Existing commit: `gcm --commit <hash>`

```mermaid
flowchart TD
  A[Run gcm --commit hash] --> B{Arguments, repository,<br/>target and conflicts valid?}
  B -- No --> X[Show reason and stop]
  B -- Yes --> C[Read target diff]
  C --> C2{Changes valid and<br/>active provider ready?}
  C2 -- No --> X
  C2 -- Yes --> C3{Conflicts absent and<br/>snapshot verifiable?}
  C3 -- No --> X
  C3 -- Yes --> C4{Inspect Git capability}
  C4 -- Amend HEAD or amend! --> D[Configure unless model<br/>and mode are both fixed]
  C4 -- In-progress operation,<br/>unreachable or unresolved target,<br/>detached HEAD or staged index --> R[Disable Git write]
  R --> D
  D --> E[Generate with active provider]
  E --> F{Generated result?}
  F -- No text --> Y[Show four-artifact deterministic fallback;<br/>exit without write or session save]
  F -- Invalid --> X
  F -- Valid --> G{Review action}
  G -- Copy or edit --> G
  G -- Regenerate, hint,<br/>or switch model --> E
  G -- Cancel --> Z[Exit without writing]
  G -- Available Git action --> H{Capability found<br/>during inspection}
  H -- Unpublished HEAD --> I{Repository state, mode,<br/>HEAD, target and index unchanged?}
  I -- Yes --> J[Amend HEAD and save session]
  I -- No --> X
  H -- Published HEAD or<br/>reachable older commit --> K{Repository state, mode,<br/>target, HEAD and index unchanged?}
  K -- Yes --> L[Create amend! and save session]
  L --> M[Print manual rebase command;<br/>never run it]
  K -- No --> X
```

The exact write-action matrix and edge cases remain in the
[Commit Safety](../README.md#commit-safety) table.

Immediately before a selected write, the action service re-reads repository
state, conflicts, the index snapshot and capability. Target actions also
revalidate HEAD and the resolved target. The delegated Git write boundary then
checks the index and HEAD/target once more. Session model and mode are saved
only after that Git action succeeds.

## Commit range: `gcm --commit-range <range>`

```mermaid
flowchart TD
  A[Resolve first-parent range once] --> B{Targets found?}
  B -- No --> X[Stop before generation]
  B -- Yes --> C[Process oldest target]
  C --> D{Exact amend exists?}
  D -- Yes --> E[Skip target]
  D -- No --> F[Run existing commit generation]
  F --> G{Generation and amend-only action succeed?}
  G -- No --> X2[Stop; keep completed amend commits]
  G -- Yes --> H{Amend commit tree equals parent?}
  H -- No --> X2
  H -- Yes --> I{More frozen targets?}
  E --> I
  I -- Yes --> C
  I -- No --> Z[Report summary; never run rebase]
```

The range is sequential, non-interactive and first-parent only. Existing
`amend!`, `fixup!` and `squash!` commits are excluded from its frozen targets.
Unexpected HEAD movement, index changes, Git operations and hook-added file
changes stop the batch without rollback. Re-running skips exact existing
`amend! <full-hash>` commits.
