import { estimateTokenCount } from '../runner-utils.js';
import type { Logger } from '../logger.js';
import { summarizeLargeDiff } from '../summarizer.js';

export interface ContextService {
  constructLLMPromptContext(
    diffContent: string,
    promptSuffix: string,
    maxAvailableTokens: number,
    tokenBytesRatio: number,
    stagedFiles: string[],
    scopeSuggestions: string[],
    logger: Logger | null,
    customHeader?: string,
  ): Promise<{ promptContext: string; processedDiffContent: string; tokens: number }>;
}

export function createContextService(): ContextService {
  function buildPromptHeader(promptSuffix: string, customHeader?: string): string {
    if (customHeader) {
      return `${customHeader} ${promptSuffix}:\n\n`;
    }
    return `Analyze the following ${promptSuffix} to generate the requested commit information:\n\n`;
  }

  async function constructLLMPromptContext(
    diffContent: string,
    promptSuffix: string,
    maxAvailableTokens: number,
    tokenBytesRatio: number,
    stagedFiles: string[],
    scopeSuggestions: string[],
    logger: Logger | null,
    customHeader?: string,
  ): Promise<{ promptContext: string; processedDiffContent: string; tokens: number }> {
    // 1. Initial Prompt Construction
    const header = buildPromptHeader(promptSuffix, customHeader);
    let scopeHint = '';

    if (scopeSuggestions && scopeSuggestions.length > 0) {
      const scopeStr = scopeSuggestions.join(', ');
      scopeHint = `\n\nSuggested scopes for conventional commit: ${scopeStr}. Select the most appropriate one if applicable.`;
    }

    const initialContent = header + diffContent + scopeHint;

    // 2. Token Estimation
    const estimatedTokens = estimateTokenCount(initialContent, tokenBytesRatio);

    // 3. Truncation / Summarization Strategy
    // We assume a safety margin for output (e.g. 1024 tokens) + system prompt (~500)
    // contextTokensLimit should be passed as SAFE limit (MAX_CONTEXT - MAX_OUTPUT - SYSTEM)

    if (estimatedTokens <= maxAvailableTokens) {
      return {
        promptContext: initialContent,
        processedDiffContent: diffContent,
        tokens: estimatedTokens,
      };
    }

    if (logger) {
      logger.log(
        'info',
        `Input token count (${estimatedTokens}) exceeds limit (${maxAvailableTokens}). Summarizing diff...`,
      );
    }

    // Attempt summarization
    const summaryResult = await summarizeLargeDiff(stagedFiles);
    const summaryText = summaryResult.text;
    const summaryContent = header + summaryText + scopeHint;

    // Check if summary is small enough
    const summaryTokens = estimateTokenCount(summaryContent, tokenBytesRatio);

    if (summaryTokens <= maxAvailableTokens) {
      return {
        promptContext: summaryContent,
        processedDiffContent: summaryText,
        tokens: summaryTokens,
      };
    }

    // If still too large, we must truncate hard
    // Calculate how many chars we can fit approximately
    // token = char / ratio => char = token * ratio
    // We have 'limit' tokens available. Header takes some.
    const headerTokens = estimateTokenCount(header + scopeHint, tokenBytesRatio);
    const remainingTokens = maxAvailableTokens - headerTokens;
    if (remainingTokens < 0) {
      // pathological case, header is huge?
      // Just return untruncated and let API fail or cut header?
      // Better to return truncation of input.
      const fallbackInput = diffContent.slice(0, 100);
      const fallbackContent = header + fallbackInput + '... (Truncated)';
      const fallbackTokens = estimateTokenCount(fallbackContent, tokenBytesRatio);
      return {
        promptContext: fallbackContent,
        processedDiffContent: fallbackInput,
        tokens: fallbackTokens,
      };
    }

    const maxChars = Math.floor(remainingTokens * tokenBytesRatio);
    const truncatedInput = summaryText.slice(0, maxChars) + '\n...(Truncated to fit context)';

    if (logger) {
      logger.log('warn', 'Summary was still too large, performing hard truncation.');
    }

    const finalContent = header + truncatedInput + scopeHint;
    const finalTokens = estimateTokenCount(finalContent, tokenBytesRatio);

    return {
      promptContext: finalContent,
      processedDiffContent: truncatedInput,
      tokens: finalTokens,
    };
  }

  return {
    constructLLMPromptContext,
  };
}
