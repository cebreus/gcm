import { homedir } from 'os';
import { join } from 'path';
import { isLanguageModelName, isLanguageModelProviderId } from './language-model-service.js';

export interface GCMSession {
  providerId: string | null;
  modelName: string | null;
}

const EMPTY_SESSION: GCMSession = { providerId: null, modelName: null };
// Read per call: Bun caches homedir() at start, so a HOME set later would be ignored.
function sessionFile(): string {
  const home = process.env.HOME ?? '';
  return join(home === '' ? homedir() : home, '.gcm-session.json');
}

function isModelName(value: unknown): value is string | null {
  return value === null || isLanguageModelName(value);
}

function isSession(value: unknown): value is GCMSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  if (!isLanguageModelProviderId(session.providerId)) return false;
  return isModelName(session.modelName);
}

export async function loadSession(): Promise<GCMSession> {
  try {
    const file = Bun.file(sessionFile());
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
    await Bun.write(sessionFile(), JSON.stringify(session, null, 2));
  } catch {
    // Ignore errors
  }
}
