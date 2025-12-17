#!/usr/bin/env bun
import { parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { CONFIG } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig, LogMetadata } from './logger.js';
import { ensureGitRepo, spawnGitStream } from './git-utils.js';
import type { SpawnGitStreamResult } from './git-utils.js';
import { summarizeLargeDiff } from './summarizer.js';
import { createGeminiClient } from './gemini-client.js';
import type { GeminiClient, GeminiUsage, GeminiResponse, GeminiCallOpts } from './gemini-client.js';
import { parseGeminiOutput } from './parser.js';
import type { Labels } from './parser.js';
import { estimateTokens as estimatePromptTokens, buildFallbackStructured } from './runner-utils.js';
import { getScopeSuggestions } from './scope-detector.js';

interface LoadChangesOptions {
  spawnStreamImpl?: (args: string[]) => Promise<SpawnGitStreamResult>;
}

interface LoadChangesResult {
  stagedDiff: string;
  stagedFiles: string[];
  truncated: boolean;
}

interface RunnerOptions {
  logger?: Logger;
  spawnStreamImpl?: (args: string[]) => Promise<SpawnGitStreamResult>;
  createGeminiClient?: (opts: { config: unknown; logger: Logger }) => GeminiClient;
}

const encoder = new TextEncoder();
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};
const SYSTEM_INSTRUCTIONS = `You are an expert at writing concise, professional conventional commit messages.\n\nOutput format (follow exactly):\n\nBRANCH: [Generated branch name]\nCOMMIT_MESSAGE: [Generated conventional commit message]\nPR_TITLE: [Generated pull request title]\nPR_DESCRIPTION: [Generated pull request description]\n\n--- RULES ---\n1. **Branch Name**: Format: \`type/short-description\`, Types: feat, fix, refactor, chore, docs\n2. **Commit Message** (MOST IMPORTANT): First line: \`type(scope): short summary\` (max 60 chars), Blank line, Body: Bullet points with dash (-), each line max 80 chars, Focus on WHAT changed, not WHY or HOW, Group related changes together, Be specific but concise, If breaking change, add \`BREAKING CHANGE:\` footer\n3. **PR Title**: Same as commit first line, Max 60 characters\n4. **PR Description**: 2-3 paragraphs maximum, Bulleted list of key changes, Use GitHub-flavored Markdown`;

export function showHelp() {
  const helpText = `
  ${C.bright}Gemini Commit Message Helper${C.reset}

  Automatically generates professional commit messages, branch names, and PR descriptions using Gemini AI.

  ${C.bright}Usage:${C.reset}
    gcm [options]

  ${C.bright}Options:${C.reset}
    ${C.cyan}-c, --commit <hash>${C.reset}   Analyse a specific commit instead of staged changes.
    ${C.cyan}-h, --help${C.reset}            Show this help message.
    ${C.cyan}-v, --verbose${C.reset}         Show detailed logs (debug level) in the console.
    ${C.cyan}-d, --debug${C.reset}           Save complete logs to a '.debug.log' file for debugging.
    ${C.cyan}--model <name>${C.reset}        Specify an alternative Gemini model to use.
    ${C.cyan}--list-models${C.reset}         List available Gemini models and exit.

  ${C.bright}Description:${C.reset}
    This script takes all changes added to the Git staging area (using \`git add\`),
    sends them to Gemini AI, and generates a suggested branch name, commit message,
    pull request title, and description.

    The script will fail if the GOOGLE_GEMINI_API_KEY is not set.

  ${C.bright}Examples:${C.reset}
    ${C.dim}# Generate a message for the current staged changes${C.reset}
    $ gcm

    ${C.dim}# Generate a message for a specific commit${C.reset}
    $ gcm -c a1b2c3d

    ${C.dim}# Run the script with detailed output for debugging${C.reset}
    $ gcm -v -d
  `;
  console.log(helpText.trim());
}

function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / CONFIG.TOKEN_BYTES_RATIO);
}

