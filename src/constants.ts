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

export const DEFAULT_QUIET_EXCLUDE_PATTERNS = ['dist/**', '**/dist/**'] as const;

// Glob has no negation, so `.env.example`/`.env.sample` are excluded with `.env.*`.
// Staged matches are reported as excluded paths so the commit needs acknowledgement.
export const SECRET_FILE_EXCLUDE_PATTERNS = [
  '.env',
  '**/.env',
  '.env.*',
  '**/.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.tfvars',
  '*.tfstate',
  '.netrc',
  '**/.netrc',
  '.npmrc',
  '**/.npmrc',
  'id_rsa*',
  '**/id_rsa*',
  'id_ed25519*',
  '**/id_ed25519*',
] as const;

export const DEFAULT_ANALYSIS_EXCLUDE_PATTERNS = [
  ...DEFAULT_QUIET_EXCLUDE_PATTERNS,
  ...SECRET_FILE_EXCLUDE_PATTERNS,
] as const;
