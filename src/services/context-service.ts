import { estimateTokenCount } from '../runner-utils.js';
import type { Logger } from '../logger.js';

export interface ContextService {
  constructLLMPromptContext(params: ContextParams): Promise<ContextResult>;
  reduceForRetry(params: {
    promptParts: PromptContextParts;
    stagedFiles?: string[];
    summaryAttempted: boolean;
    targetCommit?: string;
  }): Promise<RetryReductionResult>;
}

export interface PromptContextParts {
  prefix: string;
  diffHeading: string;
  diffBody: string;
  suffix: string;
}

export type RetryReductionResult =
  | { mode: 'unreducible' }
  | {
      promptContext: string;
      promptParts: PromptContextParts;
      mode: 'summary' | 'truncation';
      summaryAttempted: boolean;
      summaryUsed: boolean;
    };

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

export interface ContextResult {
  promptContext: string;
  promptParts: PromptContextParts;
  processedDiffContent: string;
  tokens: number;
  summaryAttempted?: boolean;
}

const PARTIAL_SUMMARY_NOTICE =
  'This summary is partial; use conservative wording when intent is ambiguous.';
const PER_FILE_BUFFER_NOTICE =
  'Note: The diff was truncated while being read due to per-file buffer limits.';
const RETRY_TRUNCATION_HEADING = 'Diff (input truncated to fit model context):\n';

export function renderPromptContext({
  prefix,
  diffHeading,
  diffBody,
  suffix,
}: PromptContextParts): string {
  return prefix + diffHeading + diffBody + suffix;
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
  promptParts: PromptContextParts,
  processedDiffContent: string,
  tokenBytesRatio: number,
  summaryAttempted = false,
): ContextResult {
  const promptContext = renderPromptContext(promptParts);
  return {
    promptContext,
    promptParts,
    processedDiffContent,
    tokens: estimateTokenCount(promptContext, tokenBytesRatio),
    summaryAttempted,
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
    const promptParts = {
      prefix: '',
      diffHeading: '',
      diffBody: truncateToTokenBudget(fixedContent, maxAvailableTokens, tokenBytesRatio),
      suffix: '',
    };
    return buildContextResult(promptParts, '', tokenBytesRatio, true);
  }
  const remainingTokens = maxAvailableTokens - fixedTokens;
  const truncatedInput = truncateToTokenBudget(
    'Diff summary:\n' + summaryText + '\n\n' + PARTIAL_SUMMARY_NOTICE,
    remainingTokens,
    tokenBytesRatio,
  );
  return buildContextResult(
    {
      prefix: header,
      diffHeading: '',
      diffBody: truncatedInput,
      suffix: scopeHint + hintSection,
    },
    truncatedInput,
    tokenBytesRatio,
    true,
  );
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
  const initialParts = {
    prefix: header + changedFilesSection + contextHeader,
    diffHeading: 'Diff:\n',
    diffBody: diffContent,
    suffix: hintSection,
  };
  const initialContent = renderPromptContext(initialParts);
  const estimatedTokens = estimateTokenCount(initialContent, tokenBytesRatio);
  if (estimatedTokens <= maxAvailableTokens) {
    return buildContextResult(initialParts, diffContent, tokenBytesRatio);
  }
  logger?.log(
    'info',
    `Input token count (${estimatedTokens}) exceeds limit (${maxAvailableTokens}). Summarizing diff...`,
  );
  const summary = await summarize(stagedFiles, { targetCommit });
  const summaryText = summary.text;
  if (diffContent.trim() && !hasSummaryEvidence(summary)) {
    throw new Error('Diff summary contains no evidence for a non-empty diff');
  }
  const summaryParts = {
    prefix: header + changedFilesSection + contextHeader,
    diffHeading: 'Diff summary:\n',
    diffBody: summaryText + '\n\n' + PARTIAL_SUMMARY_NOTICE,
    suffix: hintSection,
  };
  const summaryContent = renderPromptContext(summaryParts);
  if (estimateTokenCount(summaryContent, tokenBytesRatio) <= maxAvailableTokens) {
    return buildContextResult(summaryParts, summaryText, tokenBytesRatio, true);
  }
  logger?.log('warn', 'Summary was still too large, performing hard truncation.');
  return buildHardTruncatedContext({
    header,
    scopeHint: changedFilesSection + contextHeader,
    hintSection,
    summaryText,
    maxAvailableTokens,
    tokenBytesRatio,
  });
}

