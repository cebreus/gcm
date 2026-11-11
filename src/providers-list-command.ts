import {
  createLanguageModelApiError,
  hasLanguageModelErrorKind,
  isLanguageModelApiError,
  type LanguageModelProviderFactory,
} from './language-model-service.js';

function formatProbeError(error: unknown): string {
  if (
    hasLanguageModelErrorKind(error, 'timeout') ||
    (error instanceof Error && error.name === 'TimeoutError')
  ) {
    return 'The provider took too long to reply.';
  }
  if (
    isLanguageModelApiError(error) &&
    (error.metadata.status === 401 || error.metadata.status === 403)
  ) {
    return 'The API key was not accepted.';
  }
  if (hasLanguageModelErrorKind(error, 'missing-api-key')) return 'The API key is not set.';
  if (hasLanguageModelErrorKind(error, 'no-models')) return 'No supported models found.';
  if (hasLanguageModelErrorKind(error, 'invalid-model')) return 'Provider setup is not valid.';
  // Errors thrown by the runtime itself (DNS, sockets) carry no kind; only these are read by text.
  if (
    hasLanguageModelErrorKind(error, 'connection') ||
    (!isLanguageModelApiError(error) && /network|fetch|enotfound|econnrefused/i.test(String(error)))
  ) {
    return 'Cannot connect to the provider.';
  }
  return 'Provider check failed.';
}

export async function runProvidersListCommand(options: {
  factories: LanguageModelProviderFactory[];
  output: {
    note(message: string, title?: string): void;
    outro(message: string): void;
    style?: {
      available(message: string): string;
      unavailable(message: string): string;
    };
  };
}): Promise<number> {
  const results = await Promise.all(
    options.factories.map(async factory => {
      try {
        const provider = await factory.create({ probeOnly: true });
        if (provider.readinessError) {
          throw createLanguageModelApiError(provider.readinessError, { kind: 'missing-api-key' });
        }
        const models = await provider.models();
        if (!models.some(model => model.name === provider.defaultModel)) {
          throw new Error('Provider default model is not in its catalogue');
        }
        return {
          name: factory.id,
          available: true,
          detail: `${models.length} ${models.length === 1 ? 'model' : 'models'}`,
        };
      } catch (error) {
        return {
          name: factory.id,
          available: false,
          detail: formatProbeError(error),
        };
      }
    }),
  );
  const report = results
    .map(result => {
      const status = result.available ? 'available' : 'unavailable';
      const style = result.available
        ? options.output.style?.available
        : options.output.style?.unavailable;
      return `${style?.(result.name) ?? result.name}: ${style?.(status) ?? status} — ${result.detail}`;
    })
    .join('\n');
  options.output.note(report, 'AI providers');
  const availableCount = results.filter(result => result.available).length;
  options.output.outro(
    availableCount === results.length
      ? 'All AI providers are available.'
      : availableCount === 0
        ? 'No AI provider is available.'
        : 'Some AI providers are unavailable.',
  );
  return availableCount === results.length ? 0 : availableCount === 0 ? 2 : 1;
}
