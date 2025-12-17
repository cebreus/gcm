interface BunSpawnOptions {
  cmd?: string[];
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  // Add other properties as needed based on Bun.spawnSync documentation
  // For now, keeping it minimal
}

interface SpawnGitOptions {
  maxBytes?: number;
  execName?: string;
}

export interface SpawnGitLinesResult {
  lines: string[];
  truncated: boolean;
}

export interface SpawnGitStreamResult {
  text: string;
  truncated: boolean;
}

export function runGitCmdSync(args: string[], opts: BunSpawnOptions = {}): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], stdout: 'pipe', stderr: 'pipe', ...opts });
  if (!proc.success) {
    const stderr = proc.stderr ? proc.stderr.toString() : '';
    throw new Error('git ' + args.join(' ') + ' failed: ' + stderr);
  }
  return proc.stdout ? proc.stdout.toString() : '';
}

async function spawnCore(
  args: string[],
  onChunk: (chunk: string) => void,
  options: SpawnGitOptions = {},
): Promise<{ truncated: boolean }> {
  const maxBytes = options.maxBytes === undefined ? 1024 * 1024 : options.maxBytes;
  const execName = options.execName || 'git';

  return await new Promise((resolve, reject) => {
    const child = Bun.spawn({ cmd: [execName, ...args], stdout: 'pipe', stderr: 'pipe' });
    const dec = new TextDecoder();
    let bytes = 0;
    let truncated = false;
    let killed = false;

    function killChild() {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
    }

    (async function () {
      try {
        const reader = child.stdout?.getReader();
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value);
          const chunkBytes = chunk.length;
          bytes += chunkBytes;
          if (bytes > maxBytes) {
            truncated = true;
            killChild();
            break;
          }
          onChunk(chunk);
        }
      } catch (e) {
        reject(e);
      }
    })();

    let stderr = '';
    let stderrBytes = 0;
    const maxStderrBytes = 64 * 1024;
    (async function () {
      try {
        const reader = child.stderr?.getReader();
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value);
          const chunkBytes = chunk.length;
          stderrBytes += chunkBytes;
          if (stderrBytes <= maxStderrBytes) stderr += chunk;
        }
      } catch {
        /* ignore */
      }
    })();

    (async function () {
      const code = await child.exited;
      if (!truncated && code !== 0) {
        reject(new Error('git ' + args.join(' ') + ' failed: ' + stderr));
        return;
      }
      resolve({ truncated });
    })();
  });
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
  // Default maxBytes for stream is higher
  if (options.maxBytes === undefined) options.maxBytes = 50 * 1024 * 1024;

  let text = '';
  const { truncated } = await spawnCore(
    args,
    chunk => {
      text += chunk;
    },
    options,
  );
  return { text, truncated };
}

export function ensureGitRepo(): boolean {
  try {
    const res = Bun.spawnSync({
      cmd: ['git', 'rev-parse', '--is-inside-work-tree'],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!res.success) throw new Error('not git');
    return true;
  } catch {
    return false;
  }
}
