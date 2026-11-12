import { isRecord, stripTerminalControlSequences } from './utils.js';

export interface ProjectConfig {
  types?: string[];
  scopes?: string[];
  exclude?: string[];
  instructions?: string;
}

export const PROJECT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'types',
  'scopes',
  'exclude',
  'instructions',
]);
const IDENTIFIER = /^[a-z][a-z0-9\u002D]*$/v;
// eslint-disable-next-line no-control-regex -- config validation must reject control bytes
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/v;
const MAX_ARRAY_ITEMS = 50;
const MAX_ARRAY_ITEM_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 2_000;

function parseStringArray(
  value: unknown,
  key: 'types' | 'scopes' | 'exclude',
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_ARRAY_ITEMS
  ) {
    throw new Error(`${key} must contain 1 to 50 items`);
  }
  if (!value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${key} items must be strings`);
  }
  const items = value.filter(
    (item): item is string => typeof item === 'string',
  );
  if (
    items.some((item) => item.length < 1 || item.length > MAX_ARRAY_ITEM_LENGTH)
  ) {
    throw new Error(`${key} items must contain 1 to 100 characters`);
  }
  if (items.some((item) => CONTROL_CHARACTER.test(item))) {
    throw new Error(`${key} items must not contain control characters`);
  }
  if (key !== 'exclude' && items.some((item) => !IDENTIFIER.test(item))) {
    throw new Error(`${key} items must match /^[a-z][a-z0-9-]*$/`);
  }
  return items;
}

function parseInstructions(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('instructions must be a string');
  }
  if (value.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error('instructions must contain at most 2000 characters');
  }
  if (stripTerminalControlSequences(value) !== value) {
    throw new Error('instructions must not contain terminal control sequences');
  }
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('invalid JSON', { cause: error });
  }
}

export function parseProjectConfig(text: string): ProjectConfig {
  const value = parseJson(text);
  if (!isRecord(value)) {
    throw new Error('must be an object');
  }
  const unknownKey = Object.keys(value).find(
    (key) => !PROJECT_CONFIG_KEYS.has(key),
  );
  if (unknownKey !== undefined) {
    throw new Error(`unknown key "${unknownKey}"`);
  }
  const config: ProjectConfig = {};
  if (value.types !== undefined) {
    config.types = parseStringArray(value.types, 'types');
  }
  if (value.scopes !== undefined) {
    config.scopes = parseStringArray(value.scopes, 'scopes');
  }
  if (value.exclude !== undefined) {
    config.exclude = parseStringArray(value.exclude, 'exclude');
  }
  if (value.instructions !== undefined) {
    config.instructions = parseInstructions(value.instructions);
  }
  return config;
}
