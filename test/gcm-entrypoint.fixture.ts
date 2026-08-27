import { mock } from 'bun:test';

await mock.module('../src/runner.js', () => ({
  default: {
    executeCommitMessageGeneration: async function (): Promise<void> {
      await Promise.reject(new Error('runner \u001B]8;;https://example.test\u0007rejection'));
    },
  },
}));
