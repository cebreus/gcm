import { isCancel, note, select } from '@clack/prompts';

import type { LanguageModelProviderFactory } from './language-model-service.js';
import { reportCancel } from './runner-output.js';
import { sanitizeTerminalText } from './utils.js';

interface ProviderRecoveryOptions {
  error: unknown;
  factory: LanguageModelProviderFactory;
  factories: LanguageModelProviderFactory[];
  previousProviderId: string | null;
  isInteractive: boolean;
  nonInteractive: boolean;
  sessionOnly: boolean;
}

export type ProviderRecovery =
  | { kind: 'stop' }
  | { kind: 'switch'; providerId: string; providerSwitched: boolean }
  | { kind: 'fallback'; providerId: string };

async function selectReplacementProvider(
  message: string,
  factory: LanguageModelProviderFactory,
  factories: LanguageModelProviderFactory[],
): Promise<ProviderRecovery> {
  note(message, `${factory.label} unavailable`, { output: process.stderr });
  const selectedProvider = await select({
    message: 'Select AI Provider',
    options: factories.map((candidate) => ({
      value: candidate.id,
      label: candidate.label,
    })),
    output: process.stderr,
  });
  if (isCancel(selectedProvider)) {
    reportCancel(`Error: ${message}.`);
    return { kind: 'stop' };
  }
  return {
    kind: 'switch',
    providerId: selectedProvider,
    providerSwitched: true,
  };
}

export async function recoverProvider(
  options: ProviderRecoveryOptions,
): Promise<ProviderRecovery> {
  const {
    error,
    factory,
    factories,
    previousProviderId,
    isInteractive,
    nonInteractive,
    sessionOnly,
  } = options;
  const message = sanitizeTerminalText(
    error instanceof Error ? error.message : String(error),
  );
  if (previousProviderId !== null) {
    note(message, `${factory.label} unavailable`, { output: process.stderr });
    return {
      kind: 'switch',
      providerId: previousProviderId,
      providerSwitched: false,
    };
  }
  const canSelect = isInteractive && !nonInteractive && factories.length > 1;
  if (canSelect) {
    return await selectReplacementProvider(message, factory, factories);
  }
  // factories holds the failed factory, so the first entry always exists.
  const [fallback] = factories;
  if (sessionOnly && fallback !== factory) {
    process.stderr.write(
      `Warning: saved provider ${factory.id} is unavailable (${message}); using ${fallback.id}.\n`,
    );
    return { kind: 'fallback', providerId: fallback.id };
  }
  reportCancel(`Error: ${message}.`);
  return { kind: 'stop' };
}
