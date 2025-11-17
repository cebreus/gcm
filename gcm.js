#!/usr/bin/env node

/*
 gcm.js — Generate conventional commit messages, branch names and PR
 descriptions using Google Gemini (Generative Language API).

 Usage:
     - Default (staged changes):
             ./gcm.js
     - For a specific commit (SHA):
             ./gcm.js --commit <sha>
             ./gcm.js -c <sha>

 Notes:
     - You must set the environment variable `GOOGLE_GEMINI_API_KEY`.
     - Run this script inside a git repository.
     - On error the script prints a short message and exits with a non-zero status.
    - The `--commit` to target a commit.
    - Environment variables (optional):
        - `GCM_MAX_BUFFER` — global child-process read buffer (bytes). See [1] in `CONFIG`.
        - `GCM_MAX_INPUT_TOKENS` — soft input token limit to apply (see [11]).
        - `GCM_MAX_INPUT_TOKENS_SAFETY_FACTOR` — reduce allowed input fraction (see [12]).
        - `GCM_MODEL` / `GEMINI_MODEL` — named model to use (see [5]).
        - `GCM_MAX_OUTPUT_TOKENS` — max output tokens requested from the generation (see [10]).
        - `GCM_MAX_HUNKS` — how many hunks to keep for the final prompt (K); default 16 (see [2]).
        - `GCM_ENABLE_HUNK_WEIGHTS` — when true, apply file importance weights; default false (see [13]).
        - `GCM_TEMPERATURE` — generation temperature (see [6]).
        - `GCM_ENABLE_THINKING` — set to `true` to request thinking mode (see [7]).
        - `GCM_FILE_CONCURRENCY` — concurrent per-file streaming limit (see [3]).
        - `GCM_PER_FILE_BUFFER` — per-file bytes read limit (see [4]).
        - TIP: If you have `bun` installed prefer `bun` CLI for faster runtime: `bun /path/to/gcm.js`.
*/

import { execSync, spawn } from 'child_process';

// [1] CHILD_PROCESS_MAX_BUFFER (bytes) — Global child-process read buffer size (fallback safety).
//     - Default: 50 * 1024 * 1024 (50 MB)
//     - Env: `GCM_MAX_BUFFER`.
// [2] MAX_HUNKS (integer) — How many hunks to keep for the final LLM prompt (K). Default: 16.
//     - Unit: hunks (count)
//     - Behavior: Selects the top K hunks by a simple score; smaller K reduces tokens and cost.
//     - Env: `GCM_MAX_HUNKS`.
// [3] FILE_CONCURRENCY (integer) — Number of files processed concurrently when streaming diffs.
//     - Default: 6 (tread lightly with high concurrency to avoid CPU/process overhead).
//     - Env: `GCM_FILE_CONCURRENCY`.
// [4] PER_FILE_BUFFER (bytes) — Maximum bytes read per individual file when streaming hunks.
//     - Default: 2 * 1024 * 1024 (2 MB)
//     - Env: `GCM_PER_FILE_BUFFER`.
// [5] MODEL_NAME (string) — Gemini model name used for generation (e.g. gemini-2.5-flash).
//     - Env: `GCM_MODEL` or `GEMINI_MODEL`.
// [6] TEMPERATURE (float) — Model sampling temperature (0.0–2.0; higher = more random).
//     - Default: 1
//     - Env: `GCM_TEMPERATURE` or `GEMINI_TEMP`.
// [7] ENABLE_THINKING (boolean) — Whether to request the LLM 'thinking' mode (if supported).
//     - Default: false
//     - Env: `GCM_ENABLE_THINKING`.
// [8] TOKEN_BYTES_RATIO (float) — Heuristic ratio to convert bytes to approximate token count.
//     - Default: 3.5 (bytes per token estimate)
//     - Env: `GCM_TOKEN_BYTES_RATIO`.
// [9] MAX_CONTEXT_TOKENS (integer) — Model's context window size, used as a guard.
//     - Default: 1_048_576 (a high default; adjust as necessary for your model's real limits).
//     - Env: `GCM_MAX_CONTEXT_TOKENS`.
// [10] MAX_OUTPUT_TOKENS (integer) — Requested maximum number of output tokens for the generation.
//     - Default: 8192
//     - Env: `GCM_MAX_OUTPUT_TOKENS`.
// [11] MAX_INPUT_TOKENS (integer) — Soft cap for input tokens sent to the model to control quota.
//     - Default: 200_000
//     - Env: `GCM_MAX_INPUT_TOKENS`.
// [12] MAX_INPUT_TOKENS_SAFETY_FACTOR (float 0..1) — Multiply usable token budget by this factor.
//     - Default: 0.5
//     - Env: `GCM_MAX_INPUT_TOKENS_SAFETY_FACTOR`.
// [13] ENABLE_HUNK_WEIGHTS (boolean) — If true, apply additional file-based importance weights
//     during hunk scoring (e.g., prefer source code files). Default: false.
//     - Env: `GCM_ENABLE_HUNK_WEIGHTS`.

