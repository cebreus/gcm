import { test, expect, mock, afterEach } from 'bun:test';

// 1. Create the mock functions first
const spawnGitStreamMock = mock<() => Promise<{ text: string; exitCode: number; truncated: boolean; }>>(() =>
  Promise.resolve({ text: '', exitCode: 0, truncated: false })
);
const detectRepoTypeMock = mock<() => Promise<'single' | 'monorepo'>>(() =>
  Promise.resolve('single')
);

// 2. Mock the modules and provide the mock functions in the factory
mock.module('../src/git-utils', () => ({
  spawnGitStream: spawnGitStreamMock,
}));
mock.module('../src/utils', () => ({
  detectRepoType: detectRepoTypeMock,
}));

// 3. NOW import the code that uses the mocks
import { getScopeSuggestions } from '../src/scope-detector';

afterEach(() => {
  spawnGitStreamMock.mockClear();
  detectRepoTypeMock.mockClear();
});

test('scope-detector: should return empty array for empty file list', async () => {
  const result = await getScopeSuggestions([]);
  expect(result).toEqual([]);
});

test('scope-detector: should extract scopes from git history', async () => {
  const mockLog = `feat(scope1): message 1
fix(scope2): message 2
feat(scope1): message 3`;
  spawnGitStreamMock.mockResolvedValue({ text: mockLog, exitCode: 0, truncated: false });
  detectRepoTypeMock.mockResolvedValue('single');

  const files = ['src/some/file1.ts'];
  const result = await getScopeSuggestions(files);

  expect(result.sort()).toEqual(['scope1', 'scope2']);
  expect(spawnGitStreamMock).toHaveBeenCalled();
  expect(detectRepoTypeMock).toHaveBeenCalled();
});

test('scope-detector: should ignore invalid commit message formats', async () => {
  const mockLog = `feat(scope1): message 1
Invalid commit message
fix: no scope here`;
  spawnGitStreamMock.mockResolvedValue({ text: mockLog, exitCode: 0, truncated: false });
  detectRepoTypeMock.mockResolvedValue('single');

  const files = ['src/file1.ts'];
  const result = await getScopeSuggestions(files);

  expect(result.sort()).toEqual(['scope1']);
});

test('scope-detector: should detect monorepo scopes', async () => {
  spawnGitStreamMock.mockResolvedValue({ text: '', exitCode: 0, truncated: false });
  detectRepoTypeMock.mockResolvedValue('monorepo');
  
  const files = ['apps/app-one/src/index.ts', 'packages/lib-two/src/main.ts', 'README.md'];
  const result = await getScopeSuggestions(files);

  expect(result.sort()).toEqual(['app-one', 'lib-two']);
});

test('scope-detector: should provide fallback scopes for single repo when no history exists', async () => {
  spawnGitStreamMock.mockResolvedValue({ text: '', exitCode: 0, truncated: false });
  detectRepoTypeMock.mockResolvedValue('single');

  const files = ['src/feature-a/file.ts', 'src/feature-b/file.ts', 'docs/guide.md'];
  const result = await getScopeSuggestions(files);
  
  expect(result.sort()).toEqual(['feature-a', 'feature-b']);
});

test('scope-detector: should deduplicate scopes from all sources', async () => {
    const mockLog = `feat(history-scope): message 1
fix(common-scope): message 2`;
    spawnGitStreamMock.mockResolvedValue({ text: mockLog, exitCode: 0, truncated: false });
    detectRepoTypeMock.mockResolvedValue('monorepo');
    
    const files = [
        'apps/app-scope/src/index.ts', 
        'packages/common-scope/src/main.ts'
    ];
    const result = await getScopeSuggestions(files);

    expect(result.sort()).toEqual(['app-scope', 'common-scope', 'history-scope']);
});

test('scope-detector: should handle git log errors gracefully and still run file-based detection', async () => {
    spawnGitStreamMock.mockRejectedValue(new Error('Git error'));
    detectRepoTypeMock.mockResolvedValue('monorepo');

    const files = ['apps/app-one/src/index.ts'];
    const result = await getScopeSuggestions(files);

    expect(result).toEqual(['app-one']);
});

test('scope-detector: should handle mix of monorepo and historical scopes', async () => {
    const mockLog = `feat(history-scope): message
feat(another-scope): message`;
    spawnGitStreamMock.mockResolvedValue({ text: mockLog, exitCode: 0, truncated: false });
    detectRepoTypeMock.mockResolvedValue('monorepo');
    
    const files = ['apps/app-scope/src/index.ts'];
    const result = await getScopeSuggestions(files);

    expect(result.sort()).toEqual(['another-scope', 'app-scope', 'history-scope']);
});

test('scope-detector: parses conventional commit format correctly', async () => {
    const mockLog = 'type(scope-with-hyphen): message';
    spawnGitStreamMock.mockResolvedValue({ text: mockLog, exitCode: 0, truncated: false });
    detectRepoTypeMock.mockResolvedValue('single');

    const result = await getScopeSuggestions(['src/file.ts']);
    // Fallback logic for `src/file.ts` would add 'file.ts', but since
    // a scope is found in history, the fallback is not triggered.
    expect(result).toEqual(['scope-with-hyphen']);
});
