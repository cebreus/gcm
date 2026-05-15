function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRetryDelay(detail: unknown): string | null {
  if (!isRecord(detail)) return null;

  const retryDelay = detail.retryDelay;
  if (typeof retryDelay === 'string') return retryDelay;

  const retryInfo = detail.retryInfo;
  if (!isRecord(retryInfo)) return null;

  const nestedRetryDelay = retryInfo.retryDelay;
  return typeof nestedRetryDelay === 'string' ? nestedRetryDelay : null;
}

function hasRetryInfoType(detail: unknown): boolean {
  if (!isRecord(detail)) return false;
  const typeValue = detail['@type'];
  return typeof typeValue === 'string' && typeValue.includes('RetryInfo');
}

function getDetailsFromJson(json: unknown): unknown {
  if (!isRecord(json)) return undefined;
  const jsonError = json.error;
  if (isRecord(jsonError) && Array.isArray(jsonError.details)) {
    return jsonError.details;
  }
  return json.details;
}

function parseRetryMsFromDetails(details: unknown): number {
  if (!Array.isArray(details)) return 0;
  for (const detail of details) {
    const retryDelay = getRetryDelay(detail);
    if (!(hasRetryInfoType(detail) || retryDelay !== null)) continue;
    if (retryDelay !== null && retryDelay.endsWith('s')) {
      return Math.ceil(parseFloat(retryDelay) * 1000);
    }
  }
  return 0;
}

function getExponentialBackoffMs(retryBaseMs: number, retryMaxMs: number, attempt: number): number {
  const base = retryBaseMs;
  const cap = retryMaxMs;
  let retryMs = Math.min(cap, base * 2 ** (attempt - 1));
  retryMs += Math.floor(Math.random() * 1000);
  return retryMs;
}

export function getRetryMsFromResponse(
  textRes: string,
  retryBaseMs: number,
  retryMaxMs: number,
  attempt: number,
): number {
  let retryMs = 0;
  try {
    const json: unknown = JSON.parse(textRes);
    retryMs = parseRetryMsFromDetails(getDetailsFromJson(json));
  } catch {
    // ignore
  }
  if (retryMs) return retryMs;
  return getExponentialBackoffMs(retryBaseMs, retryMaxMs, attempt);
}
