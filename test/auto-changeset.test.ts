import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../gcm.config.js';
import {
  type ChangesetDraft,
  changesetCommitMessage,
  commitWithChangeset,
  parseChangesetDraft,
  prepareChangeset,
  stripChangesetTrailers,
} from '../src/auto-changeset.js';
import { parseArgs } from '../src/cli.js';
import { createCommitActionService } from '../src/commit-action-service.js';
import type { GenerationServices } from '../src/generation-types.js';
import {
  createGenerationState,
  runGenerationCommand,
} from '../src/generation.js';
import type { Logger } from '../src/logger.js';
import { createGitService } from '../src/services/git-service.js';

const CONFIG = loadConfig({});

describe('changeset content', () => {
  test('accepts only safe patch or minor JSON', () => {
    expect(
      parseChangesetDraft(
        JSON.stringify({
          bump: 'patch',
          summary: 'Commit messages keep the selected model.',
        }),
        'gcm',
      ),
    ).toBe(
      '---\n"gcm": patch\n---\n\nCommit messages keep the selected model.\n',
    );
    for (const value of [
      'not json',
      JSON.stringify({ bump: 'major', summary: 'Break everything.' }),
      JSON.stringify({ bump: 'patch', summary: 'Unsafe\n---\ntext.' }),
      JSON.stringify({ bump: 'patch' }),
    ]) {
      expect(parseChangesetDraft(value, 'gcm')).toBeNull();
    }
  });

  test('writes or removes skip trailers', () => {
    const stale =
      'fix: keep model\n\nChangeset: none\nChangeset-Reason: test-only';
    expect(stripChangesetTrailers(stale)).toBe('fix: keep model');
    expect(changesetCommitMessage(stale, true)).toBe('fix: keep model');
    expect(changesetCommitMessage(stale, false, 'docs-only')).toBe(
      'fix: keep model\n\nChangeset: none\nChangeset-Reason: docs-only',
    );
  });
});

