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
export const BYTES_PER_KIBIBYTE = 1024;
export const KIBIBYTES_PER_MEBIBYTE = 1024;
export const MILLISECONDS_PER_SECOND = 1_000;
export const HTTP_STATUS_BAD_REQUEST = 400;
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_FORBIDDEN = 403;
export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
export const HTTP_STATUS_REQUEST_TIMEOUT = 408;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
export const HTTP_STATUS_BAD_GATEWAY = 502;
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
export const HTTP_STATUS_GATEWAY_TIMEOUT = 504;
export const SECONDS_PER_MINUTE = 60;
const MAX_CHILD_OUTPUT_MEBIBYTES = 1024;
export const MAX_CHILD_OUTPUT_BYTES =
  BYTES_PER_KIBIBYTE * KIBIBYTES_PER_MEBIBYTE * MAX_CHILD_OUTPUT_MEBIBYTES;

const DEFAULT_QUIET_EXCLUDE_PATTERNS = ['dist/**', '**/dist/**'] as const;

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
