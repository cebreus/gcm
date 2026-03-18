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

export function parseGeminiOutput(text: string): Labels {
  if (!text || typeof text !== 'string') throw new Error('parseGeminiOutput expects a string');

  // Add a sanity limit to prevent parsing excessively large responses
  const MAX_RESPONSE_SIZE = 16 * 1024 * 1024; // 16MB
  if (text.length > MAX_RESPONSE_SIZE) {
    text = text.substring(0, MAX_RESPONSE_SIZE);
  }

  const labels: Labels = { BRANCH: '', COMMIT_MESSAGE: '', PR_TITLE: '', PR_DESCRIPTION: '' };
  const lines = text.split(/\r?\n/);
  const parsedLabels = parseLinesToLabels(lines);
  Object.assign(labels, parsedLabels);
  {
    const trimmed: Partial<Labels> = {};
    for (const k of Object.keys(labels) as Array<keyof Labels>) {
      trimmed[k] = labels[k].trim();
    }
    Object.assign(labels, trimmed);
  }

  labels.COMMIT_MESSAGE = formatCommitMessage(labels.COMMIT_MESSAGE);

  if (!labels.BRANCH || !labels.COMMIT_MESSAGE) {
    throw new Error('LLM output missing required BRANCH or COMMIT_MESSAGE fields');
  }
  function isValidBranchName(b: string): boolean {
    return /^\w+\/[a-z0-9_.-]+$/i.test(b);
  }
  if (typeof labels.BRANCH === 'string' && !isValidBranchName(labels.BRANCH)) {
    // Sanitize the branch name as a fallback
    const sanitized = labels.BRANCH.replace(/[^a-zA-Z0-9/_-]/g, '-').toLowerCase();
    labels.BRANCH = sanitized;
  }
  return labels;
}
