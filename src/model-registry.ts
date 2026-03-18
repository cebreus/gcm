export interface ModelSpec {
  name: string;
  label: string; // Friendly name for UI
  maxInputTokens: number;
  maxOutputTokens: number;
  description?: string;
}

// Limits based on public Gemini documentation as of 2026-03.
// Keep this shortlist small and focused on practical choices for the CLI.

export const KNOWN_MODELS: ModelSpec[] = [
  {
    name: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (Recommended)',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8192,
    description: 'Fast, efficient, low latency.',
  },
  {
    name: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro (Reasoning)',
    maxInputTokens: 2_000_000,
    maxOutputTokens: 8192,
    description: 'Better reasoning for complex changes.',
  },
  {
    name: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite (Low Cost)',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 4096,
    description: 'Lowest-cost Gemini option for simple commit generation.',
  },
  {
    name: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash-Lite Preview (Newest Lite)',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8192,
    description: 'Ultra-light 3.1 preview model for evaluating the newer family.',
  },
];

export const DEFAULT_MODEL = 'gemini-2.5-flash';

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
