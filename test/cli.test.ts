import { test, expect } from 'bun:test';
import { CLI_OPTION_DEFINITIONS, parseArgs } from '../src/cli';

test('README installs from this repository', async function () {
  const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
  expect(readme).toContain('git clone https://github.com/cebreus/gcm.git');
  expect(readme).toContain('cd gcm');
});

test('cli: every public long flag is documented in README', async () => {
  const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();

  for (const option of CLI_OPTION_DEFINITIONS) {
    const longFlag = option.aliases.find(alias => alias.startsWith('--'));
    expect(longFlag).toBeDefined();
    expect(readme).toContain(longFlag ?? '');
  }
});

test('cli: should parse default arguments with empty argv', () => {
  const result = parseArgs([]);
  expect(result).toEqual({
    commit: null,
    commitRange: null,
    help: false,
    version: false,
    model: null,
    provider: null,
    hint: null,
    verbose: false,
    debug: false,
    modelsList: false,
    providersList: false,
    nonInteractive: false,
    print: false,
    apply: false,
    exclude: [],
  });
});

test('cli: parses --providers-list and --models-list', () => {
  expect(parseArgs(['--providers-list']).providersList).toBe(true);
  expect(parseArgs(['--models-list']).modelsList).toBe(true);
});

test('cli: parses provider', () => {
  const result = parseArgs(['--provider', 'freellmapi']);

  expect(result.provider).toBe('freellmapi');
});

test('cli: parses generation hint', () => {
  const result = parseArgs(['--hint', 'emphasize migration']);

  expect(result.hint).toBe('emphasize migration');
});

test('cli: should handle -c/--commit flag with a SHA value', () => {
  const sha = 'a1b2c3d4';
  let result = parseArgs(['-c', sha]);
  expect(result.commit).toBe(sha);

  result = parseArgs([`--commit=${sha}`]);
  expect(result.commit).toBe(sha);
});

test('cli: accepts a non-interactive commit range', () => {
  const result = parseArgs(['--commit-range', 'base^..HEAD', '--non-interactive']);

  expect(result.commitRange).toBe('base^..HEAD');
});

test('cli: validates commit range combinations before execution', () => {
  expect(() => parseArgs(['--commit-range', 'base..HEAD'])).toThrow(
    '--commit-range requires --non-interactive',
  );
  expect(() =>
    parseArgs(['--commit', 'HEAD', '--commit-range', 'base..HEAD', '--non-interactive']),
  ).toThrow('--commit and --commit-range cannot be combined');
  expect(() => parseArgs(['--commit-range=-danger', '--non-interactive'])).toThrow(
    '--commit-range cannot start with -',
  );
});

test('cli: should handle -h/--help flag', () => {
  let result = parseArgs(['-h']);
  expect(result.help).toBe(true);

  result = parseArgs(['--help']);
  expect(result.help).toBe(true);
});

test('cli: should handle --version flag', () => {
  const result = parseArgs(['--version']);
  expect(result.version).toBe(true);
});

test('cli: parses explicit non-interactive generation and apply flags', () => {
  const result = parseArgs(['--non-interactive', '--apply']);

  expect(result.nonInteractive).toBe(true);
  expect(result.apply).toBe(true);
});

test('cli: --print implies non-interactive and rejects incompatible modes', () => {
  const result = parseArgs(['--print']);
  expect(result.print).toBe(true);
  expect(result.nonInteractive).toBe(true);
  for (const flag of ['--apply', '--commit-range', '--models-list', '--providers-list']) {
    const args = flag === '--commit-range' ? ['--print', flag, 'HEAD'] : ['--print', flag];
    expect(() => parseArgs(args)).toThrow(`--print cannot be combined with ${flag}`);
  }
});

test('cli: refuses --apply without --non-interactive', () => {
  expect(() => parseArgs(['--apply'])).toThrow('--apply requires --non-interactive');
});

test('cli: should handle -v/--verbose flag', () => {
  let result = parseArgs(['-v']);
  expect(result.verbose).toBe(true);

  result = parseArgs(['--verbose']);
  expect(result.verbose).toBe(true);
});

test('cli: should handle -d/--debug flag', () => {
  let result = parseArgs(['-d']);
  expect(result.debug).toBe(true);

  result = parseArgs(['--debug']);
  expect(result.debug).toBe(true);
});

test('cli: should handle --model flag with a model name', () => {
  const model = 'gemini-pro';
  const result = parseArgs(['--model', model]);
  expect(result.model).toBe(model);
});

test('cli: rejects the removed --mode flag', () => {
  expect(() => parseArgs(['--mode', 'full'])).toThrow('Unknown flag: --mode');
  expect(() => parseArgs(['-m', 'commit-only'])).toThrow('Unknown flag: -m');
});

test('cli: rejects repeated single-value flags', () => {
  expect(() => parseArgs(['--commit', 'abc', '--commit', 'def'])).toThrow(
    'Flag may only be specified once: --commit',
  );
  expect(() => parseArgs(['--model', 'gemini-pro', '--model', 'gemini-flash'])).toThrow(
    'Flag may only be specified once: --model',
  );
});

test('cli: should handle combined flags', () => {
  const result = parseArgs(['-v', '-d', '--commit', 'HEAD']);
  expect(result.verbose).toBe(true);
  expect(result.debug).toBe(true);
  expect(result.commit).toBe('HEAD');
  expect(result.help).toBe(false);
});

