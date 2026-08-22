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

async function killSpawnedChild(child: ReturnType<typeof Bun.spawn>, state: { killed: boolean }): Promise<void> {
  if (state.killed || child.exitCode !== null) return;
  const alreadyExited = await Promise.race([child.exited.then(() => true), Bun.sleep(1).then(() => false)]);
  if (alreadyExited) return;
  state.killed = true;
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

async function spawnCore(
  args: string[],
  onChunk: (chunk: string) => void,
  options: SpawnGitOptions = {},
): Promise<{ truncated: boolean }> {
  const maxBytes = options.maxBytes === undefined ? 1024 * 1024 : options.maxBytes;
  const execName = options.execName || 'git';
  const child = Bun.spawn({ cmd: [execName, ...args], stdout: 'pipe', stderr: 'pipe' });
  const dec = new TextDecoder();
  let bytes = 0;
  let truncated = false;
  const killState = { killed: false };

  const stdoutTask = (async (): Promise<void> => {
    const reader = child.stdout?.getReader();
    if (!reader) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        truncated = true;
        await killSpawnedChild(child, killState);
        break;
      }
      onChunk(chunk);
    }
  })();

  const stderrTask = (async (): Promise<string> => {
    const reader = child.stderr?.getReader();
    if (!reader) return '';
    let stderr = '';
    let stderrBytes = 0;
    const maxStderrBytes = 64 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      stderrBytes += chunk.length;
      if (stderrBytes <= maxStderrBytes) stderr += chunk;
    }
    return stderr;
  })();

  await stdoutTask;
  const [code, stderr] = await Promise.all([child.exited, stderrTask]);
  if (code !== 0 && !killState.killed) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + stderr);
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
