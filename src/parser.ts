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
  // Parses the labeled response format into an object with keys BRANCH, COMMIT_MESSAGE, PR_TITLE, PR_DESCRIPTION
  if (!text || typeof text !== 'string') throw new Error('parseGeminiOutput expects a string');
  const labels: Labels = { BRANCH: '', COMMIT_MESSAGE: '', PR_TITLE: '', PR_DESCRIPTION: '' };
  const lines = text.split(/\r?\n/);
  const parsedLabels = parseLinesToLabels(lines);
  Object.assign(labels, parsedLabels);
  // Trim each
  {
    const trimmed: Partial<Labels> = {};
    for (const k of Object.keys(labels) as Array<keyof Labels>) {
      trimmed[k] = labels[k].trim();
    }
    Object.assign(labels, trimmed);
  }
  // Validate minimum output
  if (!labels.BRANCH || !labels.COMMIT_MESSAGE) {
    throw new Error('LLM output missing required BRANCH or COMMIT_MESSAGE fields');
  }
  // Some validation of branch name format; not enforced but helpful to callers
  function isValidBranchName(b: string): boolean {
    return /^\w+\/[a-z0-9_.-]+$/i.test(b);
  }
  if (typeof labels.BRANCH === 'string' && !isValidBranchName(labels.BRANCH)) {
    // not strictly enforced
  }
  return labels;
}