const CONFIG = {
    CHILD_PROCESS_MAX_BUFFER: Number(process.env.GCM_MAX_BUFFER) || 50 * 1024 * 1024, // [1]
    MAX_HUNKS: Number(process.env.GCM_MAX_HUNKS || 16), // [2]
    FILE_CONCURRENCY: Number(process.env.GCM_FILE_CONCURRENCY || 6), // [3]
    PER_FILE_BUFFER: Number(process.env.GCM_PER_FILE_BUFFER || 2 * 1024 * 1024), // [4]
    MODEL_NAME: process.env.GCM_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash', // [5]
    TEMPERATURE: Number(process.env.GCM_TEMPERATURE || process.env.GEMINI_TEMP || 1), // [6]
    ENABLE_THINKING: (process.env.GCM_ENABLE_THINKING || 'false') === 'true', // [7]
    TOKEN_BYTES_RATIO: Number(process.env.GCM_TOKEN_BYTES_RATIO || 3.5), // [8]
    MAX_CONTEXT_TOKENS: Number(process.env.GCM_MAX_CONTEXT_TOKENS || 1048576), // [9]
    MAX_OUTPUT_TOKENS: Number(process.env.GCM_MAX_OUTPUT_TOKENS || 8192), // [10]
    MAX_INPUT_TOKENS: Number(process.env.GCM_MAX_INPUT_TOKENS || 200000), // [11]
    MAX_INPUT_TOKENS_SAFETY_FACTOR: Number(process.env.GCM_MAX_INPUT_TOKENS_SAFETY_FACTOR || 0.5), // [12]
    ENABLE_HUNK_WEIGHTS: (process.env.GCM_ENABLE_HUNK_WEIGHTS || 'false') === 'true', // [13]
};

const SYSTEM_INSTRUCTIONS = `You are an expert at writing concise, professional conventional commit messages.

Output format (follow exactly):

BRANCH: [Generated branch name]
COMMIT_MESSAGE: [Generated conventional commit message]
PR_TITLE: [Generated pull request title]
PR_DESCRIPTION: [Generated pull request description]

--- RULES ---
1. **Branch Name**: Format: \`type/short-description\`, Types: feat, fix, refactor, chore, docs
2. **Commit Message** (MOST IMPORTANT): First line: \`type(scope): short summary\` (max 60 chars), Blank line, Body: Bullet points with dash (-), each line max 80 chars, Focus on WHAT changed, not WHY or HOW, Group related changes together, Be specific but concise, If breaking change, add \`BREAKING CHANGE:\` footer
3. **PR Title**: Same as commit first line, Max 60 characters
4. **PR Description**: 2-3 paragraphs maximum, Bulleted list of key changes, Use GitHub-flavored Markdown`;

const C = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m'
};
const encoder = new TextEncoder();
const args = process.argv.slice(2);
const commitIdx = args.findIndex(a => a === '--commit' || a === '-c' || a.startsWith('--commit='));
let TARGET_COMMIT = null;
if (commitIdx >= 0) {
    if (args[commitIdx].startsWith('--commit=')) {
        TARGET_COMMIT = args[commitIdx].split('=')[1];
    } else {
        TARGET_COMMIT = args[commitIdx + 1];
    }
}

