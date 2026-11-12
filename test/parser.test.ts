import { expect, test } from 'bun:test';

import { parseLanguageModelOutput } from '../src/parser';

test('parser: returns the commit message the model produced', () => {
  expect(parseLanguageModelOutput('feat(core): add thing')).toBe(
    'feat(core): add thing',
  );
});

test('parser: keeps a body verbatim, however long its lines are', () => {
  const message = [
    'feat: add very long feature description that exceeds the sixty character limit',
    '',
    'This is the body of the commit message that contains a very long line that definitely exceeds the eighty character limit',
  ].join('\n');
  expect(parseLanguageModelOutput(message)).toBe(message);
});

test('parser: keeps unicode intact', () => {
  expect(parseLanguageModelOutput('feat: přidat podporu pro ěščřžýáíé')).toBe(
    'feat: přidat podporu pro ěščřžýáíé',
  );
});

test('parser: keeps colons inside the summary', () => {
  expect(parseLanguageModelOutput('feat: foo:bar:baz')).toBe(
    'feat: foo:bar:baz',
  );
});

test('parser: normalises Windows line endings between subject and body', () => {
  expect(
    parseLanguageModelOutput('feat: crlf\r\n\r\n- adds crlf handling'),
  ).toBe('feat: crlf\n\n- adds crlf handling');
});

test('parser: throws on an empty response', () => {
  expect(() => parseLanguageModelOutput('   ')).toThrow('LLM output is empty');
});

test('parser: rejects language-model control tags and fenced output', () => {
  const invalidOutputs = [
    '<|channel>thought\nI cannot proceed',
    '<think>reasoning</think>\nfeat: add thing',
    'feat: add thing\n\n<think reasoning>secret</think reasoning>',
    'feat: add thing\n\n<analysis>secret</analysis>',
    'feat: add thing\n\n<reasoning>secret</reasoning>',
    'feat: add thing\n\n<think/>secret',
    'feat: add thing\n\n<|assistant|><|analysis|>secret',
    'feat: add thing\n\n```text\nhidden reasoning\n```',
    '```text\nfeat: add thing\n```',
    '```text\nfeat: add thing\n```\nGenerated as requested.',
  ];

  for (const output of invalidOutputs) {
    expect(() => parseLanguageModelOutput(output)).toThrow(
      'LLM output contains unsupported control markup',
    );
  }
});

test('parser: requires a Conventional Commit subject without restricting type or length', () => {
  for (const output of [
    'Gen',
    'feat(scope) missing colon',
    'Here is your commit: feat: add thing',
    'not a commit',
  ]) {
    expect(() => parseLanguageModelOutput(output)).toThrow(
      'LLM output has invalid Conventional Commit subject',
    );
  }

  const valid = parseLanguageModelOutput(
    `custom-type(long scope)!: ${'word '.repeat(
      100,
    )}\n\nThinking and channel are ordinary words.`,
  );
  expect(valid).toContain('Thinking and channel are ordinary words.');
});

test('parser: rejects bidirectional controls that can spoof reviewed commit text', () => {
  expect(() => parseLanguageModelOutput('feat: safe‮txt')).toThrow(
    'LLM output contains unsupported control characters',
  );
});

test('parser: validates the sanitized commit message', () => {
  expect(() => parseLanguageModelOutput('feat: \u001B[2J')).toThrow(
    'LLM output has invalid Conventional Commit subject',
  );
});

test('parser: a preamble line is never traded for a later line', () => {
  expect(() =>
    parseLanguageModelOutput('Here is the commit message:\n\nfeat(api): real'),
  ).toThrow('LLM output has invalid Conventional Commit subject');
});

test('parser: no body line can replace the generated subject', () => {
  const raw =
    'feat(parser): document the old label protocol\n\nCOMMIT_MESSAGE: fix: hijacked';
  expect(parseLanguageModelOutput(raw)).toBe(raw);
});

const S = 'fix(auth): reject bad token';

