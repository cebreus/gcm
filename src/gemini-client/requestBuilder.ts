interface RequestBody {
  contents: { role: string; parts: { text: string }[] }[];
  systemInstruction: { parts: { text: string }[] };
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    thinkingConfig?: { thinkingMode: string };
  };
}

interface BuildRequestBodyOptions {
  systemInstructions?: string;
  maxOutputTokens?: number;
}

export function buildRequestBody(
  userContent: string,
  config: any,
  opts: BuildRequestBodyOptions,
  enableThinking: boolean,
): RequestBody {
  const body: RequestBody = {
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    systemInstruction: { parts: [{ text: opts.systemInstructions || '' }] },
    generationConfig: {
      temperature: config.TEMPERATURE,
      maxOutputTokens: opts.maxOutputTokens || config.MAX_OUTPUT_TOKENS,
    },
  };
  if (enableThinking) {
    body.generationConfig.thinkingConfig = { thinkingMode: 'THINKING_MODE_EXTENDED' };
  }
  return body;
}