/**
 * Estimate the number of LLM tokens for a string.
 * Uses a simple heuristic: bytes / TOKEN_BYTES_RATIO.
 *
 * @param {string} text
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
    return Math.ceil(encoder.encode(text).length / CONFIG.TOKEN_BYTES_RATIO);
}

/**
 * Load staged changes or a commit's changes as a single diff string and file list.
 *
 * @param {string|null} commit - Optional commit SHA; if not provided, staged changes are used.
 * @returns {Promise<{stagedDiff: string, stagedFiles: string[], truncated: boolean}|null>}
 */
async function loadChanges(commit) {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    let diff, rawNames;
    let diffTruncated = false;
    if (commit) {
        const got = await runCmdStream(`git show -w ${commit}`);
        diff = got.text;
        diffTruncated = got.truncated;
        if (!diff.trim()) {
            console.log(`No changes found in commit ${commit}.`);
            return null;
        }
        rawNames = (await runCmdStream(`git show -w --name-only --pretty=format: ${commit}`)).text.trim();
    } else {
        const got = await runCmdStream('git diff --staged -w');
        diff = got.text;
        diffTruncated = got.truncated;
        if (!diff.trim()) {
            console.log('No staged changes found. Use `git add` to stage files for commit.');
            return null;
        }
        rawNames = (await runCmdStream('git diff --staged -w --name-only')).text.trim();
    }
    const files = rawNames ? rawNames.split('\n').filter(Boolean) : [];
    return { stagedDiff: diff, stagedFiles: files, truncated: diffTruncated };
}
/**
 * Run a shell command streaming into memory with an adjustable max buffer. If the
 * output grows too large the process is killed and the `truncated` flag will be true.
 *
 * @param {string} cmd - shell command
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
function runCmdStream(cmd, opts = {}) {
    const maxBytes = opts.maxBytes ?? CONFIG.CHILD_PROCESS_MAX_BUFFER;
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let bytes = 0;
        let truncated = false;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                truncated = true;
                try { child.kill(); } catch { /* ignore */ }
                return;
            }
            stdout += chunk;
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (err) => reject(err));
        child.on('close', (code, signal) => {
            if (code !== 0) {
                const err = new Error(`Command exited with ${code} ${signal ?? ''}: ${stderr}`);
                err.code = code;
                return reject(err);
            }
            // Resolve with object to indicate whether truncated.
            resolve({ text: stdout, truncated });
        });
    });
}

/**
 * Detect the current JavaScript runtime (bun or node).
 * @returns {'bun'|'node'} Runtime indicator
 */
function detectRuntime() {
    try {
        if (typeof Bun !== 'undefined') return 'bun';
    } catch {}
    try { if (process && process.release && process.release.name === 'bun') return 'bun'; } catch {}
    return 'node';
}

/**
 * A simple file importance heuristic based on the filename extension.
 * Returns a small integer weight used in hunk scoring; higher => more important.
 *
 * @param {string} file - The path/name of the file
 * @returns {number}
 */
function fileImportanceWeight(file) {
    // Keep it simple and flexible: weights can be refined later.
    if (!file) return 0;
    const lower = file.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.jsx') || lower.endsWith('.tsx') || lower.endsWith('.svelte')) return 10;
    if (lower.endsWith('.html') || lower.endsWith('.hbs') || lower.endsWith('.njk')) return 6;
    if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.sass')) return 4;
    if (lower.match(/\.(png|jpg|jpeg|gif|ico|svg)$/)) return 0;
    // default small weight
    return 1;
}

/**
 * Keep a top-K list of hunks by score. This replaces the minimum-scoring hunk when
 * a higher-scoring one is found, while keeping the data structure simple.
 *
 * @param {Array} array - The array storing top hunks
 * @param {object} hunk - Hunk object with a numeric 'score' property
 * @param {number} maxSize - Maximum capacity of the array
 */
