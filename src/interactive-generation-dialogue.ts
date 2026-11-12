import {
  buildAtomicSplitProposal,
  detectAtomicGroup,
} from './atomic-commit-planner.js';
import {
  CHANGESET_SKIP_REASONS,
  type ChangesetSkipReason,
} from './auto-changeset.js';
import { describeExcludedPaths } from './commit-action-service.js';
import {
  getModelSelectionOptions,
  handleActionChoice,
  selectAction,
} from './interactive-review-actions.js';
import type { ModelSpec } from './model-registry.js';
import { hasText } from './utils.js';

export interface ProviderChoice {
  id: string;
  label: string;
}

export interface GenerationState {
  providerId: string;
  baselineModelName: string;
  modelName: string;
  nonInteractive?: boolean;
  print?: boolean;
  apply?: boolean;
  userHint?: string;
}

export interface ActionMenuResult {
  includeChangeset?: boolean;
  changesetReason?: ChangesetSkipReason;
  type: 'commit' | 'regenerate' | 'cancel';
  modelName: string;
  commitMessage: string;
  userHint?: string;
  exclusionsAcknowledged?: boolean;
}

export interface ReviewCommitCapability {
  allowed: boolean;
  mode: 'commit' | 'amend' | 'reword';
  reason?: string;
  target?: { subject: string };
  excludedPaths?: string[];
}

export interface PromptAdapter {
  select: (options: {
    message: string;
    options: PromptOption[];
  }) => Promise<unknown>;
  text: (options: {
    message: string;
    initialValue?: string;
    placeholder?: string;
  }) => Promise<unknown>;
  confirm: (options: {
    message: string;
    initialValue?: boolean;
  }) => Promise<unknown>;
  note: (message: string, title?: string) => void;
  outro: (message: string) => void;
  cancel: (message: string) => void;
  isCancel: (value: unknown) => boolean;
}

export interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

export interface DialogueDependencies {
  prompts: PromptAdapter;
  clipboard: { write: (message: string) => Promise<void> };
  models: () => Promise<ModelSpec[]>;
  providers: ProviderChoice[];
}

export interface InteractiveGenerationDialogue {
  configure: (
    state: GenerationState,
  ) => Promise<
    'continue' | 'exit' | { type: 'switch-provider'; providerId: string }
  >;
  handleEmptyStaging: (
    targetCommit: string | null,
    stagedFilesFromWorktree: readonly string[],
  ) => Promise<'retry' | 'cancel'>;
  recoverGeneration: (
    message: string,
  ) => Promise<
    'retry' | 'cancel' | { type: 'switch-model'; modelName: string }
  >;
  review: (params: {
    state: GenerationState;
    commitMessage: string;
    commitCapability: ReviewCommitCapability;
    changeset?: string | null;
  }) => Promise<ActionMenuResult>;
  confirmAtomicity: (
    stagedFiles: string[],
    targetCommit: string | null,
  ) => Promise<boolean>;
}

async function changeProvider(
  dependencies: DialogueDependencies,
  state: GenerationState,
): Promise<{ type: 'switch-provider'; providerId: string } | null> {
  const selectedProvider = await dependencies.prompts.select({
    message: 'Select AI Provider',
    options: dependencies.providers.map((provider) => ({
      value: provider.id,
      label: provider.label,
    })),
  });
  if (
    dependencies.prompts.isCancel(selectedProvider) ||
    selectedProvider === state.providerId
  ) {
    return null;
  }
  return { type: 'switch-provider', providerId: String(selectedProvider) };
}

async function changeModel(
  dependencies: DialogueDependencies,
  state: GenerationState,
): Promise<void> {
  const modelOptions = await getModelSelectionOptions(dependencies);
  const selectedModel = await dependencies.prompts.select({
    message: 'Select AI Model',
    options: modelOptions,
  });
  if (dependencies.prompts.isCancel(selectedModel)) {
    return;
  }
  const modelName = String(selectedModel);
  Object.assign(state, { baselineModelName: modelName, modelName });
}

