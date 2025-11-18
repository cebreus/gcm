import { spawnGitLines, spawnGitStream } from './git-utils.js';
import type { SpawnGitLinesResult, SpawnGitStreamResult } from './git-utils.js';
import { fileImportanceWeight, pushHunkToTop } from './utils.js';
import { CONFIG } from '../gcm.config.js';

interface SummarizeLargeDiffOptions {
  spawnLinesImpl?: (args: string[], options?: any) => Promise<SpawnGitLinesResult>;
  spawnStreamImpl?: (args: string[]) => Promise<SpawnGitStreamResult>;
}

interface SummarizeLargeDiffResult {
  text: string;
  numHunks: number;
  totalTruncated: number;
}

interface Hunk {
  file: string;
  header: string;
  content: string;
  added: number;
  removed: number;
  bytes: number;
  score: number;
}

export async function summarizeLargeDiff(
  stagedFiles: string[],
  options?: SummarizeLargeDiffOptions,
): Promise<SummarizeLargeDiffResult> {
  const opts = options || {};
  const spawnLinesImpl = opts.spawnLinesImpl || spawnGitLines;
  const spawnStreamImpl = opts.spawnStreamImpl || spawnGitStream;
  if (!Array.isArray(stagedFiles)) throw new Error('stagedFiles must be an array');
  const statsResp = await spawnStreamImpl(['diff', '--staged', '-w', '--stat', '--stat-width=80']);
  const stats = statsResp.text;
  const topHunks: Hunk[] = [];
  const maxHunks = CONFIG.MAX_HUNKS;

  async function processFile(file: string): Promise<{ skipped?: boolean; truncated?: boolean }> {
    const lower = file.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|ico|svg|eot|ttf|woff|woff2|map)$/.exec(lower)) {
      return { skipped: true };
    }
    const { lines, truncated } = await spawnLinesImpl(
      ['diff', '--staged', '-w', '-U1', '--', file],
      {
        maxBytes: CONFIG.PER_FILE_BUFFER,
      },
    );
    // parse hunks
    let cur: Hunk | null = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r?\n$/, '');
      if (line.startsWith('@@')) {
        if (cur) {
          const importance = CONFIG.ENABLE_HUNK_WEIGHTS ? fileImportanceWeight(cur.file) : 0;
          cur.score = cur.added + cur.removed + importance;
          pushHunkToTop(topHunks, cur, maxHunks);
        }
        cur = { file, header: line, content: '', added: 0, removed: 0, bytes: 0, score: 0 };
        continue;
      }
      if (!cur) continue;
      cur.content += line + '\n';
      cur.bytes += Buffer.byteLength(line, 'utf8');
      if (line.startsWith('+') && !line.startsWith('+++')) cur.added += 1;
      if (line.startsWith('-') && !line.startsWith('---')) cur.removed += 1;
    }
    if (cur) {
      const importance = CONFIG.ENABLE_HUNK_WEIGHTS ? fileImportanceWeight(cur.file) : 0;
      cur.score = cur.added + cur.removed + importance;
      pushHunkToTop(topHunks, cur, maxHunks);
    }
    return { truncated };
  }
  const results = [];
  for (const file of stagedFiles) {
    // process sequentially (no concurrency)
    results.push(await processFile(file));
  }
  const totalTruncated = results.filter(function (r) {
    return r?.truncated;
  }).length;
  // Scores were computed before insertion into topHunks to allow pushHunkToTop
  // to operate on valid scores; no additional per-hunk compute needed here.
  topHunks.sort(function (a, b) {
    return b.score - a.score;
  });
  const limitBytes = Math.floor(CONFIG.CHILD_PROCESS_MAX_BUFFER / 2);
  let out = `File changes summary:\n${stats}\n\n`;
  for (const h of topHunks) {
    const hText = `File: ${h.file}\n${h.header}\n${h.content}\n`;
    if (out.length + hText.length > limitBytes) {
      out += `\n... (${topHunks.length} hunks, ${totalTruncated} files truncated by per-file buffer) ...`;
      break;
    }
    out += hText;
  }
  return { text: out, numHunks: topHunks.length, totalTruncated };
}
