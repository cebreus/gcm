import type { Logger } from './logger.js';
import { KNOWN_MODELS } from './model-registry.js';
import { buildAtomicSplitProposal, detectAtomicGroup } from './atomic-commit-planner.js';
import { describeExcludedPaths } from './commit-action-service.js';
import { stripTerminalControlSequences } from './utils.js';

export interface GenerationState {
  baselineModelName: string;
  modelName: string;
  outputMode: 'full' | 'commit-only';
  userHint?: string;
}

export interface ActionMenuResult {
  type: 'commit' | 'regenerate' | 'cancel';
  modelName: string;
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
  select(options: { message: string; options: PromptOption[] }): Promise<unknown>;
  text(options: { message: string; initialValue?: string; placeholder?: string }): Promise<unknown>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<unknown>;
  note(message: string, title?: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
}

interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

export interface DialogueDependencies {
  prompts: PromptAdapter;
  clipboard: { write(message: string): Promise<void> };
  listModels(apiKey: string): Promise<string[]>;
  logger: Pick<Logger, 'log'>;
}

interface CommitMessageResult {
  COMMIT_MESSAGE: string;
}

export interface InteractiveGenerationDialogue {
  configure(state: GenerationState, apiKey: string): Promise<'continue' | 'exit'>;
  handleEmptyStaging(
    targetCommit: string | null,
    stagedFilesFromWorktree: readonly string[],
  ): Promise<'retry' | 'cancel'>;
  review(params: {
    state: GenerationState;
    result: CommitMessageResult;
    apiKey: string;
    commitCapability: ReviewCommitCapability;
  }): Promise<ActionMenuResult>;
  confirmAtomicity(stagedFiles: string[], targetCommit: string | null): Promise<boolean>;
}

type ActionChoice =
  'commit' | 'copy' | 'edit' | 'regenerate' | 'regenerate-hint' | 'switch' | 'cancel';

function toModelOption(name: string): PromptOption {
  const normalizedName = name.replace(/^models\//, '');
  const knownModel = KNOWN_MODELS.find(function (model) {
    return model.name === normalizedName;
  });

  if (knownModel) {
    return {
      value: knownModel.name,
      label: knownModel.label,
      hint: knownModel.description,
    };
  }

  return {
    value: normalizedName,
    label: normalizedName,
    hint: 'Available from Gemini API',
  };
}

function isSelectableTextModel(name: string): boolean {
  return !/(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen)/i.test(name);
}

async function getModelSelectionOptions(
  apiKey: string,
  dependencies: DialogueDependencies,
): Promise<PromptOption[]> {
  try {
    const apiModels = await dependencies.listModels(apiKey);
    const uniqueModels = [
      ...new Set(
        apiModels.map(function (name) {
          return name.replace(/^models\//, '');
        }),
      ),
    ]
      .filter(function (name) {
        return name.startsWith('gemini-');
      })
      .filter(isSelectableTextModel);

    if (uniqueModels.length > 0) return uniqueModels.map(toModelOption);
  } catch (error) {
    dependencies.logger.log(
      'debug',
      'Failed to load live Gemini model list; falling back to known models',
      {
        error: String(error),
      },
    );
  }

  return KNOWN_MODELS.map(function (model) {
    return { value: model.name, label: model.label, hint: model.description };
  });
}

function commitActionLabel(commitCapability: ReviewCommitCapability): string {
  const subject = stripTerminalControlSequences(commitCapability.target?.subject ?? '');
  if (commitCapability.mode === 'amend') return `Amend HEAD (${subject})`;
  if (commitCapability.mode === 'reword') {
    return `Reword via amend! commit; manual rebase required (${subject})`;
  }
  return 'Commit';
}

async function selectAction(
  prompts: PromptAdapter,
  commitCapability: ReviewCommitCapability,
): Promise<ActionChoice | null> {
  const options: PromptOption[] = [];
  if (commitCapability.allowed) {
    options.push({ value: 'commit', label: commitActionLabel(commitCapability) });
  }
  options.push(
    { value: 'copy', label: 'Copy to clipboard' },
    { value: 'edit', label: 'Edit message' },
    { value: 'regenerate', label: 'Regenerate (same model)' },
    { value: 'regenerate-hint', label: 'Regenerate with Hint...' },
    { value: 'switch', label: 'Switch Model & Regenerate' },
    { value: 'cancel', label: 'Cancel' },
  );
  const action = await prompts.select({ message: 'What would you like to do?', options });
  if (prompts.isCancel(action)) return null;
  return action as ActionChoice;
}

async function copyMessage(
  prompts: PromptAdapter,
  clipboard: DialogueDependencies['clipboard'],
  message: string,
): Promise<void> {
  try {
    await clipboard.write(message);
    prompts.note('Commit message copied to clipboard!', 'Success');
  } catch (error) {
    prompts.note(`Failed to copy to clipboard: ${error}`, 'Error');
  }
}

async function editMessage(prompts: PromptAdapter, message: string): Promise<string> {
  const edited = await prompts.text({
    message: 'Edit commit message',
    initialValue: message,
    placeholder: 'Enter commit message',
  });
  if (prompts.isCancel(edited)) return message;
  const updated = String(edited);
  prompts.note(updated, 'Updated Commit Message');
  return updated;
}

type ReviewActionResult =
  | { type: 'continue' }
  | { type: 'update-message'; message: string }
  | { type: 'return'; result: ActionMenuResult };

async function confirmExcludedPathCommit(
  prompts: PromptAdapter,
  excludedPaths: string[],
): Promise<boolean> {
  if (excludedPaths.length === 0) return true;
  const acknowledged = await prompts.confirm({
    message: `${describeExcludedPaths(excludedPaths)}\n\nCommit every staged path, including these excluded paths?`,
    initialValue: false,
  });
  return !prompts.isCancel(acknowledged) && acknowledged === true;
}

async function chooseRegeneration(
  action: 'regenerate' | 'regenerate-hint' | 'switch',
  state: GenerationState,
  apiKey: string,
  dependencies: DialogueDependencies,
): Promise<ReviewActionResult> {
  if (action === 'regenerate') {
    return {
      type: 'return',
      result: { type: 'regenerate', modelName: state.modelName, userHint: undefined },
    };
  }
  if (action === 'regenerate-hint') {
    const hint = await dependencies.prompts.text({
      message: 'Enter hint for regeneration (e.g. "emphasize refactoring")',
      placeholder: 'Add instructions...',
    });
    if (dependencies.prompts.isCancel(hint)) return { type: 'continue' };
    return {
      type: 'return',
      result: { type: 'regenerate', modelName: state.modelName, userHint: String(hint) },
    };
  }
  const modelOptions = await getModelSelectionOptions(apiKey, dependencies);
  const selectedModel = await dependencies.prompts.select({
    message: 'Select AI Model for Regeneration',
    options: modelOptions,
  });
  if (dependencies.prompts.isCancel(selectedModel)) return { type: 'continue' };
  return {
    type: 'return',
    result: { type: 'regenerate', modelName: String(selectedModel), userHint: undefined },
  };
}

async function handleActionChoice(params: {
  action: ActionChoice;
  message: string;
  result: CommitMessageResult;
  state: GenerationState;
  apiKey: string;
  dependencies: DialogueDependencies;
  excludedPaths: string[];
}): Promise<ReviewActionResult> {
  const { action, message, result, state, apiKey, dependencies, excludedPaths } = params;
  if (action === 'commit') {
    if (!(await confirmExcludedPathCommit(dependencies.prompts, excludedPaths))) {
      dependencies.prompts.outro('Commit cancelled.');
      return {
        type: 'return',
        result: { type: 'cancel', modelName: state.modelName, userHint: state.userHint },
      };
    }
    result.COMMIT_MESSAGE = message;
    return {
      type: 'return',
      result: {
        type: 'commit',
        modelName: state.modelName,
        userHint: state.userHint,
        ...(excludedPaths.length > 0 ? { exclusionsAcknowledged: true } : {}),
      },
    };
  }
  if (action === 'copy') {
    await copyMessage(dependencies.prompts, dependencies.clipboard, message);
    return { type: 'continue' };
  }
  if (action === 'edit')
    return { type: 'update-message', message: await editMessage(dependencies.prompts, message) };
  if (action === 'regenerate' || action === 'regenerate-hint' || action === 'switch') {
    return chooseRegeneration(action, state, apiKey, dependencies);
  }
  return { type: 'continue' };
}

export function createInteractiveGenerationDialogue(
  dependencies: DialogueDependencies,
): InteractiveGenerationDialogue {
  const { prompts } = dependencies;
  return {
    handleEmptyStaging: async function (targetCommit, stagedFilesFromWorktree) {
      if (targetCommit) {
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
        if (prompts.isCancel(action) || action === 'cancel') return 'cancel';
        if (action === 'split') {
          prompts.note(buildAtomicSplitProposal(stagedFilesFromWorktree), 'Atomic split proposal');
          continue;
        }
        return 'retry';
      }
    },
    configure: async function (state, apiKey) {
      for (;;) {
        const modeLabel = state.outputMode === 'full' ? 'Full Report' : 'Commit Msg Only';
        const action = await prompts.select({
          message: `Settings: [Model: ${state.modelName}] [Mode: ${modeLabel}]`,
          options: [
            { value: 'generate', label: 'Generate' },
            { value: 'configure', label: 'Configure...' },
            { value: 'exit', label: 'Exit' },
          ],
        });

        if (prompts.isCancel(action) || action === 'exit') {
          prompts.outro('Bye!');
          return 'exit';
        }
        if (action !== 'configure') return 'continue';

        const configAction = await prompts.select({
          message: 'Configure Settings',
          options: [
            { value: 'model', label: `Change Model (Current: ${state.modelName})` },
            { value: 'mode', label: `Change Mode (Current: ${state.outputMode})` },
            { value: 'back', label: 'Back' },
          ],
        });

        if (configAction === 'model') {
          const modelOptions = await getModelSelectionOptions(apiKey, dependencies);
          const selectedModel = await prompts.select({
            message: 'Select AI Model',
            options: modelOptions,
          });
          if (!prompts.isCancel(selectedModel)) {
            state.baselineModelName = String(selectedModel);
            state.modelName = state.baselineModelName;
          }
        } else if (configAction === 'mode') {
          const selectedMode = await prompts.select({
            message: 'Select Output Mode',
            options: [
              {
                value: 'commit-only',
                label: 'Commit Message Only (Default)',
                hint: 'Faster, concise',
              },
              { value: 'full', label: 'Full Report (Branch, PR)', hint: 'Detailed' },
            ],
          });
          if (!prompts.isCancel(selectedMode))
            state.outputMode = selectedMode as GenerationState['outputMode'];
        }
      }
    },
    review: async function ({ state, result, apiKey, commitCapability }) {
      let finalMessage = result.COMMIT_MESSAGE;
      if (!commitCapability.allowed && commitCapability.reason) {
        prompts.note(commitCapability.reason, 'Commit unavailable');
      }
      if (commitCapability.excludedPaths?.length) {
        prompts.note(describeExcludedPaths(commitCapability.excludedPaths), 'Commit warning');
      }

      for (;;) {
        const action = await selectAction(prompts, commitCapability);
        if (action === null || action === 'cancel') {
          prompts.outro('Commit cancelled.');
          return { type: 'cancel', modelName: state.modelName, userHint: state.userHint };
        }
        const actionResult = await handleActionChoice({
          action,
          message: finalMessage,
          result,
          state,
          apiKey,
          dependencies,
          excludedPaths: commitCapability.excludedPaths ?? [],
        });
        if (actionResult.type === 'update-message') {
          finalMessage = actionResult.message;
          continue;
        }
        if (actionResult.type === 'continue') continue;
        return actionResult.result;
      }
    },
    confirmAtomicity: async function (stagedFiles, targetCommit) {
      if (targetCommit) return true;
      const stagedGroups = Array.from(new Set(stagedFiles.map(detectAtomicGroup)));
      if (stagedGroups.length <= 1) return true;
      for (;;) {
        const action = await prompts.select({
          message: [
            `Staged files suggest multiple possible scopes: ${stagedGroups.join(', ')}.`,
            'Atomic commits are preferred; split unrelated changes unless this is one functional unit.',
          ].join('\n'),
          options: [
            { value: 'split', label: 'Show split proposal' },
            { value: 'continue', label: 'Continue anyway' },
            { value: 'cancel', label: 'Cancel' },
          ],
        });
        if (prompts.isCancel(action) || action === 'cancel') {
          prompts.outro('Commit cancelled.');
          return false;
        }
        if (action === 'continue') return true;
        prompts.note(buildAtomicSplitProposal(stagedFiles), 'Atomic split proposal');
      }
    },
  };
}
