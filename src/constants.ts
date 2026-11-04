export const BINARY_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'ico',
  'svg',
  'eot',
  'ttf',
  'woff',
  'woff2',
  'map',
  'heic',
] as const;

// Default values
export const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024 * 1024;

export const DEFAULT_ANALYSIS_EXCLUDE_PATTERNS = ['dist/**', '**/dist/**'] as const;
