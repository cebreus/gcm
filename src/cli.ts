import minimist, { type ParsedArgs } from 'minimist';

interface Args extends ParsedArgs {
  commit?: string | null;
  'dry-run'?: boolean;
  dryRun?: boolean;
  help?: boolean;
  model?: string | null;
  verbose?: boolean;
  debug?: boolean;
  'list-models'?: boolean;
  listModels?: boolean;
}

export interface ParsedOptions {
  commit: string | null;
  dryRun: boolean;
  help: boolean;
  model: string | null;
  verbose: boolean;
  debug: boolean;
  listModels: boolean;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedOptions {
  const parsed: Args = minimist(argv, {
    alias: { c: 'commit', h: 'help', v: 'verbose', d: 'debug' },
    boolean: ['help', 'dry-run', 'verbose', 'debug', 'list-models'],
    string: ['commit', 'model'],
  });
  return {
    commit: parsed.commit || null,
    dryRun: Boolean(parsed['dry-run']) || Boolean(parsed.dryRun) || false,
    help: Boolean(parsed.help),
    model: parsed.model || null,
    verbose: Boolean(parsed.verbose),
    debug: Boolean(parsed.debug),
    listModels: Boolean(parsed['list-models']) || Boolean(parsed.listModels) || false,
  };
}
