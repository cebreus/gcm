import { homedir } from 'os';
import { join } from 'path';
import { isLanguageModelName, isLanguageModelProviderId } from './language-model-service.js';

export interface GCMSession {
  providerId: string | null;
  modelName: string | null;
  outputMode: 'full' | 'commit-only' | null;
}

const EMPTY_SESSION: GCMSession = { providerId: null, modelName: null, outputMode: null };
const SESSION_FILE = join(homedir(), '.gcm-session.json');

function isModelName(value: unknown): value is string | null {
  return value === null || isLanguageModelName(value);
}

function isOutputMode(value: unknown): value is GCMSession['outputMode'] {
  return value === null || value === 'full' || value === 'commit-only';
}

function isSession(value: unknown): value is GCMSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  if (!isLanguageModelProviderId(session.providerId)) return false;
  if (!isModelName(session.modelName)) return false;
  return isOutputMode(session.outputMode);
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
