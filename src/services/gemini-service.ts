import type { GeminiClient, GeminiResponse, GeminiCallOpts } from '../gemini-client.js';
import type { Logger, LogMetadata } from '../logger.js';
import { summarizeLargeDiff } from '../summarizer.js';
import { CONFIG } from '../../gcm.config.js';

export interface GeminiService {
  callGeminiAPI(
    promptContext: string,
    systemPrompt: string,
    stagedFiles: string[],
    meta: LogMetadata,
  ): Promise<GeminiResponse | null>;
}

export interface GeminiServiceDeps {
  client: GeminiClient;
  logger: Logger;
  apiKey: string;
}

export function createGeminiService({ client, logger, apiKey }: GeminiServiceDeps): GeminiService {
  async function handleContextOverflow(
    stagedFiles: string[],
    input: string,
    maxOutputTokens: number,
    attempt: number,
    summaryUsed: boolean,
  ): Promise<{ input: string; maxOutputTokens: number; summaryUsed: boolean }> {
    if (!summaryUsed && Array.isArray(stagedFiles) && stagedFiles.length) {
      logger.log(
        'warn',
        'Gemini returned MAX_TOKENS or no text; switching to top-hunks summary and retrying',
        { attempt },
      );
      const summary = await summarizeLargeDiff(stagedFiles);
      let newInput = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following summary and truncated diff.\n\n${summary.text}`;
      if (summary.totalTruncated) {
        newInput +=
          '\n\nNote: The diff was truncated while being read due to per-file buffer limits.';
      }
      const newMaxOutput = Math.max(256, Math.floor(maxOutputTokens / 2));
      await Bun.sleep(200 * attempt);
      return { input: newInput, maxOutputTokens: newMaxOutput, summaryUsed: true };
    }

    const shrinkFactor = 0.5;
    const allowedBytesNow = Math.max(0, Math.floor(input.length * shrinkFactor));
    let newInput = input.substring(0, allowedBytesNow);
    newInput = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following (input truncated to fit model context).\n\n${newInput}`;
    const newMaxOutput = Math.max(256, Math.floor(maxOutputTokens / 2));

    logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; retrying with smaller input and lower maxOutputTokens',
      {
        attempt,
        newInputLength: newInput.length,
        maxOutputOverride: newMaxOutput,
      },
    );
    await Bun.sleep(500 * attempt);
    return { input: newInput, maxOutputTokens: newMaxOutput, summaryUsed };
  }

  async function callGeminiAPI(
    promptContext: string,
    systemPrompt: string,
    stagedFiles: string[],
    meta: LogMetadata,
  ): Promise<GeminiResponse | null> {
    const maxAttempts = Math.max(1, CONFIG.GEMINI_MAX_RETRIES || 3);
    const enableThinking = CONFIG.ENABLE_THINKING;

    let input = promptContext;
    let attempt = 0;
    let maxOutputOverride = CONFIG.MAX_OUTPUT_TOKENS;
    let summaryUsed = false;

    for (;;) {
      attempt += 1;
      try {
        return await client.callGemini(apiKey, input, enableThinking, meta, {
          maxOutputTokens: maxOutputOverride,
          systemInstructions: systemPrompt,
          timeoutMs: 60000,
        });
      } catch (err: unknown) {
        const errStr = String(err);
        const isMaxTokens = /MAX_TOKENS/i.test(errStr) || /returned no text/i.test(errStr);

        if (isMaxTokens && attempt < maxAttempts) {
          const result = await handleContextOverflow(
            stagedFiles,
            input,
            maxOutputOverride,
            attempt,
            summaryUsed,
          );
          input = result.input;
          maxOutputOverride = result.maxOutputTokens;
          summaryUsed = result.summaryUsed;
          continue;
        }

        if (attempt >= maxAttempts) throw err;
        throw err;
      }
    }
  }

  return { callGeminiAPI };
}
