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
  const START = '<<START>>';
  const END = '<<END>>';

  const wrappedUserContent = userContent;

  // Ensure marker-focused system instruction is present. If caller provided system
  // instructions, append ours so we keep their intent while enforcing markers.
  const markerInstruction = config.ADD_RESPONSE_MARKERS
    ? 'Your response MUST be wrapped in <<START>> and <<END>> markers. ' +
      'Return ONLY the raw content between the markers. ' +
      'Do NOT include code fences, backticks, or any additional explanation outside the markers. ' +
      'If the output is truncated, append the marker <<END_TRUNCATED>>.'
    : '';
  const systemInstruction = opts.systemInstructions
    ? `${opts.systemInstructions}${markerInstruction ? '\n\n' + markerInstruction : ''}`
    : markerInstruction;

  const body: RequestBody = {
    contents: [{ role: 'user', parts: [{ text: wrappedUserContent }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
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
