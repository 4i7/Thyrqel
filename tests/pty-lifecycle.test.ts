import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the installed dependency's state transitions without depending on OS scheduling.
// Real worker, EOF, process, and handle behavior is covered by diagnose-lifecycle.
const exports: Record<string, any> = {};
vm.runInNewContext(readFileSync(new URL('../../node_modules/node-pty/lib/windowsPtyAgent.js', import.meta.url), 'utf8'), {
  exports, require: () => ({})
});
function agent() {
  const events: string[] = [];
  const instance = Object.create(exports.WindowsPtyAgent.prototype);
  Object.assign(instance, {
    _useConpty: true, _pty: 1, _closing: false, _cleanedUp: false, _outputEnded: false,
    _inSocket: { destroy() { events.push('input-close'); } },
    _outSocket: { destroy() { events.push('output-close'); } },
    _conoutSocketWorker: { dispose() { events.push('worker-close'); } },
    _ptyNative: { kill() { events.push('native-close'); } }
  });
  return { instance, events, eof() { instance._outputEnded = true; instance._cleanUpProcess(); } };
}
for (const first of ['exit', 'eof'] as const) {
  test(`dependency retains output until both EOF and process exit (${first} first)`, () => {
    const a = agent();
    if (first === 'exit') a.instance._$onProcessExit(7); else a.eof();
    assert.ok(!a.events.includes('output-close'));
    assert.ok(!a.events.includes('worker-close'));
    if (first === 'exit') a.eof(); else a.instance._$onProcessExit(7);
    assert.equal(a.instance.exitCode, 7);
    assert.deepEqual(a.events.filter(e => e !== 'input-close'), ['native-close', 'output-close', 'worker-close']);
    a.instance.kill(); a.eof();
    assert.equal(a.events.filter(e => e === 'native-close').length, 1);
    assert.equal(a.events.filter(e => e === 'worker-close').length, 1);
  });
}
test('dependency explicit double kill preserves drain until real exit/EOF', () => {
  const a = agent();
  a.instance.kill(); a.instance.kill();
  assert.deepEqual(a.events, ['input-close', 'native-close']);
  a.eof();
  assert.ok(!a.events.includes('output-close'));
  a.instance._$onProcessExit(1);
  assert.deepEqual(a.events.filter(e => e !== 'input-close'), ['native-close', 'output-close', 'worker-close']);
});
