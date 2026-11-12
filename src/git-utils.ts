import { integerInRange } from './config-values.js';
import {
  BYTES_PER_KIBIBYTE,
  KIBIBYTES_PER_MEBIBYTE,
  MAX_CHILD_OUTPUT_BYTES,
  MILLISECONDS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from './constants.js';

export type GitFailureKind = 'not-a-repository' | 'unknown-revision';

/** A non-zero git exit; `kind` classifies git's stderr once, here, so callers never read message text. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly kind?: GitFailureKind,
  ) {
    super(message);
  }
}

function classifyGitFailure(stderr: string): GitFailureKind | undefined {
  if (/not a git repository/iv.test(stderr)) {
    return 'not-a-repository';
  }
  if (/unknown revision/iv.test(stderr)) {
    return 'unknown-revision';
  }
  return undefined;
}

export function isGitFailure(error: unknown, kind: GitFailureKind): boolean {
  return error instanceof GitCommandError && error.kind === kind;
}

interface SpawnGitOptions {
  maxBytes?: number;
  execName?: string;
  /** 0 disables the timeout and never kills on output volume (user-owned hooks); otherwise 1 ms to 10 minutes, default 120 s. */
  timeoutMs?: number;
  allowTruncated?: boolean;
}

const PROVIDER_CREDENTIAL_NAMES = new Set([
  'GOOGLE_GEMINI_API_KEY',
  'GCM_FREELLMAPI_TOKEN',
  'LM_API_TOKEN',
]);
const CHILD_KILL_GRACE_MS = 2_000;
const DEFAULT_GIT_OUTPUT_BYTES = BYTES_PER_KIBIBYTE * KIBIBYTES_PER_MEBIBYTE;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_TIMEOUT_MINUTES = 10;
const MAX_GIT_TIMEOUT_MS =
  MAX_GIT_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const MAX_STDERR_KIBIBYTES = 64;
const MAX_STDERR_BYTES = MAX_STDERR_KIBIBYTES * BYTES_PER_KIBIBYTE;
const DEFAULT_STREAM_OUTPUT_MEBIBYTES = 50;
const DEFAULT_STREAM_OUTPUT_BYTES =
  DEFAULT_STREAM_OUTPUT_MEBIBYTES * BYTES_PER_KIBIBYTE * KIBIBYTES_PER_MEBIBYTE;

interface KillState {
  killed: boolean;
  markKilled: () => void;
}

function validateSpawnOutcome(options: {
  args: string[];
  execName: string;
  code: number;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  killed: boolean;
  allowTruncated: boolean | undefined;
}): void {
  if (options.truncated && options.allowTruncated !== true) {
    throw new Error(
      `${options.execName} ${options.args.join(' ')} output was truncated`,
    );
  }
  if (options.timedOut) {
    throw new Error(`git ${options.args.join(' ')} timed out`);
  }
  if (options.code !== 0 && !options.killed) {
    throw new GitCommandError(
      `${options.execName} ${options.args.join(' ')} failed: ${options.stderr}`,
      classifyGitFailure(options.stderr),
    );
  }
}

export function childEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PROVIDER_CREDENTIAL_NAMES.has(entry[0]),
    ),
  );
}

interface SpawnGitLinesResult {
  lines: string[];
  truncated: boolean;
}

export interface SpawnGitStreamResult {
  text: string;
  truncated: boolean;
}

async function killSpawnedChild(
  child: ReturnType<typeof Bun.spawn>,
  state: KillState,
): Promise<void> {
  if (state.killed || child.exitCode !== null) {
    return;
  }
  const alreadyExited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1).then(() => false),
  ]);
  if (alreadyExited) {
    return;
  }
  state.markKilled();
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
  }, CHILD_KILL_GRACE_MS);
  void child.exited.then(() => {
    clearTimeout(forceKillTimer);
  });
}

async function spawnCore(
  args: string[],
  onChunk: (chunk: string) => void,
  options: SpawnGitOptions = {},
  defaultMaxBytes = DEFAULT_GIT_OUTPUT_BYTES,
): Promise<{ truncated: boolean }> {
  const maxBytes = integerInRange(options.maxBytes, {
    minimum: 1,
    maximum: MAX_CHILD_OUTPUT_BYTES,
    fallback: defaultMaxBytes,
  });
  const timeoutMs =
    options.timeoutMs === 0
      ? undefined
      : integerInRange(options.timeoutMs, {
          minimum: 1,
          maximum: MAX_GIT_TIMEOUT_MS,
          fallback: DEFAULT_GIT_TIMEOUT_MS,
        });
  const execName = options.execName ?? 'git';
  const child = Bun.spawn({
    cmd: [execName, ...args],
    env: childEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let bytes = 0;
  const outcome = { truncated: false, timedOut: false };
  let killed = false;
  const killState: KillState = {
    get killed() {
      return killed;
    },
    markKilled() {
      killed = true;
    },
  };
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          outcome.timedOut = true;
          void killSpawnedChild(child, killState);
        }, timeoutMs);

  const stdoutTask = (async (): Promise<void> => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- stream chunks must be read in order.
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail !== '' && !outcome.truncated) {
          onChunk(tail);
        }
        break;
      }
      if (outcome.truncated) {
        continue;
      }
      if (bytes + value.byteLength > maxBytes) {
        outcome.truncated = true;
        onChunk(
          decoder.decode(value.subarray(0, maxBytes - bytes), { stream: true }),
        );
        // Hooks may outlive the cap: keep draining so git can finish its write.
        if (options.timeoutMs === 0) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- stream must stop only after ordered child termination.
        await killSpawnedChild(child, killState);
        break;
      }
      bytes += value.byteLength;
      onChunk(decoder.decode(value, { stream: true }));
    }
  })();

  const stderrTask = (async (): Promise<string> => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let stderr = '';
    let stderrBytes = 0;
    const maxStderrBytes = MAX_STDERR_BYTES;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- stream chunks must be read in order.
      const { done, value } = await reader.read();
      if (done) {
        if (stderrBytes <= maxStderrBytes) {
          stderr += decoder.decode();
        }
        break;
      }
      stderrBytes += value.byteLength;
      if (stderrBytes <= maxStderrBytes) {
        stderr += decoder.decode(value, { stream: true });
      }
    }
    return stderr;
  })();

  await stdoutTask;
  const [code, stderr] = await Promise.all([child.exited, stderrTask]);
  clearTimeout(timeout);
  validateSpawnOutcome({
    args,
    execName,
    code,
    stderr,
    truncated: outcome.truncated,
    timedOut: outcome.timedOut,
    killed: killState.killed,
    allowTruncated: options.allowTruncated,
  });
  return { truncated: outcome.truncated };
}

export async function spawnGitLines(
  args: string[],
  options: SpawnGitOptions = {},
): Promise<SpawnGitLinesResult> {
  const lines: string[] = [];
  let buf = '';
  const { truncated } = await spawnCore(
    args,
    (chunk) => {
      buf += chunk;
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        lines.push(buf.slice(0, idx + 1));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
      }
    },
    options,
  );
  if (buf.length > 0) {
    lines.push(buf);
  }
  return { lines, truncated };
}

export type GitCommandRunner = typeof spawnGitStream;

export async function spawnGitStream(
  args: string[],
  options: SpawnGitOptions = {},
): Promise<SpawnGitStreamResult> {
  let text = '';
  const { truncated } = await spawnCore(
    args,
    (chunk) => {
      text += chunk;
    },
    options,
    DEFAULT_STREAM_OUTPUT_BYTES,
  );
  return { text, truncated };
}

export function literalPathspec(path: string): string {
  return `:(top,literal)${path}`;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}
