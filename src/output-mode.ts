export const OUTPUT_MODES = ['full', 'commit-only'] as const;

export type OutputMode = (typeof OUTPUT_MODES)[number];

export function isOutputMode(value: unknown): value is OutputMode {
  return typeof value === 'string' && (OUTPUT_MODES as readonly string[]).includes(value);
}
