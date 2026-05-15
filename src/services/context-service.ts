import { estimateTokenCount } from '../runner-utils.js';
import type { Logger } from '../logger.js';
import { summarizeLargeDiff } from '../summarizer.js';

export interface ContextService {
  constructLLMPromptContext(params: ContextParams): Promise<ContextResult>;
}

interface ContextParams {
  diffContent: string;
  promptSuffix: string;
  maxAvailableTokens: number;
  tokenBytesRatio: number;
  stagedFiles: string[];
  scopeSuggestions: string[];
  logger: Logger | null;
  customHeader?: string;
  userHint?: string;
}

interface ContextResult {
  promptContext: string;
  processedDiffContent: string;
  tokens: number;
}

function buildPromptHeader(promptSuffix: string, customHeader?: string): string {
  if (customHeader) {
    return `${customHeader} ${promptSuffix}:\n\n`;
  }
  return `Analyze the following ${promptSuffix} to generate the requested commit information:\n\n`;
}

function buildHints(
  scopeSuggestions: string[],
  userHint?: string,
): { scopeHint: string; hintSection: string } {
  const scopeHint =
    scopeSuggestions.length > 0
      ? `\n\nSuggested scopes for conventional commit: ${scopeSuggestions.join(', ')}. Select the most appropriate one if applicable.`
      : '';
  const hintSection = userHint
    ? `\n\nAdditional user instructions: ${userHint}\nPLEASE ADHERE TO THESE INSTRUCTIONS.`
    : '';
  return { scopeHint, hintSection };
}

function buildContextResult(
  promptContext: string,
  processedDiffContent: string,
  tokenBytesRatio: number,
): ContextResult {
  return {
    promptContext,
    processedDiffContent,
    tokens: estimateTokenCount(promptContext, tokenBytesRatio),
  };
}

function buildHardTruncatedContext(params: {
  header: string;
  scopeHint: string;
  hintSection: string;
  summaryText: string;
  diffContent: string;
  maxAvailableTokens: number;
  tokenBytesRatio: number;
}): ContextResult {
  const {
    header,
    scopeHint,
    hintSection,
    summaryText,
    diffContent,
    maxAvailableTokens,
    tokenBytesRatio,
  } = params;
  const headerTokens = estimateTokenCount(header + scopeHint, tokenBytesRatio);
  const remainingTokens = maxAvailableTokens - headerTokens;
  if (remainingTokens < 0) {
    const fallbackInput = diffContent.slice(0, 100);
    const fallbackContent = header + fallbackInput + '... (Truncated)';
    return buildContextResult(fallbackContent, fallbackInput, tokenBytesRatio);
  }
  const maxChars = Math.floor(remainingTokens * tokenBytesRatio);
  const truncatedInput = summaryText.slice(0, maxChars) + '\n...(Truncated to fit context)';
  return buildContextResult(
    header + truncatedInput + scopeHint + hintSection,
    truncatedInput,
    tokenBytesRatio,
  );
}

async function constructLLMPromptContext({
  diffContent,
  promptSuffix,
  maxAvailableTokens,
  tokenBytesRatio,
  stagedFiles,
  scopeSuggestions,
  logger,
  customHeader,
  userHint,
}: ContextParams): Promise<ContextResult> {
  const header = buildPromptHeader(promptSuffix, customHeader);
  const { scopeHint, hintSection } = buildHints(scopeSuggestions, userHint);
  const initialContent = header + diffContent + scopeHint + hintSection;
  const estimatedTokens = estimateTokenCount(initialContent, tokenBytesRatio);
  if (estimatedTokens <= maxAvailableTokens) {
    return buildContextResult(initialContent, diffContent, tokenBytesRatio);
  }
  logger?.log(
    'info',
    `Input token count (${estimatedTokens}) exceeds limit (${maxAvailableTokens}). Summarizing diff...`,
  );
  const summaryText = (await summarizeLargeDiff(stagedFiles)).text;
  const summaryContent = header + summaryText + scopeHint + hintSection;
  if (estimateTokenCount(summaryContent, tokenBytesRatio) <= maxAvailableTokens) {
    return buildContextResult(summaryContent, summaryText, tokenBytesRatio);
  }
  logger?.log('warn', 'Summary was still too large, performing hard truncation.');
  return buildHardTruncatedContext({
    header,
    scopeHint,
    hintSection,
    summaryText,
    diffContent,
    maxAvailableTokens,
    tokenBytesRatio,
  });
}

export function createContextService(): ContextService {
  return { constructLLMPromptContext };
}
