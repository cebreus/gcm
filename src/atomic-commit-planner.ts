import { WORKSPACE_PATH_PATTERN } from './scope-detector.js';
import { stripTerminalControlSequences } from './utils.js';

export function buildAtomicSplitProposal(
  stagedFiles: readonly string[],
  includeCommands = true,
): string {
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
    const escapedFiles = files.map(file => escapeShellArg(`:(top,literal)${file}`)).join(' ');
    const commitSubject = buildSuggestedSplitCommitSubject(scope, files);
    const commitBodyBullet = buildSuggestedSplitCommitBody(scope, files);
    sections.push(
      [
        `Commit ${index}: ${stripTerminalControlSequences(scope)}`,
        ...files.map(file => `- ${stripTerminalControlSequences(file)}`),
        '',
        ...(includeCommands
          ? [
              'Suggested commands:',
              'git reset',
              `git add -- ${escapedFiles}`,
              `git commit -m $'${escapeAnsiCString(commitSubject)}' \\`,
              `  -m $'- ${escapeAnsiCString(commitBodyBullet)}'`,
            ]
          : ['Commands omitted: staged and unstaged changes cannot be split safely by path.']),
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

  const workspaceMatch = WORKSPACE_PATH_PATTERN.exec(file);
  if (workspaceMatch?.[2]) return workspaceMatch[2];
  if (file.startsWith('.github/')) return 'ci';
  if (/^test\//.test(file) || /\.test\./.test(file)) return 'tests';
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
    core: 40,
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

function escapeShellArg(value: string): string {
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return `$'${escapeAnsiCString(value)}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeAnsiCString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, `\\'`)
    .replace(/\x1b/g, '\\x1b')
    .replace(/\x07/g, '\\x07')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(
      /[\x00-\x06\x08-\x1a\x1c-\x1f\x7f-\x9f]/g,
      character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
    );
}
