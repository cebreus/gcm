#!/usr/bin/env bun

import runner from './src/runner.js';
import { redactSensitiveText, stripTerminalControlSequences } from './src/utils.js';

const argv = Bun.argv.slice(2);
void runner.executeCommitMessageGeneration(argv).catch(async function (
  error: unknown,
): Promise<void> {
  const message = redactSensitiveText(
    stripTerminalControlSequences(error instanceof Error ? error.message : String(error)),
  );
  await Bun.write(Bun.stderr, 'gcm: ' + message + '\n');
  process.exitCode = 1;
});
