export interface ModelSpec {
  name: string;
  label: string; // Friendly name for UI
  maxInputTokens: number;
  maxOutputTokens: number;
  description?: string;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Limits based on public Gemini documentation as of 2026-03.
// Keep this shortlist small and focused on practical choices for the CLI.

export const KNOWN_MODELS: ModelSpec[] = [
  {
    name: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash (Recommended)',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8192,
    description: 'Fast, efficient, newest workhorse model.',
  },
  {
    name: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (Reasoning)',
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    description: 'Flagship reasoning for complex changes.',
  },
  {
    name: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite (Low Cost)',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8192,
    description: 'Lowest-cost Gemini option for simple commit generation.',
  },
];

export function getModelSpec(name: string): ModelSpec {
  const found = KNOWN_MODELS.find(m => m.name === name);
  if (found) return found;

  // Fallback spec for unknown models
  return {
    name,
    label: name,
    maxInputTokens: 100_000, // Conservative default for unknown
    maxOutputTokens: 8192,
    description: 'Unknown model',
  };
}

export function getEffectiveMaxOutputTokens(modelName: string, configured: number): number {
  let requested = configured;
  if (!Number.isSafeInteger(requested) || requested <= 0) requested = DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(requested, getModelSpec(modelName).maxOutputTokens);
}
