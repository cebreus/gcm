import { mock } from 'bun:test';

mock.module('../src/runner.js', () => ({
  default: {
    executeCommitMessageGeneration: function (): Promise<void> {
      return Promise.reject(new Error('runner rejection'));
    },
  },
}));
