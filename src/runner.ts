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
// Since I'm creating runner, I can't import from runner.ts comfortably if I plan to replace it.
// I'll duplicate the display logic here for independence.

import { createGitService } from './services/git-service.js';
import { createContextService } from './services/context-service.js';
import { createGeminiService } from './services/gemini-service.js';
import { generateFallbackCommitDetails } from './runner-utils.js'; // Keep this for now
import { intro, outro, spinner, note, select, text, isCancel, cancel } from '@clack/prompts';
import { KNOWN_MODELS, getModelSpec } from './model-registry.js';
import { sanitizeForDisplay } from './utils.js';
import clipboardy from 'clipboardy';
import { readFileSync } from 'node:fs';

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

interface PackageInfo {
  name: string;
  version: string;
}

function getPackageInfo(): PackageInfo {
  try {
    const packageJsonPath = new URL('../package.json', import.meta.url);
    const packageRaw = readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageRaw) as { name?: string; version?: string };
    return {
      name: packageJson.name || 'gcm',
      version: packageJson.version || 'unknown',
    };
  } catch {
    return { name: 'gcm', version: 'unknown' };
  }
}

// Re-implementing showHelp/displayResult/reportStats to avoid dependency on old runner
export function showHelp() {
  const packageInfo = getPackageInfo();
  const helpText = `
    ${C.bright}Gemini Commit Message Helper${C.reset}
    Version: ${packageInfo.version}
  
    Automatically generates professional commit messages, branch names, and PR descriptions using Gemini AI.
  
    ${C.bright}Usage:${C.reset}
      gcm [options]
  
    ${C.bright}Options:${C.reset}
      ${C.cyan}-c, --commit <hash>${C.reset}       Analyse a specific commit instead of staged changes.
      ${C.cyan}-h, --help${C.reset}                Show this help message.
      ${C.cyan}--version${C.reset}                 Show package version and exit.
      ${C.cyan}-v, --verbose${C.reset}             Show detailed logs (debug level) in the console.
      ${C.cyan}-d, --debug${C.reset}               Save complete logs to a '.debug.log' file for debugging.
      ${C.cyan}-e, --exclude <pattern>${C.reset}   Exclude files matching pattern (e.g., *manifest*).
                                Can be comma-separated or used multiple times.
      ${C.cyan}--model <name>${C.reset}            Specify an alternative Gemini model to use.
      ${C.cyan}--list-models${C.reset}             List available Gemini models and exit.

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
const SYSTEM_INSTRUCTIONS_FULL = `You are an expert at writing concise, professional conventional commit messages.\n\nOutput format (follow exactly):\n\nBRANCH: [Generated branch name]\nCOMMIT_MESSAGE: [Generated conventional commit message]\nPR_TITLE: [Generated pull request title]\nPR_DESCRIPTION: [Generated pull request description]\n\n--- RULES ---\n1. **Branch Name**: Format: \`type/short-description\`, Types: feat, fix, refactor, chore, docs\n2. **Commit Message** (MOST IMPORTANT): CRITICAL: First line MUST be ≤60 characters (type(scope): summary), BLANK LINE after first line, Body: Use bullet points with dash (-), EACH LINE MUST be ≤80 characters maximum, Focus on WHAT changed not WHY, Group related changes, Be specific and concise, If breaking change add BREAKING CHANGE: footer. Your response will be automatically formatted to enforce these limits.\n3. **PR Title**: Same as commit first line, Max 60 characters\n4. **PR Description**: 2-3 paragraphs maximum, Bulleted list of key changes, Use GitHub-flavored Markdown`;

const SYSTEM_INSTRUCTIONS_COMMIT_ONLY = `You are an expert at writing concise, professional conventional commit messages. Use GitHub-flavored Markdown as required format.\n\nOutput format (follow exactly):\n\n[Generated conventional commit message]\n\n--- RULES ---\n1. **Commit Message** (MOST IMPORTANT): CRITICAL: First line MUST be ≤60 characters (type(scope): summary), BLANK LINE after first line, Body: Use bullet points with dash (-), EACH LINE MUST be ≤80 characters maximum, Focus on WHAT changed not WHY, Group related changes, Be specific and concise, If breaking change add BREAKING CHANGE: footer. Your response will be automatically formatted to enforce these limits.`;

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
  listModels?: (apiKey: string) => Promise<string[]>;
}

