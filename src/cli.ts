import minimist, { type ParsedArgs } from 'minimist';

import { hasText } from './utils.js';

interface Args extends ParsedArgs {
  commit?: string | null;
  'commit-range'?: string | null;
  help?: boolean;
  version?: boolean;
  model?: string | null;
  provider?: string | null;
  hint?: string | null;
  verbose?: boolean;
  debug?: boolean;
  print?: boolean;
  apply?: boolean;
  'models-list'?: boolean;
  'providers-list'?: boolean;
  exclude?: string | string[];
}

export interface ParsedOptions {
  commit: string | null;
  commitRange: string | null;
  help: boolean;
  version: boolean;
  model: string | null;
  provider: string | null;
  hint: string | null;
  verbose: boolean;
  debug: boolean;
  nonInteractive: boolean;
  print: boolean;
  apply: boolean;
  modelsList: boolean;
  providersList: boolean;
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

interface CliOptionDefinition {
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  takesValue: boolean;
  allowsRepeat?: boolean;
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
    description:
      'Generate each commit in a range, oldest first; requires --non-interactive.',
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
    description: 'Use another available AI provider.',
    takesValue: true,
  },
  {
    name: 'hint',
    aliases: ['--hint'],
    usage: '--hint <text>',
    description: 'Add an instruction for generation.',
    takesValue: true,
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
    description: 'Log redacted API request and response bodies.',
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
    name: 'print',
    aliases: ['--print'],
    usage: '--print',
    description:
      'Print only the generated message to stdout; implies --non-interactive.',
    takesValue: false,
  },
  {
    name: 'modelsList',
    aliases: ['--models-list'],
    usage: '--models-list',
    description: 'List available {provider} models and exit.',
    takesValue: false,
  },
  {
    name: 'providersList',
    aliases: ['--providers-list'],
    usage: '--providers-list',
    description: 'Actively check available AI providers and exit.',
    takesValue: false,
  },
  {
    name: 'exclude',
    aliases: ['--exclude', '-e'],
    usage: '-e, --exclude <pattern>',
    description:
      'Exclude matching files; repeat or separate patterns with commas.',
    takesValue: true,
    allowsRepeat: true,
  },
] satisfies CliOptionDefinition[];

const flagsByAlias = new Map<string, CliOptionDefinition>(
  CLI_OPTION_DEFINITIONS.flatMap((definition) =>
    definition.aliases.map((alias) => [alias, definition] as const),
  ),
);

function aliasesForFlag(flag: string): string[] {
  return flag.startsWith('--')
    ? [flag]
    : flag
        .slice('-'.length)
        .split('')
        .map((letter) => `-${letter}`);
}

function findUnknownFlag(aliases: string[]): string | undefined {
  return aliases.find((alias) => !flagsByAlias.has(alias));
}

function findValueFlag(aliases: string[]): string | undefined {
  return aliases.find((alias) => flagsByAlias.get(alias)?.takesValue === true);
}

interface ValueFlagValidation {
  flag: string;
  aliases: string[];
  valueFlag: string;
  value: string | undefined;
  isInlineValue: boolean;
}

const MISSING_FLAG_VALUES = new Set([undefined, '', '--']);

function validateValueFlag(options: ValueFlagValidation): void {
  const { flag, aliases, valueFlag, value, isInlineValue } = options;
  if (aliases.at(-1) !== valueFlag) {
    throw createArgumentValidationError(
      `Value-taking flag must be last in cluster: ${flag}`,
    );
  }
  const valueDefinition = flagsByAlias.get(valueFlag)?.name;
  const allowsDashPrefixedValue =
    valueDefinition === 'exclude' ||
    (valueDefinition === 'commitRange' && isInlineValue);
  const conflictsWithFlag =
    value?.startsWith('-') === true &&
    (!allowsDashPrefixedValue || flagsByAlias.has(value));
  if (MISSING_FLAG_VALUES.has(value) || conflictsWithFlag) {
    throw createArgumentValidationError(`Missing value for flag: ${valueFlag}`);
  }
}

function validateValueDefinition(
  valueFlag: string,
  seenValueFlags: Set<string>,
): void {
  const definition = flagsByAlias.get(valueFlag);
  if (definition === undefined) {
    return;
  }
  if (definition.allowsRepeat !== true && seenValueFlags.has(definition.name)) {
    throw createArgumentValidationError(
      `Flag may only be specified once: --${definition.name}`,
    );
  }
  seenValueFlags.add(definition.name);
}

function validateFlagArgument(
  argument: string,
  nextArgument: string | undefined,
  seenValueFlags: Set<string>,
): boolean {
  const equalsIndex = argument.indexOf('=');
  const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
  if (flag === '-') {
    throw createArgumentValidationError('Unknown flag: -');
  }
  const aliases = aliasesForFlag(flag);
  const unknownFlag = findUnknownFlag(aliases);
  if (unknownFlag !== undefined) {
    throw createArgumentValidationError(`Unknown flag: ${unknownFlag}`);
  }
  const valueFlag = findValueFlag(aliases);
  if (valueFlag === undefined) {
    return false;
  }
  const value =
    equalsIndex === -1 ? nextArgument : argument.slice(equalsIndex + 1);
  validateValueFlag({
    flag,
    aliases,
    valueFlag,
    value,
    isInlineValue: equalsIndex !== -1,
  });
  validateValueDefinition(valueFlag, seenValueFlags);
  return equalsIndex === -1;
}

