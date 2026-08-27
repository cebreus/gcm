# 0005: Language model provider boundary

## Status

Accepted

## Context

Generation previously depended directly on Gemini credentials, model names,
errors and model discovery. Adding another backend must not duplicate the Git,
prompt, review or commit workflow.

## Decision

The runner composes one active `LanguageModelProvider`. It owns identity,
readiness, generation, the default model and one asynchronous `models()`
catalogue with validated, provider-published token limits. Auth, discovery and
invalid data fail closed. Gemini has separate input/output limits;
FreeLLMAPI and LM Studio publish one shared context window.
Credentials remain inside the provider adapter and must never enter generation,
dialogue, session state, errors or logs. Displayed provider errors pass through
terminal sanitization and secret redaction.

The shared generation workflow owns prompt construction, token budgeting,
response parsing, review, Git safety and provider-scoped session persistence.

## Consequences

A new provider implements `LanguageModelProvider` and its service adapter, then
is selected at the runner composition root. It does not modify the generation,
dialogue or commit workflows. Persisted models are restored only when their
provider identity matches the active provider.
