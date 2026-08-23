import { homedir } from 'os';
import { join } from 'path';

export interface GCMSession {
  modelName: string | null;
  outputMode: 'full' | 'commit-only' | null;
}

const EMPTY_SESSION: GCMSession = { modelName: null, outputMode: null };
const SESSION_FILE = join(homedir(), '.gcm-session.json');

function isModelName(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 128) return false;
  return /^gemini-[a-z0-9._-]+$/i.test(value);
}

function isSession(value: unknown): value is GCMSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  if (!isModelName(session.modelName)) return false;
  return (
    session.outputMode === null ||
    session.outputMode === 'full' ||
    session.outputMode === 'commit-only'
  );
}

export async function loadSession(): Promise<GCMSession> {
  try {
    const file = Bun.file(SESSION_FILE);
    if (await file.exists()) {
      const session: unknown = await file.json();
      if (isSession(session)) return session;
    }
  } catch {
    // Ignore errors
  }
  return { ...EMPTY_SESSION };
}

export async function saveSession(session: GCMSession): Promise<void> {
  try {
    await Bun.write(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch {
    // Ignore errors
  }
}
