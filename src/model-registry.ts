export type ModelTokenLimits =
  | { kind: 'separate'; maxInputTokens: number; maxOutputTokens: number }
  | { kind: 'shared-context'; contextWindowTokens: number };

export interface ModelSpec {
  name: string;
  label: string; // Friendly name for UI
  limits: ModelTokenLimits;
  description?: string;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export function getEffectiveMaxOutputTokens(configured: number, limit: number): number {
  const requested =
    Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(requested, limit);
}
