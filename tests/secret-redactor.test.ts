import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretRedactor } from '../src/session/secret-redactor.js';

test('exact secret echoes are suppressed across every chunk split', () => {
  const secret = 'example-秘密-😀';
  const text = `before ${secret} after ${secret}\r\n`;
  for (let split = 0; split <= text.length; split++) {
    const redactor = new SecretRedactor();
    redactor.add(secret);
    assert.equal(redactor.accept(text.slice(0, split)) + redactor.accept(text.slice(split)) + redactor.finish(),
      'before [REDACTED] after [REDACTED]\r\n');
  }
});

test('overlapping secrets and incomplete trailing echoes do not disclose their prefixes', () => {
  const redactor = new SecretRedactor();
  redactor.add('abc');
  redactor.add('abcdef');
  assert.equal(redactor.accept('abc'), '');
  assert.equal(redactor.accept('def abc! ab'), '[REDACTED] [REDACTED]! ');
  assert.equal(redactor.finish(), '[REDACTED]');
  assert.equal(redactor.accept('ordinary output'), 'ordinary output');
});

test('secret registration is bounded and rejects line or terminal control injection', () => {
  const redactor = new SecretRedactor();
  for (const invalid of ['', 'a\r', 'a\n', '\x1b', 'x'.repeat(1025)]) assert.throws(() => redactor.add(invalid));
  for (let i = 0; i < 8; i++) redactor.add(`secret${i}`);
  redactor.add('secret0');
  assert.throws(() => redactor.add('overflow'));
});
