import { describeExcludedPaths } from './commit-action-service.js';
import type {
  ActionMenuResult,
  DialogueDependencies,
  GenerationState,
  PromptAdapter,
  PromptOption,
  ReviewCommitCapability,
} from './interactive-generation-dialogue.js';
import type { ModelSpec } from './model-registry.js';
import { stripTerminalControlSequences } from './utils.js';

const ACTION_CHOICES = [
  'commit-with-changeset',
  'commit',
  'copy',
  'edit',
  'regenerate',
  'regenerate-hint',
  'switch',
  'cancel',
] as const;

export type ActionChoice = 'invalid' | (typeof ACTION_CHOICES)[number];

function toModelOption(model: ModelSpec): PromptOption {
  return {
    value: model.name,
    label: stripTerminalControlSequences(model.label).replace(
      /[\r\n\t]/gv,
      ' ',
    ),
  };
}

export async function getModelSelectionOptions(
  dependencies: DialogueDependencies,
): Promise<PromptOption[]> {
  const models = await dependencies.models();
  return models.map(toModelOption);
}

function commitActionLabel(commitCapability: ReviewCommitCapability): string {
  const subject = stripTerminalControlSequences(
    commitCapability.target?.subject ?? '',
  );
  if (commitCapability.mode === 'amend') {
    return `Amend HEAD (${subject})`;
  }
  if (commitCapability.mode === 'reword') {
    return `Reword via amend! commit; manual rebase required (${subject})`;
  }
  return 'Commit';
}

export async function selectAction(
  prompts: PromptAdapter,
  commitCapability: ReviewCommitCapability,
  changeset?: string | null,
): Promise<ActionChoice | null> {
  const options: PromptOption[] = [];
  if (commitCapability.allowed) {
    if (typeof changeset === 'string') {
      options.push({
        value: 'commit-with-changeset',
        label: 'Commit with changeset',
      });
    }
    options.push({
      value: 'commit',
      label:
        changeset === undefined
          ? commitActionLabel(commitCapability)
          : 'Commit without changeset',
    });
  }
  options.push(
    { value: 'copy', label: 'Copy to clipboard' },
    { value: 'edit', label: 'Edit message' },
    { value: 'regenerate', label: 'Regenerate (same model)' },
    { value: 'regenerate-hint', label: 'Regenerate with Hint...' },
    { value: 'switch', label: 'Switch Model & Regenerate' },
    { value: 'cancel', label: 'Cancel' },
  );
  const action = await prompts.select({
    message: 'What would you like to do?',
    options,
  });
  if (prompts.isCancel(action)) {
    return null;
  }
  return ACTION_CHOICES.find((choice) => choice === action) ?? 'invalid';
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
    prompts.note(`Failed to copy to clipboard: ${String(error)}`, 'Error');
  }
}

async function editMessage(
  prompts: PromptAdapter,
  message: string,
): Promise<string> {
  const edited = await prompts.text({
    message: 'Edit commit message',
    initialValue: message,
    placeholder: 'Enter commit message',
  });
  if (prompts.isCancel(edited)) {
    return message;
  }
  const updated = String(edited).trim();
  if (updated === '') {
    prompts.note(
      'Commit message cannot be empty. The previous message was kept.',
      'Error',
    );
    return message;
  }
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
  if (excludedPaths.length === 0) {
    return true;
  }
  const acknowledged = await prompts.confirm({
    message: `${describeExcludedPaths(excludedPaths)}\n\nCommit every staged path, including these excluded paths?`,
    initialValue: false,
  });
  return !prompts.isCancel(acknowledged) && acknowledged === true;
}

async function chooseRegeneration(
  action: 'regenerate' | 'regenerate-hint' | 'switch',
  state: GenerationState,
  message: string,
  dependencies: DialogueDependencies,
): Promise<ReviewActionResult> {
  if (action === 'regenerate') {
    return {
      type: 'return',
      result: {
        type: 'regenerate',
        modelName: state.modelName,
        commitMessage: message,
        userHint: undefined,
      },
    };
  }
  if (action === 'regenerate-hint') {
    const hint = await dependencies.prompts.text({
      message: 'Enter hint for regeneration (e.g. "emphasize refactoring")',
      placeholder: 'Add instructions...',
    });
    if (dependencies.prompts.isCancel(hint)) {
      return { type: 'continue' };
    }
    return {
      type: 'return',
      result: {
        type: 'regenerate',
        modelName: state.modelName,
        commitMessage: message,
        userHint: String(hint),
      },
    };
  }
  const modelOptions = await getModelSelectionOptions(dependencies);
  const selectedModel = await dependencies.prompts.select({
    message: 'Select AI Model for Regeneration',
    options: modelOptions,
  });
  if (dependencies.prompts.isCancel(selectedModel)) {
    return { type: 'continue' };
  }
  return {
    type: 'return',
    result: {
      type: 'regenerate',
      modelName: String(selectedModel),
      commitMessage: message,
      userHint: undefined,
    },
  };
}

export async function handleActionChoice(params: {
  action: ActionChoice;
  message: string;
  state: GenerationState;
  dependencies: DialogueDependencies;
  excludedPaths: string[];
}): Promise<ReviewActionResult> {
  const { action, message, state, dependencies, excludedPaths } = params;
  if (action === 'commit' || action === 'commit-with-changeset') {
    return await handleCommitAction({
      action,
      message,
      state,
      dependencies,
      excludedPaths,
    });
  }
  if (action === 'copy') {
    await copyMessage(dependencies.prompts, dependencies.clipboard, message);
    return { type: 'continue' };
  }
  if (action === 'edit') {
    return {
      type: 'update-message',
      message: await editMessage(dependencies.prompts, message),
    };
  }
  if (
    action === 'regenerate' ||
    action === 'regenerate-hint' ||
    action === 'switch'
  ) {
    return await chooseRegeneration(action, state, message, dependencies);
  }
  return { type: 'continue' };
}

async function handleCommitAction(params: {
  action: 'commit' | 'commit-with-changeset';
  message: string;
  state: GenerationState;
  dependencies: DialogueDependencies;
  excludedPaths: string[];
}): Promise<ReviewActionResult> {
  const { action, message, state, dependencies, excludedPaths } = params;
  const confirmed = await confirmExcludedPathCommit(
    dependencies.prompts,
    excludedPaths,
  );
  if (!confirmed) {
    dependencies.prompts.outro('Commit cancelled.');
    return {
      type: 'return',
      result: {
        type: 'cancel',
        modelName: state.modelName,
        commitMessage: message,
        userHint: state.userHint,
      },
    };
  }
  return {
    type: 'return',
    result: {
      type: 'commit',
      ...(action === 'commit-with-changeset' ? { includeChangeset: true } : {}),
      modelName: state.modelName,
      commitMessage: message,
      userHint: state.userHint,
      ...(excludedPaths.length > 0 ? { exclusionsAcknowledged: true } : {}),
    },
  };
}
