import { isRecord, stripTerminalControlSequences } from './utils.js';

export interface ProjectConfig {
  types?: string[];
  scopes?: string[];
  exclude?: string[];
  instructions?: string;
}

const KEYS = new Set(['types', 'scopes', 'exclude', 'instructions']);
const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function parseStringArray(value: unknown, key: 'types' | 'scopes' | 'exclude'): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error(`${key} must contain 1 to 50 items`);
  }
  if (value.some(item => typeof item !== 'string')) {
    throw new Error(`${key} items must be strings`);
  }
  const items = value as string[];
  if (items.some(item => item.length < 1 || item.length > 100)) {
    throw new Error(`${key} items must contain 1 to 100 characters`);
  }
  if (items.some(item => CONTROL_CHARACTER.test(item))) {
    throw new Error(`${key} items must not contain control characters`);
  }
  if (key !== 'exclude' && items.some(item => !IDENTIFIER.test(item))) {
    throw new Error(`${key} items must match /^[a-z][a-z0-9-]*$/`);
  }
  return items;
}

export function parseProjectConfig(text: string): ProjectConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid JSON');
  }
  if (!isRecord(value)) throw new Error('must be an object');
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) throw new Error(`unknown key "${key}"`);
  }
  const config: ProjectConfig = {};
  if (value.types !== undefined) config.types = parseStringArray(value.types, 'types');
  if (value.scopes !== undefined) config.scopes = parseStringArray(value.scopes, 'scopes');
  if (value.exclude !== undefined) config.exclude = parseStringArray(value.exclude, 'exclude');
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== 'string') throw new Error('instructions must be a string');
    if (value.instructions.length > 2000) {
      throw new Error('instructions must contain at most 2000 characters');
    }
    if (stripTerminalControlSequences(value.instructions) !== value.instructions) {
      throw new Error('instructions must not contain terminal control sequences');
    }
    config.instructions = value.instructions;
  }
  return config;
}
