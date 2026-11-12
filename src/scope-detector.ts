import { hasText } from './utils.js';

export interface CommitContextHints {
  scopeSuggestions: string[];
  recentCommitSubjects: string[];
}

export interface CommitContextFacts {
  scopeHistorySubjects: string[];
  recentSubjects: string[];
  repoType: 'monorepo' | 'single';
}

export const WORKSPACE_PATH_PATTERN =
  /^(?:apps|packages)\/(?<workspace>[^\/]+)/v;
const BUILD_FILE_PATTERN =
  /^(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|tsconfig\.json)$/v;
const COMMIT_SCOPE_PATTERN = /^[a-z][a-z0-9\-]*\((?<scope>[^\)]+)\)!?:/v;
const MAX_RECENT_SUBJECTS = 10;
const MIN_SCOPED_PATH_PARTS = 3;

function getPathScope(
  file: string,
  repoType: CommitContextFacts['repoType'],
): string | null {
  if (repoType === 'monorepo') {
    const workspace = WORKSPACE_PATH_PATTERN.exec(file);
    const workspaceName = workspace?.groups?.workspace;
    if (workspaceName !== undefined) {
      return workspaceName;
    }
  }
  if (file.startsWith('.github/')) {
    return 'ci';
  }
  if (BUILD_FILE_PATTERN.test(file)) {
    return 'build';
  }
  const parts = file.split('/');
  return parts[0] === 'src' && parts.length >= MIN_SCOPED_PATH_PARTS
    ? (parts[1] ?? null)
    : null;
}

function collectScopes(
  changedFiles: string[],
  facts: CommitContextFacts,
): string[] {
  const scopes = new Set<string>();
  for (const subject of facts.scopeHistorySubjects) {
    const scope = COMMIT_SCOPE_PATTERN.exec(subject)?.groups?.scope.trim();
    if (hasText(scope)) {
      scopes.add(scope);
    }
  }
  for (const file of changedFiles) {
    const scope = getPathScope(file, facts.repoType);
    if (scope !== null) {
      scopes.add(scope);
    }
  }
  return [...scopes];
}

function collectRecentSubjects(lines: string[]): string[] {
  const subjects = new Set<string>();
  for (const line of lines) {
    const subject = line.trim();
    if (subject !== '') {
      subjects.add(subject);
    }
    if (subjects.size === MAX_RECENT_SUBJECTS) {
      break;
    }
  }
  return [...subjects];
}

export function getCommitContextHints(
  changedFiles: string[],
  facts: CommitContextFacts,
): CommitContextHints {
  if (changedFiles.length === 0) {
    return { scopeSuggestions: [], recentCommitSubjects: [] };
  }
  return {
    scopeSuggestions: collectScopes(changedFiles, facts),
    recentCommitSubjects: collectRecentSubjects(facts.recentSubjects),
  };
}
