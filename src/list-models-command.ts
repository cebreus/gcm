export async function runListModelsCommand(options: {
  apiKey: string | undefined;
  listModels(apiKey: string): Promise<string[]>;
  output: {
    cancel(message: string): void;
    note(message: string): void;
    outro(message: string): void;
  };
}): Promise<number> {
  if (!options.apiKey) {
    options.output.cancel('Error: GOOGLE_GEMINI_API_KEY is not set.');
    return 1;
  }
  try {
    const models = await options.listModels(options.apiKey);
    let modelList = 'Available Gemini models:\n';
    for (const modelName of models) modelList += `  - ${modelName}\n`;
    options.output.note(modelList);
    options.output.outro('Done.');
    return 0;
  } catch (error) {
    options.output.cancel(`Failed to fetch models: ${error}`);
    return 2;
  }
}