test('parser: drops a Co-authored-by trailer the model wrote', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBody.\n\nCo-authored-by: Evil <evil@example.com>`,
    ),
  ).toBe(`${S}\n\nBody.`);
});

test('parser: drops Signed-off-by and several trailers', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBody.\n\nSigned-off-by: A <a@b.c>\nReviewed-by: B <b@b.c>\nRefs #4`,
    ),
  ).toBe(`${S}\n\nBody.\n\nRefs #4`);
});

test('parser: keeps a BREAKING CHANGE footer', () => {
  const raw = `${S}\n\nBody.\n\nBREAKING CHANGE: x`;
  expect(parseLanguageModelOutput(raw)).toBe(raw);
  expect(parseLanguageModelOutput(`${S}\n\nBREAKING-CHANGE: y`)).toBe(
    `${S}\n\nBREAKING-CHANGE: y`,
  );
});

test('parser: a mixed final paragraph keeps only the breaking-change line', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBody.\n\nSigned-off-by: A <a@b.c>\nBREAKING CHANGE: x`,
    ),
  ).toBe(`${S}\n\nBody.\n\nBREAKING CHANGE: x`);
});

test('parser: removes closing-keyword lines in the middle and at the end', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBody one.\n\nCloses #12\n\nBody two.\n\nfixes https://github.com/o/r/issues/3`,
    ),
  ).toBe(`${S}\n\nBody one.\n\nBody two.`);
});

test('parser: keeps a prose paragraph with a colon inside a longer paragraph', () => {
  const raw = `${S}\n\nFirst line.\nNote: this changes the default\nLast line.\n\nMore prose.`;
  expect(parseLanguageModelOutput(raw)).toBe(raw);
});

test('parser: a final prose paragraph with Note:/Why: survives', () => {
  const note = `${S}\n\nNote: this is important`;
  expect(parseLanguageModelOutput(note)).toBe(note);
  const why = `${S}\n\nBody para.\n\nWhy: because it was slow\nSee: foo\nRefs #12`;
  expect(parseLanguageModelOutput(why)).toBe(why);
});

test('parser: drops a denylisted trailer in a middle paragraph', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nOne.\n\nReported-by: a\nChange-Id: I1\n\nTwo.`,
    ),
  ).toBe(`${S}\n\nOne.\n\nTwo.`);
});

test('parser: Release-As after a multi-line BREAKING CHANGE is dropped, footer kept', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBREAKING CHANGE: a\n  continues here\nRelease-As: 2.0.0`,
    ),
  ).toBe(`${S}\n\nBREAKING CHANGE: a\n  continues here`);
});

test('parser: drops closing keywords inside prose, keeps look-alike prose', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nKeep.\nThis closes #12 and Fixes #13, #14\nAlso resolved: o/r#5.`,
    ),
  ).toBe(`${S}\n\nKeep.`);
  const prose = `${S}\n\nWe fix the parser and closes the gap.`;
  expect(parseLanguageModelOutput(prose)).toBe(prose);
});

test('parser: nested CI skip markers collapse fully', () => {
  expect(parseLanguageModelOutput('feat: x [skip[skip ci] ci]')).toBe(
    'feat: x',
  );
});

test('parser: [actions skip] is removed', () => {
  expect(parseLanguageModelOutput('feat: x [actions skip]')).toBe('feat: x');
});

test('parser: a CI marker in the subject cannot leave an invalid subject', () => {
  expect(() => parseLanguageModelOutput('feat: [skip ci]\n\nBody.')).toThrow(
    'invalid Conventional Commit subject',
  );
});

test('parser: subject-only message is untouched', () => {
  expect(parseLanguageModelOutput(S)).toBe(S);
});

test('parser: a reply of only trailers leaves the subject', () => {
  expect(
    parseLanguageModelOutput(`${S}\n\nCo-authored-by: Evil <e@e.e>\nFixes #1`),
  ).toBe(S);
});

