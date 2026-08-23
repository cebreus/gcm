export interface CommitContextHints {
  scopeSuggestions: string[];
  recentCommitSubjects: string[];
}

export interface CommitContextFacts {
  scopeHistorySubjects: string[];
  recentSubjects: string[];
  repoType: 'monorepo' | 'single';
}

function getPathScope(file: string, repoType: CommitContextFacts['repoType']): string | null {
  if (repoType === 'monorepo') {
    const workspace = /^(apps|packages|sites|tools)\/([^/]+)/.exec(file);
    if (workspace?.[2]) return workspace[2];
  }
  if (file.startsWith('.github/')) return 'ci';
  if (/^(infra|scripts)\//.test(file)) return 'dx';
  if (/^(package\.json|pnpm-lock\.yaml|bun\.lock|tsconfig\.json)$/.test(file)) return 'build';
  const parts = file.split('/');
  return parts[0] === 'src' && parts.length > 1 ? (parts[1] ?? null) : null;
}

export function getCommitContextHints(
  changedFiles: string[],
  facts: CommitContextFacts,
): CommitContextHints {
  if (changedFiles.length === 0) return { scopeSuggestions: [], recentCommitSubjects: [] };
  const scopes = new Set<string>();
  for (const subject of facts.scopeHistorySubjects) {
    const scope = /^[a-z]+\(([^)]+)\):/.exec(subject)?.[1]?.trim();
    if (scope) scopes.add(scope);
  }
  for (const file of changedFiles) {
    const scope = getPathScope(file, facts.repoType);
    if (scope) scopes.add(scope);
  }
  const subjects = new Set<string>();
  for (const line of facts.recentSubjects) {
    const subject = line.trim();
    if (subject) subjects.add(subject);
    if (subjects.size === 10) break;
  }
  return { scopeSuggestions: [...scopes], recentCommitSubjects: [...subjects] };
}
