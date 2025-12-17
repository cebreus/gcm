#!/usr/bin/env bun

import runner from './src/runner-refactored.js';

const argv: string[] = process.argv.slice(2);
runner.executeCommitMessageGeneration(argv);
