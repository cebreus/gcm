import { spawnGitStream } from '../git-utils.js';
import { parseProjectConfig, type ProjectConfig } from '../project-config.js';

export async function loadProjectConfig(): Promise<ProjectConfig> {
  let root: string;
  try {
    root = (await spawnGitStream(['rev-parse', '--show-toplevel'])).text.trim();
  } catch {
    return {};
  }
  const file = Bun.file(root + '/.gcmrc.json');
  if (!(await file.exists())) return {};
  try {
    return parseProjectConfig(await file.text());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .gcmrc.json: ${reason}.`);
  }
}
