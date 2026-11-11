# 0006: One chat transport for every provider

## Status

Accepted

## Context

Gemini generation used Google's native `generateContent` endpoint through a
dedicated client package, while FreeLLMAPI and LM Studio shared an
OpenAI-compatible chat client. The native client carried its own request
builder, response parsers, error taxonomy, `<<START>>`/`<<END>>` output
markers, a context-reduction retry loop for `MAX_TOKENS` responses, and an FFI
debug logger. None of that machinery was reachable from the other two
providers, so every change to generation had to be made and tested twice.

## Decision

The HTTP providers (Gemini, FreeLLMAPI, LM Studio) generate over the same OpenAI-compatible chat transport.
Gemini uses `POST /v1beta/openai/chat/completions` on
`generativelanguage.googleapis.com` with bearer authentication.

Model discovery stays on Gemini's native `/v1beta/models` endpoint, because
the OpenAI-compatible layer does not publish `inputTokenLimit` or
`outputTokenLimit`, and the provider boundary requires validated token limits.

One request carries one authoritative output cap, resolved before the call by
`resolveTokenBudget`. A response that stops on `length` is reported as
truncated to the caller instead of being retried with a reduced context.

## Consequences

Request building, response parsing and error classification exist once.
Output markers are gone, and so is the label protocol they came with: the
system prompt asks for a bare commit message and the parser validates exactly
that, rejecting anything without a Conventional Commit subject. Gemini thinking-token counts are no longer reported,
because the compatible endpoint does not break them out, and thinking tokens
count against the request's output cap. `--debug` logs redacted request and
response bodies of the HTTP providers through a fetch wrapper rather than to a file; `codex-cli` and `claude-cli` spawn local processes and trace nothing.
