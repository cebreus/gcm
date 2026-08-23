import { test, expect, mock, afterEach, afterAll } from 'bun:test';
import { spawnGitLines, spawnGitStream } from '../src/git-utils';
import { SpawnGitLinesResult, SpawnGitStreamResult } from '../src/git-utils'; // Assuming these are exported

const mockSpawn = mock(() => ({
  stdout: new Response('mock stdout').body,
  stderr: new Response('').body,
  exited: Promise.resolve(0),
  kill: mock(() => {}),
}));

const originalSpawn = Bun.spawn;

Bun.spawn = mockSpawn as any; // Cast to any because Bun.spawn's signature is complex

afterAll(() => {
  Bun.spawn = originalSpawn;
});

afterEach(() => {
  mockSpawn.mockClear();
});

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(values.length));
  result.set(values);
  return result;
}

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

test('git-utils: limits output by bytes, not characters', async () => {
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('ěě').body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));

  expect(await spawnGitLines(['diff'], { maxBytes: 3 })).toEqual({ lines: [], truncated: true });
});

test('git-utils: uses the default limit for unsafe byte caps', async () => {
  for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, -1, 1.5]) {
    mockSpawn.mockImplementationOnce(() => ({
      stdout: new Response('x'.repeat(1024 * 1024 + 1)).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    }));

    const result = await spawnGitLines(['diff'], { maxBytes });
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.lines.join('')).byteLength).toBeLessThanOrEqual(
      1024 * 1024,
    );
  }
});

test('git-utils: decodes UTF-8 split across stdout chunks', async () => {
  const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes(0xc4));
      controller.enqueue(bytes(0x9b, 0x0a));
      controller.close();
    },
  });
  mockSpawn.mockImplementationOnce(() => ({
    stdout,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));

  expect(await spawnGitLines(['diff'])).toEqual({ lines: ['ě\n'], truncated: false });
});

test('git-utils: decodes UTF-8 split across stderr chunks', async () => {
  const stderr = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes(0xc4));
      controller.enqueue(bytes(0x9b));
      controller.close();
    },
  });
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('').body,
    stderr,
    exited: Promise.resolve(1),
    kill: mock(() => {}),
  }));

  await expect(spawnGitStream(['diff'])).rejects.toThrow('failed: ě');
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
