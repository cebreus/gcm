import { spawnGitLines, spawnGitStream } from './git-utils.js';
import type { SpawnGitLinesResult, SpawnGitStreamResult } from './git-utils.js';
import { fileImportanceWeight, pushHunkToTop } from './utils.js';
import type { Hunk } from './utils.js';
import { CONFIG } from '../gcm.config.js';
import { BINARY_EXTENSIONS } from './constants.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

function appendWithinLimit(text: string, suffix: string, maxBytes: number): string {
  const fittedSuffix = truncateUtf8(suffix, maxBytes);
  const remaining = maxBytes - encoder.encode(fittedSuffix).byteLength;
  return truncateUtf8(text, remaining) + fittedSuffix;
}

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

interface ProcessFileResult {
  skipped?: boolean;
  truncated?: boolean;
}

interface HunkAccumulator {
  topHunks: Hunk[];
  maxHunks: number;
}

function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || '';
}

function isConfigFile(filePath: string): boolean {
  const lowerFilePath = filePath.toLowerCase();
  const baseName = getBasename(lowerFilePath);

  // Generic pattern-based checks
  if (baseName.endsWith('.config.js') || baseName.endsWith('.config.ts')) return true;
  if (baseName.startsWith('.') && (baseName.endsWith('rc') || baseName.startsWith('.env'))) {
    return true;
  }
  if (
    lowerFilePath.includes('config.') ||
    lowerFilePath.includes('.lock') ||
    lowerFilePath.includes('-lock.')
  ) {
    return true;
  }

  // List of truly specific config files that don't fit a broader pattern
  const specificConfigs = ['bun.lockb'];
  if (specificConfigs.includes(baseName)) return true;

  return false;
}

function isBinaryFile(file: string): boolean {
  const lower = file.toLowerCase();
  const binaryPattern = new RegExp(`\\.(${BINARY_EXTENSIONS.join('|')})$`);
  return binaryPattern.test(lower);
}

function finalizeHunk(acc: HunkAccumulator, hunk: Hunk | null): void {
  if (!hunk) return;
  const importance = CONFIG.ENABLE_HUNK_WEIGHTS ? fileImportanceWeight(hunk.file) : 0;
  hunk.score = hunk.added + hunk.removed + importance;
  pushHunkToTop(acc.topHunks, hunk, acc.maxHunks);
}

function parseDiffLinesToHunks(file: string, lines: string[], acc: HunkAccumulator): void {
  let current: Hunk | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r?\n$/, '');
    if (line.startsWith('@@')) {
      finalizeHunk(acc, current);
      current = { file, header: line, content: '', added: 0, removed: 0, score: 0 };
      continue;
    }
    if (!current) continue;
    current.content += line + '\n';
    if (line.startsWith('+') && !line.startsWith('+++')) current.added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) current.removed += 1;
  }
  finalizeHunk(acc, current);
}

async function processFileForSummary(
  file: string,
  spawnLinesImpl: (
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<SpawnGitLinesResult>,
  acc: HunkAccumulator,
): Promise<ProcessFileResult> {
  if (isBinaryFile(file)) return { skipped: true };
  const contextLines = isConfigFile(file) ? 0 : 1;
  const { lines, truncated } = await spawnLinesImpl(
    ['diff', '--staged', '-w', `-U${contextLines}`, '--', file],
    {
      maxBytes: CONFIG.PER_FILE_BUFFER,
    },
  );
  parseDiffLinesToHunks(file, lines, acc);
  return { truncated };
}

function buildSkippedFilesSection(skippedFiles: string[]): string {
  if (!skippedFiles.length) return '';
  const perDirLimit = 15;
  const grouped = new Map<string, string[]>();
  for (const file of skippedFiles) {
    const parts = file.split(/[\\/]/);
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    const filesInDir = grouped.get(dir) || [];
    filesInDir.push(file);
    grouped.set(dir, filesInDir);
  }

  let section = 'Skipped binary files (content omitted):\n';
  for (const [dir, files] of grouped) {
    section += buildDirectorySkippedFilesLines(dir, files, perDirLimit);
  }
  return section + '\n';
}

function buildDirectorySkippedFilesLines(
  dir: string,
  files: string[],
  perDirLimit: number,
): string {
  let section = '';
  if (files.length <= perDirLimit) {
    section += `  ${dir}/\n`;
    for (const file of files) section += `    - ${file}\n`;
    return section;
  }
  section += `  ${dir}/ (showing ${perDirLimit} of ${files.length})\n`;
  for (let i = 0; i < perDirLimit; i++) section += `    - ${files[i]}\n`;
  section += `    - ... and ${files.length - perDirLimit} more\n`;
  return section;
}

async function collectSummaryData(
  stagedFiles: string[],
  spawnLinesImpl: (
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<SpawnGitLinesResult>,
  hunkAccumulator: HunkAccumulator,
): Promise<{ totalTruncated: number; skippedFiles: string[] }> {
  const results: ProcessFileResult[] = [];
  const skippedFiles: string[] = [];
  for (const file of stagedFiles) {
    const result = await processFileForSummary(file, spawnLinesImpl, hunkAccumulator);
    results.push(result);
    if (result?.skipped) skippedFiles.push(file);
  }
  return {
    totalTruncated: results.filter(result => result?.truncated).length,
    skippedFiles,
  };
}

function buildSummaryOutput(
  stats: string,
  topHunks: Hunk[],
  skippedFiles: string[],
  totalTruncated: number,
): string {
  const limitBytes = Math.floor(CONFIG.CHILD_PROCESS_MAX_BUFFER / 2);
  let output = `File changes summary:\n${stats}\n\n`;
  output += buildSkippedFilesSection(skippedFiles);

  for (const hunk of topHunks) {
    const hunkText = `File: ${hunk.file}\n${hunk.header}\n${hunk.content}\n`;
    if (encoder.encode(output + hunkText).byteLength > limitBytes) {
      return appendWithinLimit(
        output,
        `\n... (${topHunks.length} hunks, ${totalTruncated} files truncated by per-file buffer) ...`,
        limitBytes,
      );
    }
    output += hunkText;
  }
  return truncateUtf8(output, limitBytes);
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
  const hunkAccumulator: HunkAccumulator = { topHunks, maxHunks };
  const { totalTruncated, skippedFiles } = await collectSummaryData(
    stagedFiles,
    spawnLinesImpl,
    hunkAccumulator,
  );
  topHunks.sort((a, b) => b.score - a.score);
  const output = buildSummaryOutput(stats, topHunks, skippedFiles, totalTruncated);
  return { text: output, numHunks: topHunks.length, totalTruncated };
}