function pushHunkToTop(array, hunk, maxSize) {
    // Simple top-K: maintain array of top hunks by score.
    if (array.length < maxSize) {
        array.push(hunk);
        return;
    }
    // find index of min
    let minIdx = 0;
    for (let i = 1; i < array.length; i++) if (array[i].score < array[minIdx].score) minIdx = i;
    if (hunk.score > array[minIdx].score) array[minIdx] = hunk;
}

/**
 * Spawn a shell command and return the output as an array of lines. Enforces a per-file
 * byte limit to avoid keeping arbitrarily large data in memory. The returned `truncated`
 * flag indicates whether we had to kill the child due to exceeding `maxBytes`.
 *
 * @param {string} cmd - shell command to run
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<{lines: string[], truncated: boolean}>}
 */
async function spawnLines(cmd, { maxBytes = CONFIG.PER_FILE_BUFFER } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        let bytes = 0;
        let truncated = false;
        const lines = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                truncated = true;
                try { child.kill(); } catch { /* ignore */ }
                return;
            }
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                lines.push(buf.slice(0, idx + 1));
                buf = buf.slice(idx + 1);
            }
        });
        child.stderr.setEncoding('utf8');
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (buf.length) lines.push(buf);
            if (code !== 0 && !truncated) return reject(new Error(`Command ${cmd} failed: ${stderr}`));
            resolve({ lines, truncated });
        });
    });
}

// Simpler behavior: just sample the staged files and return first N bytes to send to LLM.
/**
 * Build a summary of the staged diff by collecting top-ranked hunks across files.
 * Streaming per-file diffs, parsing hunks, scoring them, and selecting the top K.
 *
 * @param {string[]} stagedFiles - list of files with staged changes
 * @returns {Promise<string>} - composed summary text to send to the LLM
 */
async function summarizeLargeDiff(stagedFiles) {
    // Build a concise summary by selecting top-ranked hunks from each file using a simple heuristic.
    const stats = (await runCmdStream('git diff --staged -w --stat --stat-width=80')).text;
    const topHunks = [];
    let totalTruncated = 0;
    const maxHunks = CONFIG.MAX_HUNKS;
    const concurrency = CONFIG.FILE_CONCURRENCY;
    // simple queue of files to process
    let idx = 0;
    /**
     * Worker used by a small pool to stream and parse file hunks.
     * Each worker will: run `git diff` for a single file, parse hunks, score them and
     * insert the top hunks into the shared `topHunks` array using `pushHunkToTop`.
     */
    async function worker() {
        while (idx < stagedFiles.length) {
            const file = stagedFiles[idx++];
            try {
                // skip likely-generated or binary files
                const lower = file.toLowerCase();
                if (lower.match(/\.(png|jpg|jpeg|gif|ico|svg|eot|ttf|woff|woff2|map)$/)) continue;
                const cmd = `git diff --staged -w -U1 -- "${file}"`;
                const { lines, truncated } = await spawnLines(cmd, { maxBytes: CONFIG.PER_FILE_BUFFER });
                if (truncated) totalTruncated++;
                // parse hunks
                let cur = null;
                for (const rawLine of lines) {
                    const line = rawLine.replace(/\r?\n$/, '');
                    if (line.startsWith('@@')) {
                        if (cur) pushHunkToTop(topHunks, cur, maxHunks);
                        cur = { file, header: line, content: '', added: 0, removed: 0, bytes: 0, score: 0 };
                        continue;
                    }
                    if (!cur) continue; // only content within hunks
                    cur.content += line + '\n';
                    cur.bytes += line.length;
                    if (line.startsWith('+') && !line.startsWith('+++')) cur.added++;
                    if (line.startsWith('-') && !line.startsWith('---')) cur.removed++;
                }
                if (cur) pushHunkToTop(topHunks, cur, maxHunks);
            } catch (err) {
                // ignore errors for a single file but do not break whole run
            }
        }
    }
    // run workers
    const workers = Array(Math.max(1, Math.min(concurrency, stagedFiles.length))).fill(0).map(() => worker());
    await Promise.all(workers);
    // compute scores now and prune/format
    for (const h of topHunks) {
        const importance = CONFIG.ENABLE_HUNK_WEIGHTS ? fileImportanceWeight(h.file) : 0;
        h.score = (h.added + h.removed) + importance;
    }
    // sort by score desc
    topHunks.sort((a, b) => b.score - a.score);
    // Compose output but cap total bytes
    const limit = Math.floor(CONFIG.CHILD_PROCESS_MAX_BUFFER / 2);
    let out = `File changes summary:\n${stats}\n\n`;
    for (const h of topHunks) {
        const hText = `File: ${h.file}\n${h.header}\n${h.content}\n`;
        if (out.length + hText.length > limit) {
            out += `\n... (${topHunks.length} hunks, ${totalTruncated} files truncated by per-file buffer) ...`;
            break;
        }
        out += hText;
    }
    return out;
}

