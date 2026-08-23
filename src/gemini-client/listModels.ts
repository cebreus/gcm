/**
 * Fetches the list of available Gemini models from the API.
 * @param apiKey Google Gemini API key
 * @returns Array of model names
 */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  type ModelApiItem = {
    name?: string;
    supportedGenerationMethods?: string[];
  };

  const isModelApiItem = (value: unknown): value is ModelApiItem => {
    if (!isRecord(value)) return false;
    const methods = value.supportedGenerationMethods;
    if (methods !== undefined && !Array.isArray(methods)) return false;
    if (Array.isArray(methods) && methods.some(m => typeof m !== 'string')) return false;
    const name = value.name;
    return name === undefined || typeof name === 'string';
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models';
  const res = await fetch(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new Error('No models found in response');
  }

  return data.models
    .filter(isModelApiItem)
    .filter(m => m.supportedGenerationMethods?.includes('generateContent') ?? false)
    .map(m => m.name ?? '')
    .filter(Boolean);
}
