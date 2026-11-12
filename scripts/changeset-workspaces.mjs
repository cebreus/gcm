/**
 * Workspace globs from package.json `workspaces` or the `packages` list of
 * pnpm-workspace.yaml.
 *
 * @param {{ workspaces?: unknown }} rootData Root package data.
 * @param {string | null} pnpmWorkspace pnpm-workspace.yaml text, if tracked.
 * @returns {string[]} Workspace globs; empty for a single package.
 */
function readWorkspacePatterns(rootData, pnpmWorkspace) {
  const { workspaces } = rootData;
  if (Array.isArray(workspaces)) {
    return workspaces;
  }
  const { packages } = /** @type {{ packages?: unknown }} */ (workspaces ?? {});
  if (Array.isArray(packages)) {
    return packages;
  }
  const lines = pnpmWorkspace?.split('\n') ?? [];
  const globs = [];
  for (const line of lines.slice(
    lines.indexOf('packages:') + 1 || lines.length,
  )) {
    const item = line.trim();
    if (!item.startsWith('-')) {
      break;
    }
    globs.push(
      item
        .slice(1)
        .trim()
        .replaceAll(/^['"]|['"]$/gu, ''),
    );
  }
  return globs;
}

/**
 * @param {string} glob Workspace glob without a leading `!`.
 * @returns {RegExp} Directory matcher.
 */
function globToRegExp(glob) {
  const source = glob
    .replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${source}$`, 'u');
}

/**
 * @param {string[]} globs Workspace globs.
 * @param {string} dir Package directory.
 * @returns {boolean} Whether any glob matches.
 */
function matchesAny(globs, dir) {
  return globs.some((glob) => globToRegExp(glob).test(dir));
}

/**
 * @param {string[]} patterns Workspace globs; `!` excludes.
 * @param {string[]} files Tracked paths.
 * @returns {string[]} Workspace package directories.
 */
function workspacePackageDirs(patterns, files) {
  const include = patterns.filter((glob) => !glob.startsWith('!'));
  const exclude = patterns
    .filter((glob) => glob.startsWith('!'))
    .map((glob) => glob.slice(1));
  return files
    .filter((file) => file.endsWith('/package.json'))
    .map((file) => file.slice(0, -'/package.json'.length))
    .filter((dir) => matchesAny(include, dir) && !matchesAny(exclude, dir));
}

/**
 * @param {{ workspaces?: unknown }} rootData Root package data.
 * @param {string[]} files Tracked paths.
 * @param {(file: string) => string} read Reads a tracked file.
 * @returns {string[] | null} Workspace package names; null for a single package.
 */
export function workspacePackageNames(rootData, files, read) {
  const pnpmWorkspace = files.includes('pnpm-workspace.yaml')
    ? read('pnpm-workspace.yaml')
    : null;
  const patterns = readWorkspacePatterns(rootData, pnpmWorkspace);
  if (patterns.length === 0) {
    return null;
  }
  return workspacePackageDirs(patterns, files).flatMap((dir) => {
    const file = `${dir}/package.json`;
    let data;
    try {
      data = /** @type {{ name?: unknown }} */ (JSON.parse(read(file)));
    } catch (error) {
      throw new Error(`Cannot read ${file}: ${String(error)}`, {
        cause: error,
      });
    }
    return typeof data.name === 'string' && data.name ? [data.name] : [];
  });
}