// NOTE: displayResult defined below with JSDoc; remove duplicate definition above.

/**
 * Print parsed Gemini output to STDOUT with colored labels.
 *
 * @param {string} text - Raw Gemini output text which contains labeled sections (BRANCH, COMMIT_MESSAGE, ...)
 */
function displayResult(text) {
    const formatted = text.trim().replace(/^(?<label>BRANCH|COMMIT_MESSAGE|PR_TITLE|PR_DESCRIPTION):\s*(?<value>.*)$/gm, (...args) => {
        const { label, value } = args.at(-1);
        const color = (label === 'PR_TITLE' || label === 'PR_DESCRIPTION') ? C.magenta : C.cyan;
        return `\n${color}${C.bright}${label}:${C.reset}\n${value}`;
    });
    console.log('\n' + formatted + '\n');
}

/**
 * Print model usage statistics to STDOUT in a human-readable format.
 *
 * @param {string} modelName - Model name
 * @param {{promptTokens:number, outputTokens:number, thinkingTokens?:number}} usage - Token usage summary
 * @param {number} outputLength - Number of characters in the model output
 */
function reportStats(modelName, usage, outputLength) {
    let thinking = '';
    if (usage.thinkingTokens) {
        thinking = ` | thinking: ${usage.thinkingTokens}`;
    }
    console.log(`${C.dim}${modelName} | actual usage → input: ${usage.promptTokens} tokens | output: ${usage.outputTokens} tokens (${outputLength.toLocaleString()} chars)${thinking}${C.reset}\n`);
}

/**
 * Perform a call to the Gemini API using the configured model name and generation options.
 * Returns an object { text, usage }, where text is the generated text and usage contains token counts.
 *
 * @param {string} apiKey - GOOGLE_GEMINI_API_KEY
 * @param {string} userContent - user prompt text
 * @param {boolean} enableThinking - whether to enable 'thinking' mode
 * @returns {Promise<{text:string, usage: {promptTokens:number, outputTokens:number, thinkingTokens?:number}}>} - result
 */
async function callGemini(apiKey, userContent, enableThinking) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTIONS }] },
        generationConfig: { temperature: CONFIG.TEMPERATURE, maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS }
    };
    if (enableThinking) {
        body.generationConfig.thinkingConfig = { thinkingMode: 'THINKING_MODE_EXTENDED' };
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Gemini API failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (json.promptFeedback?.blockReason && json.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
        throw new Error(`Gemini blocked request: ${json.promptFeedback.blockReason}`);
    }
    for (const candidate of json.candidates || []) {
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts.map(p => p?.text ?? '').join('').trim();
            if (text) {
                const usage = json.usageMetadata || {};
                return {
                    text,
                    usage: {
                        promptTokens: usage.promptTokenCount || 0,
                        outputTokens: usage.candidatesTokenCount || 0,
                        thinkingTokens: candidate?.thinkingMetadata?.thinkingTokenCount
                    }
                };
            }
        }
    }
    throw new Error(`Gemini returned no text (finishReason=${json.candidates?.[0]?.finishReason ?? 'unknown'})`);
}

