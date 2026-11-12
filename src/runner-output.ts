import { cancel, note, outro, spinner } from '@clack/prompts';

import pkg from '../package.json';
import { CLI_OPTION_DEFINITIONS } from './cli.js';
import type { GenerationServices } from './generation-types.js';
import {
  sanitizeForDisplay,
  sanitizeTerminalText,
  stripTerminalControlSequences,
} from './utils.js';

type ProgressSpinner = Pick<
  ReturnType<typeof spinner>,
  'start' | 'stop' | 'clear'
>;

export function reportCancel(message: string): void {
  cancel(message, { output: process.stderr });
}

export function unknownProviderMessage(
  providerId: string,
  factories: Array<{ id: string }>,
): string {
  return `Error: Unknown language model provider "${sanitizeTerminalText(providerId)}". Valid: ${factories.map((factory) => factory.id).join(', ')}.`;
}

function paint(code: string): (message: string) => string {
  return (message) => `${code}${message}${C.reset}`;
}

export const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};
const HELP_LINE_WIDTH = 80;
const HELP_DESCRIPTION_INDENT = 8;

// Styling only for a terminal; a redirected stream gets plain text.
export function forStream(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return stream.isTTY ? text : stripTerminalControlSequences(text);
}

export function showHelp(providerLabel: string, providerIds: string[]): void {
  const optionWidth = Math.max(
    ...CLI_OPTION_DEFINITIONS.map((option) => option.usage.length),
  );
  const descriptionLine = new RegExp(
    `.{1,${HELP_LINE_WIDTH - optionWidth - HELP_DESCRIPTION_INDENT}}(?:\\s|$)`,
    'gv',
  );
  const options = CLI_OPTION_DEFINITIONS.map((option) => {
    const description = option.description.replaceAll(
      '{provider}',
      providerLabel,
    );
    const [first, ...rest] = (
      description.match(descriptionLine) ?? [description]
    ).map((line) => line.trim());
    return [
      `      ${C.cyan}${option.usage.padEnd(optionWidth)}${C.reset}  ${first}`,
      ...rest.map(
        (line) => ' '.repeat(optionWidth + HELP_DESCRIPTION_INDENT) + line,
      ),
    ].join('\n');
  }).join('\n');
  const helpText = `
    ${C.bright}${providerLabel} Commit Message Helper${C.reset}
    Version: ${pkg.version}

    Automatically generates professional Conventional Commit messages
    using ${providerLabel} AI.

    ${C.bright}Usage:${C.reset}
      gcm [options]

    ${C.bright}Options:${C.reset}
${options}

    ${C.bright}Provider:${C.reset}
      Use ${C.cyan}--provider <name>${C.reset}, choose in interactive Settings,
      or set ${C.cyan}GCM_PROVIDER${C.reset}.
      Available values: ${providerIds.join(', ')}.
      Example: ${C.cyan}GCM_PROVIDER=lm-studio gcm${C.reset}

    ${C.bright}Examples:${C.reset}
      ${C.cyan}gcm${C.reset}                                      Generate from staged changes.
      ${C.cyan}gcm --commit HEAD${C.reset}                        Generate from the latest commit.
      ${C.cyan}gcm --commit-range 'abc123^..def456' --non-interactive --apply${C.reset}
        Generate from abc123 through def456; ^ includes abc123.

    ${C.bright}Commit Safety:${C.reset}
      - Without ${C.cyan}--commit${C.reset} the action commits the staged changes.
      - With ${C.cyan}--commit${C.reset} on an unpublished HEAD the action amends that commit.
      - With ${C.cyan}--commit${C.reset} on any other commit the action adds an 'amend!' commit.
        History stays intact until you run 'git rebase --autosquash' yourself.
      - Amend is never offered for a commit already reachable from
        a remote branch.
      - Nothing is offered for a commit unreachable from HEAD,
        on a detached HEAD, or while the index has staged changes.
      - All actions are disabled when git has unresolved conflicts.
      - All actions are disabled while merge/rebase/cherry-pick/revert/bisect
        is in progress.
      - ${C.cyan}--commit-range${C.reset} creates one separate 'amend!' commit per target
        and never runs rebase.

    `;
  process.stdout.write(forStream(`${helpText.trim()}\n`));
}

export function createRunnerOutput(
  s: ProgressSpinner,
  isInteractive: boolean,
  printOnly: boolean,
): GenerationServices['output'] {
  return {
    isInteractive,
    startProgress: (message) => {
      if (printOnly) {
        return;
      }
      s.start(message);
    },
    stopProgress: (message) => {
      if (printOnly) {
        return;
      }
      if (message === undefined) {
        s.clear();
      } else {
        s.stop(message);
      }
    },
    cancel: reportCancel,
    note: (message, title) => {
      if (!printOnly) {
        note(message, title);
      }
    },
    warn: (message, title) => {
      if (!printOnly) {
        note(message, title, { output: process.stderr });
      }
    },
    outro: (message) => {
      if (!printOnly) {
        outro(message);
      }
    },
    print(message): void {
      process.stdout.write(`${message}\n`);
    },
    sanitizeGeneratedText: sanitizeForDisplay,
    sanitizeTerminalText,
    style: {
      cyan: paint(C.cyan),
      dim: paint(C.dim),
      yellow: paint(C.yellow),
    },
  };
}

export function createProgressSpinner(): ProgressSpinner {
  if (process.stderr.isTTY) {
    return spinner({ output: process.stderr });
  }
  return {
    start(): void {
      return undefined;
    },
    stop(message?: string): void {
      process.stderr.write(`${sanitizeTerminalText(message ?? '')}\n`);
    },
    clear(): void {
      return undefined;
    },
  };
}
