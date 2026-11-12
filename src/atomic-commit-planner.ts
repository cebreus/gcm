import { WORKSPACE_PATH_PATTERN } from './scope-detector.js';
import { hasText, stripTerminalControlSequences } from './utils.js';

// `*` marks where unlisted groups (workspace and top-level scopes) sort.
const ATOMIC_GROUP_ORDER = [
  'deps',
  'ci',
  'core',
  '*',
  'tests',
  'docs-formatting',
];
const HEXADECIMAL_RADIX = 16;

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
    const escapedFiles = files
      .map((file) => escapeShellArg(`:(top,literal)${file}`))
      .join(' ');
    const commitSubject = buildSuggestedSplitCommitSubject(scope, files);
    const commitBodyBullet = buildSuggestedSplitCommitBody(scope, files);
    sections.push(
      [
        `Commit ${index}: ${stripTerminalControlSequences(scope)}`,
        ...files.map((file) => `- ${stripTerminalControlSequences(file)}`),
        '',
        ...(includeCommands
          ? [
              'Suggested commands:',
              'git reset',
              `git add -- ${escapedFiles}`,
              `git commit -m $'${escapeAnsiCString(commitSubject)}' \\`,
              `  -m $'- ${escapeAnsiCString(commitBodyBullet)}'`,
            ]
          : [
              'Commands omitted: staged and unstaged changes cannot be split safely by path.',
            ]),
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
  if (isDependencyMetadataFile(file)) {
    return 'deps';
  }
  if (isDocsOrFormattingFile(file)) {
    return 'docs-formatting';
  }
  const workspaceScope = WORKSPACE_PATH_PATTERN.exec(file)?.groups?.workspace;
  if (hasText(workspaceScope)) {
    return workspaceScope;
  }
  if (file.startsWith('.github/')) {
    return 'ci';
  }
  if (file.startsWith('test/') || file.includes('.test.')) {
    return 'tests';
  }
  return detectTopLevelGroup(file);
}

function detectTopLevelGroup(file: string): string {
  const [topLevel = ''] = file.split('/');
  if (topLevel !== '' && topLevel !== file) {
    return topLevel;
  }
  return 'core';
}

function isDependencyMetadataFile(file: string): boolean {
  const base = file.split('/').pop() ?? '';
  if (base === 'package.json') {
    return true;
  }
  if (
    /^(?:pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock)$/v.test(
      base,
    )
  ) {
    return true;
  }
  if (base === 'pnpm-workspace.yaml') {
    return true;
  }
  return false;
}

function isDocsOrFormattingFile(file: string): boolean {
  if (/\.(?:md|mdx|rst|txt)$/iv.test(file)) {
    return true;
  }
  const base = file.split('/').pop() ?? '';
  if (
    /^(?:\.prettierrc(?:\..+)?|\.editorconfig|prettier\.config\.(?:js|ts|cjs|mjs))$/iv.test(
      base,
    )
  ) {
    return true;
  }
  if (
    /^(?:\.eslintrc(?:\..+)?|eslint\.config\.(?:js|ts|cjs|mjs))$/iv.test(base)
  ) {
    return true;
  }
  return false;
}

function orderAtomicGroups(
  groups: Map<string, string[]>,
): Array<[string, string[]]> {
  const rank = (group: string): number => {
    const index = ATOMIC_GROUP_ORDER.indexOf(group);
    return index === -1 ? ATOMIC_GROUP_ORDER.indexOf('*') : index;
  };
  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .sort((a, b) => rank(a[0]) - rank(b[0]));
}

function buildSuggestedSplitCommitSubject(
  scope: string,
  files: string[],
): string {
  const typeByScope: Record<string, string> = {
    tests: 'test',
    'docs-formatting': 'docs',
    deps: 'build',
    ci: 'ci',
  };
  const type = typeByScope[scope] ?? 'refactor';
  const normalizedScope = scope === 'docs-formatting' ? 'docs' : scope;
  let fileHint = 'changes';
  if (files.length === 1) {
    fileHint = files[0].split('/').pop() ?? 'changes';
  }
  return `${type}(${normalizedScope}): split ${fileHint} updates`;
}

function buildSuggestedSplitCommitBody(scope: string, files: string[]): string {
  if (scope === 'deps') {
    return 'align dependency metadata and lockfile state';
  }
  if (scope === 'docs-formatting') {
    return 'separate documentation and formatting-only changes';
  }
  if (scope === 'tests') {
    return 'keep test coverage aligned with related code updates';
  }
  if (files.length === 1) {
    return `isolate ${files[0]} changes into one atomic unit`;
  }
  return `group ${scope} changes into one atomic unit`;
}

function escapeShellArg(value: string): string {
  // eslint-disable-next-line no-control-regex -- terminal control-character sanitising requires matching C0 and C1 ranges
  if (/[\x00-\x1f\x7f-\x9f]/v.test(value)) {
    return `$'${escapeAnsiCString(value)}'`;
  }
  return `'${value.replace(/'/gv, `'\\''`)}'`;
}

function escapeAnsiCString(value: string): string {
  return (
    value
      .replace(/\\/gv, '\\\\')
      .replace(/'/gv, `\\'`)
      // eslint-disable-next-line no-control-regex -- terminal control-character sanitising requires matching escape
      .replace(/\x1b/gv, '\\x1b')
      // eslint-disable-next-line no-control-regex -- terminal control-character sanitising requires matching bell
      .replace(/\x07/gv, '\\x07')
      .replace(/\r/gv, '\\r')
      .replace(/\n/gv, '\\n')
      .replace(/\t/gv, '\\t')
      .replace(
        // eslint-disable-next-line no-control-regex -- terminal control-character sanitising requires matching remaining C0 and C1 ranges
        /[\x00-\x06\x08-\x1a\x1c-\x1f\x7f-\x9f]/gv,
        (character) =>
          `\\x${character.charCodeAt(0).toString(HEXADECIMAL_RADIX).padStart(2, '0')}`,
      )
  );
}
