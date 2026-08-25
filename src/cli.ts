import minimist, { type ParsedArgs } from 'minimist';
import { OUTPUT_MODES, isOutputMode, type OutputMode } from './output-mode.js';

export type { OutputMode } from './output-mode.js';

interface Args extends ParsedArgs {
  commit?: string | null;
  'commit-range'?: string | null;
  help?: boolean;
  version?: boolean;
  model?: string | null;
  provider?: string | null;
  mode?: OutputMode | null;
  verbose?: boolean;
  debug?: boolean;
  nonInteractive?: boolean;
  apply?: boolean;
  'list-models'?: boolean;
  exclude?: string | string[];
}

export interface ParsedOptions {
  commit: string | null;
  commitRange: string | null;
  help: boolean;
  version: boolean;
  model: string | null;
  provider: string | null;
  mode: OutputMode | null;
  verbose: boolean;
  debug: boolean;
  nonInteractive: boolean;
  apply: boolean;
  listModels: boolean;
  exclude: string[];
}

function createArgumentValidationError(message: string): Error {
  const error = new Error(message);
  error.name = 'ArgumentValidationError';
  return error;
}

export function isArgumentValidationError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ArgumentValidationError';
}

function validateOutputMode(value: string): void {
  if (!isOutputMode(value)) {
    throw createArgumentValidationError(
      `Invalid value for --mode: ${value}. Expected one of: ${OUTPUT_MODES.join(', ')}`,
    );
  }
}

export interface CliOptionDefinition {
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  takesValue: boolean;
  allowsRepeat?: boolean;
  validateValue?: (value: string) => void;
}

export const CLI_OPTION_DEFINITIONS = [
  {
    name: 'commit',
    aliases: ['--commit', '-c'],
    usage: '-c, --commit <hash>',
    description: 'Generate from one existing commit instead of staged changes.',
    takesValue: true,
  },
  {
    name: 'commitRange',
    aliases: ['--commit-range'],
    usage: '--commit-range <range>',
    description: 'Generate each commit in a range, oldest first; requires --non-interactive.',
    takesValue: true,
  },
  {
    name: 'help',
    aliases: ['--help', '-h'],
    usage: '-h, --help',
    description: 'Show this help.',
    takesValue: false,
  },
  {
    name: 'version',
    aliases: ['--version'],
    usage: '--version',
    description: 'Show the version and exit.',
    takesValue: false,
  },
  {
    name: 'model',
    aliases: ['--model'],
    usage: '--model <name>',
    description: 'Use another {provider} model.',
    takesValue: true,
  },
  {
    name: 'provider',
    aliases: ['--provider'],
    usage: '--provider <name>',
    description: 'Use gemini, openai, freellmapi, or lm-studio.',
    takesValue: true,
  },
  {
    name: 'mode',
    aliases: ['--mode', '-m'],
    usage: '-m, --mode <mode>',
    description: "Output 'commit-only' or 'full'.",
    takesValue: true,
    validateValue: validateOutputMode,
  },
  {
    name: 'verbose',
    aliases: ['--verbose', '-v'],
    usage: '-v, --verbose',
    description: 'Show detailed logs.',
    takesValue: false,
  },
  {
    name: 'debug',
    aliases: ['--debug', '-d'],
    usage: '-d, --debug',
    description: "Save bounded API traces to '.debug.log'.",
    takesValue: false,
  },
  {
    name: 'nonInteractive',
    aliases: ['--non-interactive'],
    usage: '--non-interactive',
    description: 'Run without questions; read-only unless --apply is set.',
    takesValue: false,
  },
  {
    name: 'apply',
    aliases: ['--apply'],
    usage: '--apply',
    description: 'Write the generated message; requires --non-interactive.',
    takesValue: false,
  },
  {
    name: 'listModels',
    aliases: ['--list-models'],
    usage: '--list-models',
    description: 'List available {provider} models and exit.',
    takesValue: false,
  },
  {
    name: 'exclude',
    aliases: ['--exclude', '-e'],
    usage: '-e, --exclude <pattern>',
    description: 'Exclude matching files; repeat or separate patterns with commas.',
    takesValue: true,
    allowsRepeat: true,
  },
] satisfies CliOptionDefinition[];

const flagsByAlias = new Map<string, CliOptionDefinition>(
  CLI_OPTION_DEFINITIONS.flatMap(definition =>
    definition.aliases.map(alias => [alias, definition] as const),
  ),
);

function aliasesForFlag(flag: string): string[] {
  return flag.startsWith('--') ? [flag] : [...flag.slice(1)].map(letter => `-${letter}`);
}

function findUnknownFlag(aliases: string[]): string | undefined {
  return aliases.find(alias => !flagsByAlias.has(alias));
}

