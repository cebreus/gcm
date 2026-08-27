import { spawnGitStream } from '../git-utils.js';
import type { CommitContextFacts } from '../scope-detector.js';

type RepositoryContextDependencies = {
  runGit: typeof spawnGitStream;
  fileExists(path: string): Promise<boolean>;
};

async function bunFileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function readHistory(
  dependencies: RepositoryContextDependencies,
  args: string[],
): Promise<string[] | null> {
  try {
    const result = await dependencies.runGit(args);
    if (result.truncated) throw new Error('Git history output was truncated');
    const text = result.text;
    return text ? text.split('\n') : [];
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
    ...changedFiles.map(file => `:(literal)${file}`),
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
        ...changedFiles.map(file => `:(literal)${file}`),
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
