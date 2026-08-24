# 0005: Language model provider boundary

## Status

Accepted

## Context

Generation previously depended directly on Gemini credentials, model names,
errors and model discovery. Adding another backend must not duplicate the Git,
prompt, review or commit workflow.

## Decision

The runner composes one active `LanguageModelProvider`. The provider owns its
identity, readiness check, service adapter, default and fallback model metadata,
model discovery and provider-specific error normalization.

`listModels` returns only models compatible with GCM's structured text-generation
contract. Provider adapters normalize remote model names before returning them.
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
