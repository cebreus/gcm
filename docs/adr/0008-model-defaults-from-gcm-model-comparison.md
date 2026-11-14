# 0008: Choose model defaults from the GCM model comparison

## Status

Accepted (2026-11-14, decided by the project owner)

## Context

The 2026-11-11 consolidation kept the existing defaults because the only
evidence was a two-case pilot with recorded history leakage
([model benchmarks](../model-benchmarks.md)). The GCM model comparison published
on cebre.us on 2026-11-14 reviews 156 results from six frozen GCM changes across
19 named models and 2 automatic routes. It ranks models by reviewed pass rate,
then by mean response time.

## Decision

Defaults and availability fallbacks follow that comparison:

- Gemini: `gemini-4-hydrogen` (100 %, free tier) falls back to
  `gemini-3.5-flash` (100 %).
- Claude CLI: `sonnet` (Sonnet 5 and 5.5 at 100 %) falls back to `haiku`
  (Haiku 5.5 at 83 %).
- High-class models (Opus, Fable, GPT-6 Astra) are never a default or a
  fallback because of their cost, even where they scored 100 %. Opus and
  Fable stay selectable.
- Copilot CLI: `gpt-6-luna` (100 %), then the other four models measured
  through Copilot in comparison order, without a fallback. Unmeasured models
  and the `auto` route are not offered.
- Codex CLI and FreeLLMAPI keep their defaults.

## Consequences

- Gemini responses are slower than with the previous default; the comparison
  measured 13.40 seconds on average for Hydrogen.
- A Claude fallback answer is less reliable than the Sonnet default.
- Claude CLI alias resolution depends on the installed CLI, so the measured
  model versions may differ from what `sonnet` or `opus` resolves to.
- A new comparison that changes the ranking needs a new ADR.
