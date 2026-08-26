import {
  getLanguageModelProviderValidationError,
  isLanguageModelName,
  type LanguageModelProviderFactory,
} from './language-model-service.js';

function formatProbeError(error: unknown): string {
  const message = String(error).toLowerCase();
  if (/timed? out|timeout/.test(message)) return 'The provider took too long to reply.';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/.test(message)) {
    return 'The API key was not accepted.';
  }
  if (/api key.*not set|environment variable .* not set/.test(message)) {
    return 'The API key is not set.';
  }
  if (/no compatible|no supported|no models found/.test(message)) {
    return 'No supported models found.';
  }
  if (/invalid provider|invalid .*model|factory identity|not configured/.test(message)) {
    return 'Provider setup is not valid.';
  }
  if (/request failed|network|fetch|enotfound|econnrefused|cannot connect/.test(message)) {
    return 'Cannot connect to the provider.';
  }
  return 'Provider check failed.';
}

export async function runListProvidersCommand(options: {
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
    options.factories.map(async function (factory) {
      try {
        const provider = await factory.create({ probeOnly: true });
        if (provider.id !== factory.id || provider.label !== factory.label) {
          throw new Error('Invalid provider factory identity');
        }
        const validationError = getLanguageModelProviderValidationError(provider);
        if (validationError) throw new Error(validationError);
        if (provider.readinessError) throw new Error(provider.readinessError);
        const models = await provider.listModels();
        if (models.length === 0) throw new Error('Provider returned no compatible models');
        if (models.some(model => !isLanguageModelName(model))) {
          throw new Error('Provider returned invalid model name');
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
    .map(function (result) {
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
