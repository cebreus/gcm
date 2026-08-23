export function buildAtomicSplitProposal(stagedFiles: readonly string[]): string {
  const groups = new Map<string, string[]>();
  for (const file of stagedFiles) {
    const scope = detectAtomicGroup(file);
    const list = groups.get(scope) ?? [];
    list.push(file);
    groups.set(scope, list);
  }

  const orderedGroups = orderAtomicGroups(groups);
  const sections: string[] = [];
  let index = 0;
  for (const [scope, files] of orderedGroups) {
    index += 1;
    const escapedFiles = files.map(escapeShellArg).join(' ');
    const commitSubject = buildSuggestedSplitCommitSubject(scope, files);
    const commitBodyBullet = buildSuggestedSplitCommitBody(scope, files);
    sections.push(
      [
        `Commit ${index}: ${scope}`,
        ...files.map(file => `- ${file}`),
        '',
        'Suggested commands:',
        'git reset',
        `git add -- ${escapedFiles}`,
        `git commit -m $'${escapeForAnsiCString(commitSubject)}' \\`,
        `  -m $'- ${escapeForAnsiCString(commitBodyBullet)}'`,
      ].join('\n'),
    );
  }

  return [
    `Found ${stagedFiles.length} changed file(s) in the worktree, proposed ${groups.size} atomic group(s).`,
    'Rules applied: lockfiles grouped with dependency manifests; docs/formatting split from functional changes.',
    '',
    ...sections,
  ].join('\n\n');
}

export function detectAtomicGroup(file: string): string {
  if (isDependencyMetadataFile(file)) return 'deps';
  if (isDocsOrFormattingFile(file)) return 'docs-formatting';

  const workspaceMatch = /^(apps|packages|sites|tools)\/([^/]+)/.exec(file);
  if (workspaceMatch?.[2]) return workspaceMatch[2];
  if (file.startsWith('.github/')) return 'ci';
  if (/^(infra|scripts)\//.test(file)) return 'tooling';
  if (/^test\//.test(file) || /\.test\./.test(file)) return 'tests';
  if (/^src\/services\//.test(file)) return 'services';
  if (/^src\/models\//.test(file)) return 'models';
  if (/^src\/.*runner/.test(file) || file.includes('runner.ts')) return 'runner';
  if (/^src\/.*scope-detector/.test(file) || file.includes('scope-detector.ts')) return 'scope';
  const topLevel = file.split('/')[0];
  if (topLevel && topLevel !== file) return topLevel;
  return 'core';
}

function isDependencyMetadataFile(file: string): boolean {
  const base = file.split('/').pop() ?? '';
  if (base === 'package.json') return true;
  if (/^(pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock)$/.test(base)) return true;
  if (base === 'pnpm-workspace.yaml') return true;
  return false;
}

function isDocsOrFormattingFile(file: string): boolean {
  if (/\.(md|mdx|rst|txt)$/i.test(file)) return true;
  const base = file.split('/').pop() ?? '';
  if (/^(\.prettierrc(\..+)?|\.editorconfig|prettier\.config\.(js|ts|cjs|mjs))$/i.test(base)) {
    return true;
  }
  if (/^(\.eslintrc(\..+)?|eslint\.config\.(js|ts|cjs|mjs))$/i.test(base)) return true;
  return false;
}

function orderAtomicGroups(groups: Map<string, string[]>): Array<[string, string[]]> {
  const priority: Record<string, number> = {
    deps: 10,
    ci: 20,
    tooling: 30,
    core: 40,
    services: 50,
    models: 60,
    runner: 70,
    scope: 80,
    tests: 90,
    'docs-formatting': 100,
  };
  return Array.from(groups.entries()).sort((a, b) => {
    const aPriority = priority[a[0]] ?? 50;
    const bPriority = priority[b[0]] ?? 50;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a[0].localeCompare(b[0]);
  });
}

function buildSuggestedSplitCommitSubject(scope: string, files: string[]): string {
  const typeByScope: Record<string, string> = {
    tests: 'test',
    'docs-formatting': 'docs',
    deps: 'build',
    ci: 'ci',
    tooling: 'chore',
  };
  const type = typeByScope[scope] ?? 'refactor';
  const normalizedScope = scope === 'docs-formatting' ? 'docs' : scope;
  let fileHint = 'changes';
  if (files.length === 1) fileHint = files[0].split('/').pop() ?? 'changes';
  return `${type}(${normalizedScope}): split ${fileHint} updates`;
}

function buildSuggestedSplitCommitBody(scope: string, files: string[]): string {
  if (scope === 'deps') return 'align dependency metadata and lockfile state';
  if (scope === 'docs-formatting') return 'separate documentation and formatting-only changes';
  if (scope === 'tests') return 'keep test coverage aligned with related code updates';
  if (files.length === 1) return `isolate ${files[0]} changes into one atomic unit`;
  return `group ${scope} changes into one atomic unit`;
}

function escapeForAnsiCString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, `\\'`);
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
