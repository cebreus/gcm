import type { CONFIG } from '../../gcm.config.js';
import { redactSensitiveTextForPrompt } from '../utils.js';
interface RequestBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction: { parts: Array<{ text: string }> };
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
  };
}

export function buildRequestBody(
  userContent: string,
  config: typeof CONFIG,
  opts: { systemInstructions?: string; maxOutputTokens?: number },
): RequestBody {
  const START = '<<START>>';
  const END = '<<END>>';

  const redactedUserContent = redactSensitiveTextForPrompt(userContent);
  const wrappedUserContent = `${START}\n${redactedUserContent}\n${END}`;

  // Ensure marker-focused system instruction is present. If caller provided system
  // instructions, append ours so we keep their intent while enforcing markers.
  const markerInstruction =
    'Your response MUST be wrapped in <<START>> and <<END>> markers. ' +
    'Return ONLY the raw content between the markers. ' +
    'Do NOT include code fences, backticks, or any additional explanation outside the markers. ' +
    'If the output is truncated, append the marker <<END_TRUNCATED>>.';
  const systemInstruction = opts.systemInstructions
    ? `${opts.systemInstructions}${markerInstruction ? '\n\n' + markerInstruction : ''}`
    : markerInstruction;

  const body: RequestBody = {
    contents: [{ role: 'user', parts: [{ text: wrappedUserContent }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: config.TEMP,
      maxOutputTokens: opts.maxOutputTokens || config.MAX_OUTPUT_TOKENS,
    },
  };
  return body;
}
