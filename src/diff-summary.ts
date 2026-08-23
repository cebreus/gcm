import { fileImportanceWeight, pushHunkToTop } from './utils.js';
import type { Hunk } from './utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DiffFileFacts {
  file: string;
  lines: string[];
  skipped: boolean;
  truncated: boolean;
}

export interface DiffSummaryPolicy {
  enableHunkWeights: boolean;
  maxHunks: number;
  maxOutputBytes: number;
}

export interface SummarizeDiffResult {
  text: string;
  numHunks: number;
  totalTruncated: number;
}

interface HunkAccumulator {
  topHunks: Hunk[];
  maxHunks: number;
  enableHunkWeights: boolean;
}

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

function finalizeHunk(acc: HunkAccumulator, hunk: Hunk | null): void {
  if (!hunk) return;
  const importance = acc.enableHunkWeights ? fileImportanceWeight(hunk.file) : 0;
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

function buildSkippedFilesSection(skippedFiles: string[]): string {
  if (!skippedFiles.length) return '';
  const perDirLimit = 15;
  const grouped = new Map<string, string[]>();
  for (const file of skippedFiles) {
    const parts = file.split(/[\\/]/);
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    const filesInDir = grouped.get(dir) ?? [];
    filesInDir.push(file);
    grouped.set(dir, filesInDir);
  }
  let section = 'Skipped binary files (content omitted):\n';
  for (const [dir, files] of grouped) {
    if (files.length <= perDirLimit) {
      section += `  ${dir}/\n`;
      for (const file of files) section += `    - ${file}\n`;
      continue;
    }
    section += `  ${dir}/ (showing ${perDirLimit} of ${files.length})\n`;
    for (let i = 0; i < perDirLimit; i++) section += `    - ${files[i]}\n`;
    section += `    - ... and ${files.length - perDirLimit} more\n`;
  }
  return section + '\n';
}

function buildSummaryOutput(
  stats: string,
  topHunks: Hunk[],
  skippedFiles: string[],
  totalTruncated: number,
  limitBytes: number,
): string {
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

export function summarizeDiff(
  stats: string,
  files: DiffFileFacts[],
  policy: DiffSummaryPolicy,
): SummarizeDiffResult {
  const topHunks: Hunk[] = [];
  const accumulator: HunkAccumulator = {
    topHunks,
    maxHunks: policy.maxHunks,
    enableHunkWeights: policy.enableHunkWeights,
  };
  for (const facts of files) {
    if (!facts.skipped) parseDiffLinesToHunks(facts.file, facts.lines, accumulator);
  }
  topHunks.sort((a, b) => b.score - a.score);
  const totalTruncated = files.filter(file => file.truncated).length;
  const skippedFiles = files.filter(file => file.skipped).map(file => file.file);
  return {
    text: buildSummaryOutput(stats, topHunks, skippedFiles, totalTruncated, policy.maxOutputBytes),
    numHunks: topHunks.length,
    totalTruncated,
  };
}
