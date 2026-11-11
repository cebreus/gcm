---
"gcm": minor
---

Breaking behaviour change: remove the LM Studio preference for `gemma-4-e4b-it-mlx` and its model fallback notice; without `GCM_LM_STUDIO_MODEL` or `--model`, LM Studio uses the first loaded model, otherwise loads the first compatible one and stops if that load fails. Set `GCM_LM_STUDIO_MODEL` or `--model` to pin a model.
