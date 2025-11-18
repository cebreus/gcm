#!/usr/bin/env bun

import runner from './src/runner.js';

const argv: string[] = process.argv.slice(2);
runner.run(argv);
