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

function extractText(candidate: unknown): string {
  const parts = (candidate as { content?: { parts?: unknown[] } })?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    text += (p as { text?: string })?.text ? (p as { text?: string }).text : '';
  }
  return text;
}

function stripCodeFences(text: string): string {
  if (!text) return text;
  // Extract content between triple backticks ``` ``` or triple tildes ~~~ ~~~ if they wrap the whole content
  const fencedBackticks = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (fencedBackticks) return fencedBackticks[1];
  const fencedTildes = text.match(/^\s*~~~[^\n]*\n([\s\S]*?)\n~~~\s*$/);
  if (fencedTildes) return fencedTildes[1];
  // Inline single backticks
  const inlineBackticks = text.match(/^\s*`([\s\S]*?)`\s*$/);
  if (inlineBackticks) return inlineBackticks[1];
  return text;
}

function extractBetweenMarkers(
  text: string,
  logger?: Logger,
): { text: string; truncated: boolean } {
  if (!text) return { text, truncated: false };
  const START = '<<START>>';
  const END = '<<END>>';
  const END_TRUNC = '<<END_TRUNCATED>>';

  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s !== -1) {
    if (e > s) {
      // Found a normal END marker. Check if END_TRUNCATED exists instead
      const tr = text.indexOf(END_TRUNC, s) !== -1;
      const extracted = text.slice(s + START.length, e);
      return { text: extracted, truncated: tr };
    }
    // START found but END not found -> truncated
    logger?.log?.('warn', 'Gemini response missing <<END>> marker; output may be truncated');
    const extracted = text.slice(s + START.length);
    return { text: extracted, truncated: true };
  }
  // No markers; check for END_TRUNCATED anywhere
  const hasEndTrunc = text.indexOf(END_TRUNC) !== -1;
  return { text, truncated: hasEndTrunc };
}

function hasMaxTokensFinishReason(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  return (candidate as { finishReason?: unknown }).finishReason === 'MAX_TOKENS';
}

export function parseCandidates(
  json: unknown,
  logger?: Logger,
): (GeminiResponse & { truncated?: boolean }) | null {
  const candidates = Array.isArray((json as { candidates?: unknown[] })?.candidates)
    ? (json as { candidates?: unknown[] }).candidates || []
    : [];
  for (const candidate of candidates) {
    let text = extractText(candidate);
    if (text) {
      // Normalize / clean up common artifacts: markers and code fences
      let truncated = hasMaxTokensFinishReason(candidate);
      try {
        const extracted = extractBetweenMarkers(text, logger);
        text = extracted.text;
        truncated = !!extracted.truncated || truncated;
        text = stripCodeFences(text);
      } catch {
        // be conservative: fall back to original text on any failure
      }
      text = text.trim();

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
        truncated,
      };
    }
  }
  return null;
}
