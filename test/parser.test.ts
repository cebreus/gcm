import { test, expect } from 'bun:test';
import { parseLanguageModelOutput } from '../src/parser';

test('parser: returns the commit message the model produced', () => {
  expect(parseLanguageModelOutput('feat(core): add thing')).toBe('feat(core): add thing');
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
  expect(parseLanguageModelOutput('feat: foo:bar:baz')).toBe('feat: foo:bar:baz');
});

test('parser: normalises Windows line endings between subject and body', () => {
  expect(parseLanguageModelOutput('feat: crlf\r\n\r\n- adds crlf handling')).toBe(
    'feat: crlf\n\n- adds crlf handling',
  );
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
    'custom-type(long scope)!: ' +
      'word '.repeat(100) +
      '\n\nThinking and channel are ordinary words.',
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
  expect(() => parseLanguageModelOutput('Here is the commit message:\n\nfeat(api): real')).toThrow(
    'LLM output has invalid Conventional Commit subject',
  );
});

test('parser: no body line can replace the generated subject', () => {
  const raw = 'feat(parser): document the old label protocol\n\nCOMMIT_MESSAGE: fix: hijacked';
  expect(parseLanguageModelOutput(raw)).toBe(raw);
});
