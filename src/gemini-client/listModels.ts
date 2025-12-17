/**
 * Fetches the list of available Gemini models from the API.
 * @param apiKey Google Gemini API key
 * @returns Array of model names
 */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data.models || !Array.isArray(data.models)) {
    throw new Error('No models found in response');
  }
  return data.models.map((m: { name?: string }) => m.name || '');
}
