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
*/

import { execSync, spawn } from 'child_process';

const CONFIG = {
    // Maximum bytes to collect from stream; if exceeded, child is killed and an ENOBUFS-like error is thrown.
    CHILD_PROCESS_MAX_BUFFER: Number(process.env.GCM_MAX_BUFFER) || 50 * 1024 * 1024,
    MAX_DIFF_CHARS: 10000,
    SUMMARY_PADDING: 500,
    MODEL_NAME: 'gemini-2.5-flash',
    TEMPERATURE: 1,
    ENABLE_THINKING: false,
    TOKEN_BYTES_RATIO: 3.5,
    MAX_CONTEXT_TOKENS: 1048576,
    MAX_OUTPUT_TOKENS: 8192
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

function estimateTokens(text) {
    return Math.ceil(encoder.encode(text).length / CONFIG.TOKEN_BYTES_RATIO);
}

async function loadChanges(commit) {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    let diff, rawNames;
    if (commit) {
        diff = await runCmdStream(`git show -w ${commit}`);
        if (!diff.trim()) {
            console.log(`No changes found in commit ${commit}.`);
            return null;
        }
        rawNames = (await runCmdStream(`git show -w --name-only --pretty=format: ${commit}`)).trim();
    } else {
        diff = await runCmdStream('git diff --staged -w');
        if (!diff.trim()) {
            console.log('No staged changes found. Use `git add` to stage files for commit.');
            return null;
        }
        rawNames = (await runCmdStream('git diff --staged -w --name-only')).trim();
    }
    const files = rawNames ? rawNames.split('\n').filter(Boolean) : [];
    return { stagedDiff: diff, stagedFiles: files };
}
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
            if (truncated) {
                const err = new Error('Command output exceeded max bytes');
                err.code = 'ENOBUFS';
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            if (code !== 0) {
                const err = new Error(`Command exited with ${code} ${signal ?? ''}: ${stderr}`);
                err.code = code;
                return reject(err);
            }
            resolve(stdout);
        });
    });
}

async function summarizeLargeDiff(stagedFiles) {
    const stats = await runCmdStream('git diff --staged -w --stat --stat-width=80');
    const parts = ['File changes summary:', stats];
    const available = CONFIG.MAX_DIFF_CHARS - CONFIG.SUMMARY_PADDING - stats.length;
    const diffs = [];
    for (const file of stagedFiles) {
        const diff = await runCmdStream(`git diff --staged -w -U1 -- "${file}"`);
        diffs.push({ file, diff, length: diff.length });
    }
    const totalSize = diffs.reduce((sum, d) => sum + d.length, 0);
    parts.push('\n--- Sample changes from all staged files ---');
    for (const { file, diff, length } of diffs) {
        const allocated = Math.floor((length / totalSize) * available);
        parts.push(`\nFile: ${file}`);
        parts.push(diff.length > allocated ? diff.substring(0, allocated) + '\n... (truncated)' : diff);
    }
    return parts.join('\n');
}

function displayResult(text) {
    const formatted = text.trim().replace(/^(?<label>BRANCH|COMMIT_MESSAGE|PR_TITLE|PR_DESCRIPTION):\s*(?<value>.*)$/gm, (...args) => {
        const { label, value } = args.at(-1);
        const color = (label === 'PR_TITLE' || label === 'PR_DESCRIPTION') ? C.magenta : C.cyan;
        return `\n${color}${C.bright}${label}:${C.reset}\n${value}`;
    });
    console.log('\n' + formatted + '\n');
}

function reportStats(modelName, usage, outputLength) {
    let thinking = '';
    if (usage.thinkingTokens) {
        thinking = ` | thinking: ${usage.thinkingTokens}`;
    }
    console.log(`${C.dim}${modelName} | actual usage → input: ${usage.promptTokens} tokens | output: ${usage.outputTokens} tokens (${outputLength.toLocaleString()} chars)${thinking}${C.reset}\n`);
}

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
        const staged = await loadChanges(TARGET_COMMIT);
        if (!staged) return;
        let input = staged.stagedDiff;
        const origLen = input.length;
        let promptSuffix = 'diff';
        if (input.length > CONFIG.MAX_DIFF_CHARS) {
            console.log(`${C.yellow}Diff too large (${input.length.toLocaleString()} chars), creating smart summary...${C.reset}`);
            input = await summarizeLargeDiff(staged.stagedFiles);
            promptSuffix = 'summary and truncated diff';
        }
        const userContent = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following ${promptSuffix}.\n\n${input}`;
        const tokens = estimateTokens(userContent + '\n\n' + SYSTEM_INSTRUCTIONS);
        const total = tokens + CONFIG.MAX_OUTPUT_TOKENS;
        if (total > CONFIG.MAX_CONTEXT_TOKENS) {
            console.log(`${C.yellow}⚠ Warning: Total tokens (${total}) exceeds context window (${CONFIG.MAX_CONTEXT_TOKENS})${C.reset}`);
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
