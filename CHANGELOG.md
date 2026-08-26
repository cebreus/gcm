# gcm

## 0.10.0

> GCM can now run without menus, work on several old commits, use extra user instructions, and select Gemini, FreeLLMAPI, or LM Studio. Users can check which AI services are ready before they start generation.

### Minor Changes

- **Run without menus:** `--non-interactive` runs GCM without questions or review screens. It only prints the result by default. Add `--apply` if GCM may run the matching Git action.
- **Work on a commit range:** `--commit-range <range>` reads commits from oldest to newest on the main history path. It does not enter merged branches. It needs `--non-interactive`. With `--apply`, it creates one `amend!` commit for each target. It skips a target when an `amend!` commit for the same commit hash already exists. GCM does not run rebase.
- **Safe range changes:** `--commit-range` with `--apply` needs no files in the staging area, no merge conflict, and no Git operation in progress. It stops if `HEAD` moves or a Git hook adds file changes. This protects work while GCM moves through old commits.
- **Choose an AI service:** `--provider <name>` selects `gemini`, `freellmapi`, or `lm-studio`. `--model <name>` selects one model from that service.
- **Add extra guidance:** `--hint <text>` and `-H <text>` add user guidance to the AI request. This can explain intent that is not clear from the Git diff.
- **Check AI services:** `--list-providers` contacts every configured service and checks for a usable text model. It reports which services are ready and then exits. It exits with `0` when all services are ready, `1` when only some are ready, and `2` when none are ready. It does not create text or change Git.
- **FreeLLMAPI provider:** GCM adds an OpenAI-compatible service under the public name `freellmapi`. You can set its URL, model, and token with `GCM_FREELLMAPI_URL`, `GCM_FREELLMAPI_MODEL`, and `GCM_FREELLMAPI_TOKEN`. The default URL is `http://127.0.0.1:3001` and the default model is `auto`.
- **Provider name change:** The old `openai` provider name and its `GCM_OPENAI_*` settings are replaced by `freellmapi` and `GCM_FREELLMAPI_*`. Users must update scripts and environment settings before they upgrade.

### Patch Changes

- **Safe Gemini model list:** GCM limits the size of each Gemini model-list request and the number of pages it will read. A bad or very large reply cannot keep model loading in an endless loop.

## 0.9.0

> GCM can now use models from LM Studio on the user's computer. Gemini still works as before. A simpler settings menu makes it easier to choose the AI service, model, and output type.

### Minor Changes

- **LM Studio support:** GCM can find models from LM Studio and use them to create commit messages. LM Studio must run on the same computer. The default address is `http://127.0.0.1:1234`, and other network addresses are rejected. Choose LM Studio in Settings or set `GCM_PROVIDER=lm-studio`. An optional login token can be set with `LM_API_TOKEN`. Analysed text stays on the same computer when LM Studio is used.
- **LM Studio limits:** For a loaded model, GCM uses its active context size. For an unloaded model, it uses at most 8,192 input tokens until the model is loaded.
- **LM Studio model choice:** The preferred model is `gemma-4-e4b-it-mlx`. If that model is missing or cannot load, and no strict model was set, GCM reports the fallback and chooses an already loaded model, then the first compatible model.
- **Saved AI service:** After a successful Git action, GCM saves the selected AI service with its matching model. Old session data has no service name, so this release ignores it. The user may need to choose the model and output settings again once.
- **Service failure:** If the selected AI service cannot start in an interactive terminal, GCM offers the other service. Without an interactive terminal, it exits with an error.
- **Simpler settings:** The AI service, model, and output type can now be changed directly from the main settings menu. The user no longer needs to open a second menu.

### Patch Changes

- **Safer generated text:** GCM rejects control or reasoning tags, fenced code, bidirectional control characters, and a commit subject that is not a valid Conventional Commit. It hides the secret value in `Authorization: Bearer` and `Authorization: Basic` text before that text is sent to an AI service or written to a log.
- **Better commit bodies:** A commit body is still optional. When it is needed, GCM asks for at least two short bullet points. Each point must add a different detail and must not repeat the subject.
- **Development checks:** TypeScript-aware lint checks now cover all production code. This does not change normal GCM output.

## 0.8.1

> GCM now checks the Git state and its settings before it asks an AI service for text. It stops early when files have merge conflicts or when it cannot read a full and stable Git result.

### Patch Changes

- **Early conflict check:** GCM stops before settings or generation when the Git staging area has unresolved conflicts. It checks again after the user changes which files are staged. It also stops if the staged snapshot changes or cannot be checked before generation.
- **Read-only use during a Git operation:** GCM can still create text during a merge, rebase, cherry-pick, revert, or bisect when there are no conflicts and the staged files stay the same. It does not run a Git write action during these operations.
- **Settings menu rule:** GCM skips the settings menu only when both `--model` and `--mode` are given. With only one of them, it still opens settings for the missing choice. Scripts that must avoid the menu need both options.
- **Clear `amend!` action:** When GCM must make an `amend!` commit for an older or published target, the action label now says that the user must run a rebase later.
- **Short setting names:** Model and temperature settings now use `GCM_MODEL` and `GCM_TEMP`. GCM no longer reads `GEMINI_MODEL`, `GCM_TEMPERATURE`, or `GEMINI_TEMP`. Rename these variables before upgrade.
- **Checked number settings:** If a number setting is empty, not finite, outside its allowed range, or unsafe as an integer, GCM uses its safe default. The retry start delay also cannot be longer than the retry maximum.
- **Safe Git process output:** GCM limits Git output by bytes. It keeps a UTF-8 character correct when its bytes arrive in different data parts. It stops when important output is cut instead of using incomplete repository data.
- **Bun runtime:** File and process work now uses Bun APIs. Bad saved session data is rejected. The project also removes an unwanted pnpm lockfile and uses the correct Bun lint globals. These changes mainly improve maintenance and runtime safety.

