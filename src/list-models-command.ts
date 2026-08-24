import { redactSensitiveText, stripTerminalControlSequences } from './utils.js';
import { isLanguageModelName } from './language-model-service.js';

export async function runListModelsCommand(options: {
  providerLabel: string;
  readinessError?: string;
  listModels(): Promise<string[]>;
  output: {
    cancel(message: string): void;
    note(message: string): void;
    outro(message: string): void;
  };
}): Promise<number> {
  if (options.readinessError) {
    options.output.cancel(
      `Error: ${redactSensitiveText(stripTerminalControlSequences(options.readinessError))}`,
    );
    return 1;
  }
  try {
    const models = await options.listModels();
    let modelList = `Available ${options.providerLabel} models:\n`;
    for (const modelName of models) {
      if (!isLanguageModelName(modelName)) throw new Error('Provider returned invalid model name');
      modelList += `  - ${modelName}\n`;
    }
    options.output.note(modelList);
    options.output.outro('Done.');
    return 0;
  } catch (error) {
    options.output.cancel(
      `Failed to fetch models: ${redactSensitiveText(stripTerminalControlSequences(String(error)))}`,
    );
    return 2;
  }
}
