import { homedir } from 'os';
import { join } from 'path';

export interface GCMSession {
  modelName: string | null;
  outputMode: 'full' | 'commit-only' | null;
}

const SESSION_FILE = join(homedir(), '.gcm-session.json');

export async function loadSession(): Promise<GCMSession> {
  try {
    const file = Bun.file(SESSION_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Ignore errors
  }
  return { modelName: null, outputMode: null };
}

export async function saveSession(session: GCMSession): Promise<void> {
  try {
    await Bun.write(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch {
    // Ignore errors
  }
}