async function run(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn({ cmd: args, cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(stderr);
  }
  return stdout;
}

async function withRepository(
  check: (root: string) => Promise<void>,
): Promise<void> {
  const root = `/tmp/gcm-changeset-${crypto.randomUUID()}`;
  await run(['mkdir', '-p', `${root}/.changeset`], '/tmp');
  try {
    await run(['git', 'init', '-q'], root);
    await run(['git', 'config', 'user.name', 'Test'], root);
    await run(['git', 'config', 'user.email', 'test@example.com'], root);
    await Bun.write(
      `${root}/package.json`,
      JSON.stringify({ name: 'example', private: true }),
    );
    await Bun.write(
      `${root}/.changeset/config.json`,
      JSON.stringify({ ignore: [], privatePackages: { version: true } }),
    );
    await Bun.write(`${root}/feature.ts`, 'export const supported = true;\n');
    await run(['git', 'add', '--', '.'], root);
    await run(['git', 'commit', '-qm', 'chore: initial'], root);
    await Bun.write(`${root}/feature.ts`, 'export const supported = false;\n');
    await run(['git', 'add', '--', 'feature.ts'], root);
    await check(root);
  } finally {
    await run(['rm', '-rf', root], '/tmp');
  }
}

function services(root: string): Pick<
  GenerationServices,
  'gitService' | 'commitActions'
> & {
  logger: Logger;
} {
  const logger = { log: function () {} };
  const gitService = createGitService({
    gitCommandRunner: async function (args) {
      return { text: await run(['git', ...args], root), truncated: false };
    },
  });
  return {
    logger,
    gitService,
    commitActions: createCommitActionService({ gitService, logger }),
  };
}

function draft(root: string): ChangesetDraft {
  return {
    root,
    content: '---\n"example": patch\n---\n\nThe selected model stays active.\n',
  };
}

test('prepares supported single-package changeset without writing it', async () => {
  await withRepository(async (root) => {
    const previous = process.cwd();
    process.chdir(root);
    try {
      const prepared = await prepareChangeset({
        diff: '+ keepSelectedModel();',
        generate: async function (prompt) {
          expect(prompt).toContain('+ keepSelectedModel();');
          return {
            text: JSON.stringify({
              bump: 'patch',
              summary: 'The selected model stays active.',
            }),
            usage: {},
            truncated: false,
          };
        },
      });
      expect(prepared?.content).toBe(draft(root).content);
      expect(prepared?.root.endsWith(root)).toBe(true);
      expect(
        (await run(['git', 'status', '--short'], root)).includes(
          '.changeset/gcm-',
        ),
      ).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });
}, 15_000);

test('commits staged changes and generated changeset together', async () => {
  await withRepository(async (root) => {
    const deps = services(root);
    const { capability } = await deps.commitActions.inspect(null);
    await commitWithChangeset({
      ...deps,
      draft: draft(root),
      capability,
      message: 'fix: keep model',
    });
    const files = await run(
      ['git', 'show', '--format=', '--name-only', 'HEAD'],
      root,
    );
    expect(files).toContain('feature.ts');
    expect(files).toContain('.changeset/gcm-');
  });
}, 15_000);

test('failed hook removes generated changeset but preserves hook-staged changes', async () => {
  await withRepository(async (root) => {
    const deps = services(root);
    const { capability } = await deps.commitActions.inspect(null);
    await Bun.write(`${root}/hook.txt`, 'hook change\n');
    await Bun.write(
      `${root}/.git/hooks/commit-msg`,
      '#!/bin/sh\ngit add hook.txt\nexit 1\n',
    );
    await run(['chmod', '+x', '.git/hooks/commit-msg'], root);
    await expect(
      commitWithChangeset({
        ...deps,
        draft: draft(root),
        capability,
        message: 'fix: keep model',
      }),
    ).rejects.toThrow();
    const status = await run(['git', 'status', '--short'], root);
    expect(status).toContain('A  hook.txt');
    expect(status).not.toContain('.changeset/gcm-');
    expect(await run(['git', 'log', '-1', '--format=%s'], root)).toBe(
      'chore: initial\n',
    );
  });
}, 15_000);

test('retains generated changeset when commit completed before error', async () => {
  await withRepository(async (root) => {
    const deps = services(root);
    const { capability } = await deps.commitActions.inspect(null);
    await expect(
      commitWithChangeset({
        ...deps,
        commitActions: {
          ...deps.commitActions,
          apply: async function (currentCapability, message) {
            await deps.commitActions.apply(currentCapability, message);
            throw new Error('Result unavailable');
          },
        },
        draft: draft(root),
        capability,
        message: 'fix: keep model',
      }),
    ).rejects.toThrow('generated changeset retained');
    expect(
      await run(['git', 'show', '--format=', '--name-only', 'HEAD'], root),
    ).toContain('.changeset/gcm-');
  });
}, 15_000);

for (const { includeChangeset, projectExclude } of [
  { includeChangeset: true, projectExclude: false },
  { includeChangeset: false, projectExclude: false },
  { includeChangeset: false, projectExclude: true },
]) {
  test(`generation commits ${includeChangeset ? 'with' : 'without'} changeset${projectExclude ? ' when project excludes matched' : ''}`, async () => {
    await withRepository(async (root) => {
      const previous = process.cwd();
      const { AUTO_CHANGESET: oldFlag } = CONFIG;
      CONFIG.AUTO_CHANGESET = true;
      process.chdir(root);
      try {
        if (projectExclude) {
          await Bun.write(`${root}/hidden.ts`, 'export const hidden = true;\n');
          await run(['git', 'add', '--', 'hidden.ts'], root);
        }
        const deps = services(root);
        const notes: string[] = [];
        let calls = 0;
        const generatedServices: GenerationServices = {
          ...deps,
          config: CONFIG,
          projectConfig: projectExclude
            ? { exclude: ['hidden.ts'] }
            : undefined,
          providerId: 'test',
          providerLabel: 'Test',
          contextService: {
            constructLLMPromptContext: async function ({ diffContent }) {
              return {
                promptContext: diffContent,
                processedDiffContent: diffContent,
                tokens: 20,
              };
            },
          },
          languageModelService: {
            generate: async function () {
              calls += 1;
              return {
                text:
                  calls === 1
                    ? 'fix: keep model'
                    : JSON.stringify({
                        bump: 'patch',
                        summary: 'The selected model stays active.',
                      }),
                usage: {},
                truncated: false,
              };
            },
          },
          models: async function () {
            return [
              {
                name: 'test-model',
                label: 'Test',
                limits: {
                  kind: 'separate',
                  maxInputTokens: 20_000,
                  maxOutputTokens: 8_192,
                },
              },
            ];
          },
          dialogue: {
            configure: async function () {
              return 'continue';
            },
            handleEmptyStaging: async function () {
              return 'cancel';
            },
            recoverGeneration: async function () {
              return 'cancel';
            },
            confirmAtomicity: async function () {
              return true;
            },
            review: async function ({ commitMessage, changeset }) {
              expect(typeof changeset).toBe(
                projectExclude ? 'object' : 'string',
              );
              return {
                type: 'commit',
                modelName: 'test-model',
                commitMessage,
                includeChangeset,
                ...(includeChangeset
                  ? {}
                  : { changesetReason: 'internal-refactor' as const }),
              };
            },
          },
          getCommitContextHints: async function () {
            return { scopeSuggestions: [], recentCommitSubjects: [] };
          },
          saveSession: async function () {},
          output: {
            isInteractive: true,
            startProgress: function () {},
            stopProgress: function () {},
            cancel: function () {},
            note: function (_message, title) {
              notes.push(title ?? '');
            },
            warn: function () {},
            outro: function () {},
            print: function () {},
            sanitizeGeneratedText: function (message) {
              return message;
            },
            sanitizeTerminalText: function (message) {
              return message;
            },
            style: {
              cyan: function (message) {
                return message;
              },
              dim: function (message) {
                return message;
              },
              yellow: function (message) {
                return message;
              },
            },
          },
        };
        const { state } = createGenerationState({
          parsedArgs: parseArgs([]),
          session: { providerId: null, modelName: null },
          defaultModel: 'test-model',
          providerId: 'test',
        });
        const outcome = await runGenerationCommand({
          createServices: function () {
            return generatedServices;
          },
          parsedArgs: parseArgs([]),
          logger: deps.logger,
          targetCommit: null,
          state,
          output: generatedServices.output,
        });
        expect(outcome).toBe('success');
        expect(notes.slice(0, 2)).toEqual(
          projectExclude
            ? ['Generated Commit Message', 'Changeset unavailable']
            : ['Generated Commit Message', 'Proposed Changeset'],
        );
        expect(calls).toBe(projectExclude ? 1 : 2);
        const message = await run(['git', 'log', '-1', '--format=%B'], root);
        expect(message.includes('Changeset: none')).toBe(!includeChangeset);
        const files = await run(
          ['git', 'show', '--format=', '--name-only', 'HEAD'],
          root,
        );
        expect(files.includes('.changeset/gcm-')).toBe(includeChangeset);
      } finally {
        CONFIG.AUTO_CHANGESET = oldFlag;
        process.chdir(previous);
      }
    });
  }, 15_000);
}
