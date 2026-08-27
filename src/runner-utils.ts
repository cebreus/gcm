const encoder = new TextEncoder();

export function estimateTokenCount(text: string, tokenBytesRatio: number): number {
  return Math.ceil(encoder.encode(text).length / tokenBytesRatio);
}
