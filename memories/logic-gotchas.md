# Logic/Correctness Gotchas

Description: Known logical errors, state management pitfalls, and algorithmic traps.

## 🚨 Undefined `shrinkFactor` Caused Runtime Crash

- **Date Discovered:** UNKNOWN
- **Category:** Logic/Correctness
- **Context/Manifestation:** `createGeminiService` referenced an undefined `shrinkFactor` when handling context overflow, causing a runtime exception on that retry path.
- **Rule:** Do not reference undeclared retry parameters in overflow handling; keep shrink behavior behind an explicitly defined constant/config value and cover the non-summary overflow branch with a test.

## 🚨 Global Marker Stripping Broke Legitimate Content

- **Date Discovered:** UNKNOWN
- **Category:** Logic/Correctness
- **Context/Manifestation:** `sanitizeForDisplay` originally removed `<<START>>/<<END>>` marker strings globally, which could delete legitimate user-facing content that happens to include those sequences.
- **Rule:** Only remove protocol markers in a way that preserves natural-language mentions; do not perform unconditional global string stripping for marker tokens.

## 🚨 `process.exitCode` Can Leak Between Runs

- **Date Discovered:** UNKNOWN
- **Category:** Logic/Correctness
- **Context/Manifestation:** When `executeCommitMessageGeneration` runs multiple times in the same process, a previously set non-zero `process.exitCode` can persist unless explicitly reset on success paths (e.g., `--list-models`).
- **Rule:** Any codepath that sets `process.exitCode` must also explicitly set it to `0` on success for deterministic multi-run behavior.

## 🚨 AI Generated Text Splitting & List Formatting Breaking

- **Date Discovered:** 2026-05-22T12:51:10+02:00
- **Category:** Logic/Correctness
- **Context/Manifestation:** Strict line length constraints (60/80 chars) in prompts caused the AI to inject manual `\n` line breaks mid-sentence. Further, a manual post-processing function (`wrapLine`) broke markdown lists by blindly prepending `- ` to every wrapped line segment. Additionally, failing to programmatically enforce a double newline led to standard Conventional Commit parsing failures (subject merged into body).
- **Rule:** Never implement manual line-wrapping functions for AI-generated text. Instead, instruct the AI to be concise and explicitly forbid manual line breaks (`\n`) inside bullet points or subjects. Always programmatically enforce an empty line between the commit subject and body to adhere to the Conventional Commits specification.