/**
 * Main script entrypoint: validate environment, build prompt from staged files or commit,
 * call Gemini and display the parsed output.
 */
async function run() {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
        console.error('Error: set GOOGLE_GEMINI_API_KEY before running.');
        process.exit(1);
    }
    try {
        if (TARGET_COMMIT) {
            console.log(`${C.dim}Using commit ${TARGET_COMMIT} for analysis${C.reset}`);
        }
        console.log(`${C.dim}Using top ${CONFIG.MAX_HUNKS} hunks (K=${CONFIG.MAX_HUNKS}); per-file weights enabled: ${CONFIG.ENABLE_HUNK_WEIGHTS}${C.reset}`);
        const staged = await loadChanges(TARGET_COMMIT);
        if (!staged) return;
        let input = staged.stagedDiff;
        const origLen = input.length;
        let promptSuffix = 'diff';
        if (input.length > CONFIG.CHILD_PROCESS_MAX_BUFFER) {
            console.log(`${C.yellow}Diff larger than buffer limit, creating concise summary...${C.reset}`);
            input = await summarizeLargeDiff(staged.stagedFiles);
            promptSuffix = 'summary and truncated diff';
        }
        let userContent = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following ${promptSuffix}.\n\n${input}`;
        if (staged.truncated) {
            userContent += '\n\nNote: The diff was truncated while being read due to buffer limits.';
        }
        const tokens = estimateTokens(userContent + '\n\n' + SYSTEM_INSTRUCTIONS);
        const usableTokens = Math.min(CONFIG.MAX_CONTEXT_TOKENS - CONFIG.MAX_OUTPUT_TOKENS - 32, CONFIG.MAX_INPUT_TOKENS);
        if (tokens > usableTokens) {
            const allowedBytes = Math.max(0, Math.floor(usableTokens * CONFIG.TOKEN_BYTES_RATIO * CONFIG.MAX_INPUT_TOKENS_SAFETY_FACTOR));
            input = input.substring(0, allowedBytes);
            userContent = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following ${promptSuffix} (input truncated to fit model context).\n\n${input}`;
            if (staged.truncated) userContent += '\n\nNote: Original diff was truncated by buffer limit, and prompt truncated to fit model context.';
            console.log(`${C.yellow}Input truncated to fit model context and avoid API quota limits.${C.reset}`);
            // re-estimate tokens after truncation
            const truncatedTokens = estimateTokens(userContent + '\n\n' + SYSTEM_INSTRUCTIONS);
            console.log(`${C.dim}After truncation → estimated input: ~${truncatedTokens} tokens${C.reset}`);
        }
        let summaryInfo = '';
        if (input.length !== origLen) {
            summaryInfo = ` | ${origLen.toLocaleString()} → ${input.length.toLocaleString()} chars`;
        }
        let thinkingStatus = '';
        if (CONFIG.ENABLE_THINKING) {
            thinkingStatus = ` ${C.yellow}(thinking)${C.reset}`;
        }
        console.log(`${C.dim}${CONFIG.MODEL_NAME}${summaryInfo} | estimated input: ~${tokens} tokens${thinkingStatus}${C.reset}`);
        // If runtime is Bun, mention it in debug output (we prefer Bun when available)
        const runtime = detectRuntime();
        console.log(`${C.dim}Runtime: ${runtime}${C.reset}`);
        const response = await callGemini(apiKey, userContent, CONFIG.ENABLE_THINKING);
        displayResult(response.text);
        reportStats(CONFIG.MODEL_NAME, response.usage, response.text.length);
    } catch (error) {
        const errStr = String(error);
        if (/Not a git repository/i.test(errStr)) {
            console.error('Error: Not inside a git repository.');
        } else if (/unknown revision/i.test(errStr)) {
            console.error(`Error: Invalid commit SHA: ${TARGET_COMMIT}`);
        } else {
            console.error(`Gemini commit helper failed: ${error}`);
        }
        process.exit(1);
    }
}

run();
