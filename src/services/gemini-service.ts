import type { GeminiClient, GeminiResponse } from '../gemini-client.js';
import type { Logger, LogMetadata } from '../logger.js';
import { summarizeLargeDiff } from '../summarizer.js';
import { CONFIG } from '../../gcm.config.js';

export interface GeminiService {
  callGeminiAPI(params: CallGeminiApiParams): Promise<GeminiResponse | null>;
}

export interface GeminiServiceDeps {
  client: GeminiClient;
  logger: Logger;
  apiKey: string;
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
  systemPrompt: string;
  stagedFiles: string[];
  meta: LogMetadata;
  opts?: CallGeminiOptions;
}

interface OverflowParams {
  stagedFiles: string[];
  input: string;
  maxOutputTokens: number;
  attempt: number;
  summaryUsed: boolean;
}

interface CallLoopState {
  input: string;
  maxOutputOverride: number;
  summaryUsed: boolean;
}

interface GeminiServiceRuntimeDeps extends GeminiServiceDeps {
  inputShrinkFactor: number;
}

async function handleContextOverflow(
  params: {
    deps: GeminiServiceRuntimeDeps;
  } & OverflowParams,
): Promise<{ input: string; maxOutputTokens: number; summaryUsed: boolean }> {
  const { deps, stagedFiles, input, maxOutputTokens, attempt, summaryUsed } = params;
  if (!summaryUsed && Array.isArray(stagedFiles) && stagedFiles.length) {
    deps.logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; switching to top-hunks summary and retrying',
      { attempt },
    );
    const summary = await summarizeLargeDiff(stagedFiles);
    let newInput = `Analyse the following summary and truncated diff to generate the requested commit information:\n\n${summary.text}`;
    if (summary.totalTruncated) {
      newInput +=
        '\n\nNote: The diff was truncated while being read due to per-file buffer limits.';
    }
    const newMaxOutput = maxOutputTokens + 1024;
    await Bun.sleep(200 * attempt);
    return { input: newInput, maxOutputTokens: newMaxOutput, summaryUsed: true };
  }
  const allowedBytesNow = Math.max(0, Math.floor(input.length * deps.inputShrinkFactor));
  let newInput = input.substring(0, allowedBytesNow);
  newInput = `Analyse the following (input truncated to fit model context) to generate the requested commit information:\n\n${newInput}`;
  const newMaxOutput = maxOutputTokens + 1024;
  deps.logger.log(
    'warn',
    'Gemini returned MAX_TOKENS or no text; retrying with smaller input and lower maxOutputTokens',
    { attempt, newInputLength: newInput.length, maxOutputOverride: newMaxOutput },
  );
  await Bun.sleep(500 * attempt);
  return { input: newInput, maxOutputTokens: newMaxOutput, summaryUsed };
}

async function callOnce(params: {
  deps: GeminiServiceRuntimeDeps;
  input: string;
  enableThinking: boolean;
  meta: LogMetadata;
  systemPrompt: string;
  maxOutputOverride: number;
  opts?: CallGeminiOptions;
}): Promise<GeminiResponse | null> {
  const { deps, input, enableThinking, meta, systemPrompt, maxOutputOverride, opts } = params;
  return deps.client.callGemini({
    apiKey: deps.apiKey,
    userContent: input,
    enableThinking,
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
    input: loopState.input,
    maxOutputTokens: loopState.maxOutputOverride,
    attempt,
    summaryUsed: loopState.summaryUsed,
  });
  loopState.input = result.input;
  loopState.maxOutputOverride = result.maxOutputTokens;
  loopState.summaryUsed = result.summaryUsed;
  return true;
}

async function callGeminiAPIWithDeps(params: {
  deps: GeminiServiceRuntimeDeps;
  promptContext: string;
  systemPrompt: string;
  stagedFiles: string[];
  meta: LogMetadata;
  opts?: CallGeminiOptions;
}): Promise<GeminiResponse | null> {
  const { deps, promptContext, systemPrompt, stagedFiles, meta, opts } = params;
  const maxAttempts = Math.max(1, CONFIG.GEMINI_MAX_RETRIES || 3);
  const enableThinking = CONFIG.ENABLE_THINKING;
  let attempt = 0;
  const loopState: CallLoopState = {
    input: promptContext,
    maxOutputOverride: CONFIG.MAX_OUTPUT_TOKENS,
    summaryUsed: false,
  };
  for (;;) {
    attempt += 1;
    try {
      return await callOnce({
        deps,
        input: loopState.input,
        enableThinking,
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

export function createGeminiService({ client, logger, apiKey }: GeminiServiceDeps): GeminiService {
  const deps: GeminiServiceRuntimeDeps = {
    client,
    logger,
    apiKey,
    inputShrinkFactor: 0.7,
  };
  return {
    callGeminiAPI: function (params: CallGeminiApiParams): Promise<GeminiResponse | null> {
      return callGeminiAPIWithDeps({ deps, ...params });
    },
  };
}
