import { spawnGitStream } from '../git-utils.js';
import { type ProjectConfig, parseProjectConfig } from '../project-config.js';

async function repositoryRoot(): Promise<string | null> {
  try {
    return (await spawnGitStream(['rev-parse', '--show-toplevel'])).text.trim();
  } catch {
    return null;
  }
}

export async function loadProjectConfig(): Promise<ProjectConfig> {
  const root = await repositoryRoot();
  if (root === null) {
    return {};
  }
  const file = Bun.file(`${root}/.gcmrc.json`);
  if (!(await file.exists())) {
    return {};
  }
  try {
    return parseProjectConfig(await file.text());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .gcmrc.json: ${reason}.`, { cause: error });
  }
}
