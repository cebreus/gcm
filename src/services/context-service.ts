import { estimateTokenCount } from '../utils.js';
import type { Logger } from '../logger.js';

export interface ContextService {
  constructLLMPromptContext(params: ContextParams): Promise<ContextResult>;
}

interface DiffSummary {
  text: string;
  numHunks: number;
  numSkippedFiles?: number;
  totalTruncated: number;
}

interface ContextServiceDeps {
  summarizeLargeDiff(
    stagedFiles: string[],
    options?: { targetCommit?: string },
  ): Promise<DiffSummary>;
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
  targetCommit?: string;
}

interface ContextResult {
  promptContext: string;
  processedDiffContent: string;
  tokens: number;
}

const PARTIAL_SUMMARY_NOTICE =
  'This summary is partial; use conservative wording when intent is ambiguous.';

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

function truncateToTokenBudget(
  content: string,
  maxTokens: number,
  tokenBytesRatio: number,
): string {
  const maxBytes = Math.max(0, Math.floor(maxTokens * tokenBytesRatio));
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength <= maxBytes) return content;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

function buildHardTruncatedContext(params: {
  header: string;
  scopeHint: string;
  hintSection: string;
  summaryText: string;
  maxAvailableTokens: number;
  tokenBytesRatio: number;
}): ContextResult {
  const { header, scopeHint, hintSection, summaryText, maxAvailableTokens, tokenBytesRatio } =
    params;
  const fixedContent = header + scopeHint + hintSection;
  const fixedTokens = estimateTokenCount(fixedContent, tokenBytesRatio);
  if (fixedTokens >= maxAvailableTokens) {
    return buildContextResult(
      truncateToTokenBudget(fixedContent, maxAvailableTokens, tokenBytesRatio),
      '',
      tokenBytesRatio,
    );
  }
  const truncatedInput = truncateToTokenBudget(
    'Diff summary:\n' + summaryText + '\n\n' + PARTIAL_SUMMARY_NOTICE,
    maxAvailableTokens - fixedTokens,
    tokenBytesRatio,
  );
  return buildContextResult(
    header + truncatedInput + scopeHint + hintSection,
    truncatedInput,
    tokenBytesRatio,
  );
}

function hasSummaryEvidence(summary: DiffSummary): boolean {
  return summary.numHunks > 0 || (summary.numSkippedFiles ?? 0) > 0;
}

async function constructLLMPromptContext(
  {
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
    targetCommit,
  }: ContextParams,
  summarize: ContextServiceDeps['summarizeLargeDiff'],
): Promise<ContextResult> {
  const header = buildPromptHeader(promptSuffix, customHeader);
  const changedFilesSection = buildListSection('Changed files', stagedFiles);
  const { contextHeader, hintSection } = buildHints(
    scopeSuggestions,
    recentCommitSubjects,
    userHint,
  );
  const prefix = header + changedFilesSection + contextHeader;
  const initialContent = prefix + 'Diff:\n' + diffContent + hintSection;
  const estimatedTokens = estimateTokenCount(initialContent, tokenBytesRatio);
  if (estimatedTokens <= maxAvailableTokens) {
    return buildContextResult(initialContent, diffContent, tokenBytesRatio);
  }
  logger?.log(
    'info',
    `Input token count (${estimatedTokens}) exceeds limit (${maxAvailableTokens}). Summarizing diff...`,
  );
  const summary = await summarize(stagedFiles, { targetCommit });
  if (diffContent.trim() && !hasSummaryEvidence(summary)) {
    throw new Error('Diff summary contains no evidence for a non-empty diff');
  }
  const summaryBody = summary.text + '\n\n' + PARTIAL_SUMMARY_NOTICE;
  const summaryContent = prefix + 'Diff summary:\n' + summaryBody + hintSection;
  if (estimateTokenCount(summaryContent, tokenBytesRatio) <= maxAvailableTokens) {
    return buildContextResult(summaryContent, summary.text, tokenBytesRatio);
  }
  logger?.log('warn', 'Summary was still too large, performing hard truncation.');
  return buildHardTruncatedContext({
    header,
    scopeHint: changedFilesSection + contextHeader,
    hintSection,
    summaryText: summary.text,
    maxAvailableTokens,
    tokenBytesRatio,
  });
}

export function createContextService({
  summarizeLargeDiff: summarize,
}: ContextServiceDeps): ContextService {
  return {
    constructLLMPromptContext: params => constructLLMPromptContext(params, summarize),
  };
}
