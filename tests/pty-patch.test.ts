import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';
import { EventEmitter } from 'node:events';

const source = readFileSync(new URL('../../node_modules/node-pty/lib/windowsPtyAgent.js', import.meta.url), 'utf8');
const killSource = source.slice(source.indexOf('    WindowsPtyAgent.prototype.kill = function () {'),
  source.indexOf('    WindowsPtyAgent.prototype._getConsoleProcessList'));

function fixture(exited = false) {
  const events: string[] = [];
  const warnings: unknown[] = [];
  let resolve!: (pids: number[]) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<number[]>((yes, no) => { resolve = yes; reject = no; });
  const Agent = function () {};
  runInNewContext(killSource, { WindowsPtyAgent: Agent, process: {
    kill(pid: number) { events.push(`kill:${pid}`); },
    emitWarning(error: unknown) { warnings.push(error); },
  } });
  const agent = Object.assign(Object.create(Agent.prototype), {
    _useConpty: true, _useConptyDll: false, _exitCode: exited ? 0 : undefined,
    _getConsoleProcessList() { events.push('enumerate'); return pending; },
    _ptyNative: { kill() { events.push('native-release'); } },
    _conoutSocketWorker: { dispose() { events.push('worker-release'); } },
    _inSocket: { destroy() { events.push('input-release'); } },
    _outSocket: { destroy() { events.push('output-release'); } },
  });
  return { agent, events, warnings, resolve, reject };
}

test('ConPTY teardown waits for enumeration and duplicate close cannot start another sweep', async () => {
  const f = fixture();
  f.agent.kill(); f.agent.kill();
  assert.deepEqual(f.events, ['enumerate']);
  f.resolve([42, 43]);
  await tick();
  assert.deepEqual(f.events, ['enumerate', 'kill:42', 'kill:43', 'native-release', 'worker-release', 'input-release', 'output-release']);
  assert.deepEqual(f.warnings, []);
});

test('natural exit only releases resources; enumeration failure is visible and never guesses a PID', async () => {
  const exited = fixture(true);
  exited.agent.kill();
  assert.deepEqual(exited.events, ['native-release', 'worker-release', 'input-release', 'output-release']);
  const failed = fixture();
  failed.agent.kill();
  failed.reject(new Error('enumeration failed'));
  await tick();
  assert.deepEqual(failed.events, ['enumerate', 'native-release', 'worker-release', 'input-release', 'output-release']);
  assert.equal(failed.warnings.length, 1);
});

test('enumeration accepts an attach race only after native exit and rejects other failures', async () => {
  const enumeration = source.slice(source.indexOf('    WindowsPtyAgent.prototype._getConsoleProcessList = function () {'),
    source.indexOf('    Object.defineProperty(WindowsPtyAgent.prototype, "exitCode"'));
  for (const [exitCode, message, expected] of [
    [undefined, 'AttachConsole failed', 'reject'],
    [0, 'AttachConsole failed', 'resolve'],
    [0, 'Unexpected native failure', 'reject'],
  ] as const) {
    const helper = new EventEmitter();
    const Agent = function () {};
    let cleared = false;
    runInNewContext(enumeration, { WindowsPtyAgent: Agent, __dirname: '.',
      path: { join: () => 'helper' }, child_process_1: { fork: () => helper },
      setTimeout: () => 1, clearTimeout: () => { cleared = true; } });
    const agent = Object.assign(Object.create(Agent.prototype), { _innerPid: 42, _exitCode: exitCode });
    const pending = agent._getConsoleProcessList();
    helper.emit('message', { enumerationError: message });
    if (expected === 'resolve') assert.equal((await pending).length, 0);
    else await assert.rejects(pending, /ConPTY process enumeration failed/);
    assert.equal(cleared, true);
    helper.emit('exit', 1);
  }
});
