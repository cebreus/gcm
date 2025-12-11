import { spawnGitLines, spawnGitStream } from './git-utils.js';
import type { SpawnGitLinesResult, SpawnGitStreamResult } from './git-utils.js';
import { fileImportanceWeight, pushHunkToTop } from './utils.js';
import type { Hunk } from './utils.js';
import { CONFIG } from '../gcm.config.js';

interface SummarizeLargeDiffOptions {
  spawnLinesImpl?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<SpawnGitLinesResult>;
  spawnStreamImpl?: (args: string[]) => Promise<SpawnGitStreamResult>;
}

interface SummarizeLargeDiffResult {
  text: string;
  numHunks: number;
  totalTruncated: number;
}

function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || '';
}

function isConfigFile(filePath: string): boolean {
  const lowerFilePath = filePath.toLowerCase();
  const baseName = getBasename(lowerFilePath);

  // Generic pattern-based checks
  if (baseName.endsWith('.config.js') || baseName.endsWith('.config.ts')) return true;
  if (baseName.startsWith('.') && (baseName.endsWith('rc') || baseName.startsWith('.env')))
    return true;
  if (
    lowerFilePath.includes('config.') ||
    lowerFilePath.includes('.lock') ||
    lowerFilePath.includes('-lock.')
  )
    return true;

  // List of truly specific config files that don't fit a broader pattern
  const specificConfigs = ['bun.lockb'];
  if (specificConfigs.includes(baseName)) return true;

  return false;
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
    if (/\.(png|jpg|jpeg|gif|ico|svg|eot|ttf|woff|woff2|map|heic)$/.exec(lower)) {
      // Record we skipped a binary-like file — contents are not useful for AI summarization.
      return { skipped: true };
    }

    const contextLines = isConfigFile(file) ? 0 : 1;
    const { lines, truncated } = await spawnLinesImpl(
      ['diff', '--staged', '-w', `-U${contextLines}`, '--', file],
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
  const skippedFiles: string[] = [];
  for (const file of stagedFiles) {
    // process sequentially (no concurrency)
    const r = await processFile(file);
    results.push(r);
    if (r?.skipped) skippedFiles.push(file);
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
  if (skippedFiles.length) {
    // Group skipped binary files by parent directory and show up to a per-dir cap so
    // we don't flood output when many files were moved/renamed in bulk.
    const perDirLimit = 15;
    const grouped = new Map<string, string[]>();
    for (const f of skippedFiles) {
      const parts = f.split(/[\\/]/);
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      const arr = grouped.get(dir) || [];
      arr.push(f);
      grouped.set(dir, arr);
    }

    out += `Skipped binary files (content omitted):\n`;
    for (const [dir, files] of grouped) {
      if (files.length <= perDirLimit) {
        out += `  ${dir}/\n`;
        for (const f of files) out += `    - ${f}\n`;
      } else {
        out += `  ${dir}/ (showing ${perDirLimit} of ${files.length})\n`;
        for (let i = 0; i < perDirLimit; i++) out += `    - ${files[i]}\n`;
        out += `    - ... and ${files.length - perDirLimit} more\n`;
      }
    }
    out += '\n';
  }

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
