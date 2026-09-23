import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { runOperatorConsole } from '../src/remote/operator-console.js';

test('local console hides secret typing and history, and aborts without sending on Ctrl+C', async () => {
  for (const cancel of [false, true]) {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
    const display = Object.assign(new PassThrough(), { isTTY: true });
    let shown = '';
    display.on('data', chunk => { shown += chunk.toString(); });
    const sent: string[] = [];
    const abort = new AbortController();
    const running = runOperatorConsole({
      list: () => [{ sessionId: 'local-test', profile: 'windows-pwsh', state: 'READY', createdAt: '', lastActivityAt: '',
        identity: undefined, exitCode: undefined, error: undefined }],
      writeSecret: (id, secret) => { assert.equal(id, 'local-test'); sent.push(secret); },
    }, abort, input as unknown as typeof process.stdin, display as unknown as typeof process.stdout);
    try {
      input.write('secret local-test\r');
      await setImmediate();
      assert.ok(shown.includes('Secret: '));
      input.write('synthetic-private-value');
      await setImmediate();
      assert.ok(!shown.includes('synthetic-private-value'));
      input.write(cancel ? '\x03' : '\r');
      await setImmediate();
      if (!cancel) {
        input.write('\x1b[A'); // no secret may enter command history
        await setImmediate();
        input.write('quit\r');
      }
      await running;
      assert.deepEqual(sent, cancel ? [] : ['synthetic-private-value']);
      assert.ok(!shown.includes('synthetic-private-value'));
      assert.equal(abort.signal.aborted, true);
      assert.equal(abort.signal.reason, cancel ? 'local Ctrl+C' : 'local quit');
    } finally { abort.abort(); await running; input.destroy(); display.destroy(); }
  }
});

test('profile shortcut selects exactly one live session and refuses stale or ambiguous targets', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const display = Object.assign(new PassThrough(), { isTTY: true });
  let shown = '';
  display.on('data', chunk => { shown += chunk.toString(); });
  const sent: string[] = [];
  const abort = new AbortController();
  const sessions = [{ sessionId: 'current-1', profile: 'wsl-kali' as const, state: 'READY' as const,
    createdAt: '', lastActivityAt: '', identity: undefined, exitCode: undefined, error: undefined }];
  const running = runOperatorConsole({ list: () => sessions,
    writeSecret: (id, secret) => { assert.equal(id, 'current-1'); sent.push(secret); },
  }, abort, input as unknown as typeof process.stdin, display as unknown as typeof process.stdout);
  try {
    input.write('secret stale-id\r');
    await setImmediate();
    assert.ok(shown.includes('No ready session matches'));
    sessions.push({ ...sessions[0]!, sessionId: 'current-2' });
    input.write('secret wsl-kali\r');
    await setImmediate();
    assert.ok(shown.includes('Multiple sessions match'));
    assert.ok(!shown.includes('Secret: '));
    sessions.pop();
    input.write('secret wsl-kali\r');
    await setImmediate();
    assert.ok(shown.includes('Secret: '));
    input.write('synthetic-value\r');
    await setImmediate();
    input.write('quit\r');
    await running;
    assert.deepEqual(sent, ['synthetic-value']);
    assert.ok(!shown.includes('synthetic-value'));
    assert.equal(abort.signal.reason, 'local quit');
  } finally { abort.abort(); await running; input.destroy(); display.destroy(); }
});

test('closing the local TTY records a distinct stop reason', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const display = Object.assign(new PassThrough(), { isTTY: true });
  const abort = new AbortController();
  const running = runOperatorConsole({ list: () => [], writeSecret: () => {} },
    abort, input as unknown as typeof process.stdin, display as unknown as typeof process.stdout);
  try {
    input.end();
    await running;
    assert.equal(abort.signal.reason, 'local console closed');
  } finally { abort.abort(); await running; input.destroy(); display.destroy(); }
});