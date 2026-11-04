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

/** Parses a raw provider catalogue into specs, dropping unusable entries and sorting by name. */
export function collectSortedModels(
  rawEntries: readonly unknown[],
  parseModel: (entry: unknown) => ModelSpec | null,
): ModelSpec[] {
  return rawEntries
    .map(parseModel)
    .filter((model): model is ModelSpec => model !== null)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Rejects a catalogue that is empty or names the same model twice. Providers
 * pass their own error factory so the failure keeps their error taxonomy.
 */
export function requireDistinctModels(
  models: ModelSpec[],
  label: string,
  fail: (message: string) => Error,
): ModelSpec[] {
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) throw fail(`Duplicate ${label} model identifier`);
    names.add(model.name);
  }
  if (models.length === 0) throw fail(`${label} returned no compatible text models`);
  return models;
}

/** Reads a provider-published token count, rejecting anything that is not a positive safe integer. */
export function readPositiveTokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export interface TokenBudget {
  maxOutputTokens: number;
  maxAvailableTokens: number;
}

/**
 * Single owner of the token split for one request. A model with separate
 * limits budgets input and output independently; a shared context window
 * reserves at most half for output and spends the rest on the prompt.
 */
export function resolveTokenBudget(
  limits: ModelTokenLimits,
  configuredMaxOutputTokens: number,
  systemPromptTokens: number,
): TokenBudget {
  if (limits.kind === 'separate') {
    return {
      maxOutputTokens: Math.min(configuredMaxOutputTokens, limits.maxOutputTokens),
      maxAvailableTokens: Math.max(0, limits.maxInputTokens - systemPromptTokens),
    };
  }
  const maxOutputTokens = Math.min(
    configuredMaxOutputTokens,
    Math.floor(limits.contextWindowTokens / 2),
  );
  return {
    maxOutputTokens,
    maxAvailableTokens: Math.max(
      0,
      limits.contextWindowTokens - maxOutputTokens - systemPromptTokens,
    ),
  };
}