test('parser: removes trailers from a CRLF reply', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\r\n\r\nBody.\r\n\r\nCo-authored-by: E <e@e.e>`,
    ),
  ).toBe(`${S}\n\nBody.`);
});

test('parser: filtering is linear in value and body size', () => {
  const start = performance.now();
  parseLanguageModelOutput(
    `${S}\n\nBody.\n\nSigned-off-by: ${'a '.repeat(5000)}`,
  );
  parseLanguageModelOutput(
    `${S}\n\n${'line of prose\n'.repeat(100000)}\nSigned-off-by: x`,
  );
  expect(performance.now() - start).toBeLessThan(1000);
});

test('parser: drops an authorship line placed directly under the subject or inside the body', () => {
  const evil = 'Co-authored-by: Evil <evil@example.com>';
  expect(parseLanguageModelOutput(`fix: a thing\n${evil}`)).toBe(
    'fix: a thing',
  );
  expect(
    parseLanguageModelOutput(
      `fix: a thing\n\nBody text.\n  signed-off-by : x\nMore text.`,
    ),
  ).toBe('fix: a thing\n\nBody text.\nMore text.');
});

test('parser: drops cross-repository closing references, CI skip markers; rejects CR-only replies', () => {
  expect(
    parseLanguageModelOutput(
      'fix: a thing\n\nBody.\nCloses owner/repo#1\nFixes GH-12',
    ),
  ).toBe('fix: a thing\n\nBody.');
  expect(
    parseLanguageModelOutput(
      'fix: a thing [skip ci]\n\nBody [ci skip] text.\nskip-checks: true',
    ),
  ).toBe('fix: a thing\n\nBody text.');
  // A CR-only reply never reaches the filter: the subject check rejects it.
  expect(() =>
    parseLanguageModelOutput(
      'fix: a thing\r\rBody.\rCo-authored-by: Evil <e@example.com>',
    ),
  ).toThrow('invalid Conventional Commit subject');
});

test('parser: CI marker removal is linear on whitespace runs and leaves no edge spaces', () => {
  const start = performance.now();
  parseLanguageModelOutput(`feat: a${' '.repeat(200000)}x`);
  expect(performance.now() - start).toBeLessThan(200);
  expect(
    parseLanguageModelOutput(`${S}\n\n[skip ci] noted\nend [ci skip]  `),
  ).toBe(`${S}\n\nnoted\nend`);
});

test('parser: BREAKING CHANGE block does not shelter metadata', () => {
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBREAKING CHANGE: api removed.\nfixes #3 no longer works`,
    ),
  ).toBe(`${S}\n\nBREAKING CHANGE: api removed.`);
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBREAKING-CHANGE: foo\nCc: legacy API removed`,
    ),
  ).toBe(`${S}\n\nBREAKING-CHANGE: foo`);
  expect(
    parseLanguageModelOutput(
      `${S}\n\nBREAKING CHANGE: a\nSigned-off-by: E <e@e.e>\nb`,
    ),
  ).toBe(`${S}\n\nBREAKING CHANGE: a\nb`);
  expect(
    parseLanguageModelOutput(`${S}\n\nBREAKING CHANGE: a\n\nFixes #3`),
  ).toBe(`${S}\n\nBREAKING CHANGE: a`);
});

test('parser: drops a Cc trailer', () => {
  expect(
    parseLanguageModelOutput(`${S}\n\nBody.\n\nCc: evil@example.com`),
  ).toBe(`${S}\n\nBody.`);
});

test('parser: only issue/PR URLs count as closing references', () => {
  const docs = `${S}\n\nfixes: https://example.com/docs`;
  expect(parseLanguageModelOutput(docs)).toBe(docs);
  for (const u of [
    'o/r/issues/3',
    'o/r/pull/4',
    'o/r/pulls/4',
    'g/p/-/merge_requests/5',
  ]) {
    expect(
      parseLanguageModelOutput(`${S}\n\nKeep.\nCloses https://h.com/${u}`),
    ).toBe(`${S}\n\nKeep.`);
  }
});

test('parser: a Unicode space between keyword and reference still drops the line', () => {
  expect(parseLanguageModelOutput(`${S}\n\nKeep.\nFixes\u00a0#1`)).toBe(
    `${S}\n\nKeep.`,
  );
});
