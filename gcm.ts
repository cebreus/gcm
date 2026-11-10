#!/usr/bin/env bun

import { sanitizeTerminalText } from './src/utils.js';

// The runner is imported lazily: gcm.config.ts validates the environment at
// import, and a static import would throw before this handler exists.
void import('./src/runner.js')
  .then(async function ({ default: runner }): Promise<void> {
    await runner.executeCommitMessageGeneration(Bun.argv.slice(2));
  })
  .catch(async function (error: unknown): Promise<void> {
    const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    await Bun.write(Bun.stderr, 'gcm: ' + message + '\n');
    process.exitCode = 1;
  });
