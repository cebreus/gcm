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
): Promise<string[] | null> {
  try {
    return (await dependencies.runGit(args)).text.split('\n');
  } catch {
    return null;
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
  const historyPromise = readHistory(dependencies, [
    'log',
    '-n',
    '50',
    '--pretty=format:%s',
    '--',
    ...changedFiles,
  ]).then(async function (history) {
    if (history !== null) {
      return { scopeHistorySubjects: history, recentSubjects: history.slice(0, 20) };
    }
    const recentSubjects =
      (await readHistory(dependencies, [
        'log',
        '-n',
        '20',
        '--pretty=format:%s',
        '--',
        ...changedFiles,
      ])) ?? [];
    return { scopeHistorySubjects: [], recentSubjects };
  });
  const [history, hasLerna, hasPnpmWorkspace, hasPackagesDir, hasAppsDir] = await Promise.all([
    historyPromise,
    dependencies.fileExists('lerna.json'),
    dependencies.fileExists('pnpm-workspace.yaml'),
    dependencies.fileExists('packages'),
    dependencies.fileExists('apps'),
  ]);
  return {
    ...history,
    repoType:
      hasLerna || hasPnpmWorkspace || (hasPackagesDir && hasAppsDir) ? 'monorepo' : 'single',
  };
}
