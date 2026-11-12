import { expect, test } from 'bun:test';

import type { Logger } from '../src/logger.js';
import { withRequestTrace } from '../src/provider-http.js';

test('provider-http: trace redacts a provider token echoed in a body', async () => {
  const token = 'opaque-value-123';
  // eslint-disable-next-line no-useless-concat -- fake token stays split so secret scanners skip this fixture
  const gitlabToken = 'glpat-' + 'aB3dE5gH7jK9mN1pQ3rS5';
  const logged: string[] = [];
  const logger: Logger = {
    log: (_level, message, meta) => {
      logged.push(message + JSON.stringify(meta));
    },
  };
  const traced = withRequestTrace(
    logger,
    async () =>
      await Promise.resolve(
        new Response(
          JSON.stringify({ echoed: `Bearer ${token}`, text: gitlabToken }),
        ),
      ),
    'Fake',
    token,
  );

  const response = await traced('http://127.0.0.1/v1/chat/completions', {
    body: JSON.stringify({ note: token }),
  });

  expect(await response.text()).toContain(token);
  expect(logged).toHaveLength(2);
  expect(logged.join('\n')).not.toContain(token);
  expect(logged.join('\n')).not.toContain(gitlabToken);
  expect(logged.join('\n')).toContain('[REDACTED-TOKEN]');
});