function validateArgs(argv: string[]): void {
  const seenValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const { [index]: argument } = argv;
    // Only a trailing `--` is accepted; gcm takes no positional arguments.
    const isLast = index === argv.length - 1;
    if (argument === '--' && isLast) {
      return;
    }
    if (argument === '--' || argument === '-' || !argument.startsWith('-')) {
      throw createArgumentValidationError('Unexpected positional argument');
    }
    const consumesNextArgument = validateFlagArgument(
      argument,
      argv[index + 1],
      seenValueFlags,
    );
    if (consumesNextArgument) {
      index += 1;
    }
  }
}

function normaliseExcludeValues(argv: string[]): string[] {
  const normalised: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const { [index]: argument } = argv;
    if (argument === '--') {
      return [...normalised, ...argv.slice(index)];
    }
    if (argument === '--exclude' || argument === '-e') {
      normalised.push(`${argument}=${argv[index + 1]}`);
      index += 1;
      continue;
    }
    normalised.push(argument);
  }
  return normalised;
}

function parseMinimistArgs(argv: string[]): Args {
  const normalisedArgv = normaliseExcludeValues(argv);
  const optionTerminator = normalisedArgv.indexOf('--');
  return minimist(
    optionTerminator === -1
      ? normalisedArgv
      : normalisedArgv.slice(0, optionTerminator),
    {
      alias: { c: 'commit', h: 'help', v: 'verbose', d: 'debug', e: 'exclude' },
      boolean: [
        'help',
        'version',
        'verbose',
        'debug',
        'non-interactive',
        'print',
        'apply',
        'models-list',
        'providers-list',
      ],
      string: [
        'commit',
        'commit-range',
        'model',
        'provider',
        'hint',
        'exclude',
      ],
    },
  );
}

function parseExcludePatterns(value: Args['exclude']): string[] {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return values
    .flatMap((entry) => entry.split(',').map((pattern) => pattern.trim()))
    .filter((pattern) => pattern !== '');
}

function validatePrintOptions(parsed: Args): void {
  const print = Boolean(parsed.print);
  const commitRange = parsed['commit-range'] ?? null;
  if (print) {
    const incompatibleFlag = [
      { name: '--apply', enabled: parsed.apply === true },
      { name: '--commit-range', enabled: commitRange !== null },
      { name: '--models-list', enabled: parsed['models-list'] === true },
      { name: '--providers-list', enabled: parsed['providers-list'] === true },
    ].find((entry) => entry.enabled)?.name;
    if (incompatibleFlag !== undefined) {
      throw createArgumentValidationError(
        `--print cannot be combined with ${incompatibleFlag}`,
      );
    }
  }
}

function validateCommitRangeOptions(parsed: Args): void {
  const commitRange = parsed['commit-range'] ?? null;
  if (!hasText(commitRange)) {
    return;
  }
  const nonInteractive =
    parsed['non-interactive'] === true || parsed.print === true;
  if (!nonInteractive) {
    throw createArgumentValidationError(
      '--commit-range requires --non-interactive',
    );
  }
  if (hasText(parsed.commit)) {
    throw createArgumentValidationError(
      '--commit and --commit-range cannot be combined',
    );
  }
  if (commitRange.startsWith('-')) {
    throw createArgumentValidationError('--commit-range cannot start with -');
  }
}

function validateParsedOptions(parsed: Args): void {
  validatePrintOptions(parsed);
  const nonInteractive =
    parsed['non-interactive'] === true || parsed.print === true;
  const apply = parsed.apply === true;
  if (apply && !nonInteractive) {
    throw createArgumentValidationError('--apply requires --non-interactive');
  }
  validateCommitRangeOptions(parsed);
}

function toParsedOptions(parsed: Args): ParsedOptions {
  const print = parsed.print === true;
  const commitRange = parsed['commit-range'] ?? null;
  return {
    commit: parsed.commit ?? null,
    commitRange,
    help: Boolean(parsed.help),
    version: Boolean(parsed.version),
    model: parsed.model ?? null,
    provider: parsed.provider ?? null,
    hint: parsed.hint ?? null,
    verbose: Boolean(parsed.verbose),
    debug: Boolean(parsed.debug),
    nonInteractive: parsed['non-interactive'] === true || print,
    print,
    apply: parsed.apply === true,
    modelsList: Boolean(parsed['models-list']),
    providersList: Boolean(parsed['providers-list']),
    exclude: parseExcludePatterns(parsed.exclude),
  };
}

export function parseArgs(
  argv: string[] = process.argv.slice(2),
): ParsedOptions {
  validateArgs(argv);
  const parsed = parseMinimistArgs(argv);
  validateParsedOptions(parsed);
  return toParsedOptions(parsed);
}