test('cli: should handle clustered boolean flags', () => {
  const result = parseArgs(['-vd']);
  expect(result.verbose).toBe(true);
  expect(result.debug).toBe(true);
});

test('cli: gives precedence to flags over string arguments', () => {
  const fakeSha = '-h';
  expect(() => parseArgs(['-c', fakeSha])).toThrow('Missing value for flag: -c');
});

test('cli: rejects unknown flags', () => {
  expect(() => parseArgs(['--commmit', 'abc123'])).toThrow('Unknown flag: --commmit');
  expect(() => parseArgs(['--listModels'])).toThrow('Unknown flag: --listModels');
  expect(() => parseArgs(['--list-models'])).toThrow('Unknown flag: --list-models');
  expect(() => parseArgs(['--list-providers'])).toThrow('Unknown flag: --list-providers');
});

test('cli: rejects unknown clustered flags', () => {
  expect(() => parseArgs(['-vx'])).toThrow('Unknown flag: -x');
});

test('cli: rejects clusters with a non-final value-taking flag', () => {
  expect(() => parseArgs(['-cv', 'sha'])).toThrow('Value-taking flag must be last in cluster: -cv');
});

test('cli: rejects malformed short flags and a bare positional dash', () => {
  expect(() => parseArgs(['-='])).toThrow('Unknown flag: -');
  expect(() => parseArgs(['-=x'])).toThrow('Unknown flag: -');
  expect(() => parseArgs(['-'])).toThrow('Unexpected positional argument');
});

test('cli: rejects string flags without a value', () => {
  expect(() => parseArgs(['--commit'])).toThrow('Missing value for flag: --commit');
});

test('cli: should handle -e/--exclude flag with a single pattern', () => {
  let result = parseArgs(['-e', '*manifest*']);
  expect(result.exclude).toEqual(['*manifest*']);

  result = parseArgs(['--exclude', '*manifest*']);
  expect(result.exclude).toEqual(['*manifest*']);
});

test('cli: should handle --exclude flag with comma-separated patterns', () => {
  const result = parseArgs(['--exclude', '*manifest*,*.lock,dist/*']);
  expect(result.exclude).toEqual(['*manifest*', '*.lock', 'dist/*']);
});

test('cli: should handle multiple --exclude flags', () => {
  const result = parseArgs([
    '--exclude',
    '*manifest*',
    '--exclude',
    '*.lock',
    '--exclude',
    'dist/*',
  ]);
  expect(result.exclude).toEqual(['*manifest*', '*.lock', 'dist/*']);
});

test('cli: should handle --exclude with mixed comma-separated and multiple flags', () => {
  const result = parseArgs(['--exclude', '*manifest*,*.lock', '--exclude', 'dist/*']);
  expect(result.exclude).toEqual(['*manifest*', '*.lock', 'dist/*']);
});

test('cli: should handle --exclude with spaces around patterns', () => {
  const result = parseArgs(['--exclude', ' *manifest* , *.lock ']);
  expect(result.exclude).toEqual(['*manifest*', '*.lock']);
});

for (const inputCase of [
  { args: ['--exclude', '-generated/*'], exclude: ['-generated/*'] },
  { args: ['-e', '-generated/*'], exclude: ['-generated/*'] },
  { args: ['--exclude=-generated/*'], exclude: ['-generated/*'] },
  { args: ['-e=-generated/*'], exclude: ['-generated/*'] },
  { args: ['--exclude', 'path with space/*'], exclude: ['path with space/*'] },
] as const) {
  test(`cli: preserves the exclude pattern ${inputCase.args.join(' ')}`, () => {
    const result = parseArgs([...inputCase.args]);

    expect(result.exclude).toEqual([...inputCase.exclude]);
    expect(result.debug).toBe(false);
  });
}

test('cli: rejects an option terminator and known flags as separated exclude values', () => {
  for (const value of ['--', '-v', '--commit']) {
    expect(() => parseArgs(['--exclude', value])).toThrow('Missing value for flag: --exclude');
  }
});

test('cli: rejects positional arguments after the option terminator', () => {
  expect(() => parseArgs(['--', '--debug', '--exclude', 'private/*'])).toThrow(
    'Unexpected positional argument',
  );
});

const valueTakingFlagCases = [
  {
    aliases: ['--commit', '-c'],
    longAlias: '--commit',
    option: 'commit',
    value: 'a1b2c3d4',
    expected: 'a1b2c3d4',
  },
  {
    aliases: ['--exclude', '-e'],
    longAlias: '--exclude',
    option: 'exclude',
    value: '*.lock',
    expected: Array.of('*.lock'),
  },
  {
    aliases: ['--model'],
    longAlias: '--model',
    option: 'model',
    value: 'gemini-pro',
    expected: 'gemini-pro',
  },
] as const;

for (const flagCase of valueTakingFlagCases) {
  test(`cli: validates missing values for ${flagCase.longAlias}`, () => {
    for (const alias of flagCase.aliases) {
      expect(() => parseArgs([alias])).toThrow(`Missing value for flag: ${alias}`);
      expect(() => parseArgs([alias, '--help'])).toThrow(`Missing value for flag: ${alias}`);
      expect(parseArgs([alias, flagCase.value])[flagCase.option]).toEqual(flagCase.expected);
    }

    expect(() => parseArgs([`${flagCase.longAlias}=`])).toThrow(
      `Missing value for flag: ${flagCase.longAlias}`,
    );
  });
}
