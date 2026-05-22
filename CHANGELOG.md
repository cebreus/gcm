# gcm

## 0.7.1

> GCM no longer wraps a long subject at 60 characters or a long body line at 80 characters. This avoids unwanted breaks in Markdown lists.

### Patch Changes

- **Less message rewriting:** GCM no longer adds manual line breaks to long lines. It still trims the subject and body lines, removes empty lines inside the body, and adds one blank line between subject and body. The AI prompt asks for a subject of at most 60 characters and bullets of at most 80 characters.
- **Whitespace-only changes:** Staged file discovery now keeps files changed only by whitespace. If the staged diff still contains only whitespace, GCM stops before it calls Gemini and reports how many files it found.

## 0.7.0

> GCM can now find staged files that may belong in separate commits. It can show a split plan and uses recent related commit subjects as writing examples. It also stops Git writes when the repository is not safe.

### Minor Changes

- **Atomic groups:** GCM groups staged files by dependencies, documents, formatting, tests, CI, or product code. If it finds more than one scope, it warns the user and offers `Show split proposal`, `Continue anyway`, or `Cancel`. Commands appear only when the user asks for the plan. GCM does not run them.
- **Split-plan limits:** Each group starts with plain `git reset`, then uses `git add <paths>` without `--`. A path that starts with `-` may be read as an option. Unstaged content in the same path may also enter the new commit. The user must check the commands and file content before using the plan.
- **Repository writing examples:** GCM sends up to 10 unique subjects from the last 20 commits that touched the changed files. These are repository examples, not proof of the current user's style. GCM also tells the AI to use only diff, file, and history facts and not invent reasons, speed, security, migration, or breaking changes.
- **Saved model:** GCM remembers the model selected at the start of a session and saves it after a successful commit. A saved `gemini-2.5-pro` value moves to `gemini-2.5-flash`.
- **Safe Git state:** Unresolved conflicts stop generation. During a merge, rebase, cherry-pick, revert, or bisect, GCM can still generate, copy, and edit text, but it removes the Commit action. Work with `--commit` is also read-only.
- **No staged files:** When nothing is staged, the user can check the repository again or stop. A split plan is also offered when changed worktree files exist. A re-check loads fresh Git state and staged content.

## 0.6.1

> This release changes internal code and development checks. It does not intend to change normal GCM behaviour.

### Patch Changes

- **Smaller functions:** Large generation, parsing, logging, Git, and AI service functions are split into smaller internal helpers. This is an internal structure change with no intended user-visible effect.
- **Checked model list:** Gemini model-list JSON is now read as unknown data. GCM checks the response object, model entries, names, and generation-method lists before use. Bad model entries are ignored instead of being trusted.
- **Stronger development checks:** Developer-only lint rules now check full switches, object-literal type assertions, unsafe `any` use, unsafe data access, negative conditions, and task comments. They also warn above two nested callbacks, four parameters, or 18 statements.
- **Type-check command:** The package script `typecheck` is renamed to `check`. Developers must use `bun run check`; `bun run typecheck` no longer exists.

## 0.6.0

> GCM now has an interactive loop. The user can review, edit, copy, commit, or generate the message again before leaving. GCM remembers the last model and output type after a successful Git action.

### Minor Changes

- **Review menu:** After generation, the user can commit, edit, copy, generate again with extra guidance, choose another model, or stop. Copy and Edit work only with the commit message, not branch or pull request text. GCM does not reject an empty edit in this release, so Git may reject it later.
- **Output type:** `--mode commit-only` asks for a Conventional Commit message. `--mode full` also asks for a branch name and pull request text. `-m` is the short form. With no CLI or saved choice, the default is `commit-only`.
- **Settings menu rule:** The settings menu opens only when neither `--model` nor `--mode` is given. Either option skips the menu, and a missing choice comes from the session or default. An invalid `--mode` is silently ignored.
- **Saved settings:** After a successful commit, GCM saves the model and output type in `~/.gcm-session.json`. It does not save after copy, edit, or cancel. Read, parse, and write errors are silently ignored. This release does not check the saved data shape, model, or mode before use.
- **Interactive guidance:** The user can enter extra guidance after reviewing a draft. GCM adds it to the next AI request. This release does not add the later `--hint` CLI option.
- **Truncated reply:** GCM retries one cut reply with a larger output limit. If a commit message is present, and full mode also has a branch name, it may show a partial result with a warning. Pull request title and description may still be missing. Commit-only mode accepts any non-empty raw reply as the message.
- **Reply markers:** GCM removes protocol markers `<<START>>`, `<<END>>`, and `<<END_TRUNCATED>>` when they look like protocol text. It keeps likely natural-language mentions of the same words.
- **Contributor tools:** TypeScript now uses ESNext modules, bundler resolution, no emit, isolated modules, and Bun types. ESLint config moves from `.ts` to `.js`, and major ESLint and Clack versions change. Users need no migration, but contributors need the new project toolchain.