async function handleConfigurationChange(
  action: unknown,
  dependencies: DialogueDependencies,
  state: GenerationState,
): Promise<{ type: 'switch-provider'; providerId: string } | null> {
  if (action === 'provider') {
    return await changeProvider(dependencies, state);
  }
  if (action === 'model') {
    await changeModel(dependencies, state);
  }
  return null;
}

function isChangesetSkipReason(value: unknown): value is ChangesetSkipReason {
  return CHANGESET_SKIP_REASONS.some((reason) => reason === value);
}

async function requestChangesetReason(
  prompts: PromptAdapter,
): Promise<ChangesetSkipReason | null> {
  const reason = await prompts.select({
    message: 'Why does this commit need no changeset?',
    options: CHANGESET_SKIP_REASONS.map((value) => ({ value, label: value })),
  });
  return prompts.isCancel(reason) || !isChangesetSkipReason(reason)
    ? null
    : reason;
}

type ReviewStep =
  | { type: 'repeat' }
  | { type: 'message'; message: string }
  | { type: 'result'; result: ActionMenuResult };

async function runReviewStep(options: {
  dependencies: DialogueDependencies;
  state: GenerationState;
  message: string;
  commitCapability: ReviewCommitCapability;
  changeset?: string | null;
}): Promise<ReviewStep> {
  const { dependencies, state, message, commitCapability, changeset } = options;
  const action = await selectAction(
    dependencies.prompts,
    commitCapability,
    changeset,
  );
  if (action === null || action === 'cancel') {
    dependencies.prompts.outro('Commit cancelled.');
    return {
      type: 'result',
      result: {
        type: 'cancel',
        modelName: state.modelName,
        commitMessage: message,
        userHint: state.userHint,
      },
    };
  }
  const actionResult = await handleActionChoice({
    action,
    message,
    state,
    dependencies,
    excludedPaths: commitCapability.excludedPaths ?? [],
  });
  if (actionResult.type === 'update-message') {
    return { type: 'message', message: actionResult.message };
  }
  if (actionResult.type === 'continue') {
    return { type: 'repeat' };
  }
  if (
    actionResult.result.type === 'commit' &&
    actionResult.result.includeChangeset !== true &&
    changeset !== undefined
  ) {
    const reason = await requestChangesetReason(dependencies.prompts);
    if (reason === null) {
      return { type: 'repeat' };
    }
    actionResult.result.changesetReason = reason;
  }
  return { type: 'result', result: actionResult.result };
}

function showReviewNotices(
  prompts: PromptAdapter,
  commitCapability: ReviewCommitCapability,
): void {
  if (!commitCapability.allowed && hasText(commitCapability.reason)) {
    prompts.note(commitCapability.reason, 'Commit unavailable');
  }
  if ((commitCapability.excludedPaths?.length ?? 0) > 0) {
    prompts.note(
      describeExcludedPaths(commitCapability.excludedPaths ?? []),
      'Commit warning',
    );
  }
}