export function displayResultStructured(logger: Logger, res: Labels): void {
  const branchText = `\n${C.cyan}${C.bright}BRANCH:${C.reset}\n${res.BRANCH || ''}\n`;
  const commitText = `\n${C.cyan}${C.bright}COMMIT_MESSAGE:${C.reset}\n${res.COMMIT_MESSAGE || ''}\n`;
  const titleText = `\n${C.magenta}${C.bright}PR_TITLE:${C.reset}\n${res.PR_TITLE || ''}\n`;
  const descText = `\n${C.magenta}${C.bright}PR_DESCRIPTION:${C.reset}\n${res.PR_DESCRIPTION || ''}\n`;
  logger.log('info', `${branchText}${commitText}${titleText}${descText}`);
}

export function reportStats(
  logger: Logger,
  modelName: string,
  usage: GeminiUsage,
  outputLength: number,
): void {
  let thinking = '';
  if (usage.thinkingTokens) thinking = ` | thinking: ${usage.thinkingTokens}`;
  logger.log(
    'info',
    `${C.dim}${modelName} | actual usage → input: ${usage.promptTokens} tokens | output: ${
      usage.outputTokens
    } tokens (${outputLength.toLocaleString()} chars)${thinking}${C.reset}\n`,
  );
}

function detectRuntime(): string {
  // Project is Bun-only—always return 'bun'
  return 'bun';
}

export async function loadChanges(
  commit: string | null,
  options: LoadChangesOptions = {},
  logger?: Logger,
): Promise<LoadChangesResult | null> {
  if (!ensureGitRepo()) throw new Error('Not a git repository');
  const spawnStreamImpl = options.spawnStreamImpl || spawnGitStream;
  if (commit) {
    const r = await spawnStreamImpl(['show', '-w', commit]);
    const diff = r.text;
    const { truncated } = r;
    if (!diff.trim()) {
      if (logger) logger.log('info', `No changes found in commit ${commit}.`);
      else process.stdout.write(`No changes found in commit ${commit}.\n`);
      return null;
    }
    const names = (
      await spawnStreamImpl(['show', '-w', '--name-only', '--pretty=format:', commit])
    ).text.trim();
    const files = names ? names.split('\n').filter(Boolean) : [];
    return { stagedDiff: diff, stagedFiles: files, truncated };
  }
  const r = await spawnStreamImpl(['diff', '--staged', '-w']);
  const diff = r.text;
  const { truncated } = r;
  if (!diff.trim()) {
    if (logger) {
      logger.log('info', 'No staged changes found. Use `git add` to stage files for commit.');
    } else {
      process.stdout.write('No staged changes found. Use `git add` to stage files for commit.\n');
    }
    return null;
  }
  const names = (await spawnStreamImpl(['diff', '--staged', '-w', '--name-only'])).text.trim();
  const files = names ? names.split('\n').filter(Boolean) : [];
  return { stagedDiff: diff, stagedFiles: files, truncated };
}

