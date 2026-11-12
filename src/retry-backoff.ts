import { MILLISECONDS_PER_SECOND } from './constants.js';
import { isRecord } from './utils.js';

function retryDetails(value: unknown): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const errorDetails = isRecord(value.error) ? value.error.details : undefined;
  const details = errorDetails ?? value.details;
  return Array.isArray(details) ? details : [];
}

function retryDelay(detail: unknown): string | undefined {
  if (!isRecord(detail)) {
    return undefined;
  }
  if (typeof detail.retryDelay === 'string') {
    return detail.retryDelay;
  }
  return isRecord(detail.retryInfo) &&
    typeof detail.retryInfo.retryDelay === 'string'
    ? detail.retryInfo.retryDelay
    : undefined;
}

function providerDelayMs(text: string): number | null {
  try {
    const json: unknown = JSON.parse(text);
    for (const detail of retryDetails(json)) {
      const value = retryDelay(detail);
      if (value?.endsWith('s') === true) {
        const milliseconds = Math.ceil(
          Number.parseFloat(value) * MILLISECONDS_PER_SECOND,
        );
        if (Number.isFinite(milliseconds) && milliseconds > 0) {
          return milliseconds;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function retryDelayMs(
  responseBody: string,
  baseMs: number,
  capMs: number,
  attempt: number,
): number {
  const providerMs = providerDelayMs(responseBody);
  if (providerMs !== null) {
    return Math.max(0, Math.min(providerMs, capMs));
  }
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}
