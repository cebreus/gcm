#!/usr/bin/env bun

import runner from './src/runner.js';

const argv: string[] = process.argv.slice(2);
void runner.executeCommitMessageGeneration(argv).catch(function (error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write('gcm: ' + message + '\n');
  process.exitCode = 1;
});
