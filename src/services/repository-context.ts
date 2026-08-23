import { spawnGitStream } from '../git-utils.js';
import type { CommitContextFacts } from '../scope-detector.js';

type RepositoryContextDependencies = {
  runGit: typeof spawnGitStream;
  fileExists(path: string): Promise<boolean>;
};

async function bunFileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function readHistory(
  dependencies: RepositoryContextDependencies,
  args: string[],
): Promise<string[]> {
  try {
    return (await dependencies.runGit(args)).text.split('\n');
  } catch {
    return [];
  }
}

export async function readCommitContextFacts(
  changedFiles: string[],
  dependencies: RepositoryContextDependencies = {
    runGit: spawnGitStream,
    fileExists: bunFileExists,
  },
): Promise<CommitContextFacts> {
  if (changedFiles.length === 0)
    return { scopeHistorySubjects: [], recentSubjects: [], repoType: 'single' };
  const [scopeHistory, recentHistory, hasLerna, hasPnpmWorkspace, hasPackagesDir, hasAppsDir] =
    await Promise.all([
      readHistory(dependencies, ['log', '-n', '50', '--pretty=format:%s', '--', ...changedFiles]),
      readHistory(dependencies, ['log', '-n', '20', '--pretty=format:%s', '--', ...changedFiles]),
      dependencies.fileExists('lerna.json'),
      dependencies.fileExists('pnpm-workspace.yaml'),
      dependencies.fileExists('packages'),
      dependencies.fileExists('apps'),
    ]);
  return {
    scopeHistorySubjects: scopeHistory,
    recentSubjects: recentHistory,
    repoType:
      hasLerna || hasPnpmWorkspace || (hasPackagesDir && hasAppsDir) ? 'monorepo' : 'single',
  };
}
