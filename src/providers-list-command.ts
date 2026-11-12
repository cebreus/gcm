import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_UNAUTHORIZED,
} from './constants.js';
import {
  type LanguageModelProviderFactory,
  createLanguageModelApiError,
  hasLanguageModelErrorKind,
  isLanguageModelApiError,
} from './language-model-service.js';
import { hasText } from './utils.js';

const PARTIAL_PROVIDER_FAILURE_EXIT_CODE = 1;
const ALL_PROVIDERS_FAILED_EXIT_CODE = 2;

function isRejectedApiKey(error: unknown): boolean {
  return (
    isLanguageModelApiError(error) &&
    (error.metadata.status === HTTP_STATUS_UNAUTHORIZED ||
      error.metadata.status === HTTP_STATUS_FORBIDDEN)
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    hasLanguageModelErrorKind(error, 'timeout') ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

function formatProbeError(error: unknown): string {
  if (isTimeoutError(error)) {
    return 'The provider took too long to reply.';
  }
  if (isRejectedApiKey(error)) {
    return 'The API key was not accepted.';
  }
  if (hasLanguageModelErrorKind(error, 'missing-api-key')) {
    return 'The API key is not set.';
  }
  if (hasLanguageModelErrorKind(error, 'no-models')) {
    return 'No supported models found.';
  }
  if (hasLanguageModelErrorKind(error, 'invalid-model')) {
    return 'Provider setup is not valid.';
  }
  // Errors thrown by the runtime itself (DNS, sockets) carry no kind; only these are read by text.
  if (
    hasLanguageModelErrorKind(error, 'connection') ||
    (!isLanguageModelApiError(error) &&
      /network|fetch|enotfound|econnrefused/iv.test(String(error)))
  ) {
    return 'Cannot connect to the provider.';
  }
  return 'Provider check failed.';
}

export async function runProvidersListCommand(options: {
  factories: LanguageModelProviderFactory[];
  output: {
    note: (message: string, title?: string) => void;
    outro: (message: string) => void;
    style?: {
      available: (message: string) => string;
      unavailable: (message: string) => string;
    };
  };
}): Promise<number> {
  const { output } = options;
  const results = await Promise.all(
    options.factories.map(async (factory) => {
      try {
        const provider = await factory.create({ probeOnly: true });
        if (hasText(provider.readinessError)) {
          throw createLanguageModelApiError(provider.readinessError, {
            kind: 'missing-api-key',
          });
        }
        const models = await provider.models();
        if (!models.some((model) => model.name === provider.defaultModel)) {
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
    .map((result) => {
      const status = result.available ? 'available' : 'unavailable';
      const { style: outputStyle } = output;
      const style = result.available
        ? outputStyle?.available
        : outputStyle?.unavailable;
      return `${style?.(result.name) ?? result.name}: ${style?.(status) ?? status} — ${result.detail}`;
    })
    .join('\n');
  output.note(report, 'AI providers');
  const { length: availableCount } = results.filter(
    (result) => result.available,
  );
  output.outro(
    availableCount === results.length
      ? 'All AI providers are available.'
      : availableCount === 0
        ? 'No AI provider is available.'
        : 'Some AI providers are unavailable.',
  );
  return availableCount === results.length
    ? 0
    : availableCount === 0
      ? ALL_PROVIDERS_FAILED_EXIT_CODE
      : PARTIAL_PROVIDER_FAILURE_EXIT_CODE;
}
