import type { ModelSpec } from './model-registry.js';
import { hasText, sanitizeTerminalText } from './utils.js';

const EXIT_SUCCESS = 0;
const EXIT_NOT_READY = 1;
const EXIT_FETCH_FAILED = 2;

export async function runModelsListCommand(options: {
  providerLabel: string;
  readinessError?: string;
  models: () => Promise<ModelSpec[]>;
  output: {
    cancel: (message: string) => void;
    note: (message: string) => void;
    outro: (message: string) => void;
  };
}): Promise<number> {
  if (hasText(options.readinessError)) {
    options.output.cancel(
      `Error: ${sanitizeTerminalText(options.readinessError)}`,
    );
    return EXIT_NOT_READY;
  }
  try {
    const models = await options.models();
    let modelList = `Available ${options.providerLabel} models:\n`;
    for (const model of models) {
      modelList += `  - ${model.name}\n`;
    }
    options.output.note(modelList);
    options.output.outro('Done.');
    return EXIT_SUCCESS;
  } catch (error) {
    options.output.cancel(
      `Failed to fetch models: ${sanitizeTerminalText(String(error))}`,
    );
    return EXIT_FETCH_FAILED;
  }
}
