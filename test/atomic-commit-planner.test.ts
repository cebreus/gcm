import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAtomicSplitProposal, detectAtomicGroup } from '../src/atomic-commit-planner.js';

async function runGit(repository: string, args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

test('atomic commit planner: classifies paths in rule precedence order', () => {
  const cases: Array<[string, string]> = [
    ['apps/web/package.json', 'deps'],
    ['apps/web/pnpm-lock.yaml', 'deps'],
    ['apps/web/README.md', 'docs-formatting'],
    ['apps/web/src/main.ts', 'web'],
    ['.github/README.md', 'docs-formatting'],
    ['.github/workflows/ci.yml', 'ci'],
    ['scripts/README.md', 'docs-formatting'],
    ['scripts/release.ts', 'scripts'],
    ['infra/x', 'infra'],
    ['sites/a/x.ts', 'sites'],
    ['tools/b/x.ts', 'tools'],
    ['test/README.md', 'docs-formatting'],
    ['test/runner.test.ts', 'tests'],
    ['src/services/README.md', 'docs-formatting'],
    ['src/services/api.ts', 'src'],
    ['src/models/user.ts', 'src'],
    ['src/runner.test.ts', 'tests'],
    ['src/runner.ts', 'src'],
    ['src/scope-detector.test.ts', 'tests'],
    ['src/scope-detector.ts', 'src'],
    ['src/feature.ts', 'src'],
    ['LICENSE', 'core'],
  ];

  for (const [file, group] of cases) expect(detectAtomicGroup(file)).toBe(group);
});

test('atomic commit planner: groups matching files and orders groups deterministically', () => {
  const proposal = buildAtomicSplitProposal([
    'docs/guide.md',
    'src/runner.ts',
    'package.json',
    'src/services/api.ts',
    'src/services/auth.ts',
  ]);

  expect(proposal).toContain(
    'Found 5 changed file(s) in the worktree, proposed 3 atomic group(s).',
  );
  expect(proposal).toContain('Commit 1: deps');
  expect(proposal).toContain('Commit 2: src');
  expect(proposal).toContain('Commit 3: docs-formatting');
  expect(proposal).toContain('- src/runner.ts\n- src/services/api.ts\n- src/services/auth.ts');
});

test('atomic commit planner: renders a complete deterministic proposal', () => {
  const proposal = buildAtomicSplitProposal([
    'docs/guide.md',
    'src/runner.ts',
    'package.json',
    'src/services/api.ts',
    'src/services/auth.ts',
  ]);

  expect(proposal).toBe(`Found 5 changed file(s) in the worktree, proposed 3 atomic group(s).

Rules applied: lockfiles grouped with dependency manifests; docs/formatting split from functional changes.



Commit 1: deps
- package.json

Suggested commands:
git reset
git add -- ':(top,literal)package.json'
git commit -m $'build(deps): split package.json updates' \\
  -m $'- align dependency metadata and lockfile state'

Commit 2: src
- src/runner.ts
- src/services/api.ts
- src/services/auth.ts

Suggested commands:
git reset
git add -- ':(top,literal)src/runner.ts' ':(top,literal)src/services/api.ts' ':(top,literal)src/services/auth.ts'
git commit -m $'refactor(src): split changes updates' \\
  -m $'- group src changes into one atomic unit'

Commit 3: docs-formatting
- docs/guide.md

Suggested commands:
git reset
git add -- ':(top,literal)docs/guide.md'
git commit -m $'docs(docs): split guide.md updates' \\
  -m $'- separate documentation and formatting-only changes'`);
});

test('atomic commit planner: classifies alternate dependency, documentation, and config paths', () => {
  const cases: Array<[string, string]> = [
    ['bun.lock', 'deps'],
    ['bun.lockb', 'deps'],
    ['package-lock.json', 'deps'],
    ['yarn.lock', 'deps'],
    ['pnpm-workspace.yaml', 'deps'],
    ['guide.mdx', 'docs-formatting'],
    ['guide.rst', 'docs-formatting'],
    ['guide.txt', 'docs-formatting'],
    ['GUIDE.MD', 'docs-formatting'],
    ['.prettierrc', 'docs-formatting'],
    ['.prettierrc.json', 'docs-formatting'],
    ['.editorconfig', 'docs-formatting'],
    ['prettier.config.ts', 'docs-formatting'],
    ['.eslintrc', 'docs-formatting'],
    ['.eslintrc.cjs', 'docs-formatting'],
    ['eslint.config.mjs', 'docs-formatting'],
    ['docs/runner.ts', 'docs'],
    ['docs/scope-detector.ts', 'docs'],
  ];

  for (const [file, group] of cases) expect(detectAtomicGroup(file)).toBe(group);
});

test('atomic commit planner: uses multi-file commit wording', () => {
  const proposal = buildAtomicSplitProposal([
    'src/runner.ts',
    'src/services/api.ts',
    'src/services/auth.ts',
  ]);

  expect(proposal).toContain("git commit -m $'refactor(src): split changes updates'");
  expect(proposal).toContain("-m $'- group src changes into one atomic unit'");
});

test('atomic commit planner: safely quotes shell paths', () => {
  const proposal = buildAtomicSplitProposal([
    'src/file with space.ts',
    "src/quote's.ts",
    '-leading.ts',
  ]);

  expect(proposal).toContain(
    "git add -- ':(top,literal)src/file with space.ts' ':(top,literal)src/quote'\\''s.ts'",
  );
  expect(proposal).toContain("git add -- ':(top,literal)-leading.ts'");
});

test('atomic commit planner: renders control characters in filenames without terminal escapes', () => {
  const proposal = buildAtomicSplitProposal(['src/\u001B]8;;https://example.test\u0007unsafe.ts']);

  expect(proposal).not.toContain('\u001B');
  expect(proposal).not.toContain('\u0007');
  expect(proposal).toContain(
    "git add -- $':(top,literal)src/\\x1b]8;;https://example.test\\x07unsafe.ts'",
  );
});

test('atomic commit planner: keeps special paths as literal shell arguments', () => {
  const proposal = buildAtomicSplitProposal([
    'src/line\nbreak.ts',
    'src/semicolon;file.ts',
    'src/$(printf unsafe).ts',
    'src/café.ts',
  ]);

  const addCommand = proposal.split('git reset\n')[1]?.split('\ngit commit')[0];

  expect(addCommand).toBe(
    `git add -- $':(top,literal)src/line\\nbreak.ts' ':(top,literal)src/semicolon;file.ts' ':(top,literal)src/$(printf unsafe).ts' ':(top,literal)src/café.ts'`,
  );
});

test('atomic commit planner: emits reset for every group', () => {
  const proposal = buildAtomicSplitProposal(['src/one.ts', 'test/two.test.ts']);

  expect(proposal).toContain(`Commit 1: src
- src/one.ts

Suggested commands:
git reset
git add -- ':(top,literal)src/one.ts'
git commit -m $'refactor(src): split one.ts updates' \\
  -m $'- isolate src/one.ts changes into one atomic unit'`);
  expect(proposal).toContain(`Commit 2: tests
- test/two.test.ts

Suggested commands:
git reset
git add -- ':(top,literal)test/two.test.ts'
git commit -m $'test(tests): split two.test.ts updates' \\
  -m $'- keep test coverage aligned with related code updates'`);
  expect(proposal).toContain(`Commit 2: tests
- test/two.test.ts

Suggested commands:
git reset`);
});

test('atomic commit planner: a later group stages only its own files', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-atomic-plan-'));
  const proposal = buildAtomicSplitProposal(['src/one.ts', 'test/two.test.ts']);
  const laterGroup = proposal.split('Commit 2: tests\n')[1]?.split('\ngit commit')[0];
  const laterCommands = laterGroup?.split('Suggested commands:\n')[1];

  try {
    await mkdir(join(repository, 'src'));
    await mkdir(join(repository, 'test'));
    await writeFile(join(repository, 'src/one.ts'), 'one\n');
    await writeFile(join(repository, 'test/two.test.ts'), 'two\n');
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['add', '--', 'src/one.ts']);

    if (laterCommands === undefined) throw new Error('Missing later group commands');
    expect(laterCommands).toBe(`git reset
git add -- ':(top,literal)test/two.test.ts'`);
    const child = Bun.spawn({ cmd: ['sh', '-c', laterCommands], cwd: repository, stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);

    expect(await runGit(repository, ['diff', '--cached', '--name-only'])).toBe(
      'test/two.test.ts\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
