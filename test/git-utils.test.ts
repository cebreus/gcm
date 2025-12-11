import { test, expect, mock, afterEach, afterAll } from 'bun:test';
import { runGitCmdSync, spawnGitLines, ensureGitRepo } from '../src/git-utils';
import { SpawnGitLinesResult, SpawnGitStreamResult } from '../src/git-utils'; // Assuming these are exported

// Mock Bun.spawnSync and Bun.spawn
const mockSpawnSync = mock(() => ({
  stdout: 'mock stdout',
  stderr: '',
  success: true,
  exitCode: 0,
}));
const mockSpawn = mock(() => ({
  stdout: new Response('mock stdout').body,
  stderr: new Response('').body,
  exited: Promise.resolve(0),
  kill: mock(() => {}),
}));

const originalSpawnSync = Bun.spawnSync;
const originalSpawn = Bun.spawn;

// Patch Bun.spawnSync and Bun.spawn directly
Bun.spawnSync = mockSpawnSync;
Bun.spawn = mockSpawn as any; // Cast to any because Bun.spawn's signature is complex

afterAll(() => {
  // Restore original Bun.spawnSync and Bun.spawn
  Bun.spawnSync = originalSpawnSync;
  Bun.spawn = originalSpawn;
});

afterEach(() => {
  mockSpawnSync.mockClear();
  mockSpawn.mockClear();
});

test('git-utils: runGitCmdSync - should run a git command synchronously', () => {
  mockSpawnSync.mockReturnValue({ stdout: 'git output', stderr: '', success: true, exitCode: 0 });
  const result = runGitCmdSync(['status']);
  expect(result).toBe('git output');
  expect(mockSpawnSync).toHaveBeenCalledWith(expect.objectContaining({ cmd: ['git', 'status'] }));
});

test('git-utils: runGitCmdSync - should throw on command failure', () => {
  mockSpawnSync.mockReturnValue({ stdout: '', stderr: 'error', success: false, exitCode: 1 });
  expect(() => runGitCmdSync(['status'])).toThrow('git status failed: error');
});

test('git-utils: spawnGitLines - should spawn a git command and return lines', async () => {
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('line1\nline2\n').body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['log']);
  expect(result.lines).toEqual(['line1\n', 'line2\n']);
  expect(result.truncated).toBe(false);
  expect(mockSpawn).toHaveBeenCalledWith(expect.objectContaining({ cmd: ['git', 'log'] }));
});

test('git-utils: ensureGitRepo - should return true if in a git repository', () => {
  mockSpawnSync.mockReturnValue({ stdout: 'true\n', stderr: '', success: true, exitCode: 0 });
  const result = ensureGitRepo();
  expect(result).toBe(true);
  expect(mockSpawnSync).toHaveBeenCalledWith(expect.objectContaining({ cmd: ['git', 'rev-parse', '--is-inside-work-tree'] }));
});

test('git-utils: ensureGitRepo - should return false if not in a git repository', () => {
  mockSpawnSync.mockReturnValue({ stdout: '', stderr: 'not a git repo', success: false, exitCode: 1 });
  const result = ensureGitRepo();
  expect(result).toBe(false);
});

// --- Edge Cases for Git Utils ---
test('git-utils: should handle binary diff files output', async () => {
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('Binary files a/foo.png and b/foo.png differ\n').body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['diff', 'a/foo.png', 'b/foo.png']);
  expect(result.lines).toEqual(['Binary files a/foo.png and b/foo.png differ\n']);
  expect(result.truncated).toBe(false);
});

test('git-utils: should handle empty repository (no diff output)', async () => {
  // ensureGitRepo is already mocked to return true for most tests.
  // This tests what spawnGitLines returns in an empty scenario.
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('').body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['diff']);
  expect(result.lines).toEqual([]);
  expect(result.truncated).toBe(false);
});

test('git-utils: should handle detached HEAD state output', () => {
  mockSpawnSync.mockReturnValue({
    stdout: 'HEAD detached at a1b2c3d\n',
    stderr: '',
    success: true,
    exitCode: 0,
  });
  const result = runGitCmdSync(['rev-parse', '--abbrev-ref', 'HEAD']);
  expect(result).toBe('HEAD detached at a1b2c3d\n');
});

test('git-utils: should handle merge conflicts in staging', async () => {
  const conflictDiff = `<<<<<<< HEAD
console.log("hello");
=======
console.log("world");
>>>>>>> conflict`;
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response(conflictDiff).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['diff', '--staged']);
  expect(result.lines.join('')).toBe(conflictDiff);
});

test('git-utils: should handle submodule paths correctly', async () => {
  const submodulePaths = `path/to/submodule (a1b2c3d)\nother/sub`;
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response(submodulePaths).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['ls-files', '--stage']); // A command that might list submodules
  expect(result.lines.join('')).toContain('path/to/submodule');
  expect(result.lines.join('')).toContain('other/sub');
});

test('git-utils: should handle very long file paths', async () => {
  const longPath = 'a/'.repeat(150) + 'file.txt'; // Path > 256 chars
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response(longPath + '\n').body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['ls-files']);
  expect(result.lines[0].trim()).toBe(longPath);
});