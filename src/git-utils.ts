interface BunSpawnOptions {
  cmd?: string[];
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  // Add other properties as needed based on Bun.spawnSync documentation
  // For now, keeping it minimal
}

export function runGitCmdSync(args: string[], opts: BunSpawnOptions = {}): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], stdout: 'pipe', stderr: 'pipe', ...opts });
  if (!proc.success) {
    const stderr = proc.stderr ? proc.stderr.toString() : '';
    throw new Error('git ' + args.join(' ') + ' failed: ' + stderr);
  }
  return proc.stdout ? proc.stdout.toString() : '';
}

interface SpawnGitOptions {
  maxBytes?: number;
  execName?: string;
}

export interface SpawnGitLinesResult {
  lines: string[];
  truncated: boolean;
}

export async function spawnGitLines(
  args: string[],
  options: SpawnGitOptions = {},
): Promise<SpawnGitLinesResult> {
  const maxBytes = options.maxBytes === undefined ? 1024 * 1024 : options.maxBytes;
  const execName = options.execName || 'git';
  return await new Promise(function (resolve, reject) {
    const child = Bun.spawn({ cmd: [execName, ...args], stdout: 'pipe', stderr: 'pipe' });
    const dec = new TextDecoder();
    let buf = '';
    let bytes = 0;
    let truncated = false;
    const lines: string[] = [];
    let killed = false;
    function killChild() {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch (_e) {
        /* ignore */
      }
      // fallback to SIGKILL in 2s if still alive
      setTimeout(function () {
        try {
          child.kill('SIGKILL');
        } catch (_e) {
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
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            lines.push(buf.slice(0, idx + 1));
            buf = buf.slice(idx + 1);
          }
        }
      } catch (_e) {
        reject(e);
      }
    })();
    // Bun's stderr is a ReadableStream; we handle decoding with TextDecoder
    let stderr = '';
    let stderrBytes = 0;
    const maxStderrBytes = 64 * 1024; // 64 KiB for stderr capture
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
      } catch (_e) {
        /* ignore */
      }
    })();
    (async function () {
      const code = await child.exited;
      if (buf.length) lines.push(buf);
      if (!truncated && code !== 0) {
        reject(new Error('git ' + args.join(' ') + ' failed: ' + stderr));
        return;
      }
      resolve({ lines, truncated });
    })();
  });
}

export interface SpawnGitStreamResult {
  text: string;
  truncated: boolean;
}

export async function spawnGitStream(
  args: string[],
  options: SpawnGitOptions = {},
): Promise<SpawnGitStreamResult> {
  let maxBytes = options.maxBytes === undefined ? 50 * 1024 * 1024 : options.maxBytes;
  const execName = options.execName || 'git';
  return await new Promise(function (resolve, reject) {
    const child = Bun.spawn({ cmd: [execName, ...args], stdout: 'pipe', stderr: 'pipe' });
    const dec = new TextDecoder();
    let out = '';
    let bytes = 0;
    let truncated = false;
    let killed = false;
    function killChild() {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch (_e) {
        /* ignore */
      }
      setTimeout(function () {
        try {
          child.kill('SIGKILL');
        } catch (_e) {
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
            const POST_KILL_CAPTURE = Math.min(1024 * 4, Math.max(1024, maxBytes));
            maxBytes = bytes + POST_KILL_CAPTURE;
            killChild();
            break;
          }
          out += chunk;
        }
      } catch (_e) {
        reject(e);
      }
    })();
    // Bun's stderr is a ReadableStream; we handle decoding with TextDecoder
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
      } catch (_e) {
        /* ignore */
      }
    })();
    (async function () {
      const code = await child.exited;
      if (!truncated && code !== 0) {
        reject(new Error('git ' + args.join(' ') + ' failed: ' + stderr));
        return;
      }
      resolve({ text: out, truncated });
    })();
  });
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
  } catch (_err) {
    return false;
  }
}
