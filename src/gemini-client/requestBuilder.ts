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
  const TRUNC = '<<END_TRUNCATED>>';

  // If enabled, wrap the user content with explicit markers to make extraction
  // and truncation detection more robust on the receiver side.
  const wrappedUserContent = config.ADD_RESPONSE_MARKERS
    ? `${START}\n${userContent}\n${END}`
    : userContent;

  // Ensure marker-focused system instruction is present. If caller provided system
  // instructions, append ours so we keep their intent while enforcing markers.
  const markerInstruction =
    'Return ONLY the raw content between the markers <<START>> and <<END>>. ' +
    'Do NOT include code fences, backticks, or any additional explanation. ' +
    'If the output is truncated, append the marker <<END_TRUNCATED>>.';
  const systemInstruction = opts.systemInstructions
    ? `${opts.systemInstructions}\n\n${markerInstruction}`
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
