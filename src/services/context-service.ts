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
  recentCommitSubjects?: string[];
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

function buildListSection(title: string, values: string[]): string {
  if (!values.length) return '';
  return `${title}:\n${values.map(value => `- ${value}`).join('\n')}\n\n`;
}

function buildHints(
  scopeSuggestions: string[],
  recentCommitSubjects: string[] = [],
  userHint?: string,
): { contextHeader: string; hintSection: string } {
  const scopeHint =
    scopeSuggestions.length > 0
      ? `Scope candidates:\n${scopeSuggestions.map(scope => `- ${scope}`).join('\n')}\n\n`
      : '';
  const historyHint =
    recentCommitSubjects.length > 0
      ? buildListSection('Recent commit style examples for these files', recentCommitSubjects) +
        'Use recent examples only to align type, scope, and wording style. Do not copy unrelated content.\n\n'
      : '';
  const hintSection = userHint
    ? `\n\nAdditional user instructions: ${userHint}\nPLEASE ADHERE TO THESE INSTRUCTIONS.`
    : '';
  return { contextHeader: scopeHint + historyHint, hintSection };
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
  recentCommitSubjects,
  logger,
  customHeader,
  userHint,
}: ContextParams): Promise<ContextResult> {
  const header = buildPromptHeader(promptSuffix, customHeader);
  const changedFilesSection = buildListSection('Changed files', stagedFiles);
  const { contextHeader, hintSection } = buildHints(
    scopeSuggestions,
    recentCommitSubjects,
    userHint,
  );
  const diffSection = `Diff:\n${diffContent}`;
  const initialContent = header + changedFilesSection + contextHeader + diffSection + hintSection;
  const estimatedTokens = estimateTokenCount(initialContent, tokenBytesRatio);
  if (estimatedTokens <= maxAvailableTokens) {
    return buildContextResult(initialContent, diffContent, tokenBytesRatio);
  }
  logger?.log(
    'info',
    `Input token count (${estimatedTokens}) exceeds limit (${maxAvailableTokens}). Summarizing diff...`,
  );
  const summaryText = (await summarizeLargeDiff(stagedFiles)).text;
  const summaryContent =
    header +
    changedFilesSection +
    contextHeader +
    'Diff summary:\n' +
    summaryText +
    '\n\nThis summary is partial; use conservative wording when intent is ambiguous.' +
    hintSection;
  if (estimateTokenCount(summaryContent, tokenBytesRatio) <= maxAvailableTokens) {
    return buildContextResult(summaryContent, summaryText, tokenBytesRatio);
  }
  logger?.log('warn', 'Summary was still too large, performing hard truncation.');
  return buildHardTruncatedContext({
    header,
    scopeHint: changedFilesSection + contextHeader,
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
