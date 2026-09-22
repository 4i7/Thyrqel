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
    } finally { abort.abort(); await running; input.destroy(); display.destroy(); }
  }
});