export async function handleTokenLimitFallback(
  logger: Logger,
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

export async function callGeminiWithRetries(
  logger: Logger,
  client: GeminiClient,
  apiKey: string,
  userContentInitial: string,
  enableThinking: boolean,
  meta: LogMetadata,
  options: GeminiCallOpts,
  stagedFiles: string[],
  maxAttempts: number,
): Promise<GeminiResponse | null> {
  let input = userContentInitial;
  let attempt = 0;
  let maxOutputOverride = options.maxOutputTokens || CONFIG.MAX_OUTPUT_TOKENS;
  let summaryUsed = false;

  for (;;) {
    attempt += 1;
    try {
      return await client.callGemini(apiKey, input, enableThinking, meta, {
        maxOutputTokens: maxOutputOverride,
        systemInstructions: options.systemInstructions,
        timeoutMs: options.timeoutMs,
      });
    } catch (err: unknown) {
      const errStr = String(err);
      const isMaxTokens = /MAX_TOKENS/i.test(errStr) || /returned no text/i.test(errStr);

      if (isMaxTokens && attempt < maxAttempts) {
        const result = await handleTokenLimitFallback(
          logger,
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

import { listGeminiModels } from './gemini-client/listModels.js';

export async function run(argv?: string[], runnerOptions?: RunnerOptions): Promise<void> {
  const opts = runnerOptions || {};
  const parsedArgs: ParsedOptions = parseArgs(argv || process.argv.slice(2));

  if (parsedArgs.help) {
    showHelp();
    return;
  }

  if (parsedArgs.listModels) {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      console.error('Error: set GOOGLE_GEMINI_API_KEY before running.');
      process.exit(1);
    }
    try {
      const models = await listGeminiModels(apiKey);
      if (!models.length) {
        console.log('No models found.');
      } else {
        console.log('Available Gemini models:');
        for (const m of models) console.log('  -', m);
      }
    } catch (e) {
      console.error('Failed to fetch models:', e);
      process.exit(2);
    }
    return;
  }

  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: CONFIG.LOG_LEVEL,
    TELEMETRY_FILE: CONFIG.TELEMETRY_FILE,
  };
  if (parsedArgs.verbose) {
    loggerConfig.LOG_LEVEL = 'debug';
  }
  if (parsedArgs.debug) {
    CONFIG.DEBUG_API = true;
  }
  const modelName = parsedArgs.model || CONFIG.MODEL_NAME;

  const TARGET_COMMIT = parsedArgs.commit || null;
  const logger = opts.logger || createLogger(loggerConfig);
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    logger.log('error', 'Error: set GOOGLE_GEMINI_API_KEY before running.');
    throw new Error('Environment variable GOOGLE_GEMINI_API_KEY not set');
  }
  let meta: LogMetadata = {};
  try {
    if (TARGET_COMMIT) {
      logger.log('info', `${C.dim}Using commit ${TARGET_COMMIT} for analysis${C.reset}`);
    }
    logger.log(
      'debug',
      `${C.dim}Using top ${CONFIG.MAX_HUNKS} hunks (K=${CONFIG.MAX_HUNKS}); per-file weights enabled: ${CONFIG.ENABLE_HUNK_WEIGHTS}${C.reset}`,
    );
    const staged = await loadChanges(
      TARGET_COMMIT,
      {
        spawnStreamImpl: opts.spawnStreamImpl || spawnGitStream,
      },
      logger,
    );
    if (!staged) return;

    let input = staged.stagedDiff;
    const origLen = input.length;
    meta = {
      targetCommit: TARGET_COMMIT || null,
      numFiles: staged.stagedFiles.length,
      origLen,
      truncated: staged.truncated,
    };
    let promptSuffix = 'diff';
    if (input.length > CONFIG.CHILD_PROCESS_MAX_BUFFER) {
      logger.log(
        'info',
        `${C.yellow}Diff larger than buffer limit, creating concise summary...${C.reset}`,
      );
      const summary = await summarizeLargeDiff(staged.stagedFiles);
      input = summary.text;
      meta.numHunks = summary.numHunks;
      meta.totalTruncated = summary.totalTruncated;
      logger.log('info', 'Built summary using top-hunks', {
        numHunks: summary.numHunks,
        totalTruncated: summary.totalTruncated,
      });
      promptSuffix = 'summary and truncated diff';
    }

    let userContent = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following ${promptSuffix}.\n\n`;

    try {
      const scopeSuggestions = await getScopeSuggestions(staged.stagedFiles);
      if (scopeSuggestions.length > 0) {
        const hint = `To help you determine the best scope, here are some scopes that have been used previously for these files or are derived from the project structure: [${scopeSuggestions.join(
          ', ',
        )}]. Please consider using one of these if it is relevant to the current changes.\n\n`;
        userContent += hint;
        logger.log('info', `Found scope suggestions: ${scopeSuggestions.join(', ')}`);
      }
    } catch (e) {
      logger.log('debug', 'Failed to get scope suggestions', { error: String(e) });
    }

    userContent += `--- GIT DIFF ---\n${input}`;

    if (staged.truncated) {
      userContent += '\n\nNote: The diff was truncated while being read due to buffer limits.';
    }
    const tokens = estimatePromptTokens(
      userContent + '\n\n' + SYSTEM_INSTRUCTIONS,
      CONFIG.TOKEN_BYTES_RATIO,
    );
    const usableTokens = Math.min(
      CONFIG.MAX_CONTEXT_TOKENS - CONFIG.MAX_OUTPUT_TOKENS - 32,
      CONFIG.MAX_INPUT_TOKENS,
    );
    if (tokens > usableTokens) {
      const allowedBytes = Math.max(
        0,
        Math.floor(usableTokens * CONFIG.TOKEN_BYTES_RATIO * CONFIG.MAX_INPUT_TOKENS_SAFETY_FACTOR),
      );
      input = input.substring(0, allowedBytes);
      // Re-construct userContent with truncated input
      userContent = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following ${promptSuffix} (input truncated to fit model context).\n\n${input}`;
      if (staged.truncated) {
        userContent +=
          '\n\nNote: Original diff was truncated by buffer limit, and prompt truncated to fit model context.';
      }
      logger.log(
        'info',
        `${C.yellow}Input truncated to fit model context and avoid API quota limits.${C.reset}`,
      );
      const truncatedTokens = estimateTokens(userContent + '\n\n' + SYSTEM_INSTRUCTIONS);
      logger.log(
        'info',
        `${C.dim}After truncation → estimated input: ~${truncatedTokens} tokens${C.reset}`,
      );
    }
    if (CONFIG.ENABLE_THINKING) {
      logger.log(
        'info',
        `model: ${modelName} (thinking) | estimated input: ~${tokens} tokens | length: ${input.length}`,
      );
    } else {
      logger.log(
        'info',
        `model: ${modelName} | estimated input: ~${tokens} tokens | length: ${input.length}`,
      );
    }
    const runtime = detectRuntime();
    logger.log('debug', 'Run started', { targetCommit: TARGET_COMMIT ?? null, runtime });
    logger.log('debug', `${C.dim}Runtime: ${runtime}${C.reset}`);
    const geminiClientFactory = opts.createGeminiClient || createGeminiClient;
    const geminiClient = geminiClientFactory({ config: CONFIG, logger });
    const geminiMaxAttemptsLocal = Math.max(1, CONFIG.GEMINI_MAX_RETRIES || 3);
    const geminiOptions: GeminiCallOpts = {
      maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
      systemInstructions: SYSTEM_INSTRUCTIONS,
      timeoutMs: 60000,
    };
    const response = await callGeminiWithRetries(
      logger,
      geminiClient,
      apiKey,
      userContent,
      CONFIG.ENABLE_THINKING,
      meta,
      geminiOptions,
      staged.stagedFiles,
      geminiMaxAttemptsLocal,
    );
    if (!response) {
      logger.log('warn', 'Gemini did not return text after retries; using deterministic fallback', {
        numFiles: staged.stagedFiles.length,
        origLen,
        inputLength: input.length,
      });
      // Build structured fallback object and display it using structured display
      const structured = buildFallbackStructured(staged.stagedFiles);
      const fallbackText = `BRANCH: ${structured.BRANCH}\nCOMMIT_MESSAGE: ${structured.COMMIT_MESSAGE}\n\nPR_TITLE: ${structured.PR_TITLE}\nPR_DESCRIPTION: ${structured.PR_DESCRIPTION}`;
      displayResultStructured(logger, structured);
      reportStats(
        logger,
        modelName,
        { promptTokens: 0, outputTokens: 0, thinkingTokens: 0 },
        fallbackText.length,
      );
      return;
    }
    logger.log('debug', 'LLM response received', {
      promptTokens: response.usage.promptTokens,
      outputTokens: response.usage.outputTokens,
      ...meta,
    });
    let parsedOut: Labels | null = null;
    try {
      parsedOut = parseGeminiOutput(response.text);
    } catch {
      parsedOut = null;
    }
    if (parsedOut) displayResultStructured(logger, parsedOut);
    else logger.log('info', response.text);
    reportStats(logger, modelName, response.usage, response.text.length);
  } catch (error: unknown) {
    const errStr = String(error);
    if (/Not a git repository/i.test(errStr)) {
      logger.log('error', 'Error: Not inside a git repository.');
    } else if (/unknown revision/i.test(errStr)) {
      logger.log('error', `Error: Invalid commit SHA: ${TARGET_COMMIT}`);
    } else {
      logger.log('error', `Gemini commit helper failed: ${error}`);
      try {
        opts.logger?.log('error', `Gemini commit helper failed: ${error}`, {
          error: errStr,
          meta: meta || {},
        });
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

export default { run };
