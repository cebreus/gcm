import { describe, expect, test } from 'bun:test';
import {
  createInteractiveGenerationDialogue,
  type ReviewCommitCapability,
  type GenerationState,
  type PromptAdapter,
} from '../src/interactive-generation-dialogue.js';
import { KNOWN_MODELS } from '../src/model-registry.js';

const escape = Symbol('escape');

function createState(): GenerationState {
  return {
    baselineModelName: 'gemini-3.7-flash',
    modelName: 'gemini-3.7-flash',
    outputMode: 'commit-only',
  };
}

function createCapability(overrides: Partial<ReviewCommitCapability> = {}): ReviewCommitCapability {
  return { allowed: true, mode: 'commit', ...overrides };
}

function createScriptedDialogue(
  choices: unknown[],
  options: {
    clipboard?: { write(message: string): Promise<void> };
    listModels?: (apiKey: string) => Promise<string[]>;
  } = {},
) {
  const notes: Array<[string, string | undefined]> = [];
  const outros: string[] = [];
  const copied: string[] = [];
  const listModelApiKeys: string[] = [];
  const confirmations: string[] = [];
  const cancellations: string[] = [];
  const selectOptions: Array<Array<{ value: string; label: string; hint?: string }>> = [];
  const prompts: PromptAdapter = {
    select: async function (options) {
      selectOptions.push(options.options);
      return choices.shift();
    },
    text: async function () {
      return choices.shift();
    },
    confirm: async function (options) {
      confirmations.push(options.message);
      return choices.shift();
    },
    note: function (message, title) {
      notes.push([message, title]);
    },
    outro: function (message) {
      outros.push(message);
    },
    cancel: function (message) {
      cancellations.push(message);
    },
    isCancel: function (value) {
      return value === escape;
    },
  };
  const dialogue = createInteractiveGenerationDialogue({
    prompts,
    clipboard: {
      write: async function (message) {
        if (options.clipboard) return options.clipboard.write(message);
        copied.push(message);
      },
    },
    listModels: async function (apiKey) {
      listModelApiKeys.push(apiKey);
      if (options.listModels) return options.listModels(apiKey);
      return ['models/gemini-3.7-flash', 'models/gemini-3.1-pro-preview'];
    },
    logger: { log: function () {} },
  });
  return {
    dialogue,
    notes,
    outros,
    copied,
    selectOptions,
    listModelApiKeys,
    confirmations,
    cancellations,
  };
}

