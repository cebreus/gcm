import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { text as readStream } from 'node:stream/consumers';

import { workspacePackageNames } from './changeset-workspaces.mjs';

/** @typedef {{ hash: string, subject: string }} CommitSubject */
/** @typedef {{ inheritsDecision?: boolean, isMerge?: boolean, releaseOutputsValid?: boolean }} ChangesetDecisionContext */
/** @typedef {{ names: string[], summary: string }} ParsedFrontmatter */
/** @typedef {{ baseline: string, reason: string }} ChangesetBaseline */
/** @typedef {{ code: number, message?: string }} GateResult */
/** @typedef {{ names: string[], workspace: boolean }} ReleaseNames */
/** @typedef {{ localRef: string, localSha: string, remoteRef: string, remoteSha: string }} PrePushUpdate */

// prettier-ignore
const NO_CHANGESET_REASONS = new Set('ci-only docs-only generated-only internal-refactor planning-only release-plumbing revert-unreleased test-only'.split(' '));
const CHANGESET_PATH = /^\.changeset\/[^/]+\.md$/;

/**
 * @param {unknown} error Error value.
 * @returns {string} Error text.
 */
function toErrorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} condition Required condition.
 * @param {string} message Failure text.
 * @returns {asserts condition}
 */
function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * @param {string} text JSON source.
 * @param {string} errorPrefix Failure context.
 * @returns {unknown} Parsed JSON.
 */
function parseJson(text, errorPrefix) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${errorPrefix}: ${toErrorText(error)}`, { cause: error });
  }
}

/**
 * @param {string[]} args Git arguments.
 * @param {{ allowFailure?: boolean }} [options] Execution options.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Git result.
 */
function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync('/usr/bin/git', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`git ${args[0]} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0 && !allowFailure) {
    const detail =
      result.stderr.trim() || `exit status ${String(result.status)}`;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return result;
}

/**
 * @param {string[]} args Git arguments.
 * @returns {string} Git standard output.
 */
function gitOutput(args) {
  return runGit(args).stdout;
}

/**
 * @param {string[]} args Git arguments.
 * @returns {boolean} Whether Git succeeds.
 */
function gitBoolean(args) {
  const result = runGit(args, { allowFailure: true });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}

/**
 * @param {string} ref Git revision.
 * @param {string} file Repository path.
 * @returns {string} File content.
 */
function readGitFile(ref, file) {
  return gitOutput(['show', ref === ':' ? `:${file}` : `${ref}:${file}`]);
}

/**
 * @param {string} text Package JSON.
 * @param {string} source Source name.
 * @returns {string} Package name.
 */
function parsePackageName(text, source) {
  // prettier-ignore
  const prefix = `Cannot read package name from ${source}`, packageData = /** @type {{ name?: unknown }} */ (parseJson(text, prefix));
  requireCondition(
    typeof packageData.name === 'string' && packageData.name.trim() !== '',
    `${prefix}: name must be a non-empty string`,
  );
  return packageData.name;
}

/**
 * @param {string} ref Git revision, or ':' for the index.
 * @returns {string[]} Tracked paths.
 */
function listFiles(ref) {
  // prettier-ignore
  const args = ref === ':' ? ['ls-files', '--cached'] : ['ls-tree', '-r', '--name-only', ref];
  return gitOutput(args).split('\n').filter(Boolean);
}

/**
 * Root package for a single-package repository; workspace packages otherwise.
 *
 * @param {string} ref Git revision, or ':' for the index.
 * @returns {ReleaseNames} Releasable package names.
 */
function readReleaseNames(ref) {
  const source = ref === ':' ? ':package.json' : `${ref}:package.json`;
  const text = readGitFile(ref, 'package.json');
  const rootName = parsePackageName(text, source);
  // prettier-ignore
  const names = workspacePackageNames(/** @type {{ workspaces?: unknown }} */ (parseJson(text, `Cannot read ${source}`)), listFiles(ref), (file) => readGitFile(ref, file));
  return names
    ? { names, workspace: true }
    : { names: [rootName], workspace: false };
}

/**
 * @param {string} message Commit message.
 * @returns {string} Subject line.
 */
