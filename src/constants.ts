// HTTP status codes
const HTTP_STATUS = {
  TOO_MANY_REQUESTS: 429,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

// File extensions
export const CODE_EXTENSIONS = ['js', 'ts', 'jsx', 'tsx', 'svelte'] as const;
export const MARKUP_EXTENSIONS = ['html', 'hbs', 'njk'] as const;
export const STYLE_EXTENSIONS = ['css', 'scss', 'sass'] as const;
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

// File importance weights
export const FILE_IMPORTANCE_WEIGHTS = {
  CODE: 10,
  MARKUP: 6,
  STYLE: 4,
  BINARY: 0,
  DEFAULT: 1,
} as const;

// Default values
export const DEFAULT_MAX_DEBUG_LOG_BYTES = 32768;