export function createInteractiveGenerationDialogue(
  dependencies: DialogueDependencies,
): InteractiveGenerationDialogue {
  const { prompts } = dependencies;
  return {
    recoverGeneration: async (message) => {
      prompts.note(message, 'Details');
      const action = await prompts.select({
        message: 'What do you want to do?',
        options: [
          { value: 'retry', label: 'Try again' },
          { value: 'switch', label: 'Choose another model' },
          { value: 'cancel', label: 'Cancel' },
        ],
      });
      if (prompts.isCancel(action) || action === 'cancel') {
        return 'cancel';
      }
      if (action === 'retry') {
        return 'retry';
      }
      const selectedModel = await prompts.select({
        message: 'Select AI Model',
        options: await getModelSelectionOptions(dependencies),
      });
      if (prompts.isCancel(selectedModel)) {
        return 'cancel';
      }
      return { type: 'switch-model', modelName: String(selectedModel) };
    },
    handleEmptyStaging: async (targetCommit, stagedFilesFromWorktree) => {
      if (targetCommit !== null) {
        prompts.cancel(`No changes found in commit ${targetCommit}.`);
        return 'cancel';
      }

      const hasWorktreeChanges = stagedFilesFromWorktree.length > 0;
      const warningLines = hasWorktreeChanges
        ? [
            'No files are selected for commit (stage).',
            'Add files with `git add <files>`, then choose "Re-check changes".',
            'Or choose "Show split proposal" for a commit split suggestion.',
          ]
        : [
            'No files are selected for commit (stage).',
            'Worktree is clean. Create or change files, then add them with `git add`.',
          ];
      prompts.note(warningLines.join('\n'), 'TIP');

      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- user prompt sequence must remain ordered
        const action = await prompts.select({
          message: 'How do you want to proceed?',
          options: [
            { value: 'retry', label: 'Re-check changes' },
            ...(hasWorktreeChanges
              ? [{ value: 'split', label: 'Show split proposal' as const }]
              : []),
            { value: 'cancel', label: 'Cancel' },
          ],
        });
        if (prompts.isCancel(action) || action === 'cancel') {
          return 'cancel';
        }
        if (action === 'split') {
          prompts.note(
            buildAtomicSplitProposal(stagedFilesFromWorktree),
            'Atomic split proposal',
          );
          continue;
        }
        return 'retry';
      }
    },
    configure: async (state) => {
      for (;;) {
        const providerLabel =
          dependencies.providers.find(
            (provider) => provider.id === state.providerId,
          )?.label ?? state.providerId;
        // eslint-disable-next-line no-await-in-loop -- user prompt sequence must remain ordered
        const action = await prompts.select({
          message: `Settings: [Provider: ${providerLabel}] [Model: ${state.modelName}]`,
          options: [
            { value: 'generate', label: 'Generate' },
            ...(dependencies.providers.length > 1
              ? [
                  {
                    value: 'provider',
                    label: `Change Provider (Current: ${providerLabel})`,
                  },
                ]
              : []),
            {
              value: 'model',
              label: `Change Model (Current: ${state.modelName})`,
            },
            { value: 'exit', label: 'Exit' },
          ],
        });

        if (prompts.isCancel(action) || action === 'exit') {
          prompts.outro('Bye!');
          return 'exit';
        }
        if (action === 'generate') {
          return 'continue';
        }

        // eslint-disable-next-line no-await-in-loop -- configuration prompts follow ordered settings prompt
        const configurationChange = await handleConfigurationChange(
          action,
          dependencies,
          state,
        );
        if (configurationChange !== null) {
          return configurationChange;
        }
      }
    },
    review: async ({ state, commitMessage, commitCapability, changeset }) => {
      let finalMessage = commitMessage;
      showReviewNotices(prompts, commitCapability);

      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each review step depends on previous user action
        const step = await runReviewStep({
          dependencies,
          state,
          message: finalMessage,
          commitCapability,
          changeset,
        });
        if (step.type === 'message') {
          ({ message: finalMessage } = step);
          continue;
        }
        if (step.type === 'repeat') {
          continue;
        }
        return step.result;
      }
    },
    confirmAtomicity: async (stagedFiles, targetCommit) => {
      if (targetCommit !== null) {
        return true;
      }
      const stagedGroups = Array.from(
        new Set(stagedFiles.map(detectAtomicGroup)),
      );
      if (stagedGroups.length <= 1) {
        return true;
      }
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- user prompt sequence must remain ordered
        const action = await prompts.select({
          message: [
            `Staged files suggest multiple possible scopes: ${stagedGroups.join(', ')}.`,
            'Atomic commits are preferred; split unrelated changes unless this is one functional unit.',
          ].join('\n'),
          options: [
            { value: 'continue', label: 'Continue anyway' },
            { value: 'split', label: 'Show split proposal' },
            { value: 'cancel', label: 'Cancel' },
          ],
        });
        if (prompts.isCancel(action) || action === 'cancel') {
          prompts.outro('Commit cancelled.');
          return false;
        }
        if (action === 'continue') {
          return true;
        }
        prompts.note(
          buildAtomicSplitProposal(stagedFiles, false),
          'Atomic split proposal',
        );
      }
    },
  };
}
