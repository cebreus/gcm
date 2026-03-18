# gcm

## 0.3.0

> GCM now suggests a Conventional Commit scope from changed paths and recent commit subjects. It also lists Gemini models and adds an interactive terminal flow. This first flow has important Git safety limits.

### Minor Changes

- **Scope suggestion:** A scope is the text inside `feat(scope):`. GCM first gets unique scopes from the last 50 commit subjects that touched the changed files. In a monorepo, it also uses the folder after `apps/` or `packages/`. If none exist, it uses the folder after `src/`. Gemini may ignore all suggestions.
- **Live model list:** `--list-models` needs `GOOGLE_GEMINI_API_KEY`, calls Gemini, and prints every returned name without checking whether it can generate text. It exits `1` for no key and `2` for bad service data. In this release, the key is placed in the URL.
- **Built-in model data:** Four built-in models give the interactive menu labels and limits. An unknown model instead gets a general limit of 100,000 input and 8,192 output tokens. These values are assumptions and may be wrong. The default changes from `gemini-2.5-flash-lite` to `gemini-2.5-flash`.
- **Output choices:** There is no `--mode` option yet. Commit-only is the default. Full mode asks Gemini for branch, pull request, and commit fields, but the UI shows only branch and commit message. If `--model` is passed, settings are skipped and full mode cannot be selected.
- **Interactive limits:** Regeneration first opens the built-in model picker. Copy copies only the commit message and exits. Edit accepts an empty message. Commit runs `git commit -m` for all files currently staged; after failure, the run ends.
- **Unsafe old-commit action:** `--commit <hash>` reads an old commit, but the Commit action still writes the user's current staged files. It can commit unrelated work with a message made for the old commit.
- **Injected no-response fallback:** The normal Gemini client throws after invalid or empty replies, so it does not reach this fallback. A custom or test service that returns no response makes GCM build a general `chore` branch and commit message. The commit lists up to 12 paths; the pull request text always says the list may be cut. GCM logs it and exits without review.
- **Large changes:** Binary-like files, including SVG, map, and HEIC files, may be left out of summaries. Skipped names are grouped and capped at 15 per folder. Oversize context is summarised, then may be hard-cut. Recovery uses top diff sections, then halves input and output limits. Some changes can be omitted. Service recovery treats `GCM_GEMINI_MAX_RETRIES` as three total attempts by default. The lower Gemini client treats it as three retries after the first request and broadly retries caught errors first, so the total call count can be higher.
- **Runtime and packages:** The build target changes from Node to Bun. Runtime packages move to `devDependencies`, so a production-only install may not run the source CLI; the compiled binary includes them.

## 0.2.0

> The first tagged GCM release reads the Git diff and file names staged for the next commit. It sends the diff, or a reduced form when limits are hit, to Google's Gemini service. It prints a branch name, commit message, pull request title, and pull request description. It does not edit files or create a commit.

### Minor Changes

- **Generated text only:** GCM prints a branch name and commit message. Pull request fields may be missing. It does not check that the branch name is valid. If full parsing fails, it prints the raw Gemini reply. `--commit <hash>` reads an old commit but remains read-only.
- **Broken options:** `--model` is read and shown in logs, but requests still use `GCM_MODEL`, `GEMINI_MODEL`, or the default `gemini-2.5-flash-lite`. `--dry-run` is also read but has no effect. `GOOGLE_GEMINI_API_KEY` is required.
- **Git output limit:** Git runs as a non-blocking child process, but its text is still kept in memory. The hard-coded limit is about 50 million text units; the code calls them bytes but does not count real bytes. Calls do not use `GCM_MAX_BUFFER`. When the limit is crossed, GCM kills Git, drops the crossing data part, and returns partial text marked as cut. Per-file limits use the same wrong unit.
- **Large diff summary:** Files are processed one after another; `GCM_FILE_CONCURRENCY` has no effect. PNG, JPEG, GIF, ICO, SVG, font, and map file content is skipped. Config-like files get no context lines and other files get one. At most 16 changed sections are kept by default, and weighting is off. Whole files or changes can be omitted.
- **Summary trigger limit:** With default settings, the first Git cut at about 50 million text units often happens before the later size-based summary check. Text may still be cut to fit an estimated model limit. Token counts are estimates, not a guarantee.
- **Wrong old-commit summary:** `--commit <hash>` first reads the old commit. If size recovery asks for a summary, GCM instead runs a staged diff for its statistics and file text. The Gemini request may then describe current staged work, or no work, instead of the old commit. It remains read-only.
- **Broad retries:** The lower Gemini client retries most caught errors three times after the first call by default. The outer recovery uses the same setting as three total attempts. It first uses top diff sections, then halves input and output limits. This can make many calls and omit more changes.
- **Injected fallback only:** The normal Gemini client throws when it gets no text. A fixed fallback message is reachable only when a custom or test client returns no response.
- **Unsafe debug log:** `--debug` writes the API URL with the Gemini key, the full diff and request, and the full parsed reply to `.debug.log`. The preview limit does not protect all entries, and debug text is not redacted. The key is sent in both the URL and a header. Protect and delete this file; rotate the key if it was exposed.
- **Limited normal redaction:** Main log redaction uses known text patterns and may miss secrets. Console metadata is not redacted.
- **Unsafe telemetry path:** `GCM_TELEMETRY_FILE` adds info and error data to a JSON log. Its exit path builds a `bash -c` command with the configured path. Shell control text in an untrusted path can run commands. Use only a trusted simple path. Best-effort writes can also be lost.
- **Weak setting checks:** Most number settings accept invalid, negative, or unsafe values. `GCM_MAX_BUFFER=0` falls back to about 50 million text units, while some other zero values stay zero.
- **Broken source start:** `package.json` starts and points to `gcm.js`, but that file was deleted during the TypeScript move. From source, use `bun run ./gcm.ts`. The build writes `dist/gcm`, but `main` does not point there.
- **Build mismatch:** The build command runs through Bun but targets Node, while source and built code use Bun APIs and the package requires Bun. A portable Node program is not proven. There is no install or release script.
- **Wrong setup key:** The README tells users to set `GEMINI_API_KEY`, but the code requires `GOOGLE_GEMINI_API_KEY`. Following the README example fails.
- **Contributor checks:** The project adds tests, lint, and formatting checks for contributors.