function hasSummaryEvidence(summary: DiffSummary): boolean {
  return summary.numHunks > 0 || (summary.numSkippedFiles ?? 0) > 0;
}

function buildRetrySummaryBody(summary: DiffSummary): string {
  return (
    summary.text +
    '\n\n' +
    PARTIAL_SUMMARY_NOTICE +
    (summary.totalTruncated ? `\n\n${PER_FILE_BUFFER_NOTICE}` : '')
  );
}

function hardTruncateForRetry(promptParts: PromptContextParts): PromptContextParts | null {
  const currentPrompt = renderPromptContext(promptParts);
  const proportionalMaximumLength = Math.ceil(currentPrompt.length * 0.7);
  const maximumLength =
    proportionalMaximumLength < currentPrompt.length
      ? proportionalMaximumLength
      : Math.max(0, currentPrompt.length - 1);
  const fixedContent = promptParts.prefix + RETRY_TRUNCATION_HEADING + promptParts.suffix;
  const truncatedParts = {
    prefix: promptParts.prefix,
    diffHeading: RETRY_TRUNCATION_HEADING,
    diffBody: promptParts.diffBody.slice(0, Math.max(0, maximumLength - fixedContent.length)),
    suffix: promptParts.suffix,
  };
  if (renderPromptContext(truncatedParts).length < currentPrompt.length) {
    return truncatedParts;
  }
  const emptiedParts = {
    prefix: promptParts.prefix,
    diffHeading: promptParts.diffHeading,
    diffBody: '',
    suffix: promptParts.suffix,
  };
  return renderPromptContext(emptiedParts).length < currentPrompt.length ? emptiedParts : null;
}

function truncateRetryPrompt(
  promptParts: PromptContextParts,
  summaryAttempted: boolean,
): RetryReductionResult {
  const truncatedParts = hardTruncateForRetry(promptParts);
  if (!truncatedParts) return { mode: 'unreducible' };
  return {
    promptContext: renderPromptContext(truncatedParts),
    promptParts: truncatedParts,
    mode: 'truncation',
    summaryAttempted,
    summaryUsed: false,
  };
}

async function reduceForRetry(
  {
    promptParts,
    stagedFiles,
    summaryAttempted,
    targetCommit,
  }: {
    promptParts: PromptContextParts;
    stagedFiles?: string[];
    summaryAttempted: boolean;
    targetCommit?: string;
  },
  summarize: ContextServiceDeps['summarizeLargeDiff'],
): Promise<RetryReductionResult> {
  const currentPrompt = renderPromptContext(promptParts);
  if (!summaryAttempted && Array.isArray(stagedFiles) && stagedFiles.length > 0) {
    const summary = await summarize(stagedFiles, { targetCommit });
    if (!hasSummaryEvidence(summary)) {
      throw new Error('Diff summary contains no evidence for a non-empty diff');
    }
    const summaryParts = {
      prefix: promptParts.prefix,
      diffHeading: 'Diff summary:\n',
      diffBody: buildRetrySummaryBody(summary),
      suffix: promptParts.suffix,
    };
    const summaryPrompt = renderPromptContext(summaryParts);
    if (summaryPrompt.length < currentPrompt.length) {
      return {
        promptContext: summaryPrompt,
        promptParts: summaryParts,
        mode: 'summary',
        summaryAttempted: true,
        summaryUsed: true,
      };
    }
    return truncateRetryPrompt(promptParts, true);
  }
  return truncateRetryPrompt(promptParts, summaryAttempted);
}

export function createContextService({
  summarizeLargeDiff: summarize,
}: ContextServiceDeps): ContextService {
  return {
    constructLLMPromptContext: params => constructLLMPromptContext(params, summarize),
    reduceForRetry: params => reduceForRetry(params, summarize),
  };
}