## 0.8.0

> GCM now links each generated message to the exact files that were ready for the next commit. It checks those files again before it writes to Git. It also protects secrets and terminal output, and stops Git actions that may lose work.

### Minor Changes

- **New default model:** The default Gemini model is now `gemini-3.7-flash`. A saved session that uses `gemini-2.5-flash` or `gemini-2.5-pro` moves to the configured or default model. Other saved model names stay unchanged.
- **Safe work on old commits:** With `--commit <target>`, GCM changes a message directly only when the target is the current `HEAD`, no remote branch contains it, `HEAD` is attached to a branch, and no files are staged. If GCM cannot get a safe answer from configured remotes, it treats the commit as published. For an older or published target, GCM creates a new `amend!` commit and prints the exact manual rebase command. It does not rewrite old history itself.
- **Git write checks:** A target outside the current branch is read-only. Before every Git write, GCM checks `HEAD`, the target, the action type, and the exact staged tree again. It retries one unstable read of the staging area, then stops. It also stops when excluded staged files were not accepted by the user. Excluding a file keeps its text away from the AI service but does not remove it from the staging area.
- **Commit split plan:** GCM can group staged files that look like more than one change. When nothing is staged, it can instead use changed worktree files and labels them as worktree files. It shows copy-ready `git reset` and `git add` commands but does not run them. Each command puts `--` before file paths, so a path that starts with `-` is not read as an option. In this release, commands for staged paths can mix unstaged content from the same path into a commit. The user must check both versions before using them. Release `0.11.0` later removes these commands for staged input.
- **Safe debug logs:** GCM creates a debug log with private file access, does not follow a symbolic link, and limits each saved API body preview. The file itself can still grow as new records are added.

### Patch Changes

- **API key safety:** The Gemini model-list request now sends the API key in an HTTP header, not in the URL.
- **Secret removal:** GCM removes supported Google, AWS, GitHub, Slack, OpenAI-style, JWT, and PEM secret shapes before a diff is sent to Gemini or logged. This pattern check cannot find every secret. A stricter outbound check keeps ordinary code that only looks similar to a secret.
- **Safe terminal text:** GCM removes ANSI and other terminal control text from AI output, API errors, Git text, and commit subjects.
- **Safe file names:** GCM reads staged file names with Git's zero-byte separator. File names with spaces, quotes, new lines, or non-ASCII text cannot avoid an `--exclude` rule. GCM stops if this file list is cut.
- **Correct merge diff:** GCM compares a merge commit with its first parent, so the merge changes are not shown as empty.
- **Git hook changes:** After a commit, GCM compares the committed tree with the tree it analysed. It warns when a Git hook changed the tree and names new file paths. It cannot stop the hook from changing the commit, so this is a warning after the write.
- **Empty Gemini reply:** If Gemini gives no text after all retries, GCM shows a fixed diagnostic result. It does not offer a Git write action for that result.
- **Gemini error detail:** A Gemini API failure shows the error detail and a short part of the response. This part has a size limit and known secret shapes are hidden, so it may not contain the full server reply.
- **Commit body layout:** Release `0.7.1` removed manual line wrapping. This release also keeps blank lines and indentation in the generated commit body instead of trimming every body line.
- **Token limits:** GCM counts fixed instructions, repository facts, diff summaries, and user hints in the model input limit. It keeps a full user hint or removes it; it never cuts the hint in half. It uses a diff summary only when the summary is shorter. It treats `MAX_TOKENS` as an incomplete reply and stops retrying when output space cannot grow. Server retry waits are limited. The default output limit is now 8,192 tokens and the default diff limit is 40 hunks.
- **Clear CLI errors:** GCM rejects unknown options, missing values, invalid values, and repeated options that accept only one value. `--exclude` can be repeated or use comma-separated patterns. An exclude value may start with a dash. `--` ends option parsing, so later text is not treated as an option. Errors use a non-zero exit code instead of silent success.
- **Removed CLI and settings:** `--dry-run` is removed. GCM also stops reading `GCM_FILE_CONCURRENCY`, `GCM_MAX_CONTEXT_TOKENS`, `GCM_MAX_INPUT_TOKENS`, and `GCM_MAX_INPUT_TOKENS_SAFETY_FACTOR`. Scripts and settings must stop using these names before upgrade.
- **Exact exclude rules:** Exclude patterns are case-sensitive and match the full path. `*` can cross folders. `?` matches exactly one character.
- **Bounded debug previews:** Each saved API request or response body preview has a size limit measured in UTF-8 bytes, and a cut never splits a character. Normal redacted log messages are no longer cut at the old 256-character metadata limit.
- **No saved telemetry:** GCM removes telemetry events and `GCM_TELEMETRY_FILE` because there is no supported reader for them. Only terminal output and optional debug logs with bounded API body previews remain.

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
