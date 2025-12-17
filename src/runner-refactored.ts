import { parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { CONFIG } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig, LogMetadata } from './logger.js';
import { createGeminiClient } from './gemini-client.js';
import { parseGeminiOutput } from './parser.js';
import type { Labels } from './parser.js';
import { getScopeSuggestions } from './scope-detector.js';
import { listGeminiModels } from './gemini-client/listModels.js';

// Actually, displayResultStructured was exported in runner.ts. I should probably copy it or import it.
// Ideally I should extract it to 'ui-utils.ts' but for now let's duplicate or import.
// Since I'm creating runner-refactored, I can't import from runner.ts comfortably if I plan to replace it.
// I'll duplicate the display logic here for independence.

import { createGitService } from './services/git-service.js';
import { createContextService } from './services/context-service.js';
import { createGeminiService } from './services/gemini-service.js';
import { generateFallbackCommitDetails } from './runner-utils.js'; // Keep this for now

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

// Re-implementing showHelp/displayResult/reportStats to avoid dependency on old runner
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
    `;
  console.log(helpText.trim());
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
  usage: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number } = {},
  outputLength: number,
): void {
  let thinking = '';
  if (usage.thinkingTokens) thinking = ` | thinking: ${usage.thinkingTokens}`;
  logger.log(
    'info',
    `${C.dim}${modelName} | actual usage → input: ${usage.promptTokens || 0} tokens | output: ${
      usage.outputTokens || 0
    } tokens (${outputLength.toLocaleString()} chars)${thinking}${C.reset}\n`,
  );
}

function detectRuntime(): string {
  return 'bun';
}

// SYSTEM_INSTRUCTIONS
const SYSTEM_INSTRUCTIONS = `You are an expert at writing concise, professional conventional commit messages.\n\nOutput format (follow exactly):\n\nBRANCH: [Generated branch name]\nCOMMIT_MESSAGE: [Generated conventional commit message]\nPR_TITLE: [Generated pull request title]\nPR_DESCRIPTION: [Generated pull request description]\n\n--- RULES ---\n1. **Branch Name**: Format: \`type/short-description\`, Types: feat, fix, refactor, chore, docs\n2. **Commit Message** (MOST IMPORTANT): First line: \`type(scope): short summary\` (max 60 chars), Blank line, Body: Bullet points with dash (-), each line max 80 chars, Focus on WHAT changed, not WHY or HOW, Group related changes together, Be specific but concise, If breaking change, add \`BREAKING CHANGE:\` footer\n3. **PR Title**: Same as commit first line, Max 60 characters\n4. **PR Description**: 2-3 paragraphs maximum, Bulleted list of key changes, Use GitHub-flavored Markdown`;

function logTokenInfo(
  modelName: string,
  tokens: number,
  inputLength: number,
  enableThinking: boolean,
  logger: Logger,
): void {
  if (enableThinking) {
    logger.log(
      'info',
      `model: ${modelName} (thinking) | estimated input: ~${tokens} tokens | length: ${inputLength}`,
    );
  } else {
    logger.log(
      'info',
      `model: ${modelName} | estimated input: ~${tokens} tokens | length: ${inputLength}`,
    );
  }
}

export interface RunnerOptions {
  logger?: Logger;
  gitService?: any; // Using any to avoid importing types if not strictly needed or could import
  contextService?: any;
  geminiService?: any;
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies || {};
  const parsedArgs: ParsedOptions = parseArgs(argv || process.argv.slice(2));

  if (parsedArgs.help) {
    showHelp();
    return;
  }

  if (parsedArgs.listModels) {
    // Handle list models logic (simplified)
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      console.error('Error: set GOOGLE_GEMINI_API_KEY before running.');
      process.exit(1);
    }
    try {
      const models = await listGeminiModels(apiKey);
      console.log('Available Gemini models:');
      for (const m of models) console.log('  -', m);
    } catch (e) {
      console.error('Failed to fetch models:', e);
      process.exit(2);
    }
    return;
  }

  // 1. Setup Logger
  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: CONFIG.LOG_LEVEL,
    TELEMETRY_FILE: CONFIG.TELEMETRY_FILE,
  };
  if (parsedArgs.verbose) loggerConfig.LOG_LEVEL = 'debug';
  if (parsedArgs.debug) CONFIG.DEBUG_API = true;

  const logger = opts.logger || createLogger(loggerConfig);

  // 2. Validate Env
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    logger.log('error', 'Error: set GOOGLE_GEMINI_API_KEY before running.');
    throw new Error('Environment variable GOOGLE_GEMINI_API_KEY not set');
  }

  const TARGET_COMMIT = parsedArgs.commit || null;
  const modelName = parsedArgs.model || CONFIG.MODEL_NAME;

  try {
    // 3. Initialize Services
    const gitService = opts.gitService || createGitService();
    const contextService = opts.contextService || createContextService();
    const geminiClient = createGeminiClient({ config: CONFIG, logger });
    const geminiService =
      opts.geminiService || createGeminiService({ client: geminiClient, logger, apiKey });

    if (TARGET_COMMIT) {
      logger.log('info', `${C.dim}Using commit ${TARGET_COMMIT} for analysis${C.reset}`);
    }

    // 4. Load Changes
    const staged = await gitService.retrieveStagedChanges(TARGET_COMMIT, logger);
    if (!staged) return;

    const meta: LogMetadata = {
      targetCommit: TARGET_COMMIT || null,
      numFiles: staged.stagedFiles.length,
      origLen: staged.stagedDiff.length,
      truncated: staged.truncated,
    };

    // 5. Get suggested scopes
    let scopeSuggestions: string[] = [];
    try {
      scopeSuggestions = await getScopeSuggestions(staged.stagedFiles);
    } catch (e) {
      logger.log('debug', 'Failed to get scope suggestions', { error: String(e) });
    }

    // 6. Build Context (Prompt)
    const { promptContext, processedDiffContent, tokens } =
      await contextService.constructLLMPromptContext(
        staged.stagedDiff,
        staged.truncated ? 'truncated diff' : 'diff',
        CONFIG.MAX_CONTEXT_TOKENS - CONFIG.MAX_OUTPUT_TOKENS - 500, // Safe buffer
        CONFIG.TOKEN_BYTES_RATIO,
        staged.stagedFiles,
        scopeSuggestions,
        logger,
      );

    // 7. Call Gemini
    const runtime = detectRuntime();
    logTokenInfo(modelName, tokens, processedDiffContent.length, CONFIG.ENABLE_THINKING, logger);
    logger.log('debug', 'Run started', { targetCommit: TARGET_COMMIT ?? null, runtime });

    const response = await geminiService.callGeminiAPI(
      promptContext,
      SYSTEM_INSTRUCTIONS,
      staged.stagedFiles,
      meta,
    );

    // 8. Handle Response / Fallback
    if (!response) {
      logger.log('warn', 'Gemini did not return text after retries; using deterministic fallback');
      const structured = generateFallbackCommitDetails(staged.stagedFiles);
      displayResultStructured(logger, structured);
      return;
    }

    logger.log('debug', 'LLM response received', {
      promptTokens: response.usage.promptTokens,
      outputTokens: response.usage.outputTokens,
      ...meta,
    });

    // 9. Parse and Display
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
      logger.log('error', `Gemini commit helper failed: ${error}`, { error: errStr });
    }
    throw error;
  }
}

export default { executeCommitMessageGeneration };
