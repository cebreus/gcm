import { sanitizeTerminalText } from './utils.js';
import type { ModelSpec } from './model-registry.js';

export async function runModelsListCommand(options: {
  providerLabel: string;
  readinessError?: string;
  models(): Promise<ModelSpec[]>;
  output: {
    cancel(message: string): void;
    note(message: string): void;
    outro(message: string): void;
  };
}): Promise<number> {
  if (options.readinessError) {
    options.output.cancel(`Error: ${sanitizeTerminalText(options.readinessError)}`);
    return 1;
  }
  try {
    const models = await options.models();
    let modelList = `Available ${options.providerLabel} models:\n`;
    for (const model of models) modelList += `  - ${model.name}\n`;
    options.output.note(modelList);
    options.output.outro('Done.');
    return 0;
  } catch (error) {
    options.output.cancel(`Failed to fetch models: ${sanitizeTerminalText(String(error))}`);
    return 2;
  }
}
