function providerDelayMs(text: string): number | null {
  try {
    const json = JSON.parse(text) as {
      error?: { details?: Array<{ retryDelay?: string; retryInfo?: { retryDelay?: string } }> };
      details?: Array<{ retryDelay?: string; retryInfo?: { retryDelay?: string } }>;
    };
    const details = json.error?.details ?? json.details ?? [];
    for (const detail of details) {
      const value = detail.retryDelay ?? detail.retryInfo?.retryDelay;
      if (value?.endsWith('s')) {
        const milliseconds = Math.ceil(Number.parseFloat(value) * 1_000);
        if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
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
  if (providerMs !== null) return Math.max(0, Math.min(providerMs, capMs));
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}