function toModelOption(name: string): { value: string; label: string; hint?: string } {
  const normalizedName = name.replace(/^models\//, '');
  const knownModel = KNOWN_MODELS.find(model => model.name === normalizedName);

  if (knownModel) {
    return {
      value: knownModel.name,
      label: knownModel.label,
      hint: knownModel.description,
    };
  }

  return {
    value: normalizedName,
    label: normalizedName,
    hint: 'Available from Gemini API',
  };
}

function isSelectableTextModel(name: string): boolean {
  return !/(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen)/i.test(name);
}

async function getModelSelectionOptions(
  apiKey: string,
  logger: Logger,
  listModelsFn: (apiKey: string) => Promise<string[]>,
): Promise<Array<{ value: string; label: string; hint?: string }>> {
  try {
    const apiModels = await listModelsFn(apiKey);
    const uniqueModels = [...new Set(apiModels.map(name => name.replace(/^models\//, '')))]
      .filter(name => name.startsWith('gemini-'))
      .filter(isSelectableTextModel);

    if (uniqueModels.length > 0) {
      return uniqueModels.map(toModelOption);
    }
  } catch (error) {
    logger.log('debug', 'Failed to load live Gemini model list; falling back to known models', {
      error: String(error),
    });
  }

  return KNOWN_MODELS.map(model => ({
    value: model.name,
    label: model.label,
    hint: model.description,
  }));
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies || {};
  const parsedArgs: ParsedOptions = parseArgs(argv || process.argv.slice(2));
  const packageInfo = getPackageInfo();

  if (parsedArgs.version) {
    console.log(`${packageInfo.name} ${packageInfo.version}`);
    return;
  }

  // Initialize Clack Intro
  intro(`${C.bright}Gemini Commit Message Helper${C.reset}`);

  if (parsedArgs.help) {
    showHelp();
    return;
  }

  if (parsedArgs.listModels) {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      cancel('Error: GOOGLE_GEMINI_API_KEY is not set.');
      process.exit(1);
    }
    try {
      const models = await listGeminiModels(apiKey);
      let modelList = 'Available Gemini models:\n';
      for (const m of models) modelList += `  - ${m}\n`;
      note(modelList);
      outro('Done.');
    } catch (e) {
      cancel(`Failed to fetch models: ${e}`);
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
  const s = spinner();

  // 2. Validate Env
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    cancel('Error: Environment variable GOOGLE_GEMINI_API_KEY not set.');
    // We throw here to exit the flow, but the catch block will handle it gracefully if we structured it right.
    // Or simply return.
    return;
  }

  const TARGET_COMMIT = parsedArgs.commit || null;
  let modelName = parsedArgs.model || CONFIG.MODEL_NAME;
  let outputMode: 'full' | 'commit-only' = 'commit-only'; // Default as requested

  try {
    // 3. Initialize Services
    const gitService = opts.gitService || createGitService();
    const contextService = opts.contextService || createContextService();
    const geminiClient = createGeminiClient({ config: CONFIG, logger });
    const geminiService =
      opts.geminiService || createGeminiService({ client: geminiClient, logger, apiKey });
    const listModelsFn = opts.listModels || listGeminiModels;

    if (TARGET_COMMIT) {
      logger.log('info', `${C.dim}Using commit ${TARGET_COMMIT} for analysis${C.reset}`);
    }

    // PRE-FLIGHT LOOP
    // Skip if model is explicitly provided via CLI args
    const skipPreFlight = !!parsedArgs.model;

    if (!skipPreFlight) {
      while (true) {
        const modeLabel = outputMode === 'full' ? 'Full Report' : 'Commit Msg Only';
        const action = await select({
          message: `Settings: [Model: ${modelName}] [Mode: ${modeLabel}]`,
          options: [
            { value: 'generate', label: 'Generate' },
            { value: 'configure', label: 'Configure...' },
            { value: 'exit', label: 'Exit' },
          ],
        });

        if (isCancel(action) || action === 'exit') {
          outro('Bye!');
          return;
        }

        if (action === 'configure') {
          const configAction = await select({
            message: 'Configure Settings',
            options: [
              { value: 'model', label: 'Change Model' },
              { value: 'mode', label: 'Change Output Mode' },
              { value: 'back', label: 'Back' },
            ],
          });

          if (configAction === 'model') {
            const modelOptions = await getModelSelectionOptions(apiKey, logger, listModelsFn);
            const selectedModel = await select({
              message: 'Select AI Model',
              options: modelOptions,
            });
            if (!isCancel(selectedModel)) modelName = String(selectedModel);
          } else if (configAction === 'mode') {
            const selectedMode = await select({
              message: 'Select Output Mode',
              options: [
                {
                  value: 'commit-only',
                  label: 'Commit Message Only (Default)',
                  hint: 'Faster, concise',
                },
                { value: 'full', label: 'Full Report (Branch, PR)', hint: 'Detailed' },
              ],
            });
            if (!isCancel(selectedMode)) outputMode = selectedMode as 'full' | 'commit-only';
          }
          continue; // Loop back to Pre-flight
        }
        // If 'generate', break loop
        break;
      }
    } // End if (!skipPreFlight)

    // 4. Load Changes
    s.start('Analyzing repository changes...');
    const staged = await gitService.retrieveStagedChanges(
      TARGET_COMMIT,
      logger,
      parsedArgs.exclude,
    );
    if (!staged) {
      s.stop('No changes found');
      cancel('No staged changes found. Use "git add" to stage files.');
      return;
    }
    s.stop(`Found ${staged.stagedFiles.length} file(s) changed`);

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

    // GENERATION LOOP
    while (true) {
      const modelSpec = getModelSpec(modelName);
      const safeMaxTokens = modelSpec.maxInputTokens - CONFIG.MAX_OUTPUT_TOKENS - 1000;

      // 6. Build Context (Prompt)
      const { promptContext, processedDiffContent, tokens } =
        await contextService.constructLLMPromptContext(
          staged.stagedDiff,
          staged.truncated ? 'truncated diff' : 'diff',
          safeMaxTokens,
          CONFIG.TOKEN_BYTES_RATIO,
          staged.stagedFiles,
          scopeSuggestions,
          logger,
        );

      // 7. Call Gemini
      const runtime = detectRuntime();
      logTokenInfo(modelName, tokens, processedDiffContent.length, CONFIG.ENABLE_THINKING, logger);
      logger.log('debug', 'Run started', { targetCommit: TARGET_COMMIT ?? null, runtime });

      s.start(`Generating commit message with ${modelName}...`);

      const systemPrompt =
        outputMode === 'full' ? SYSTEM_INSTRUCTIONS_FULL : SYSTEM_INSTRUCTIONS_COMMIT_ONLY;

      let response = await geminiService.callGeminiAPI(
        promptContext,
        systemPrompt,
        staged.stagedFiles,
        meta,
      );
      s.stop('Gemini response received');

      // If the response appears truncated, offer the user an interactive retry with higher tokens
      if (response?.truncated) {
        const retryChoice = await select({
          message: 'Výstup vypadá oříznutý. Chcete zkusit znovu s vyšším limitem tokenů?',
          options: [
            { value: 'retry', label: 'Ano, zopakovat' },
            { value: 'continue', label: 'Ne, pokračovat s oříznutým výstupem' },
          ],
        });
        if (!isCancel(retryChoice) && retryChoice === 'retry') {
          s.start('Opakuji volání s vyšším limitem tokenů...');
          const retryRes = await geminiService.callGeminiAPI(
            promptContext,
            systemPrompt,
            staged.stagedFiles,
            meta,
            {
              retryIfTruncated: true,
              retryIfTruncatedMaxRetries: 2,
              retryIfTruncatedIncreaseTokens: CONFIG.MAX_OUTPUT_TOKENS,
              timeoutMs: 60000,
            },
          );
          s.stop('Retry dokončen');
          if (retryRes) response = retryRes;
        }
      }

      // 8. Handle Response / Fallback
      if (!response) {
        logger.log(
          'warn',
          'Gemini did not return text after retries; using deterministic fallback',
        );
        const structured = generateFallbackCommitDetails(staged.stagedFiles);
        // Fallback display logic remains simple for now
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
        const rawParsed = parseGeminiOutput(response.text);
        // Sanitize all parts to prevent clipboard poisoning or display issues
        parsedOut = {
          BRANCH: sanitizeForDisplay(rawParsed.BRANCH),
          COMMIT_MESSAGE: sanitizeForDisplay(rawParsed.COMMIT_MESSAGE),
          PR_TITLE: sanitizeForDisplay(rawParsed.PR_TITLE),
          PR_DESCRIPTION: sanitizeForDisplay(rawParsed.PR_DESCRIPTION),
        };
      } catch {
        if (outputMode === 'commit-only') {
          // For commit-only, let's assume the response IS the message if parse fails.
          const sanitizedText = sanitizeForDisplay(response.text.trim());
          parsedOut = { COMMIT_MESSAGE: sanitizedText } as Labels;
        } else {
          parsedOut = null;
        }
      }

      // If still null check, e.g. from a failed parse in 'full' mode that fell through
      if (!parsedOut && outputMode === 'commit-only') {
        const sanitizedText = sanitizeForDisplay(response.text.trim());
        parsedOut = { COMMIT_MESSAGE: sanitizedText } as Labels;
      }

      if (parsedOut) {
        let noteContent = '';
        if (outputMode === 'full') {
          noteContent = `BRANCH: ${parsedOut.BRANCH || 'N/A'}\n\n${parsedOut.COMMIT_MESSAGE}`;
        } else {
          noteContent = parsedOut.COMMIT_MESSAGE;
        }

        note(noteContent, outputMode === 'full' ? 'Generated Report' : 'Generated Commit Message');

        let finalMessage = parsedOut.COMMIT_MESSAGE;
        let action = null;

        const integrityLoop = true;
        while (integrityLoop) {
          // Inner loop for Action Menu
          action = await select({
            message: 'What would you like to do?',
            options: [
              { value: 'commit', label: 'Commit' },
              { value: 'copy', label: 'Copy to clipboard' },
              { value: 'edit', label: 'Edit message' },
              { value: 'regenerate', label: 'Switch Model & Regenerate' },
              { value: 'cancel', label: 'Cancel' },
            ],
          });

          if (isCancel(action) || action === 'cancel') {
            outro('Commit cancelled.');
            return;
          }

          if (action === 'copy') {
            try {
              await clipboardy.write(finalMessage);
              note('Commit message copied to clipboard!', 'Success');
              outro(`${C.cyan}Message copied successfully!${C.reset}`);
              return;
            } catch (e) {
              note(`Failed to copy to clipboard: ${e}`, 'Error');
              continue;
            }
          }

          if (action === 'edit') {
            const edited = await text({
              message: 'Edit commit message',
              initialValue: finalMessage,
              placeholder: 'Enter commit message',
            });

            if (isCancel(edited)) {
              // Don't exit, just back to menu
              continue;
            }
            finalMessage = String(edited);
            note(finalMessage, 'Updated Commit Message');
            continue;
          }

          if (action === 'regenerate') {
            const modelOptions = await getModelSelectionOptions(apiKey, logger, listModelsFn);
            const selectedModel = await select({
              message: 'Select AI Model for Regeneration',
              options: modelOptions,
            });
            if (!isCancel(selectedModel)) {
              modelName = String(selectedModel);
              break; // BREAK inner loop to OUTER generation loop
            }
            continue; // If cancelled, stay in menu
          }

          if (action === 'commit') {
            s.start('Committing changes...');
            try {
              await gitService.commitChanges(finalMessage, logger);
              s.stop('Changes committed successfully');
              outro(`${C.cyan}Commit successfully created!${C.reset}`);
            } catch (e) {
              s.stop('Commit failed');
              cancel(`Failed to commit changes: ${e}`);
              logger.log('error', `Commit failed: ${e}`);
            }
            return;
          }
        } // End Action Loop

        // If we broke out here with action === 'regenerate', we loop back to GENERATION loop
        if (action === 'regenerate') continue;
      } else {
        logger.log('info', response.text);
        outro('Failed to parse structured output.');
        return;
      }

      reportStats(logger, modelName, response.usage, response.text.length);
      break; // Exit Generation Loop if done or error
    } // End Generation Loop
  } catch (error: unknown) {
    s.stop('An error occurred'); // Stop spinner if running
    const errStr = String(error);
    if (/Not a git repository/i.test(errStr)) {
      cancel('Error: Not inside a git repository.');
    } else if (/unknown revision/i.test(errStr)) {
      cancel(`Error: Invalid commit SHA: ${TARGET_COMMIT}`);
    } else {
      // Log full details for debugging
      logger.log('error', `Gemini commit helper failed: ${error}`, { error: errStr });
      // Show user friendly message
      cancel(`An unexpected error occurred: ${errStr}`);
    }
    // process.exit(1); // Optional: ensure non-zero exit code if wrapper doesn't handle it
    throw error; // Re-throw if the caller needs to know, but CLI likely ends here.
  }
}

export default { executeCommitMessageGeneration };
