import { spawnGitStream } from './git-utils.js';
import { detectRepoType } from './utils.js';

export interface CommitContextHints {
  scopeSuggestions: string[];
  recentCommitSubjects: string[];
}

async function getScopesFromHistory(files: string[], depth = 50): Promise<string[]> {
  if (!files.length) return [];
  try {
    const { text } = await spawnGitStream([
      'log',
      `-n`,
      `${depth}`,
      '--pretty=format:%s',
      '--',
      ...files,
    ]);

    const scopes = new Set<string>();
    const regex = /^[a-z]+\(([^)]+)\):/;

    for (const line of text.split('\n')) {
      const match = line.match(regex);
      if (match?.[1]) {
        scopes.add(match[1].trim());
      }
    }
    return Array.from(scopes);
  } catch {
    return [];
  }
}

async function getRecentCommitSubjects(files: string[], depth = 20, limit = 10): Promise<string[]> {
  if (!files.length) return [];
  try {
    const { text } = await spawnGitStream([
      'log',
      `-n`,
      `${depth}`,
      '--pretty=format:%s',
      '--',
      ...files,
    ]);

    const subjects = new Set<string>();
    for (const line of text.split('\n')) {
      const subject = line.trim();
      if (subject) subjects.add(subject);
      if (subjects.size >= limit) break;
    }
    return Array.from(subjects);
  } catch {
    return [];
  }
}

function getPathBasedScope(file: string, repoType: 'monorepo' | 'single'): string | null {
  if (repoType === 'monorepo') {
    const workspaceMatch = /^(apps|packages|sites|tools)\/([^/]+)/.exec(file);
    if (workspaceMatch?.[2]) return workspaceMatch[2];
  }

  if (/^\.github\//.test(file)) return 'ci';
  if (/^(infra|scripts)\//.test(file)) return 'dx';
  if (/^(package\.json|pnpm-lock\.yaml|bun\.lock|tsconfig\.json)$/.test(file)) return 'build';

  const parts = file.split('/');
  if (parts.length > 1 && parts[0] === 'src') return parts[1];
  return null;
}

function getScopesFromPaths(changedFiles: string[], repoType: 'monorepo' | 'single'): string[] {
  const scopes = new Set<string>();
  for (const file of changedFiles) {
    const scope = getPathBasedScope(file, repoType);
    if (scope) scopes.add(scope);
  }
  return Array.from(scopes);
}

export async function getCommitContextHints(changedFiles: string[]): Promise<CommitContextHints> {
  const allScopes = new Set<string>();

  const historicalScopes = await getScopesFromHistory(changedFiles, 50);
  historicalScopes.forEach(scope => allScopes.add(scope));

  const repoType = await detectRepoType();
  getScopesFromPaths(changedFiles, repoType).forEach(scope => allScopes.add(scope));

  return {
    scopeSuggestions: Array.from(allScopes),
    recentCommitSubjects: await getRecentCommitSubjects(changedFiles),
  };
}
