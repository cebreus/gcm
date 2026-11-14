import { afterAll, afterEach, expect, mock, test } from 'bun:test';

import { spawnGitLines, spawnGitStream } from '../src/git-utils';

const mockSpawn = mock(() => ({
  stdout: new Response('mock stdout').body,
  stderr: new Response('').body,
  exited: Promise.resolve(0),
  kill: mock(() => {}),
}));

const { spawn: originalSpawn } = Bun;

Bun.spawn = mockSpawn as unknown as typeof Bun.spawn;

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
  expect(mockSpawn).toHaveBeenCalledWith(
    expect.objectContaining({ cmd: ['git', 'log'] }),
  );
});

test('git-utils: removes provider credentials from Git subprocess environments', async () => {
  const {
    env: {
      GCM_GEMINI_API_KEY: originalGeminiKey,
      GCM_FREELLMAPI_API_KEY: originalFreeLlmToken,
      GCM_LM_STUDIO_API_KEY: originalLmToken,
      COMMIT_SIGNING_TOKEN: originalSigningToken,
    },
  } = process;
  process.env.GCM_GEMINI_API_KEY = 'gemini-secret';
  process.env.GCM_FREELLMAPI_API_KEY = 'freellm-secret';
  process.env.GCM_LM_STUDIO_API_KEY = 'lm-secret';
  process.env.COMMIT_SIGNING_TOKEN = 'hook-secret';
  process.env.GCM_FUTURE_API_KEY = 'future-secret';
  try {
    await spawnGitStream(['status']);
    const call = mockSpawn.mock.calls.at(-1) as unknown as [
      { env?: Record<string, string> },
    ];
    const [options] = call;
    expect(options.env).toBeDefined();
    expect(options.env?.GCM_GEMINI_API_KEY).toBeUndefined();
    expect(options.env?.GCM_FREELLMAPI_API_KEY).toBeUndefined();
    expect(options.env?.GCM_LM_STUDIO_API_KEY).toBeUndefined();
    expect(options.env?.GCM_FUTURE_API_KEY).toBeUndefined();
    expect(options.env?.COMMIT_SIGNING_TOKEN).toBe('hook-secret');
  } finally {
    delete process.env.GCM_FUTURE_API_KEY;
    if (originalGeminiKey === undefined) {
      delete process.env.GCM_GEMINI_API_KEY;
    } else {
      process.env.GCM_GEMINI_API_KEY = originalGeminiKey;
    }
    if (originalFreeLlmToken === undefined) {
      delete process.env.GCM_FREELLMAPI_API_KEY;
    } else {
      process.env.GCM_FREELLMAPI_API_KEY = originalFreeLlmToken;
    }
    if (originalLmToken === undefined) {
      delete process.env.GCM_LM_STUDIO_API_KEY;
    } else {
      process.env.GCM_LM_STUDIO_API_KEY = originalLmToken;
    }
    if (originalSigningToken === undefined) {
      delete process.env.COMMIT_SIGNING_TOKEN;
    } else {
      process.env.COMMIT_SIGNING_TOKEN = originalSigningToken;
    }
  }
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
  expect(result.lines).toEqual([
    'Binary files a/foo.png and b/foo.png differ\n',
  ]);
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

  expect(
    await spawnGitLines(['diff'], { maxBytes: 3, allowTruncated: true }),
  ).toEqual({
    lines: ['ě'],
    truncated: true,
  });
});

test('git-utils: draining past the cap does not flush a split character', async () => {
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('ěě').body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));

  expect(
    await spawnGitLines(['diff'], {
      maxBytes: 3,
      allowTruncated: true,
      timeoutMs: 0,
    }),
  ).toEqual({ lines: ['ě'], truncated: true });
});

test('git-utils: uses the default limit for unsafe byte caps', async () => {
  for (const maxBytes of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    -1,
    1.5,
  ]) {
    mockSpawn.mockImplementationOnce(() => ({
      stdout: new Response('x'.repeat(1024 * 1024 + 1)).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    }));

    const result = await spawnGitLines(['diff'], {
      maxBytes,
      allowTruncated: true,
    });
    expect(result.truncated).toBe(true);
    expect(
      new TextEncoder().encode(result.lines.join('')).byteLength,
    ).toBeLessThanOrEqual(1024 * 1024);
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

  expect(await spawnGitLines(['diff'])).toEqual({
    lines: ['ě\n'],
    truncated: false,
  });
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

test('git-utils: reports the executable that failed', async () => {
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response('').body,
    stderr: new Response('boom').body,
    exited: Promise.resolve(1),
    kill: mock(() => {}),
  }));

  await expect(
    spawnGitStream(['run', 'script.ts'], { execName: 'bun' }),
  ).rejects.toThrow('bun run script.ts failed: boom');
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
  const longPath = `${'a/'.repeat(150)}file.txt`; // Path > 256 chars
  mockSpawn.mockImplementationOnce(() => ({
    stdout: new Response(`${longPath}\n`).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: mock(() => {}),
  }));
  const result = await spawnGitLines(['ls-files']);
  expect(result.lines[0].trim()).toBe(longPath);
});
