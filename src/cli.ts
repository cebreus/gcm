import minimist, { type ParsedArgs } from 'minimist';

const outputModes = ['full', 'commit-only'] as const;

type OutputMode = (typeof outputModes)[number];

interface Args extends ParsedArgs {
  commit?: string | null;
  help?: boolean;
  version?: boolean;
  model?: string | null;
  mode?: OutputMode | null;
  verbose?: boolean;
  debug?: boolean;
  'list-models'?: boolean;
  listModels?: boolean;
  exclude?: string | string[];
}

export interface ParsedOptions {
  commit: string | null;
  help: boolean;
  version: boolean;
  model: string | null;
  mode: OutputMode | null;
  verbose: boolean;
  debug: boolean;
  listModels: boolean;
  exclude: string[];
}

export class ArgumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentValidationError';
  }
}

function isOutputMode(value: string): value is OutputMode {
  return (outputModes as readonly string[]).includes(value);
}

function validateOutputMode(value: string): void {
  if (!isOutputMode(value)) {
    throw new ArgumentValidationError(
      `Invalid value for --mode: ${value}. Expected one of: ${outputModes.join(', ')}`,
    );
  }
}

interface FlagDefinition {
  name: string;
  aliases: string[];
  takesValue: boolean;
  allowsRepeat?: boolean;
  validateValue?: (value: string) => void;
}

const flagDefinitions = [
  { name: 'commit', aliases: ['--commit', '-c'], takesValue: true },
  { name: 'help', aliases: ['--help', '-h'], takesValue: false },
  { name: 'version', aliases: ['--version'], takesValue: false },
  { name: 'model', aliases: ['--model'], takesValue: true },
  {
    name: 'mode',
    aliases: ['--mode', '-m'],
    takesValue: true,
    validateValue: validateOutputMode,
  },
  { name: 'verbose', aliases: ['--verbose', '-v'], takesValue: false },
  { name: 'debug', aliases: ['--debug', '-d'], takesValue: false },
  { name: 'listModels', aliases: ['--list-models', '--listModels'], takesValue: false },
  { name: 'exclude', aliases: ['--exclude', '-e'], takesValue: true, allowsRepeat: true },
] satisfies FlagDefinition[];

const flagsByAlias = new Map<string, FlagDefinition>(
  flagDefinitions.flatMap(definition =>
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

function validateValueFlag(flag: string, aliases: string[], valueFlag: string, value: string | undefined): void {
  if (aliases.at(-1) !== valueFlag) {
    throw new ArgumentValidationError(`Value-taking flag must be last in cluster: ${flag}`);
  }
  const isExcludePattern = flagsByAlias.get(valueFlag)?.name === 'exclude';
  if (
    !value ||
    value === '--' ||
    (value.startsWith('-') && (!isExcludePattern || flagsByAlias.has(value)))
  ) {
    throw new ArgumentValidationError(`Missing value for flag: ${valueFlag}`);
  }
}

function validateValueDefinition(valueFlag: string, value: string, seenValueFlags: Set<string>): void {
  const definition = flagsByAlias.get(valueFlag);
  if (!definition) return;
  definition.validateValue?.(value);
  if (!definition.allowsRepeat && seenValueFlags.has(definition.name)) {
    throw new ArgumentValidationError(`Flag may only be specified once: --${definition.name}`);
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
    if (flag === '-') throw new ArgumentValidationError('Unknown flag: -');
    const aliases = aliasesForFlag(flag);
    const unknownFlag = findUnknownFlag(aliases);
    if (unknownFlag) throw new ArgumentValidationError(`Unknown flag: ${unknownFlag}`);
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
  const parsed: Args = minimist(optionTerminator === -1 ? normalisedArgv : normalisedArgv.slice(0, optionTerminator), {
    alias: { c: 'commit', h: 'help', v: 'verbose', d: 'debug', e: 'exclude', m: 'mode' },
    boolean: ['help', 'version', 'verbose', 'debug', 'list-models'],
    string: ['commit', 'model', 'mode', 'exclude'],
  });

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

  return {
    commit: parsed.commit || null,
    help: Boolean(parsed.help),
    version: Boolean(parsed.version),
    model: parsed.model || null,
    mode: finalMode,
    verbose: Boolean(parsed.verbose),
    debug: Boolean(parsed.debug),
    listModels: Boolean(parsed['list-models']) || Boolean(parsed.listModels) || false,
    exclude: excludePatterns,
  };
}
