export interface ModelSpec {
  name: string;
  label: string; // Friendly name for UI
  maxInputTokens: number;
  maxOutputTokens: number;
  description?: string;
}

// Limits based on public documentation (conservative estimates)
// Flash 1.5/2.0 ~ 1M
// Pro 1.5 ~ 2M
// Flash 2.5 ~ 1M (assuming similar to 2.0/1.5 family for now until specs clear)
// Pro 2.5 ~ 2M (assuming)

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
    name: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro Preview (Experimental)',
    maxInputTokens: 2_000_000, // Assuming high context
    maxOutputTokens: 8192,
    description: 'Bleeding edge capabilities.',
  },
  {
    name: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash (Fallback)',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8192,
    description: 'Reliable previous generation.',
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
