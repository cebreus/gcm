import minimist, { type ParsedArgs } from 'minimist';

interface Args extends ParsedArgs {
  commit?: string | null;
  'dry-run'?: boolean;
  dryRun?: boolean;
  help?: boolean;
  version?: boolean;
  model?: string | null;
  mode?: 'full' | 'commit-only' | null;
  verbose?: boolean;
  debug?: boolean;
  'list-models'?: boolean;
  listModels?: boolean;
  exclude?: string | string[];
}

export interface ParsedOptions {
  commit: string | null;
  dryRun: boolean;
  help: boolean;
  version: boolean;
  model: string | null;
  mode: 'full' | 'commit-only' | null;
  verbose: boolean;
  debug: boolean;
  listModels: boolean;
  exclude: string[];
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedOptions {
  const parsed: Args = minimist(argv, {
    alias: { c: 'commit', h: 'help', v: 'verbose', d: 'debug', e: 'exclude', m: 'mode' },
    boolean: ['help', 'version', 'dry-run', 'verbose', 'debug', 'list-models'],
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

  // Validate mode
  let finalMode: 'full' | 'commit-only' | null = null;
  if (parsed.mode === 'full' || parsed.mode === 'commit-only') {
    finalMode = parsed.mode;
  }

  return {
    commit: parsed.commit || null,
    dryRun: Boolean(parsed['dry-run']) || Boolean(parsed.dryRun) || false,
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
