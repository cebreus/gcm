import { expect, test, mock, describe, beforeEach, afterEach } from 'bun:test';
import { executeCommitMessageGeneration } from '../src/runner.js';
import { createGenerationState } from '../src/generation.js';
import { parseArgs } from '../src/cli.js';
import packageJson from '../package.json';
import type { Logger } from '../src/logger.js';
import { CONFIG } from '../gcm.config.js';

// Mock @clack/prompts
const mockIntro = mock();
const mockOutro = mock();
const mockSpinner = mock(() => ({ start: mock(), stop: mock() }));
const mockNote = mock();
interface MockSelectRequest {
  message: string;
  options?: { value: string }[];
}

const mockSelect = mock((arg: MockSelectRequest) => {
  console.log('Unexpected Select:', arg.message);
  return Promise.resolve('cancel');
});
const mockText = mock(() => Promise.resolve('edited message'));
const mockIsCancel = mock(val => val === 'cancel');
const mockCancel = mock();

void mock.module('@clack/prompts', () => ({
  intro: mockIntro,
  outro: mockOutro,
  spinner: mockSpinner,
  note: mockNote,
  select: mockSelect,
  text: mockText,
  isCancel: mockIsCancel,
  cancel: mockCancel,
}));

// Mock ../src/session.js
const mockLoadSession = mock(() =>
  Promise.resolve({
    providerId: null as string | null,
    modelName: null as string | null,
    outputMode: null as 'full' | 'commit-only' | null,
  }),
);
const mockSaveSession = mock(() => Promise.resolve());
void mock.module('../src/session.js', () => ({
  loadSession: mockLoadSession,
  saveSession: mockSaveSession,
}));

// Mock clipboardy
const mockClipboardyWrite = mock(() => Promise.resolve());
void mock.module('clipboardy', () => ({
  default: {
    write: mockClipboardyWrite,
  },
}));

// Mocks
const mockLogger = { log: mock() };
const mockGitService = {
  listCommitHashes: mock(),
  hasAmendment: mock(),
  getHeadHash: mock(),
  retrieveStagedChanges: mock(),
  commitChanges: mock(),
  amendCommit: mock(),
  rewordCommit: mock(),
  inspectCommitTarget: mock(),
  getIndexTree: mock(),
  getIndexEntries: mock(),
  getRepositoryState: mock(),
};
const mockContextService = {
  constructLLMPromptContext: mock(),
  reduceForRetry: mock(
    async (params: {
      promptParts: { prefix: string; diffHeading: string; diffBody: string; suffix: string };
      stagedFiles?: string[];
      summaryAttempted: boolean;
    }) => ({
      promptContext:
        params.promptParts.prefix +
        params.promptParts.diffHeading +
        params.promptParts.diffBody +
        params.promptParts.suffix,
      promptParts: params.promptParts,
      mode: 'truncation' as const,
      summaryAttempted: params.summaryAttempted,
      summaryUsed: false,
    }),
  ),
};
const mockGeminiService = { generate: mock() };
const mockListModels = mock(() =>
  Promise.resolve(['models/gemini-3.7-flash', 'models/gemini-3.1-pro-preview']),
);