## 0.5.0

> GCM now shows its version in help and in the start banner. It also adds tools for a reply that may be cut and keeps letters and symbols from languages other than English.

### Minor Changes

- **Version output:** `--version` prints the version from `package.json` and exits. `--help` and the start banner show it too. If the file or version cannot be read, they show `unknown`; the product name falls back to `gcm`.

### Patch Changes

- **Reply markers:** When `GCM_ADD_RESPONSE_MARKERS=true`, which is the default, GCM asks Gemini to use reply markers. When `<<START>>` has no later `<<END>>`, or when `<<END_TRUNCATED>>` is present, GCM treats the reply as cut. A normal end marker cannot prove that all wanted text is present.
- **Cut reply retry:** GCM first asks the user whether to retry a reply marked as cut. If the user agrees, it starts a new request. That request may make up to two more automatic retries, and each adds `GCM_MAX_OUTPUT_TOKENS` of output space. This does not guarantee a full reply.
- **Known overflow bug:** After a no-text or `MAX_TOKENS` error, GCM first retries with selected diff sections and 1,024 more output tokens. If that still overflows and another attempt runs, the code can read an undefined `shrinkFactor` and fail with `ReferenceError`.
- **Clear prompt:** Commit-only mode asks only for a commit message. Full mode asks for a branch name, pull request title and text, and a commit message.
- **English cut-reply UI:** Questions, choices, and progress text for a cut reply change from Czech to English.
- **More writing systems:** GCM keeps letters and symbols from languages other than English. It still removes basic control characters, except tab and line breaks.
- **Project tools:** Formatting now ignores `dist`. `.prettierignore` adds `node_modules`, `dist`, `bun.lock`, and `pnpm-lock.yaml`. This does not change generated messages.

## 0.4.0

> GCM adds an `--exclude` option, but this release filters only the file-name list and still sends excluded file text to Gemini. It also adds reply markers, cut-reply handling, model filtering, and broad error retries.

### Minor Changes

- **Exclude files:** Repeat `--exclude <pattern>` or `-e <pattern>`, or use commas. Patterns are case-sensitive and match the full path; `*` crosses folders and `?` matches one character. In this release, only the file-name list is filtered. The full staged diff, including excluded file text, is still sent to Gemini. If every file matches, GCM stops. Files stay staged.
- **Message wrapping:** Full-mode commit text is wrapped near 60 characters for the subject and 80 for body lines. Commit-only fallback text is not wrapped. Long words and text inside backticks may stay longer. A long subject becomes extra lines, and a wrapped list item repeats its marker, so one item may become several. Release `0.7.1` later removes this wrapping.

### Patch Changes

- **Reply checks:** By default, GCM wraps the input diff in markers and always asks Gemini to mark its output. Turning `GCM_ADD_RESPONSE_MARKERS` off stops only the input markers. `<<START>>` without a later `<<END>>`, or any `<<END_TRUNCATED>>`, means cut; no markers means not cut. A Czech question offers a retry. If accepted, a fresh request may retry twice with more output space. Success is not guaranteed.
- **Model list:** Live results must support `generateContent`. GCM then keeps `gemini-` names and removes known embedding, image, audio, live, robotics, computer-use, Veo, and Imagen models. If loading fails or leaves no models, it uses four built-in names. The built-in limits may not match the live service. Gemini 3 Pro Preview is removed and Gemini 3.1 Flash-Lite Preview is added.
- **Retries:** GCM retries almost every caught Gemini error, not only temporary server errors. The default is three retries after the first call. HTTP `429`, `502`, `503`, and `504` use a server or growing wait; other errors use a growing wait plus random time. Separate context-overflow retries may use a summary or smaller input. Recovery is not guaranteed.
- **API key location:** The Gemini API key moves from the URL to the `x-goog-api-key` request header. This reduces exposure in URL logs and history but does not make the whole request secret.
- **Destructive output cleaning:** GCM removes all non-ASCII characters, so accents and non-Latin writing can disappear. It removes every marker string, even when it is real content. Full parsing stops at about 16 million text characters, allows missing pull request fields, and changes branch text without proving it is a valid Git branch. Commit-only fallback accepts any non-empty cleaned reply.
- **Log redaction limit:** JWT matching now needs the first two parts to start with `ey`. This removes fewer normal strings, but other three-part secrets may remain visible. Key and PEM checks are still pattern-based.
- **Contributor tools:** The format command runs ESLint fix and then Prettier. Clack, ESLint, TypeScript, Bun types, and other tools change versions. Both `bun.lock` and `pnpm-lock.yaml` are committed, which conflicts with using one package manager.

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
