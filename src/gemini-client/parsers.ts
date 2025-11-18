import type { Logger } from '../logger.js';
import type { GeminiResponse } from './index.js';

export function tryParseJSON(logger: Logger, text: string): any {
  try {
    return JSON.parse(text);
  } catch (err: any) {
    const snippet = (text || '').slice(0, 1024);
    try {
      logger?.log?.('error', 'Invalid JSON received from Gemini', {
        snippet,
        parseError: String(err),
      });
       
    } catch (_e: any) {
      /* ignore */
    }
    const parseError: any = new Error('Gemini returned invalid JSON');
    parseError.snippet = snippet;
    parseError.originalError = err;
    throw parseError;
  }
}

export function parseCandidates(json: any): GeminiResponse | null {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content ? candidate.content.parts : null;
    if (!Array.isArray(parts)) continue;
    let text = '';
    for (const p of parts) {
      text += p?.text ? p.text : '';
    }
    text = text.trim();
    if (text) {
      const usage = json.usageMetadata || {};
      return {
        text,
        usage: {
          promptTokens: usage.promptTokenCount || 0,
          outputTokens: usage.candidatesTokenCount || 0,
          thinkingTokens: candidate?.thinkingMetadata
            ? candidate.thinkingMetadata.thinkingTokenCount
            : undefined,
        },
      };
    }
  }
  return null;
}
