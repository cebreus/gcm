# Online evaluation platforms for GCM

Research date: 2026-11-09. Sources are vendor primary documentation. This note
evaluates complete GCM routes, not foundation models in isolation.

## Answer

Yes, but no hosted service can safely replace the Git harness. An online platform
can store versioned datasets, traces, per-run scores, experiment comparisons and
human review. A local, disposable Git-fixture runner must still create the exact
pre-target history, invoke each CLI/API route, enforce timeouts, and upload only
redacted evidence. Otherwise it cannot prevent the recent-history leakage found
in the current pilot.

## Best fit: Langfuse Cloud or self-hosted Langfuse

Langfuse documents datasets, SDK/UI experiments, experiment comparison, custom
scores, annotation queues, CI/CD experiments, tracing and self-hosting. This
matches GCM's need to retain a frozen case manifest and attach deterministic and
human scores to each route/run.

- Docs: <https://langfuse.com/docs/evaluation>
- Datasets: <https://langfuse.com/docs/evaluation/experiments/datasets>
- SDK experiments: <https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk>
- Comparison: <https://langfuse.com/docs/evaluation/experiments/compare-experiments>
- Annotation queues: <https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues>
- Self-hosting: <https://langfuse.com/docs/self-hosting>

Use it as evidence store and review UI, not as executor. GCM collector owns:

1. fixture SHA-256, parent commit, diff SHA-256, prompt SHA-256 and GCM build SHA;
2. resolved executable/version, requested model, observed model/route when exposed,
   reasoning setting, command line without credentials, start/end monotonic time;
3. raw stdout/stderr/events after secret scan; exit outcome; deterministic format and
   grounding scores; and blinded reviewer labels;
4. an explicit `INVALID` cause for infrastructure/authentication/harness failures.

Self-hosting is preferable if any trace contains proprietary diff content. Cloud
means prompts, diffs and outputs leave the workstation; redact first even when
using a service with contractual safeguards.

## Strong managed alternative: Braintrust

Braintrust documents datasets, experiments, custom code scorers, tracing,
annotations/human review and experiment comparison. It is suitable if hosted
evidence storage is acceptable and its SDK fits the collector.

- Evals: <https://www.braintrust.dev/docs/guides/evals>
- Datasets: <https://www.braintrust.dev/docs/guides/datasets>
- Scorers: <https://www.braintrust.dev/docs/guides/evals/scorers>
- Experiments: <https://www.braintrust.dev/docs/guides/experiments>
- Annotation: <https://www.braintrust.dev/docs/guides/annotation>

Same boundary applies: Braintrust can score and compare uploads but cannot prove a
Codex/Claude CLI child had isolated Git history unless our harness captures it.

## Viable alternatives

| Service | Useful capability | GCM limitation |
| --- | --- | --- |
| LangSmith | Dataset-backed evaluation, custom evaluators, experiment comparison and human feedback. Docs: <https://docs.smith.langchain.com/evaluation>. | Managed trace store; local fixture/CLI process remains ours. |
| Weights & Biases Weave | Versioned evaluation datasets, scorers and evaluation calls. Docs: <https://weave-docs.wandb.ai/guides/evaluation/>. | Requires SDK integration; not Git-fixture isolation. |
| Promptfoo | Local/CI test matrix, assertions and red-team tooling. Docs: <https://www.promptfoo.dev/docs/configuration/expected-outputs/>. | Better deterministic regression gate than online evidence/review system; custom provider can shell out, but must be written and secured. |
| OpenAI Evals | Hosted API evaluation runs, datasets and graders. Docs: <https://platform.openai.com/docs/guides/evals>. | API-product fit, not multi-CLI harness; does not directly evaluate Codex/Claude/Kilo route behaviour. |

## Smallest defensible architecture

Keep existing local research harness in `cebre.us` as source of truth. Add one
export adapter rather than replacing it:

```text
frozen Git fixture + local route runner
  -> JSONL evidence (hashes, inputs, raw redacted events, verdicts)
  -> Langfuse experiment / dataset run
  -> blinded human-review queue + derived publication table
```

Start with Langfuse self-hosted if private diffs may be included; otherwise use
Langfuse Cloud for lowest implementation cost. Do not buy or integrate a platform
until a two-case dry run proves that it preserves run IDs, artifacts, deterministic
scores and reviewer blinding.

## Non-negotiable publication rules

- No leaderboard from one run or one diff category.
- Do not count `INVALID` or capture-censored attempts as model failures.
- Separate correctness, completeness, format, availability, wall time, tokens and
  monetary/subscription usage.
- Store raw evidence and immutable hashes before scoring.
- Report requested model separately from resolved backend/route.
- Do not send private staged diffs to a cloud service without explicit approval.