describe('Refactored Runner', () => {
  test('--debug does not mutate shared configuration', async () => {
    const originalDebugApi = CONFIG.DEBUG_API;

    await executeCommitMessageGeneration(['--debug', '--version'], { logger: mockLogger });

    expect(CONFIG.DEBUG_API).toBe(originalDebugApi);
  });

  test('Should scope restored models to their provider', () => {
    const session = { providerId: 'gemini', modelName: 'gemini-model', outputMode: null } as const;
    expect(
      createGenerationState(parseArgs([]), session, 'local-model', 'local').state.modelName,
    ).toBe('local-model');
    expect(
      createGenerationState(parseArgs([]), session, 'fallback', 'gemini').state.modelName,
    ).toBe('gemini-model');
  });

  test('Should seed generation with a CLI hint', () => {
    const session = { providerId: null, modelName: null, outputMode: null } as const;
    const state = createGenerationState(
      parseArgs(['--hint', 'emphasize migration']),
      session,
      'gemini-model',
      'gemini',
    ).state;

    expect(state.userHint).toBe('emphasize migration');
  });

  beforeEach(() => {
    mockLogger.log.mockClear();
    mockGitService.retrieveStagedChanges.mockClear();
    mockGitService.commitChanges.mockClear();
    mockGitService.amendCommit.mockClear();
    mockGitService.rewordCommit.mockClear();
    mockGitService.listCommitHashes.mockClear();
    mockGitService.hasAmendment.mockClear();
    mockGitService.getHeadHash.mockClear();
    mockGitService.getIndexTree.mockClear();
    mockGitService.getIndexTree.mockResolvedValue('index-tree');
    mockGitService.getIndexEntries.mockClear();
    mockGitService.getIndexEntries.mockResolvedValue([]);
    mockGitService.getRepositoryState.mockClear();
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: false,
      inProgressOperation: null,
      changedFiles: ['file.ts'],
    });
    mockContextService.constructLLMPromptContext.mockClear();
    mockGeminiService.generate.mockClear();
    mockListModels.mockClear();

    // Clear clack mocks
    mockIntro.mockClear();
    mockOutro.mockClear();
    mockSpinner.mockClear();
    mockNote.mockClear();
    mockSelect.mockReset();
    mockSelect.mockImplementation((arg: MockSelectRequest) => {
      console.log('Unexpected Select:', arg.message);
      return Promise.resolve('cancel');
    });
    mockText.mockReset();
    mockText.mockImplementation(() => Promise.resolve('edited message'));

    // Clear clipboardy mock
    mockClipboardyWrite.mockClear();
    mockCancel.mockClear();
  });

  test('Should actively list every provider with probe-only factories and propagate partial exit', async () => {
    const model = {
      name: 'model',
      label: 'Model',
      maxInputTokens: 8_192,
      maxOutputTokens: 1_024,
    };
    const availableCreate = mock(async function (options?: { probeOnly?: boolean }) {
      return {
        id: 'available',
        label: 'Available',
        defaultModel: model.name,
        fallbackModels: [model],
        service: {
          generate: async function () {
            return null;
          },
        },
        listModels: async function () {
          return [model.name];
        },
        getModelSpec: function () {
          return model;
        },
      };
    });
    const missingCreate = mock(async function () {
      throw new Error('offline');
    });

    await executeCommitMessageGeneration(['--list-providers'], {
      logger: mockLogger,
      gitService: mockGitService,
      languageModelProviderFactories: [
        { id: 'available', label: 'Available', create: availableCreate },
        { id: 'missing', label: 'Missing', create: missingCreate },
      ],
    });

    expect(availableCreate).toHaveBeenCalledWith({ probeOnly: true });
    expect(missingCreate).toHaveBeenCalledWith({ probeOnly: true });
    expect(process.exitCode).toBe(1);
    expect(mockGitService.getRepositoryState).not.toHaveBeenCalled();
    if (!process.stdout.isTTY) expect(mockNote.mock.calls[0]?.[0]).not.toContain('\u001b');
  });

  test('Should list providers even when the configured provider is unknown', async () => {
    const originalProvider = process.env.GCM_PROVIDER;
    process.env.GCM_PROVIDER = 'openai';
    const create = mock(async function () {
      const model = {
        name: 'model',
        label: 'Model',
        maxInputTokens: 8_192,
        maxOutputTokens: 1_024,
      };
      return {
        id: 'ready',
        label: 'Ready',
        defaultModel: model.name,
        fallbackModels: [model],
        service: {
          generate: async function () {
            return null;
          },
        },
        listModels: async function () {
          return [model.name];
        },
        getModelSpec: function () {
          return model;
        },
      };
    });

    try {
      await executeCommitMessageGeneration(['--list-providers'], {
        logger: mockLogger,
        languageModelProviderFactories: [{ id: 'ready', label: 'Ready', create }],
      });
      expect(create).toHaveBeenCalledWith({ probeOnly: true });
      expect(process.exitCode).toBe(0);
    } finally {
      if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
      else process.env.GCM_PROVIDER = originalProvider;
    }
  });

  test('Should show help without probing providers when list-providers is also present', async () => {
    const create = mock(async function () {
      throw new Error('must not probe');
    });

    await executeCommitMessageGeneration(['--help', '--list-providers'], {
      logger: mockLogger,
      languageModelProviderFactories: [{ id: 'local', label: 'Local', create }],
    });

    expect(create).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  test('Should orchestrate services correctly', async () => {
    // Setup
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      promptParts: { prefix: 'prefix', diffHeading: 'Diff:\n', diffBody: 'diff', suffix: 'suffix' },
      processedDiffContent: 'diff',
      tokens: 10,
      summaryAttempted: true,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'BRANCH: feat/test\nCOMMIT_MESSAGE: test: message',
      usage: {},
    });

    // Pre-flight: generate, Review: commit
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    // Execute
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    await executeCommitMessageGeneration([], {
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Verify
    expect(mockGitService.retrieveStagedChanges).toHaveBeenCalled();
    expect(mockContextService.constructLLMPromptContext).toHaveBeenCalled();
    expect(mockGeminiService.generate).toHaveBeenCalled();
    expect(mockGeminiService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryAttempted: true,
        systemPrompt: expect.stringContaining(
          'Body is optional. Use it only when the change cannot be described faithfully in the subject alone.',
        ) as unknown,
      }),
    );
    expect(mockGeminiService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'When a body is needed, use at least two concise "- " bullets.',
        ) as unknown,
      }),
    );

    // Default is now Commit Only, so only message is shown.
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining('test'),
      'Generated Commit Message',
    );
  });

  test('non-interactive generation does not prompt or write without --apply', async () => {
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
      snapshot: { tree: 'index-tree', entries: [] },
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: fix(scope): generated message',
      usage: {},
    });

    await executeCommitMessageGeneration(
      ['--non-interactive', '--mode', 'commit-only', '--model', 'gemini-3.7-flash'],
      {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      },
    );

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockNote).toHaveBeenCalledWith(
      'fix(scope): generated message',
      'Generated Commit Message',
    );
    expect(mockGitService.commitChanges).not.toHaveBeenCalled();
  });

  test('non-interactive --apply writes the generated message without prompting', async () => {
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
      snapshot: { tree: 'index-tree', entries: [] },
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: fix(scope): generated message',
      usage: {},
    });

    await executeCommitMessageGeneration(
      ['--non-interactive', '--apply', '--mode', 'commit-only', '--model', 'gemini-3.7-flash'],
      {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      },
    );

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGitService.commitChanges).toHaveBeenCalledWith(
      'fix(scope): generated message',
      mockLogger,
      expect.anything(),
    );
  });

  test('commit range applies one amend! action per frozen target without prompting', async () => {
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    const targets = ['a'.repeat(40), 'b'.repeat(40)];
    const rewordedTargets: string[] = [];
    let currentHead = 'c'.repeat(40);
    mockGitService.listCommitHashes.mockResolvedValue(targets);
    mockGitService.hasAmendment.mockResolvedValue(false);
    mockGitService.getHeadHash.mockImplementation(async () => currentHead);
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
      snapshot: { tree: 'index-tree', entries: [] },
    });
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: false,
      inProgressOperation: null,
      changedFiles: [],
    });
    mockGitService.inspectCommitTarget.mockImplementation(async (hash: string) => ({
      hash,
      headHash: currentHead,
      subject: 'feat: original',
      isHead: hash === currentHead,
      isPublished: false,
      isAncestorOfHead: true,
      isHeadDetached: false,
      hasParent: true,
      hasAmbiguousSubject: false,
    }));
    mockGitService.rewordCommit.mockImplementation(async (target: { hash: string }) => {
      rewordedTargets.push(target.hash);
      currentHead = currentHead === 'c'.repeat(40) ? 'd'.repeat(40) : 'e'.repeat(40);
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: fix(scope): generated message',
      usage: {},
    });

    await executeCommitMessageGeneration(
      [
        '--commit-range',
        'base^..HEAD',
        '--non-interactive',
        '--apply',
        '--mode',
        'commit-only',
        '--model',
        'gemini-3.7-flash',
      ],
      {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      },
    );

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGitService.rewordCommit).toHaveBeenCalledTimes(2);
    expect(rewordedTargets).toEqual(targets);
  });

  test('commit range stops before generation when the index is staged', async () => {
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: false,
      inProgressOperation: null,
      changedFiles: ['staged.ts'],
    });

    await executeCommitMessageGeneration(
      ['--commit-range', 'base^..HEAD', '--non-interactive', '--apply'],
      {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      },
    );

    expect(mockGitService.listCommitHashes).not.toHaveBeenCalled();
    expect(mockGeminiService.generate).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith(
      'Commit range apply requires a clean index with no Git operation in progress.',
    );
  });

  test('Should run a keyless provider through the complete generation seam', async () => {
    const generate = mock(async () => ({
      text: 'COMMIT_MESSAGE: test: local result',
      usage: {},
    }));
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      promptParts: { prefix: '', diffHeading: '', diffBody: 'diff', suffix: '' },
      processedDiffContent: 'diff',
      tokens: 10,
      summaryAttempted: false,
    });
    mockSelect
      .mockResolvedValueOnce('configure')
      .mockResolvedValueOnce('model')
      .mockResolvedValueOnce('local-alt')
      .mockResolvedValueOnce('generate')
      .mockResolvedValueOnce('commit');

    const provider = {
      id: 'local',
      label: 'Local',
      selectionNotice: 'Preferred model is unavailable; using local-model',
      defaultModel: 'local-model',
      fallbackModels: [
        {
          name: 'local-alt',
          label: 'Local Alternative',
          maxInputTokens: 8_192,
          maxOutputTokens: 1_024,
        },
      ],
      service: { generate },
      listModels: async function () {
        return ['local-alt'];
      },
      getModelSpec: function (name: string) {
        return {
          name,
          label: name,
          maxInputTokens: 8_192,
          maxOutputTokens: 1_024,
        };
      },
    };

    await executeCommitMessageGeneration(['--mode', 'commit-only'], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      languageModelProvider: provider,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining('local result'),
      'Generated Commit Message',
    );
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'local', modelName: 'local-alt' }),
    );
    expect(mockIntro).toHaveBeenCalledWith(expect.stringContaining('Local Commit Message Helper'));
    expect(mockNote).toHaveBeenCalledWith(
      'Preferred model is unavailable; using local-model',
      'Model fallback',
    );

    const originalStdoutWrite = process.stdout.write;
    const helpOutput: string[] = [];
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      helpOutput.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;
    try {
      await executeCommitMessageGeneration(['--help'], { languageModelProvider: provider });
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
    expect(helpOutput.join('')).toContain('Local Commit Message Helper');
    expect(helpOutput.join('')).not.toContain('Gemini model');
  });

  test('Should recompose services after selecting another provider', async () => {
    const geminiGenerate = mock(async () => ({ text: 'COMMIT_MESSAGE: test: wrong', usage: {} }));
    const localGenerate = mock(async () => ({
      text: 'COMMIT_MESSAGE: test: local result',
      usage: {},
    }));
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      promptParts: { prefix: '', diffHeading: '', diffBody: 'diff', suffix: '' },
      processedDiffContent: 'diff',
      tokens: 10,
      summaryAttempted: false,
    });
    mockSelect
      .mockResolvedValueOnce('configure')
      .mockResolvedValueOnce('provider')
      .mockResolvedValueOnce('local')
      .mockResolvedValueOnce('generate')
      .mockResolvedValueOnce('commit');
    function provider(id: string, label: string, generate: typeof localGenerate) {
      return {
        id,
        label,
        defaultModel: `${id}-model`,
        fallbackModels: [
          { name: `${id}-model`, label, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
        ],
        service: { generate },
        listModels: async function () {
          return [`${id}-model`];
        },
        getModelSpec: function (name: string) {
          return { name, label, maxInputTokens: 8_192, maxOutputTokens: 1_024 };
        },
      };
    }

    await executeCommitMessageGeneration(['--mode', 'commit-only'], {
      isInteractive: true,
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      languageModelProviderFactories: [
        {
          id: 'gemini',
          label: 'Gemini',
          create: async function () {
            return provider('gemini', 'Gemini', geminiGenerate);
          },
        },
        {
          id: 'local',
          label: 'Local',
          create: async function () {
            return provider('local', 'Local', localGenerate);
          },
        },
      ],
    });

    expect(geminiGenerate).not.toHaveBeenCalled();
    expect(localGenerate).toHaveBeenCalledTimes(1);
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'local', modelName: 'local-model' }),
    );
  });

  test('Should allow switching away from a provider that is not ready', async () => {
    const localGenerate = mock(async () => ({
      text: 'COMMIT_MESSAGE: test: local result',
      usage: {},
    }));
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      promptParts: { prefix: '', diffHeading: '', diffBody: 'diff', suffix: '' },
      processedDiffContent: 'diff',
      tokens: 10,
      summaryAttempted: false,
    });
    mockSelect
      .mockResolvedValueOnce('configure')
      .mockResolvedValueOnce('provider')
      .mockResolvedValueOnce('local')
      .mockResolvedValueOnce('generate')
      .mockResolvedValueOnce('commit');
    const spec = { name: 'model', label: 'Model', maxInputTokens: 8_192, maxOutputTokens: 1_024 };
    await executeCommitMessageGeneration(['--mode', 'commit-only'], {
      isInteractive: true,
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      languageModelProviderFactories: [
        {
          id: 'broken',
          label: 'Broken',
          create: async function () {
            return {
              id: 'broken',
              label: 'Broken',
              readinessError: 'Unavailable',
              defaultModel: 'model',
              fallbackModels: [spec],
              service: { generate: mock() },
              listModels: async function () {
                return ['model'];
              },
              getModelSpec: function () {
                return spec;
              },
            };
          },
        },
        {
          id: 'local',
          label: 'Local',
          create: async function () {
            return {
              id: 'local',
              label: 'Local',
              defaultModel: 'model',
              fallbackModels: [spec],
              service: { generate: localGenerate },
              listModels: async function () {
                return ['model'];
              },
              getModelSpec: function () {
                return spec;
              },
            };
          },
        },
      ],
    });
    expect(localGenerate).toHaveBeenCalledTimes(1);
  });

  test('Should keep version independent from invalid provider selection', async () => {
    const originalProvider = process.env.GCM_PROVIDER;
    process.env.GCM_PROVIDER = 'missing';
    try {
      await executeCommitMessageGeneration(['--version'], { logger: mockLogger });
      expect(process.exitCode).not.toBe(1);
    } finally {
      if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
      else process.env.GCM_PROVIDER = originalProvider;
    }
  });

  test('Should prefer the freellmapi provider over the environment', async () => {
    const originalProvider = process.env.GCM_PROVIDER;
    process.env.GCM_PROVIDER = 'lm-studio';
    try {
      await executeCommitMessageGeneration(['--provider', 'freellmapi', '--help'], {
        logger: mockLogger,
      });
      expect(process.exitCode).toBe(0);
      expect(mockIntro).toHaveBeenCalledWith(expect.stringContaining('FreeLLMAPI'));
    } finally {
      if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
      else process.env.GCM_PROVIDER = originalProvider;
    }
  });

  test('Should reject an unknown provider before showing help', async () => {
    const originalProvider = process.env.GCM_PROVIDER;
    process.env.GCM_PROVIDER = 'missing';
    try {
      await executeCommitMessageGeneration(['--help'], { logger: mockLogger });
      expect(process.exitCode).toBe(1);
      expect(mockCancel).toHaveBeenCalledWith('Error: Unknown language model provider.');
      expect(mockIntro).not.toHaveBeenCalled();
    } finally {
      if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
      else process.env.GCM_PROVIDER = originalProvider;
    }
  });

  test('Should show LM Studio help without contacting the server', async () => {
    const originalProvider = process.env.GCM_PROVIDER;
    const originalUrl = process.env.GCM_LM_STUDIO_URL;
    process.env.GCM_PROVIDER = 'lm-studio';
    process.env.GCM_LM_STUDIO_URL = 'http://127.0.0.1:1';
    try {
      await executeCommitMessageGeneration(['--help'], { logger: mockLogger });
      expect(process.exitCode).toBe(0);
      expect(mockIntro).toHaveBeenCalledWith(expect.stringContaining('LM Studio'));
      expect(mockCancel).not.toHaveBeenCalled();
    } finally {
      if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
      else process.env.GCM_PROVIDER = originalProvider;
      if (originalUrl === undefined) delete process.env.GCM_LM_STUDIO_URL;
      else process.env.GCM_LM_STUDIO_URL = originalUrl;
    }
  });

  test('Should keep Gemini as default when a prior session used LM Studio', async () => {
    const originalProvider = process.env.GCM_PROVIDER;
    delete process.env.GCM_PROVIDER;
    mockLoadSession.mockResolvedValueOnce({
      providerId: 'lm-studio',
      modelName: 'local-model',
      outputMode: null,
    });
    try {
      await executeCommitMessageGeneration(['--help'], { logger: mockLogger });
      expect(mockIntro).toHaveBeenCalledWith(expect.stringContaining('Gemini'));
    } finally {
      if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
      else process.env.GCM_PROVIDER = originalProvider;
    }
  });

  test('Should keep explicit model and mode prompt-free with multiple providers', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue(null);
    const provider = {
      id: 'gemini',
      label: 'Gemini',
      defaultModel: 'gemini-3.7-flash',
      fallbackModels: [
        {
          name: 'gemini-3.7-flash',
          label: 'Gemini',
          maxInputTokens: 8_192,
          maxOutputTokens: 1_024,
        },
      ],
      service: { generate: mock() },
      listModels: async function () {
        return ['gemini-3.7-flash'];
      },
      getModelSpec: function () {
        return {
          name: 'gemini-3.7-flash',
          label: 'Gemini',
          maxInputTokens: 8_192,
          maxOutputTokens: 1_024,
        };
      },
    };
    await executeCommitMessageGeneration(['--model', 'gemini-3.7-flash', '--mode', 'commit-only'], {
      isInteractive: true,
      logger: mockLogger,
      gitService: mockGitService,
      languageModelProviderFactories: [
        {
          id: 'gemini',
          label: 'Gemini',
          create: async function () {
            return provider;
          },
        },
        {
          id: 'local',
          label: 'Local',
          create: async function () {
            return { ...provider, id: 'local', label: 'Local' };
          },
        },
      ],
    });
    expect(
      mockSelect.mock.calls.some(call => String(call[0]?.message).startsWith('Settings:')),
    ).toBe(false);
  });

  test('Should reject a provider factory identity mismatch', async () => {
    await executeCommitMessageGeneration([], {
      logger: mockLogger,
      languageModelProviderFactories: [
        {
          id: 'advertised',
          label: 'Advertised',
          create: async function () {
            return {
              id: 'different',
              label: 'Different',
              defaultModel: 'model',
              fallbackModels: [
                { name: 'model', label: 'Model', maxInputTokens: 8_192, maxOutputTokens: 1_024 },
              ],
              service: { generate: mock() },
              listModels: async function () {
                return ['model'];
              },
              getModelSpec: function () {
                return {
                  name: 'model',
                  label: 'Model',
                  maxInputTokens: 8_192,
                  maxOutputTokens: 1_024,
                };
              },
            };
          },
        },
      ],
    });
    expect(mockCancel).toHaveBeenCalledWith(expect.stringContaining('provider factory identity'));
  });

  test('Should reject an invalid live model spec before generation', async () => {
    const generate = mock(async () => null);
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });

    await executeCommitMessageGeneration(['--model', 'live-model', '--mode', 'commit-only'], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      languageModelProvider: {
        id: 'local',
        label: 'Local',
        defaultModel: 'default-model',
        fallbackModels: [
          {
            name: 'default-model',
            label: 'Default',
            maxInputTokens: 8_192,
            maxOutputTokens: 1_024,
          },
        ],
        service: { generate },
        listModels: async function () {
          return ['live-model'];
        },
        getModelSpec: function (name) {
          return {
            name,
            label: name,
            maxInputTokens: name === 'live-model' ? 1_000 : 8_192,
            maxOutputTokens: 1_024,
          };
        },
      },
    });

    expect(mockCancel).toHaveBeenCalledWith('Error: Invalid model token limits.');
    expect(generate).not.toHaveBeenCalled();
  });

  test('Should print package version and exit on --version', async () => {
    const originalStdoutWrite = process.stdout.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;

    try {
      await executeCommitMessageGeneration(['--version'], {
        logger: mockLogger as unknown as Logger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      const output = stdoutChunks.join('');
      expect(output).toContain('gcm');
      expect(output).toContain(packageJson.version);
      expect(mockIntro).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  test('Should report argument validation failures without throwing', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await expect(
        executeCommitMessageGeneration(['--commmit', 'abc'], {
          logger: mockLogger as unknown as Logger,
          gitService: mockGitService,
          contextService: mockContextService,
          geminiService: mockGeminiService,
          geminiModelLister: mockListModels,
        }),
      ).resolves.toBeUndefined();

      expect(mockCancel).toHaveBeenCalledWith(
        'Error: Unknown flag: --commmit. Run gcm --help for usage.',
      );
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test('Should reject terminal-control model names before generation', async () => {
    await executeCommitMessageGeneration(['--model', 'bad\u001b[2Jmodel'], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    expect(mockCancel).toHaveBeenCalledWith('Error: Invalid model name.');
    expect(mockGeminiService.generate).not.toHaveBeenCalled();
  });

  test('Should redact credentials from provider readiness errors', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      languageModelProvider: {
        id: 'local',
        label: 'Local',
        readinessError: 'Invalid credential: AIzaSyExampleSecret1234567890',
        defaultModel: 'local-model',
        fallbackModels: [
          {
            name: 'local-model',
            label: 'Local model',
            maxInputTokens: 8_192,
            maxOutputTokens: 1_024,
          },
        ],
        service: {
          generate: async function () {
            return null;
          },
        },
        listModels: async function () {
          return [];
        },
        getModelSpec: function (name) {
          return { name, label: name, maxInputTokens: 8_192, maxOutputTokens: 1_024 };
        },
      },
    });

    expect(mockCancel).toHaveBeenCalledWith('Error: Invalid credential: [REDACTED-KEY]');
  });

  test('Should report provider API errors by metadata shape', async () => {
    const error = Object.assign(new Error('quota exhausted'), {
      name: 'LanguageModelApiError',
      metadata: { status: 429, snippet: '{"error":{"message":"quota exhausted"}}' },
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockRejectedValueOnce(error);
    mockSelect.mockResolvedValueOnce('generate');

    await expect(
      executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      }),
    ).rejects.toBe(error);

    expect(mockCancel).toHaveBeenCalledWith('API Error (429): quota exhausted');
  });

  test('Should report truthy non-string Gemini API error messages', async () => {
    const error = Object.assign(new Error('quota exhausted'), {
      name: 'LanguageModelApiError',
      metadata: { status: 429, snippet: '{"error":{"message":429}}' },
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockRejectedValueOnce(error);
    mockSelect.mockResolvedValueOnce('generate');

    await expect(
      executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      }),
    ).rejects.toBe(error);

    expect(mockCancel).toHaveBeenCalledWith('API Error (429): quota exhausted');
  });

  test('Should remove terminal controls from Gemini API error messages', async () => {
    const error = Object.assign(new Error('quota exhausted'), {
      name: 'LanguageModelApiError',
      metadata: {
        status: 429,
        snippet:
          '{"error":{"message":"bad\\u001b]8;;https://example.test\\u0007link\\u001b]8;;\\u0007"}}',
      },
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockRejectedValueOnce(error);
    mockSelect.mockResolvedValueOnce('generate');

    await expect(
      executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      }),
    ).rejects.toBe(error);

    expect(mockCancel).toHaveBeenCalledWith('API Error (429): badlink');
  });

  test('Should include version details in --help output', async () => {
    const originalStdoutWrite = process.stdout.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;

    try {
      await executeCommitMessageGeneration(['--help'], {
        logger: mockLogger as unknown as Logger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      const output = stdoutChunks.join('');
      expect(output).toContain('Version:');
      expect(output).toContain(packageJson.version);
      expect(output).toContain('--version');
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  test('Should handle Edit flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'BRANCH: branch\nCOMMIT_MESSAGE: test: initial message',
      usage: {},
    });

    // Sequence: 'edit' -> 'commit'
    // BUT first we have Pre-flight: 'generate'
    // Then Review Menu: 'edit' -> 'commit'
    mockSelect
      .mockResolvedValueOnce('generate') // Pre-flight
      .mockResolvedValueOnce('edit') // Review
      .mockResolvedValueOnce('commit'); // Review loop
    mockText.mockResolvedValue('edited message');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Verify text prompt called with initial value
    expect(mockText).toHaveBeenCalled();
    // Verify commit called with edited message
    expect(mockGitService.commitChanges).toHaveBeenCalledWith(
      'edited message',
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('Should reject a stale index through the commit workflow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
      snapshot: {
        tree: 'original-tree',
        entries: [{ path: 'file.ts', mode: '100644', objectId: '1'.repeat(40) }],
      },
    });
    mockGitService.getIndexTree
      .mockResolvedValueOnce('original-tree')
      .mockResolvedValueOnce('changed-tree')
      .mockResolvedValueOnce('changed-tree');
    mockGitService.getIndexEntries.mockResolvedValueOnce([
      { path: 'file.ts', mode: '100644', objectId: '1'.repeat(40) },
      { path: 'later.ts', mode: '100644', objectId: '2'.repeat(40) },
    ]);
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: initial message',
      usage: {},
    });
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    expect(mockGitService.commitChanges).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith(
      'Staged changes were modified while this message was on screen, so the message no longer describes what would be committed. Added: "later.ts". Regenerate the message, review it, then commit.',
    );
  });

  test('Should handle no staged changes', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue(null);
    mockSelect.mockResolvedValueOnce('generate'); // Pre-flight
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });
      expect(mockGeminiService.generate).not.toHaveBeenCalled();
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test('Should fail when Git has unresolved conflicts', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: true,
      inProgressOperation: null,
      changedFiles: ['file.ts'],
    });

    try {
      await executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      expect(mockCancel).toHaveBeenCalledWith(
        'Git index has unresolved conflicts. Resolve conflicts before generating or committing.',
      );
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockGeminiService.generate).not.toHaveBeenCalled();
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  for (const inputCase of [
    {
      args: ['--model', 'gemini-3.1-pro-preview'],
      message:
        'Settings: [Provider: Gemini] [Model: gemini-3.1-pro-preview] [Mode: Commit Msg Only]',
    },
    {
      args: ['--mode', 'full'],
      message: 'Settings: [Provider: Gemini] [Model: gemini-3.7-flash] [Mode: Full Report]',
    },
  ]) {
    test(`Should still offer settings when only ${inputCase.args[0]} is provided`, async () => {
      const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
      process.env.GOOGLE_GEMINI_API_KEY = 'test';
      mockGitService.retrieveStagedChanges.mockResolvedValue({
        stagedDiff: 'diff',
        stagedFiles: ['file.ts'],
        truncated: false,
      });
      mockSelect.mockResolvedValueOnce('exit');

      try {
        await executeCommitMessageGeneration(inputCase.args, {
          logger: mockLogger,
          gitService: mockGitService,
          contextService: mockContextService,
          geminiService: mockGeminiService,
          geminiModelLister: mockListModels,
        });

        expect(mockSelect).toHaveBeenCalledWith(
          expect.objectContaining({ message: inputCase.message }),
        );
        expect(mockGeminiService.generate).not.toHaveBeenCalled();
      } finally {
        if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
        else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
      }
    });
  }

  test('Should show the latest repository state discovered during preflight', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
      snapshot: { tree: 'index-tree', entries: [] },
    });
    mockGitService.getRepositoryState
      .mockResolvedValueOnce({
        hasStagedChanges: true,
        hasUnstagedChanges: false,
        hasUntrackedFiles: false,
        hasUnmergedPaths: false,
        inProgressOperation: null,
        changedFiles: ['file.ts'],
      })
      .mockResolvedValueOnce({
        hasStagedChanges: true,
        hasUnstagedChanges: false,
        hasUntrackedFiles: false,
        hasUnmergedPaths: false,
        inProgressOperation: 'rebase',
        changedFiles: ['file.ts'],
      })
      .mockResolvedValueOnce({
        hasStagedChanges: true,
        hasUnstagedChanges: false,
        hasUntrackedFiles: false,
        hasUnmergedPaths: false,
        inProgressOperation: 'rebase',
        changedFiles: ['file.ts'],
      });
    mockSelect.mockResolvedValueOnce('exit');

    try {
      await executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Git operation in progress: rebase.'),
        'Repository warnings',
      );
      expect(mockSelect).toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should keep generation read-only while a rebase is in progress', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    mockGitService.commitChanges.mockClear();
    mockGitService.amendCommit.mockClear();
    mockGitService.rewordCommit.mockClear();
    mockSaveSession.mockClear();
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
      snapshot: { tree: 'index-tree', entries: [] },
    });
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: false,
      inProgressOperation: 'rebase',
      changedFiles: ['file.ts'],
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: message',
      usage: {},
    });
    mockSelect.mockResolvedValueOnce('cancel');

    try {
      await executeCommitMessageGeneration(
        ['--mode', 'commit-only', '--model', 'gemini-3.7-flash'],
        {
          logger: mockLogger,
          gitService: mockGitService,
          contextService: mockContextService,
          geminiService: mockGeminiService,
          geminiModelLister: mockListModels,
        },
      );

      expect(mockGeminiService.generate).toHaveBeenCalledTimes(1);
      expect(mockNote).toHaveBeenCalledWith(
        'Commit is disabled while a git rebase is in progress. Finish or abort the operation first.',
        'Commit unavailable',
      );
      const reviewRequest = mockSelect.mock.calls
        .map(function ([request]) {
          return request;
        })
        .find(function (request) {
          return request.message === 'What would you like to do?';
        });
      expect(reviewRequest?.options?.some(({ value }) => value === 'commit')).toBe(false);
      expect(mockGitService.commitChanges).not.toHaveBeenCalled();
      expect(mockGitService.amendCommit).not.toHaveBeenCalled();
      expect(mockGitService.rewordCommit).not.toHaveBeenCalled();
      expect(mockSaveSession).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should stop before settings when the staged snapshot changed', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
      snapshot: { tree: 'read-tree', entries: [] },
    });
    mockGitService.getIndexTree.mockResolvedValue('changed-tree');

    try {
      await executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      expect(mockCancel).toHaveBeenCalledWith(
        expect.stringContaining('the index changed after its diff was read'),
      );
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockGeminiService.generate).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should fail when Gemini returns malformed full output', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: missing branch',
      usage: {},
    });

    try {
      await executeCommitMessageGeneration(['--mode', 'full', '--model', 'gemini-3.7-flash'], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      expect(mockOutro).toHaveBeenCalledWith('Failed to parse structured output.');
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should remove terminal controls before logging an unparseable model response', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: '\u001B[2Junparseable\u0000 response',
      usage: {},
    });

    try {
      await executeCommitMessageGeneration(['--mode', 'full', '--model', 'gemini-3.7-flash'], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        geminiModelLister: mockListModels,
      });

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'unparseable response');
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should fail when the commit action fails', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: message',
      usage: {},
    });
    mockGitService.commitChanges.mockRejectedValueOnce(new Error('git commit failed'));
    mockSelect.mockResolvedValueOnce('commit');

    try {
      await executeCommitMessageGeneration(
        ['--mode', 'commit-only', '--model', 'gemini-3.7-flash'],
        {
          logger: mockLogger,
          gitService: mockGitService,
          contextService: mockContextService,
          geminiService: mockGeminiService,
          geminiModelLister: mockListModels,
        },
      );

      expect(mockCancel).toHaveBeenCalledWith('Failed to apply commit action: git commit failed');
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should handle Copy to clipboard flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: message',
      usage: {},
    });

    // Flow: 'generate' -> 'copy' -> 'commit'
    mockSelect
      .mockResolvedValueOnce('generate') // Pre-flight
      .mockResolvedValueOnce('copy') // Review - copy to clipboard
      .mockResolvedValueOnce('commit'); // Review - commit

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Verify clipboardy.write was called with correct message (extracted)
    expect(mockClipboardyWrite).toHaveBeenCalledWith('test: message');
    // Verify note was shown about successful copy
    expect(mockNote).toHaveBeenCalledWith('Commit message copied to clipboard!', 'Success');
    // Verify commit was eventually called
    expect(mockGitService.commitChanges).toHaveBeenCalled();
  });

  test('Should handle Regeneration flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    // Context service called twice (initial + regen)
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: msg',
      usage: {},
    });

    // Flow:
    // 1. Pre-flight: 'generate'
    // 2. Review: 'regenerate'
    // 3. Select Model: 'gemini-2.5-pro'
    // -- Loop restarts --
    // 4. Review (2nd run): 'commit'

    mockSelect
      .mockResolvedValueOnce('generate') // 1
      .mockResolvedValueOnce('switch') // 2 (Changed from 'regenerate' to 'switch')
      .mockResolvedValueOnce('gemini-2.5-pro') // 3
      .mockResolvedValueOnce('commit'); // 4

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Gemini should be called twice
    expect(mockGeminiService.generate).toHaveBeenCalledTimes(2);
    expect(mockListModels).toHaveBeenCalled();
    // Git commit called once
    expect(mockGitService.commitChanges).toHaveBeenCalled();
  });

  test('Should handle Regenerate with Hint flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: msg',
      usage: {},
    });

    // Flow: 'generate' -> 'regenerate-hint' -> enter hint -> 'commit'
    mockSelect
      .mockResolvedValueOnce('generate')
      .mockResolvedValueOnce('regenerate-hint')
      .mockResolvedValueOnce('commit');
    mockText.mockResolvedValue('make it shorter');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Verify hint was passed to context service in second call
    expect(mockContextService.constructLLMPromptContext).toHaveBeenCalledTimes(2);
    expect(mockContextService.constructLLMPromptContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userHint: 'make it shorter',
      }),
    );
  });

  test('Should save session on successful commit', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: msg',
      usage: {},
    });

    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration(['--model', 'gemini-special'], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Verify session was saved with the model used
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: 'gemini-special' }),
    );
  });

  test('Should use the session model for the active provider', async () => {
    mockLoadSession.mockResolvedValueOnce({
      providerId: 'gemini',
      modelName: 'gemini-2.5-flash',
      outputMode: null,
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.generate.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test: msg',
      usage: {},
    });
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    expect(mockGeminiService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ modelOverride: 'gemini-2.5-flash' }) as unknown,
      }),
    );
  });

  test('Should perform auto-retry on truncated response', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });

    // First call returns full (internal retry logic is handled by the client/service)
    mockGeminiService.generate.mockResolvedValueOnce({
      text: 'COMMIT_MESSAGE: test: full message',
      truncated: false,
      usage: { outputTokens: 20, promptTokens: 10 },
    });

    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as unknown as Logger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      geminiModelLister: mockListModels,
    });

    // Gemini should be called once with retryIfTruncated flag
    expect(mockGeminiService.generate).toHaveBeenCalledTimes(1);
    expect(mockGeminiService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ retryIfTruncated: true }) as unknown,
      }),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining('full message'),
      expect.any(String),
    );
  });
});
