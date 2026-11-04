---
'gcm': major
---

Remove the `full` output mode and generate every provider's completion over one OpenAI-compatible chat transport.

- `--mode` / `-m` is gone. `gcm` always generates a commit message; branch names, PR titles and PR descriptions are no longer produced. Remove `--mode` from scripts and aliases, and note that the saved session no longer remembers a mode.
- Gemini generation now uses the OpenAI-compatible endpoint with bearer authentication instead of the native `generateContent` API. Model discovery still reads Gemini's own catalogue, so published token limits are unchanged.
- A response that hits the output cap is reported as truncated instead of being retried silently with a reduced context, so an oversized diff fails visibly rather than quietly losing detail. `--non-interactive --apply` now refuses to commit a truncated message and tells you to reduce the diff or raise `GCM_MAX_OUTPUT_TOKENS`.
- Gemini thinking-token counts are no longer reported, because the compatible endpoint does not break them out.
- `--debug` and `GCM_DEBUG_API` log redacted request and response bodies to the console. The `GCM_DEBUG_FILE` and `GCM_DEBUG_MAX_BODY_LOG_BYTES` settings and the `.debug.log` trace file are gone.
- `GCM_MODEL` is validated before it is used or displayed. A value carrying terminal control sequences, bidirectional Unicode or newlines now stops the run with `Error: Invalid GCM_MODEL.` instead of reaching the terminal. `--help` and `--version` keep working.
- Model output is no longer parsed as a labelled report. The `BRANCH:`, `COMMIT_MESSAGE:`, `PR_TITLE:` and `PR_DESCRIPTION:` labels belonged to the removed `full` mode, the system prompt asks for a bare commit message, and keeping the labels meant a line anywhere in the body could replace the reviewed subject. A response that still arrives labelled is now rejected rather than guessed at.
- A response is treated as truncated for `finish_reason: "length"` or `"max_tokens"` in either case, and also when its completion token count reached the requested cap, which covers servers that send no finish reason at all.
