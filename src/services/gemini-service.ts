import type { GeminiClient, GeminiResponse } from '../gemini-client.js';
import type { Logger, LogMetadata } from '../logger.js';
import { createContextService } from './context-service.js';
import { renderPromptContext } from './context-service.js';
import type { ContextService, PromptContextParts } from './context-service.js';
import { CONFIG } from '../../gcm.config.js';

export interface GeminiService {
  callGeminiAPI(params: CallGeminiApiParams): Promise<GeminiResponse | null>;
}

export interface GeminiServiceDeps {
  client: GeminiClient;
  logger: Logger;
  apiKey: string;
  contextService?: ContextService;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

type CallGeminiOptions = {
  retryIfTruncated?: boolean;
  retryIfTruncatedMaxRetries?: number;
  retryIfTruncatedIncreaseTokens?: number;
  timeoutMs?: number;
  modelOverride?: string;
};

interface CallGeminiApiParams {
  promptContext: string;
  promptParts?: PromptContextParts;
  summaryAttempted?: boolean;
  systemPrompt: string;
  stagedFiles: string[];
  meta: LogMetadata;
  opts?: CallGeminiOptions;
}

interface CallLoopState {
  input: string;
  promptParts: PromptContextParts;
  maxOutputOverride: number;
  summaryAttempted: boolean;
}

interface GeminiServiceRuntimeDeps extends GeminiServiceDeps {
  contextService: ContextService;
  sleep: (milliseconds: number) => Promise<unknown>;
}

async function handleContextOverflow(params: {
  deps: GeminiServiceRuntimeDeps;
  stagedFiles: string[];
  promptParts: PromptContextParts;
  maxOutputTokens: number;
  attempt: number;
  summaryAttempted: boolean;
}): Promise<{
  input: string;
  promptParts: PromptContextParts;
  maxOutputTokens: number;
  summaryAttempted: boolean;
} | null> {
  const { deps, stagedFiles, promptParts, maxOutputTokens, attempt, summaryAttempted } = params;
  const result = await deps.contextService.reduceForRetry({
    promptParts,
    stagedFiles,
    summaryAttempted,
  });
  if (result.mode === 'unreducible') return null;
  const newMaxOutput = maxOutputTokens + 1024;
  if (result.mode === 'summary') {
    deps.logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; switching to top-hunks summary and retrying',
      { attempt },
    );
  } else {
    deps.logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; retrying with smaller input and lower maxOutputTokens',
      { attempt, newInputLength: result.promptContext.length, maxOutputOverride: newMaxOutput },
    );
  }
  await deps.sleep((result.mode === 'summary' ? 200 : 500) * attempt);
  return {
    input: result.promptContext,
    promptParts: result.promptParts,
    maxOutputTokens: newMaxOutput,
    summaryAttempted: result.summaryAttempted,
  };
}

async function callOnce(params: {
  deps: GeminiServiceRuntimeDeps;
  input: string;
  meta: LogMetadata;
  systemPrompt: string;
  maxOutputOverride: number;
  opts?: CallGeminiOptions;
}): Promise<GeminiResponse | null> {
  const { deps, input, meta, systemPrompt, maxOutputOverride, opts } = params;
  return deps.client.callGemini({
    apiKey: deps.apiKey,
    userContent: input,
    telemetryMeta: meta,
    callOptions: {
      maxOutputTokens: maxOutputOverride,
      systemInstructions: systemPrompt,
      timeoutMs: typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 60000,
      retryIfTruncated: opts?.retryIfTruncated,
      retryIfTruncatedMaxRetries: opts?.retryIfTruncatedMaxRetries,
      retryIfTruncatedIncreaseTokens: opts?.retryIfTruncatedIncreaseTokens,
    },
    modelOverride: opts?.modelOverride,
  });
}

async function maybeHandleOverflow(params: {
  deps: GeminiServiceRuntimeDeps;
  err: unknown;
  attempt: number;
  maxAttempts: number;
  stagedFiles: string[];
  loopState: CallLoopState;
}): Promise<boolean> {
  const { deps, err, attempt, maxAttempts, stagedFiles, loopState } = params;
  const errStr = String(err);
  const isMaxTokens = /MAX_TOKENS/i.test(errStr) || /returned no text/i.test(errStr);
  if (!(isMaxTokens && attempt < maxAttempts)) return false;
  const result = await handleContextOverflow({
    deps,
    stagedFiles,
    promptParts: loopState.promptParts,
    maxOutputTokens: loopState.maxOutputOverride,
    attempt,
    summaryAttempted: loopState.summaryAttempted,
  });
  if (!result) return false;
  loopState.input = result.input;
  loopState.promptParts = result.promptParts;
  loopState.maxOutputOverride = result.maxOutputTokens;
  loopState.summaryAttempted = result.summaryAttempted;
  return true;
}

async function callGeminiAPIWithDeps(params: {
  deps: GeminiServiceRuntimeDeps;
  promptContext: string;
  promptParts?: PromptContextParts;
  summaryAttempted?: boolean;
  systemPrompt: string;
  stagedFiles: string[];
  meta: LogMetadata;
  opts?: CallGeminiOptions;
}): Promise<GeminiResponse | null> {
  const {
    deps,
    promptContext,
    promptParts,
    summaryAttempted,
    systemPrompt,
    stagedFiles,
    meta,
    opts,
  } = params;
  const maxAttempts = Math.max(1, CONFIG.GEMINI_MAX_RETRIES || 3);
  let attempt = 0;
  const loopState: CallLoopState = {
    promptParts: promptParts || {
      prefix: '',
      diffHeading: '',
      diffBody: promptContext,
      suffix: '',
    },
    input: promptContext,
    maxOutputOverride: CONFIG.MAX_OUTPUT_TOKENS,
    summaryAttempted: summaryAttempted ?? false,
  };
  loopState.input = renderPromptContext(loopState.promptParts);
  for (;;) {
    attempt += 1;
    try {
      return await callOnce({
        deps,
        input: loopState.input,
        meta,
        systemPrompt,
        maxOutputOverride: loopState.maxOutputOverride,
        opts,
      });
    } catch (err: unknown) {
      const handled = await maybeHandleOverflow({
        deps,
        err,
        attempt,
        maxAttempts,
        stagedFiles,
        loopState,
      });
      if (handled) continue;
      throw err;
    }
  }
}

export function createGeminiService({
  client,
  logger,
  apiKey,
  contextService = createContextService(),
  sleep = Bun.sleep,
}: GeminiServiceDeps): GeminiService {
  const deps: GeminiServiceRuntimeDeps = {
    client,
    logger,
    apiKey,
    contextService,
    sleep,
  };
  return {
    callGeminiAPI: function (params: CallGeminiApiParams): Promise<GeminiResponse | null> {
      return callGeminiAPIWithDeps({ deps, ...params });
    },
  };
}