function extractSubject(message) {
  const subject = message.split('\n').find((line) => line.trim());
  return subject?.trim() ?? '';
}

/**
 * @param {string[]} changes Changed paths from Git.
 * @returns {string[]} Changeset paths with statuses.
 */
function extractChangesets(changes) {
  return changes.flatMap((line) => {
    const [status, ...paths] = line.split('\t');
    return paths
      .filter((path) => CHANGESET_PATH.test(path))
      .map((path) => `${status}\t${path}`);
  });
}

/**
 * @param {string} ref Git revision.
 * @param {string} file Changeset path.
 * @returns {string} Content without quote style or extra blank lines.
 */
function releaseText(ref, file) {
  return readGitFile(ref, file)
    .replaceAll(/^(['"])([^'"\n]+)\1:/gmu, '$2:')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trimEnd();
}

/**
 * Drops Changeset edits that only restyle frontmatter quotes or collapse
 * blank lines, such as a formatter run; the release and its note stay the same.
 *
 * @param {string[]} changes Changed paths from Git.
 * @param {string} before Revision before the change.
 * @param {string} after Revision after the change.
 * @returns {string[]} Changes that affect releases.
 */
function withoutFormatOnlyChangesets(changes, before, after) {
  return changes.filter((line) => {
    const [status, file = ''] = line.split('\t');
    const restyled = status === 'M' && CHANGESET_PATH.test(file);
    return !restyled || releaseText(before, file) !== releaseText(after, file);
  });
}

/**
 * @param {string} reason Decision reason.
 * @param {string} subject Commit subject.
 * @param {string[]} changesets Changed Changesets.
 * @returns {string | null} Failure text or null.
 */
function validateNoChangesetReason(reason, subject, changesets) {
  if (!NO_CHANGESET_REASONS.has(reason)) {
    return `Unknown Changeset-Reason "${reason}".`;
  }
  if (reason !== 'revert-unreleased') {
    return changesets.length === 0
      ? null
      : 'Changeset: none commit must not add or modify Changeset files.';
  }
  const isScopedRevert =
    subject.startsWith('revert(') && subject.indexOf('):') > 7;
  if (
    !subject.startsWith('revert:') &&
    !subject.startsWith('Revert "') &&
    !isScopedRevert
  ) {
    return 'Changeset-Reason revert-unreleased requires a revert commit.';
  }
  return changesets.some((line) => line.startsWith('A\t'))
    ? 'Unreleased revert must not add a Changeset.'
    : null;
}

/**
 * @param {string} message Commit message.
 * @param {string} subject Commit subject.
 * @param {string[]} changesets Changed Changesets.
 * @returns {string | null | undefined} Failure text, null, or no decision.
 */
function validateNoChangesetDecision(message, subject, changesets) {
  const paragraphs = message.trimEnd().split(/\n\s*\n/);
  const trailerBlock = paragraphs.at(-1) ?? '';
  const lines = trailerBlock.split('\n');
  const decisions = lines.filter((line) => /^Changeset:\s*/.test(line));
  const reasons = lines.filter((line) => /^Changeset-Reason:\s*/.test(line));
  if (reasons.length > 0 && decisions.length === 0) {
    return 'Changeset-Reason requires Changeset: none.';
  }
  if (decisions.length === 0) {
    return undefined;
  }
  if (decisions.length !== 1 || decisions[0] !== 'Changeset: none') {
    return 'Changeset trailer must be exactly Changeset: none.';
  }
  if (reasons.length !== 1) {
    return 'Changeset: none requires exactly one Changeset-Reason trailer.';
  }
  const reason = reasons[0].slice('Changeset-Reason:'.length).trim();
  return validateNoChangesetReason(reason, subject, changesets);
}

// prettier-ignore
/**
 * @param {string} subject Commit subject.
 * @param {string[]} changesets Changed Changesets.
 * @param {string[]} remainingChangesets Changesets after release.
 * @param {boolean} releaseOutputsValid Required release files changed.
 * @returns {string | null | undefined} Failure text, null, or not release.
 */
function validateReleaseCommit(subject, changesets, remainingChangesets, releaseOutputsValid) {
  if (!/^chore\(release\): (?:v\d+\.\d+\.\d+|version packages)$/.test(subject)) {
    return undefined;
  }
  if (changesets.length === 0) {
    return 'Release commit must delete consumed Changesets.';
  }
  if (!changesets.every((line) => line.startsWith('D\t'))) {
    return 'Release commit must only delete consumed Changesets.';
  }
  if (!releaseOutputsValid) {
    return 'Release commit must update package.json and CHANGELOG.md.';
  }
  return remainingChangesets.length === 0
    ? null
    : `Release commit leaves ${remainingChangesets.length} pending Changeset(s).`;
}

// prettier-ignore
/**
 * @param {string[]} changesets Changed Changesets.
 * @param {string | undefined} reusableChangeset Reusable Changeset path.
 * @param {boolean} inheritsDecision Whether commit inherits a decision.
 * @returns {string | null | undefined} Failure text, null, or no inherited decision.
 */
function validateInheritedDecision(changesets, reusableChangeset, inheritsDecision) {
  const added = changesets.filter((line) => line.startsWith('A\t'));
  if (reusableChangeset && added.length > 0) {
    return 'Amend commit must only modify the reusable Changeset.';
  }
  if (!inheritsDecision && !reusableChangeset) {
    return undefined;
  }
  if (changesets.length === 0) {
    return null;
  }
  return reusableChangeset &&
    changesets.length === 1 &&
    changesets[0] === `M\t${reusableChangeset}`
    ? null
    : 'Inherited release decision must not add or replace Changeset files.';
}

/**
 * @param {string} content Changeset file content.
 * @returns {ParsedFrontmatter} Parsed frontmatter.
 */
function parseFrontmatter(content) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  requireCondition(lines[0] === '---', 'frontmatter must start with ---');
  const closingIndex = lines.indexOf('---', 1);
  requireCondition(closingIndex !== -1, 'frontmatter must end with ---');
  const releases = lines
    .slice(1, closingIndex)
    .filter((line) => line.trim() !== '');
  const names = releases.map((line) => {
    const match = line.match(
      /^\s*(?:(['"])([^'"]+)\1|([^:\s]+)):\s*(?:major|minor|patch)\s*$/,
    );
    requireCondition(match, `unsupported frontmatter line: ${line}`);
    return match[2] ?? match[3];
  });
  requireCondition(
    new Set(names).size === names.length,
    'duplicate package name in frontmatter',
  );
  return { names, summary: lines.slice(closingIndex + 1).join('\n') };
}

/**
 * @param {string} output NUL-separated hashes and subjects.
 * @returns {CommitSubject[]} Commit subjects.
 */
function parseCommitSubjects(output) {
  return output
    .split('\0')
    .flatMap((hash, index, fields) =>
      index % 2 === 0 && hash.trim()
        ? [{ hash: hash.trim(), subject: fields[index + 1] }]
        : [],
    );
}

/**
 * @param {string} message Commit message.
 * @param {string[]} stagedChanges Changed paths from Git.
 * @param {string[]} [remainingChangesets] Changesets present after commit.
 * @param {...*} decisionOptions Reusable Changeset path and validation context.
 * @returns {string | null} Failure text or null.
 */
// prettier-ignore
function validateChangesetCommit(message, stagedChanges, remainingChangesets = [], ...decisionOptions) {
  const [reusableChangeset, context = {}] = decisionOptions;
  const subject = extractSubject(message);
  const changesets = extractChangesets(stagedChanges);
  const releaseFailure = /^co-authored-by:/imu.test(message)
    ? 'Co-Authored-By trailer is not allowed; commits belong to the Git user'
    : validateReleaseCommit(
        subject,
        changesets,
        remainingChangesets,
        Boolean(context.releaseOutputsValid),
      );
  if (releaseFailure !== undefined) {
    return releaseFailure;
  }
  if (context.isMerge) {
    return null;
  }
  const noChangesetFailure = validateNoChangesetDecision(
    message,
    subject,
    changesets,
  );
  if (noChangesetFailure !== undefined) {
    return noChangesetFailure;
  }
  const inheritedFailure = validateInheritedDecision(
    changesets,
    reusableChangeset,
    Boolean(context.inheritsDecision),
  );
  if (inheritedFailure !== undefined) {
    return inheritedFailure;
  }
  const added = changesets.filter((line) => line.startsWith('A\t'));
  if (added.length !== 1) {
    return added.length === 0
      ? 'Commit must add exactly one .changeset/*.md file or declare Changeset: none; found 0.'
      : `Commit must add exactly one .changeset/*.md file; found ${added.length}.`;
  }
  return changesets.length === 1
    ? null
    : 'Non-release commit must only add one .changeset/*.md file.';
}

/**
 * @param {string} file Changeset path.
 * @param {string} content Changeset file content.
 * @param {string[]} packageNames Releasable package names.
 * @param {boolean} [workspace] Whether names are workspace packages.
 * @returns {string | null} Failure text or null.
 */
function validateChangesetContent(
  file,
  content,
  packageNames,
  workspace = false,
) {
  if (file === '.changeset/README.md') {
    return `${file}: reserved Changesets documentation file.`;
  }
  try {
    const parsed = parseFrontmatter(content);
    if (!parsed.summary.trim()) {
      return `${file}: empty public text.`;
    }
    if (parsed.names.length === 0) {
      return `${file}: no package release declared.`;
    }
    const foreign = parsed.names.find((name) => !packageNames.includes(name));
    if (foreign !== undefined) {
      return workspace
        ? `${file}: ${foreign} is not a workspace package.`
        : `${file}: only ${packageNames.join(', ')} can be released from this repository.`;
    }
  } catch (error) {
    return `${file}: invalid Changeset: ${toErrorText(error)}`;
  }
  return null;
}

/**
 * @param {string} message Commit message.
 * @param {CommitSubject[]} history Commit subjects newest first.
 * @returns {string | null} Target hash or null.
 */
function getReusableChangesetTarget(message, history) {
  const subject = extractSubject(message);
  const targetSubject = subject.match(/^(?:fixup|squash|amend)! (.+)$/)?.[1];
  return (
    history.find((commit) => commit.subject === targetSubject)?.hash ?? null
  );
}

/**
 * @param {string[]} changes Changed paths from Git.
 * @returns {boolean} Whether release outputs changed.
 */
function hasReleaseOutputs(changes) {
  const paths = new Set(changes.flatMap((line) => line.split('\t').slice(1)));
  return [...paths].some(
    (path) =>
      /(?:^|\/)package\.json$/u.test(path) &&
      paths.has(path.replace(/package\.json$/u, 'CHANGELOG.md')),
  );
}

/**
 * @param {string[]} args Git arguments.
 * @returns {string[]} Non-empty output lines.
 */
function gitLines(args) {
  return gitOutput(args).split('\n').filter(Boolean);
}

/**
 * @param {string} ref Git revision.
 * @param {string} [path] Optional path filter.
 * @returns {string[]} Changed paths with statuses.
 */
function listCommitChanges(ref, path) {
  const args = [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-status',
    '-r',
    ref,
  ];
  if (path) {
    args.push('--', path);
  }
  return gitLines(args);
}

/**
 * @param {string} message Commit message.
 * @param {CommitSubject[]} history Commit subjects newest first.
 * @returns {{ reusableChangeset: string | undefined, target: string | null | undefined }} Reusable Changeset data.
 */
function findReusableChangeset(message, history) {
  const target = history[0] && getReusableChangesetTarget(message, history);
  const changes = target ? listCommitChanges(target, '.changeset') : [];
  return {
    reusableChangeset:
      changes.length === 1 && /^A\t\.changeset\/[^/]+\.md$/.test(changes[0])
        ? changes[0].slice(2)
        : undefined,
    target,
  };
}

/**
 * @param {string[]} changes Changed paths from Git.
 * @param {string} ref Git revision.
 * @param {ReleaseNames} release Releasable package names.
 * @returns {string | null} Failure text or null.
 */
function validateAddedChangesets(changes, ref, release) {
  return (
    extractChangesets(changes)
      .filter((line) => /^[AM]/u.test(line))
      .map((line) =>
        validateChangesetContent(
          line.slice(2),
          readGitFile(ref, line.slice(2)),
          release.names,
          release.workspace,
        ),
      )
      .find(Boolean) ?? null
  );
}

/**
 * @param {string} sha Commit SHA.
 * @returns {string | null} Failure text or null.
 */
function validateCommitAt(sha) {
  const changes = withoutFormatOnlyChangesets(
    listCommitChanges(sha),
    `${sha}^`,
    sha,
  );
  const contentFailure = validateAddedChangesets(
    changes,
    sha,
    readReleaseNames(sha),
  );
  if (contentFailure) {
    return contentFailure;
  }
  const message = gitOutput(['log', '-1', '--format=%B', sha]);
  const history = parseCommitSubjects(
    gitOutput(['log', '--format=%H%x00%s%x00', sha]),
  );
  const reusable = findReusableChangeset(message, history);
  const parents = gitOutput(['rev-list', '--parents', '-n', '1', sha])
    .trim()
    .split(/\s+/);
  const remaining = gitLines([
    'ls-tree',
    '-r',
    '--name-only',
    sha,
    '--',
    '.changeset',
  ]).filter(
    (file) => CHANGESET_PATH.test(file) && file !== '.changeset/README.md',
  );
  return validateChangesetCommit(
    message,
    changes,
    remaining,
    reusable.reusableChangeset,
    {
      inheritsDecision: Boolean(reusable.target),
      isMerge: parents.length > 2,
      releaseOutputsValid: hasReleaseOutputs(changes),
    },
  );
}

/**
 * @param {string} head Checked head SHA.
 * @returns {ChangesetBaseline | null} Baseline data or null.
 */
function readBaseline(head) {
  gitOutput(['cat-file', '-e', `${head}^{commit}`]);
  const path = gitOutput([
    'ls-tree',
    '--name-only',
    head,
    '--',
    '.changeset/gate.json',
  ]).trim();
  if (!path) {
    return null;
  }
  // prettier-ignore
  const source = `${head}:.changeset/gate.json`, baselineData = /** @type {{ baseline?: unknown, reason?: unknown }} */ (parseJson(readGitFile(head, '.changeset/gate.json'), `Cannot read ${source}`));
  requireCondition(
    typeof baselineData.baseline === 'string' &&
      /^[a-f0-9]{40}$/u.test(baselineData.baseline) &&
      typeof baselineData.reason === 'string' &&
      baselineData.reason.trim() !== '',
    `Cannot read ${source}: baseline must be a full 40-hex SHA and reason must be a non-empty string`,
  );
  return /** @type {ChangesetBaseline} */ (baselineData);
}

/**
 * @param {string[]} commits Commit SHAs.
 * @param {string} head Checked head SHA.
 * @returns {GateResult} Gate result.
 */
function validateCommits(commits, head) {
  const baseline = readBaseline(head);
  if (
    baseline &&
    !gitBoolean(['merge-base', '--is-ancestor', baseline.baseline, head])
  ) {
    throw new Error(
      `${head.slice(0, 7)}: Baseline ${baseline.baseline} is not an ancestor of checked head.`,
    );
  }
  // prettier-ignore
  const checkedCommits = baseline ? commits.filter((sha) => !gitBoolean(['merge-base', '--is-ancestor', sha, baseline.baseline])) : commits;
  for (const sha of checkedCommits) {
    let failure;
    try {
      failure = validateCommitAt(sha);
    } catch (error) {
      throw new Error(`${sha.slice(0, 7)}: ${toErrorText(error)}`, {
        cause: error,
      });
    }
    if (failure) {
      return { code: 1, message: `${sha.slice(0, 7)}: ${failure}` };
    }
  }
  return { code: 0 };
}

/**
 * @param {string} message Commit message.
 * @returns {GateResult} Gate result.
 */
function runCommitMessage(message) {
  const changes = withoutFormatOnlyChangesets(
    gitLines(['diff', '--cached', '--name-status']),
    'HEAD',
    ':',
  );
  const contentFailure = validateAddedChangesets(
    changes,
    ':',
    readReleaseNames(':'),
  );
  if (contentFailure) {
    return { code: 1, message: contentFailure };
  }
  const history = gitBoolean(['rev-parse', '--verify', '--quiet', 'HEAD'])
    ? parseCommitSubjects(gitOutput(['log', '--format=%H%x00%s%x00']))
    : [];
  const reusable = findReusableChangeset(message, history);
  // prettier-ignore
  const remainingChangesets = gitLines(['ls-files', '--cached', '--', '.changeset']);
  const failure = validateChangesetCommit(
    message,
    changes,
    remainingChangesets.filter(
      (file) => CHANGESET_PATH.test(file) && file !== '.changeset/README.md',
    ),
    reusable.reusableChangeset,
    {
      inheritsDecision: Boolean(reusable.target),
      isMerge: gitBoolean(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']),
      releaseOutputsValid: hasReleaseOutputs(changes),
    },
  );
  return failure ? { code: 1, message: failure } : { code: 0 };
}

/**
 * @param {string | undefined} remote Remote name.
 * @param {string} input Pre-push input.
 * @returns {GateResult} Gate result.
 */
function runPrePush(remote, input) {
  requireCondition(remote, 'Remote name missing.');
  const updates = input
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      requireCondition(
        fields.length === 4,
        'Invalid pre-push input; expected four fields per line.',
      );
      const [localRef, localSha, remoteRef, remoteSha] = fields;
      /** @type {PrePushUpdate} */
      const update = { localRef, localSha, remoteRef, remoteSha };
      return update;
    })
    .filter((update) => !/^0+$/.test(update.localSha));
  for (const update of updates) {
    const revisionArgs = /^0+$/.test(update.remoteSha)
      ? [update.localSha, '--not', `--remotes=${remote}`]
      : [`${update.remoteSha}..${update.localSha}`];
    const commits = gitLines(['rev-list', '--reverse', ...revisionArgs]);
    const result = validateCommits(commits, update.localSha);
    if (result.code !== 0) {
      return result;
    }
  }
  return { code: 0 };
}

// Git removes `#` lines and the `commit -v` diff only after commit-msg hooks.
// shortcut: a fake scissors line in `-m` text is also cut; pre-push still checks it.
const EDITOR_NOISE = /^# -{24} >8 -{24}$[\s\S]*|^#.*(?:\r?\n|$)/gm;

/**
 * @param {string[]} argv Command arguments.
 * @param {string} [input] Hook input.
 * @returns {GateResult} Gate result.
 */
function runCli(argv, input = '') {
  try {
    const [mode, ...args] = argv;
    const runners = {
      'commit-msg': () => runCommitMessage(input.replaceAll(EDITOR_NOISE, '')),
      'pre-push': () => runPrePush(args[0], input),
      range: () => {
        const [base, head] = args;
        requireCondition(
          base && head,
          'Usage: changeset-gate.mjs range <base> <head>',
        );
        const commits = gitLines(['rev-list', '--reverse', `${base}..${head}`]);
        return validateCommits(commits, head);
      },
    };
    requireCondition(
      mode === 'commit-msg' || mode === 'pre-push' || mode === 'range',
      'Usage: changeset-gate.mjs commit-msg <message-file> | pre-push <remote> | range <base> <head>',
    );
    return runners[mode]();
  } catch (error) {
    return { code: 2, message: toErrorText(error) };
  }
}

export {
  getReusableChangesetTarget,
  validateChangesetCommit,
  validateChangesetContent,
};

/**
 * @param {string[]} argv Command arguments.
 * @returns {Promise<GateResult>} Gate result.
 */
async function main(argv) {
  const [mode, file] = argv;
  if (mode === 'commit-msg') {
    try {
      requireCondition(file, 'Commit message path missing.');
      return runCli(argv, await readFile(file, 'utf8'));
    } catch (error) {
      return { code: 2, message: toErrorText(error) };
    }
  }
  return runCli(
    argv,
    mode === 'pre-push' ? await readStream(process.stdin) : '',
  );
}

/**
 * Check whether this file is the process entry point. Real paths are compared,
 * so `#`, `%`, and symlinks in the path cannot silently skip the gate.
 *
 * @returns {boolean} True when run directly.
 */
function isCliEntry() {
  try {
    return realpathSync(import.meta.filename) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const result = await main(process.argv.slice(2));
  if (result.message) {
    process.stderr.write(`changeset-gate: ${result.message}\n`);
  }
  process.exitCode = result.code;
}
