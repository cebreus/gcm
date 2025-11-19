import type { Logger } from '../logger.js';
import type { GeminiResponse } from './index.js';

export function tryParseJSON(logger: Logger, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    const snippet = (text || '').slice(0, 1024);
    try {
      logger?.log?.('error', 'Invalid JSON received from Gemini', {
        parseError: String(err),
      });
    } catch {
      /* ignore */
    }
    const parseError: Error & { snippet?: string; originalError?: unknown } = new Error(
      'Gemini returned invalid JSON',
    );
    parseError.snippet = snippet;
    parseError.originalError = err;
    throw parseError;
  }
}

export function extractText(candidate: unknown): string {
  const parts = (candidate as { content?: { parts?: unknown[] } })?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    text += (p as { text?: string })?.text ? (p as { text?: string }).text : '';
  }
  return text.trim();
}

export function parseCandidates(json: unknown): GeminiResponse | null {
  const candidates = Array.isArray((json as { candidates?: unknown[] })?.candidates)
    ? (json as { candidates?: unknown[] }).candidates || []
    : [];
  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) {
      const usage =
        (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
          .usageMetadata || {};
      return {
        text,
        usage: {
          promptTokens: usage.promptTokenCount || 0,
          outputTokens: usage.candidatesTokenCount || 0,
          thinkingTokens: (candidate as { thinkingMetadata?: { thinkingTokenCount?: number } })
            ?.thinkingMetadata
            ? (candidate as { thinkingMetadata?: { thinkingTokenCount?: number } })
                .thinkingMetadata!.thinkingTokenCount || 0
            : 0,
        },
      };
    }
  }
  return null;
}
