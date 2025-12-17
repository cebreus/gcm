import type { CONFIG } from '../../gcm.config.js';
interface RequestBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction: { parts: Array<{ text: string }> };
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    thinkingConfig?: { thinkingMode: string };
  };
}

export function buildRequestBody(
  userContent: string,
  config: typeof CONFIG,
  opts: { systemInstructions?: string; maxOutputTokens?: number },
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
