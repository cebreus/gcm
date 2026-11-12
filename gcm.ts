#!/usr/bin/env bun

import runner from './src/runner.js';
import { sanitizeTerminalText } from './src/utils.js';

const BUN_USER_ARGUMENT_START = 2;

void runner
  .executeCommitMessageGeneration(Bun.argv.slice(BUN_USER_ARGUMENT_START))
  .catch(async (error: unknown): Promise<void> => {
    const message = sanitizeTerminalText(
      error instanceof Error ? error.message : String(error),
    );
    await Bun.write(Bun.stderr, `gcm: ${message}\n`);
    process.exitCode = 1;
  });
