import { spawnGitStream } from './git-utils.js';
import { detectRepoType } from './utils.js';

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

export async function getScopeSuggestions(changedFiles: string[]): Promise<string[]> {
  const allScopes = new Set<string>();

  const historicalScopes = await getScopesFromHistory(changedFiles, 50);
  historicalScopes.forEach(scope => allScopes.add(scope));

  const repoType = await detectRepoType();
  if (repoType === 'monorepo') {
    const packageRegex = /^(apps|packages)\/([^/]+)/;
    for (const file of changedFiles) {
      const match = packageRegex.exec(file);
      if (match && match[2]) {
        allScopes.add(match[2]);
      }
    }
  }

  if (allScopes.size === 0) {
    for (const file of changedFiles) {
      const parts = file.split('/');
      if (parts.length > 1 && parts[0] === 'src') {
        allScopes.add(parts[1]);
      }
    }
  }

  return Array.from(allScopes);
}
