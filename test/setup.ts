// gcm.config.ts reads the environment at import, so a developer's own GCM
// settings would otherwise change test results.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GCM_') || name === 'LM_API_TOKEN' || name === 'GOOGLE_GEMINI_API_KEY') {
    delete process.env[name];
  }
}
