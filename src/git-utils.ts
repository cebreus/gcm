import { integerInRange } from './config-values.js';
import { MAX_CHILD_OUTPUT_BYTES } from './constants.js';

interface SpawnGitOptions {
  maxBytes?: number;
  execName?: string;
  timeoutMs?: number;
  allowTruncated?: boolean;
}

const PROVIDER_CREDENTIAL_NAMES = new Set([
  'GOOGLE_GEMINI_API_KEY',
  'GCM_FREELLMAPI_TOKEN',
  'LM_API_TOKEN',
]);

function gitEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(function (entry): entry is [string, string] {
      return entry[1] !== undefined && !PROVIDER_CREDENTIAL_NAMES.has(entry[0]);
    }),
  );
}

export interface SpawnGitLinesResult {
  lines: string[];
  truncated: boolean;
}

export interface SpawnGitStreamResult {
  text: string;
  truncated: boolean;
}

async function killSpawnedChild(
  child: ReturnType<typeof Bun.spawn>,
  state: { killed: boolean },
): Promise<void> {
  if (state.killed || child.exitCode !== null) return;
  const alreadyExited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1).then(() => false),
  ]);
  if (alreadyExited) return;
  state.killed = true;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const forceKillTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 2000);
  void child.exited.then(function () {
    clearTimeout(forceKillTimer);
  });
}

async function spawnCore(
  args: string[],
  onChunk: (chunk: string) => void,
  options: SpawnGitOptions = {},
  defaultMaxBytes = 1024 * 1024,
): Promise<{ truncated: boolean }> {
  const maxBytes = integerInRange(options.maxBytes, 1, MAX_CHILD_OUTPUT_BYTES, defaultMaxBytes);
  const timeoutMs = integerInRange(options.timeoutMs, 1, 10 * 60 * 1000, 120_000);
  const execName = options.execName ?? 'git';
  const child = Bun.spawn({
    cmd: [execName, ...args],
    env: gitEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  const killState = { killed: false };
  const timeout = setTimeout(function () {
    timedOut = true;
    void killSpawnedChild(child, killState);
  }, timeoutMs);

  const stdoutTask = (async (): Promise<void> => {
    const reader = child.stdout?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) onChunk(tail);
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        await killSpawnedChild(child, killState);
        break;
      }
      onChunk(decoder.decode(value, { stream: true }));
    }
  })();

  const stderrTask = (async (): Promise<string> => {
    const reader = child.stderr?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let stderr = '';
    let stderrBytes = 0;
    const maxStderrBytes = 64 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (stderrBytes <= maxStderrBytes) stderr += decoder.decode();
        break;
      }
      stderrBytes += value.byteLength;
      if (stderrBytes <= maxStderrBytes) stderr += decoder.decode(value, { stream: true });
    }
    return stderr;
  })();

  await stdoutTask;
  const [code, stderr] = await Promise.all([child.exited, stderrTask]);
  clearTimeout(timeout);
  if (truncated && !options.allowTruncated) {
    throw new Error(execName + ' ' + args.join(' ') + ' output was truncated');
  }
  if (timedOut) throw new Error('git ' + args.join(' ') + ' timed out');
  if (truncated && args[0] === 'commit') {
    throw new Error('git commit output was truncated; the commit result could not be verified');
  }
  if (code !== 0 && !killState.killed) {
    throw new Error(execName + ' ' + args.join(' ') + ' failed: ' + stderr);
  }
  return { truncated };
}

export async function spawnGitLines(
  args: string[],
  options: SpawnGitOptions = {},
): Promise<SpawnGitLinesResult> {
  const lines: string[] = [];
  let buf = '';
  const { truncated } = await spawnCore(
    args,
    chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, idx + 1));
        buf = buf.slice(idx + 1);
      }
    },
    options,
  );
  if (buf.length) lines.push(buf);
  return { lines, truncated };
}

export async function spawnGitStream(
  args: string[],
  options: SpawnGitOptions = {},
): Promise<SpawnGitStreamResult> {
  let text = '';
  const { truncated } = await spawnCore(
    args,
    chunk => {
      text += chunk;
    },
    options,
    50 * 1024 * 1024,
  );
  return { text, truncated };
}
