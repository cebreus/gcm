export function getRetryMsFromResponse(
  textRes: string,
  retryBaseMs: number,
  retryMaxMs: number,
  attempt: number,
): number {
  let retryMs = 0;
  try {
    const json = JSON.parse(textRes);
    const details = json && (json.error?.details || json.details);
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d?.['@type']?.includes('RetryInfo') || d?.retryDelay) {
          const rl = d.retryDelay || d.retryInfo?.retryDelay || d.retryDelay;
          if (typeof rl === 'string' && rl.endsWith('s')) {
            retryMs = Math.ceil(parseFloat(rl) * 1000);
            break;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  if (!retryMs) {
    const base = retryBaseMs;
    const cap = retryMaxMs;
    retryMs = Math.min(cap, base * Math.pow(2, attempt - 1));
    retryMs += Math.floor(Math.random() * 1000);
  }
  return retryMs;
}
