import { formatCommitMessage } from './utils.js';

export interface Labels {
  BRANCH: string;
  COMMIT_MESSAGE: string;
  PR_TITLE: string;
  PR_DESCRIPTION: string;
}

function parseLinesToLabels(lines: string[]): Labels {
  const labelRe = /^(BRANCH|COMMIT_MESSAGE|PR_TITLE|PR_DESCRIPTION)\s*(?::|-)\s*(.*)$/i;
  const labels: Labels = { BRANCH: '', COMMIT_MESSAGE: '', PR_TITLE: '', PR_DESCRIPTION: '' };
  let current: keyof Labels | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = labelRe.exec(line);
    if (m) {
      const [, labelKey, labelText] = m;
      current = labelKey.toUpperCase() as keyof Labels;
      labels[current] = labelText || '';
      continue;
    }
    if (current) {
      labels[current] += '\n' + line;
    }
  }
  return labels;
}

function trimLabels(labels: Labels): Labels {
  return {
    BRANCH: labels.BRANCH.trim(),
    COMMIT_MESSAGE: labels.COMMIT_MESSAGE.trim(),
    PR_TITLE: labels.PR_TITLE.trim(),
    PR_DESCRIPTION: labels.PR_DESCRIPTION.trim(),
  };
}

function ensureRequiredFields(labels: Labels, mode: 'full' | 'commit-only', text: string): Labels {
  if (mode === 'full') {
    if (!labels.BRANCH || !labels.COMMIT_MESSAGE) {
      throw new Error('LLM output missing required BRANCH or COMMIT_MESSAGE fields');
    }
    return labels;
  }

  if (labels.COMMIT_MESSAGE) return labels;
  if (!text.trim()) {
    throw new Error('LLM output missing required COMMIT_MESSAGE field');
  }
  return { ...labels, COMMIT_MESSAGE: formatCommitMessage(text.trim()) };
}

function sanitizeBranchName(branch: string): string {
  const isValidBranchName = /^\w+\/[a-z0-9_.-]+$/i.test(branch);
  if (isValidBranchName) return branch;
  return branch.replace(/[^a-zA-Z0-9/_-]/g, '-').toLowerCase();
}

export function parseLanguageModelOutput(
  text: string,
  mode: 'full' | 'commit-only' = 'full',
): Labels {
  if (!text || typeof text !== 'string') {
    throw new Error('parseLanguageModelOutput expects a string');
  }

  // Add a sanity limit to prevent parsing excessively large responses
  const MAX_RESPONSE_SIZE = 16 * 1024 * 1024; // 16MB
  if (text.length > MAX_RESPONSE_SIZE) {
    text = text.substring(0, MAX_RESPONSE_SIZE);
  }

  const lines = text.split(/\r?\n/);
  const parsedLabels = parseLinesToLabels(lines);
  const labels = trimLabels(parsedLabels);
  labels.COMMIT_MESSAGE = formatCommitMessage(labels.COMMIT_MESSAGE);
  const labelsWithRequiredFields = ensureRequiredFields(labels, mode, text);
  if (labelsWithRequiredFields.BRANCH) {
    labelsWithRequiredFields.BRANCH = sanitizeBranchName(labelsWithRequiredFields.BRANCH);
  }
  return labelsWithRequiredFields;
}