function findValueFlag(aliases: string[]): string | undefined {
  return aliases.find(alias => flagsByAlias.get(alias)?.takesValue);
}

function validateValueFlag(
  flag: string,
  aliases: string[],
  valueFlag: string,
  value: string | undefined,
): void {
  if (aliases.at(-1) !== valueFlag) {
    throw createArgumentValidationError(`Value-taking flag must be last in cluster: ${flag}`);
  }
  const valueDefinition = flagsByAlias.get(valueFlag)?.name;
  const allowsDashPrefixedValue =
    valueDefinition === 'exclude' || valueDefinition === 'commitRange';
  if (
    !value ||
    value === '--' ||
    (value.startsWith('-') && (!allowsDashPrefixedValue || flagsByAlias.has(value)))
  ) {
    throw createArgumentValidationError(`Missing value for flag: ${valueFlag}`);
  }
}

function validateValueDefinition(
  valueFlag: string,
  value: string,
  seenValueFlags: Set<string>,
): void {
  const definition = flagsByAlias.get(valueFlag);
  if (!definition) return;
  definition.validateValue?.(value);
  if (!definition.allowsRepeat && seenValueFlags.has(definition.name)) {
    throw createArgumentValidationError(`Flag may only be specified once: --${definition.name}`);
  }
  seenValueFlags.add(definition.name);
}

function validateArgs(argv: string[]): void {
  const seenValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') return;
    if (argument === '-' || !argument.startsWith('-')) continue;
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (flag === '-') throw createArgumentValidationError('Unknown flag: -');
    const aliases = aliasesForFlag(flag);
    const unknownFlag = findUnknownFlag(aliases);
    if (unknownFlag) throw createArgumentValidationError(`Unknown flag: ${unknownFlag}`);
    const valueFlag = findValueFlag(aliases);
    if (!valueFlag) continue;
    const value = equalsIndex === -1 ? argv[index + 1] : argument.slice(equalsIndex + 1);
    validateValueFlag(flag, aliases, valueFlag, value);
    validateValueDefinition(valueFlag, value, seenValueFlags);
    index += Number(equalsIndex === -1);
  }
}

function normaliseExcludeValues(argv: string[]): string[] {
  const normalised: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') return [...normalised, ...argv.slice(index)];
    if (argument === '--exclude' || argument === '-e') {
      normalised.push(`${argument}=${argv[index + 1]}`);
      index += 1;
      continue;
    }
    normalised.push(argument);
  }
  return normalised;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedOptions {
  validateArgs(argv);
  const normalisedArgv = normaliseExcludeValues(argv);
  const optionTerminator = normalisedArgv.indexOf('--');
  const parsed: Args = minimist(
    optionTerminator === -1 ? normalisedArgv : normalisedArgv.slice(0, optionTerminator),
    {
      alias: { c: 'commit', h: 'help', v: 'verbose', d: 'debug', e: 'exclude', m: 'mode' },
      boolean: ['help', 'version', 'verbose', 'debug', 'non-interactive', 'apply', 'list-models'],
      string: ['commit', 'commit-range', 'model', 'provider', 'mode', 'exclude'],
    },
  );

  // Parse exclude patterns - can be comma-separated or multiple --exclude flags
  let excludePatterns: string[] = [];
  if (parsed.exclude) {
    if (Array.isArray(parsed.exclude)) {
      excludePatterns = parsed.exclude
        .flatMap(e => e.split(',').map(s => s.trim()))
        .filter(Boolean);
    } else if (typeof parsed.exclude === 'string') {
      excludePatterns = parsed.exclude
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
  }

  const finalMode = parsed.mode && isOutputMode(parsed.mode) ? parsed.mode : null;
  const nonInteractive = Boolean(parsed['non-interactive']);
  const apply = Boolean(parsed.apply);
  const commitRange = parsed['commit-range'] ?? null;
  if (apply && !nonInteractive) {
    throw createArgumentValidationError('--apply requires --non-interactive');
  }
  if (commitRange && !nonInteractive) {
    throw createArgumentValidationError('--commit-range requires --non-interactive');
  }
  if (commitRange && parsed.commit) {
    throw createArgumentValidationError('--commit and --commit-range cannot be combined');
  }
  if (commitRange?.startsWith('-')) {
    throw createArgumentValidationError('--commit-range cannot start with -');
  }

  return {
    commit: parsed.commit ?? null,
    commitRange,
    help: Boolean(parsed.help),
    version: Boolean(parsed.version),
    model: parsed.model ?? null,
    provider: parsed.provider ?? null,
    mode: finalMode,
    verbose: Boolean(parsed.verbose),
    debug: Boolean(parsed.debug),
    nonInteractive,
    apply,
    listModels: Boolean(parsed['list-models']),
    exclude: excludePatterns,
  };
}