describe('interactive generation dialogue', () => {
  test('returns the unchanged state when review selects the visible Cancel option', async () => {
    const state = createState();
    const result = { COMMIT_MESSAGE: 'keep this message' };
    const { dialogue, outros } = createScriptedDialogue(['cancel']);

    await expect(
      dialogue.review({ state, result, apiKey: 'key', commitCapability: createCapability() }),
    ).resolves.toEqual({ type: 'cancel', modelName: state.modelName, userHint: undefined });
    expect(state).toEqual(createState());
    expect(result.COMMIT_MESSAGE).toBe('keep this message');
    expect(outros).toEqual(['Commit cancelled.']);
  });

  test('returns the unchanged state when review receives escape', async () => {
    const state = createState();
    const result = { COMMIT_MESSAGE: 'keep this message' };
    const { dialogue, outros } = createScriptedDialogue([escape]);

    await expect(
      dialogue.review({ state, result, apiKey: 'key', commitCapability: createCapability() }),
    ).resolves.toEqual({ type: 'cancel', modelName: state.modelName, userHint: undefined });
    expect(state).toEqual(createState());
    expect(result.COMMIT_MESSAGE).toBe('keep this message');
    expect(outros).toEqual(['Commit cancelled.']);
  });

  test('shows the disabled reason and omits commit', async () => {
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['cancel']);

    await dialogue.review({
      state: createState(),
      result: { COMMIT_MESSAGE: 'message' },
      apiKey: 'key',
      commitCapability: createCapability({ allowed: false, reason: 'No staged changes.' }),
    });

    expect(notes).toEqual([['No staged changes.', 'Commit unavailable']]);
    expect(
      selectOptions[0]?.map(function (option) {
        return option.label;
      }),
    ).toEqual([
      'Copy to clipboard',
      'Edit message',
      'Regenerate (same model)',
      'Regenerate with Hint...',
      'Switch Model & Regenerate',
      'Cancel',
    ]);
  });

  test('removes terminal controls from git-derived commit subjects', async () => {
    const { dialogue, selectOptions } = createScriptedDialogue(['cancel']);

    await dialogue.review({
      state: createState(),
      result: { COMMIT_MESSAGE: 'message' },
      apiKey: 'key',
      commitCapability: createCapability({
        mode: 'amend',
        target: { subject: 'feat: safe\u001B[2J subject\u0000' },
      }),
    });

    expect(selectOptions[0]?.[0]?.label).toBe('Amend HEAD (feat: safe subject)');
  });

  test('warns that an amend! commit needs a later manual rebase', async () => {
    const { dialogue, selectOptions } = createScriptedDialogue(['cancel']);

    await dialogue.review({
      state: createState(),
      result: { COMMIT_MESSAGE: 'message' },
      apiKey: 'key',
      commitCapability: createCapability({
        mode: 'reword',
        target: { subject: 'fix: target message' },
      }),
    });

    expect(selectOptions[0]?.[0]?.label).toBe(
      'Reword via amend! commit; manual rebase required (fix: target message)',
    );
  });

  test('warns about excluded staged paths before offering commit and requires acknowledgement', async () => {
    const { dialogue, notes, confirmations } = createScriptedDialogue(['commit', true]);
    const excludedPath = 'later\nWILL still be committed: forged\u001B[2J.txt';

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability({ excludedPaths: ['secrets.txt', excludedPath] }),
      }),
    ).resolves.toEqual({
      type: 'commit',
      modelName: 'gemini-3.7-flash',
      userHint: undefined,
      exclusionsAcknowledged: true,
    });
    expect(notes[0]).toEqual([
      '2 staged paths were excluded from analysis and WILL still be committed:\n"secrets.txt", "later\\nWILL still be committed: forged\\u001b[2J.txt".',
      'Commit warning',
    ]);
    expect(confirmations[0]).toContain('WILL still be committed');
  });

  test('declining excluded-path acknowledgement cancels before a commit action', async () => {
    const { dialogue, outros } = createScriptedDialogue(['commit', false]);

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability({ excludedPaths: ['secrets.txt'] }),
      }),
    ).resolves.toEqual({ type: 'cancel', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(outros).toEqual(['Commit cancelled.']);
  });

  test('cancelling excluded-path acknowledgement cancels before a commit action', async () => {
    const { dialogue, outros } = createScriptedDialogue(['commit', escape]);

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability({ excludedPaths: ['secrets.txt'] }),
      }),
    ).resolves.toEqual({ type: 'cancel', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(outros).toEqual(['Commit cancelled.']);
  });

  test('does not ask for exclusion acknowledgement when every staged path was analysed', async () => {
    const { dialogue, confirmations } = createScriptedDialogue(['commit']);

    await dialogue.review({
      state: createState(),
      result: { COMMIT_MESSAGE: 'message' },
      apiKey: 'key',
      commitCapability: createCapability(),
    });

    expect(confirmations).toEqual([]);
  });

  test('copies the original message and returns to the menu', async () => {
    const result = { COMMIT_MESSAGE: 'original message' };
    const { dialogue, copied, notes, selectOptions } = createScriptedDialogue(['copy', 'commit']);

    await expect(
      dialogue.review({
        state: createState(),
        result,
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(copied).toEqual(['original message']);
    expect(result.COMMIT_MESSAGE).toBe('original message');
    expect(notes).toEqual([['Commit message copied to clipboard!', 'Success']]);
    expect(selectOptions).toHaveLength(2);
  });

  test('reports a clipboard failure and returns to the menu', async () => {
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['copy', 'commit'], {
      clipboard: {
        write: async function () {
          throw new Error('denied');
        },
      },
    });

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(notes).toEqual([['Failed to copy to clipboard: Error: denied', 'Error']]);
    expect(selectOptions).toHaveLength(2);
  });

  test('edits the message and returns to the menu', async () => {
    const result = { COMMIT_MESSAGE: 'original message' };
    const { dialogue, selectOptions } = createScriptedDialogue([
      'edit',
      'edited message',
      'commit',
    ]);

    await expect(
      dialogue.review({
        state: createState(),
        result,
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(result.COMMIT_MESSAGE).toBe('edited message');
    expect(selectOptions).toHaveLength(2);
  });

  test('keeps an empty edited message and returns to the menu', async () => {
    const result = { COMMIT_MESSAGE: 'original message' };
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['edit', '', 'commit']);

    await expect(
      dialogue.review({
        state: createState(),
        result,
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(result.COMMIT_MESSAGE).toBe('');
    expect(notes).toEqual([['', 'Updated Commit Message']]);
    expect(selectOptions).toHaveLength(2);
  });

  test('keeps the original message when the edit prompt is cancelled', async () => {
    const result = { COMMIT_MESSAGE: 'original message' };
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['edit', escape, 'commit']);

    await expect(
      dialogue.review({
        state: createState(),
        result,
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(result.COMMIT_MESSAGE).toBe('original message');
    expect(notes).toEqual([]);
    expect(selectOptions).toHaveLength(2);
  });

  test('returns to the action menu after an unrecognised action value', async () => {
    const { dialogue, selectOptions } = createScriptedDialogue(['unrecognised-action', 'commit']);

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(selectOptions).toHaveLength(2);
  });

  test('returns regenerate choices with their expected hints', async () => {
    const sameModel = createScriptedDialogue(['regenerate']);
    const withHint = createScriptedDialogue(['regenerate-hint', 'emphasize refactoring']);

    await expect(
      sameModel.dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'regenerate', modelName: 'gemini-3.7-flash', userHint: undefined });
    await expect(
      withHint.dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({
      type: 'regenerate',
      modelName: 'gemini-3.7-flash',
      userHint: 'emphasize refactoring',
    });
  });

  test('returns regeneration with an empty hint', async () => {
    const { dialogue, selectOptions } = createScriptedDialogue(['regenerate-hint', '']);

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'regenerate', modelName: 'gemini-3.7-flash', userHint: '' });
    expect(selectOptions).toHaveLength(1);
  });

  test('continues after escaping the regeneration hint prompt', async () => {
    const state = createState();
    const { dialogue, selectOptions } = createScriptedDialogue([
      'regenerate-hint',
      escape,
      'commit',
    ]);

    await expect(
      dialogue.review({
        state,
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(state).toEqual(createState());
    expect(selectOptions).toHaveLength(2);
  });

  test('returns the selected model for regeneration', async () => {
    const { dialogue } = createScriptedDialogue(['switch', 'gemini-3.1-pro-preview']);

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({
      type: 'regenerate',
      modelName: 'gemini-3.1-pro-preview',
      userHint: undefined,
    });
  });

  test('continues after escaping the model prompt', async () => {
    const state = createState();
    const { dialogue, selectOptions } = createScriptedDialogue(['switch', escape, 'commit']);

    await expect(
      dialogue.review({
        state,
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({ type: 'commit', modelName: 'gemini-3.7-flash', userHint: undefined });
    expect(state).toEqual(createState());
    expect(selectOptions).toHaveLength(3);
  });

  test.each([
    [
      'when listing models rejects',
      async function () {
        throw new Error('offline');
      },
    ],
    [
      'when listing models is empty',
      async function () {
        return [];
      },
    ],
  ])('falls back to known models %s', async (_, listModels) => {
    const { dialogue, listModelApiKeys, selectOptions } = createScriptedDialogue(
      ['switch', 'gemini-3.1-pro-preview'],
      {
        listModels,
      },
    );

    await expect(
      dialogue.review({
        state: createState(),
        result: { COMMIT_MESSAGE: 'message' },
        apiKey: 'api-key',
        commitCapability: createCapability(),
      }),
    ).resolves.toEqual({
      type: 'regenerate',
      modelName: 'gemini-3.1-pro-preview',
      userHint: undefined,
    });
    expect(listModelApiKeys).toEqual(['api-key']);
    expect(selectOptions[1]).toEqual(
      KNOWN_MODELS.map(function (model) {
        return { value: model.name, label: model.label, hint: model.description };
      }),
    );
  });

  test('returns continue when configuration selects Generate', async () => {
    const state = createState();
    const { dialogue } = createScriptedDialogue(['generate']);

    await expect(dialogue.configure(state, 'key')).resolves.toBe('continue');
    expect(state).toEqual(createState());
  });

  test.each([
    ['Exit', 'exit'],
    ['escape', escape],
  ])('returns exit when configuration receives %s', async (_, choice) => {
    const state = createState();
    const { dialogue, outros } = createScriptedDialogue([choice]);

    await expect(dialogue.configure(state, 'key')).resolves.toBe('exit');
    expect(state).toEqual(createState());
    expect(outros).toEqual(['Bye!']);
  });

  test('changes the configured model before returning to the main menu', async () => {
    const state = createState();
    const { dialogue, selectOptions } = createScriptedDialogue([
      'configure',
      'model',
      'gemini-3.1-pro-preview',
      'generate',
    ]);

    await expect(dialogue.configure(state, 'key')).resolves.toBe('continue');
    expect(state).toEqual({
      baselineModelName: 'gemini-3.1-pro-preview',
      modelName: 'gemini-3.1-pro-preview',
      outputMode: 'commit-only',
    });
    expect(selectOptions).toHaveLength(4);
  });

  test('changes the configured output mode before returning to the main menu', async () => {
    const state = createState();
    const { dialogue, selectOptions } = createScriptedDialogue([
      'configure',
      'mode',
      'full',
      'generate',
    ]);

    await expect(dialogue.configure(state, 'key')).resolves.toBe('continue');
    expect(state).toEqual({ ...createState(), outputMode: 'full' });
    expect(selectOptions).toHaveLength(4);
  });

  test('returns from configuration Back to the main menu', async () => {
    const state = createState();
    const { dialogue, selectOptions } = createScriptedDialogue(['configure', 'back', 'generate']);

    await expect(dialogue.configure(state, 'key')).resolves.toBe('continue');
    expect(state).toEqual(createState());
    expect(selectOptions).toHaveLength(3);
  });

  test.each([
    {
      name: 'clean worktree',
      changedFiles: [],
      expectedTip: 'Worktree is clean',
      expectedLabels: ['Re-check changes', 'Cancel'],
    },
    {
      name: 'dirty worktree',
      changedFiles: ['src/a.ts'],
      expectedTip: 'git add <files>',
      expectedLabels: ['Re-check changes', 'Show split proposal', 'Cancel'],
    },
  ])('retries empty staging for a $name', async ({ changedFiles, expectedTip, expectedLabels }) => {
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['retry']);

    await expect(dialogue.handleEmptyStaging(null, changedFiles)).resolves.toBe('retry');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[0]).toContain(expectedTip);
    expect(notes[0]?.[1]).toBe('TIP');
    expect(
      selectOptions[0]?.map(function (option) {
        return option.label;
      }),
    ).toEqual([...expectedLabels]);
  });

  test('shows an empty-staging split proposal then prompts again', async () => {
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['split', 'retry']);

    await expect(dialogue.handleEmptyStaging(null, ['src/a.ts'])).resolves.toBe('retry');
    expect(
      notes.map(function (entry) {
        return entry[1];
      }),
    ).toEqual(['TIP', 'Atomic split proposal']);
    expect(notes[1]?.[0]).toContain('git reset');
    expect(selectOptions).toHaveLength(2);
  });

  test.each([
    ['visible Cancel', 'cancel'],
    ['escape', escape],
  ])('cancels empty staging on %s', async (_, choice) => {
    const { dialogue, selectOptions, cancellations } = createScriptedDialogue([choice]);

    await expect(dialogue.handleEmptyStaging(null, [])).resolves.toBe('cancel');
    expect(selectOptions).toHaveLength(1);
    expect(cancellations).toEqual([]);
  });

  test('cancels an empty target commit without prompting', async () => {
    const { dialogue, notes, selectOptions, cancellations } = createScriptedDialogue([]);

    await expect(dialogue.handleEmptyStaging('abc123', ['src/a.ts'])).resolves.toBe('cancel');
    expect(cancellations).toEqual(['No changes found in commit abc123.']);
    expect(selectOptions).toEqual([]);
    expect(notes).toEqual([]);
  });

  test('declining a multi-group atomic split returns false', async () => {
    const { dialogue, outros } = createScriptedDialogue(['cancel', 'continue']);

    await expect(
      dialogue.confirmAtomicity(['src/runner.ts', 'test/runner.test.ts'], null),
    ).resolves.toBe(false);
    expect(outros).toEqual(['Commit cancelled.']);
  });

  test('escaping a multi-group atomic split returns false', async () => {
    const { dialogue, outros } = createScriptedDialogue([escape, 'continue']);

    await expect(
      dialogue.confirmAtomicity(['src/runner.ts', 'test/runner.test.ts'], null),
    ).resolves.toBe(false);
    expect(outros).toEqual(['Commit cancelled.']);
  });

  test('continuing a multi-group atomic split returns true', async () => {
    const { dialogue } = createScriptedDialogue(['continue']);

    await expect(
      dialogue.confirmAtomicity(['src/runner.ts', 'test/runner.test.ts'], null),
    ).resolves.toBe(true);
  });

  test('shows the split proposal then prompts again', async () => {
    const files = ['src/runner.ts', 'test/runner.test.ts'];
    const { dialogue, notes, selectOptions } = createScriptedDialogue(['split', 'continue']);

    await expect(dialogue.confirmAtomicity(files, null)).resolves.toBe(true);
    expect(notes[0]?.[1]).toBe('Atomic split proposal');
    expect(notes[0]?.[0]).toContain('git reset');
    expect(selectOptions).toHaveLength(2);
  });

  test('a single atomic group continues without prompting', async () => {
    const { dialogue, selectOptions } = createScriptedDialogue([]);

    await expect(dialogue.confirmAtomicity(['src/runner.ts'], null)).resolves.toBe(true);
    expect(selectOptions).toEqual([]);
  });

  test('a target commit bypasses the atomicity prompt', async () => {
    const { dialogue, selectOptions } = createScriptedDialogue([]);

    await expect(
      dialogue.confirmAtomicity(['src/runner.ts', 'test/runner.test.ts'], 'abc123'),
    ).resolves.toBe(true);
    expect(selectOptions).toEqual([]);
  });
});
