import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// gcm.config.ts reads the environment at import, so a developer's own GCM
// settings would otherwise change test results.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GCM_') || name === 'LM_API_TOKEN' || name === 'GOOGLE_GEMINI_API_KEY') {
    delete process.env[name];
  }
}

// The saved session in the developer's home directory selects a provider and a
// model, so every test file gets an empty home of its own.
const testHome = mkdtempSync(join(tmpdir(), 'gcm-test-home-'));
process.env.HOME = testHome;
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
