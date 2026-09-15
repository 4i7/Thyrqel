import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IPty } from 'node-pty';
import { BashCommandFramer, PowerShellCommandFramer } from '../src/session/command-framer.js';
import { CompletionDetector } from '../src/session/completion-detector.js';
import { SessionManager } from '../src/session/manager.js';
import { ProfileRegistry } from '../src/profiles.js';
import type { Profile } from '../src/types.js';

const ps: Profile = { id: 'windows-pwsh', platform: 'windows', shellDialect: 'powershell', command: 'pwsh.exe' };
const psIdentity = JSON.stringify({ shell: 'powershell', version: '7.6.5', edition: 'Core', cwd: 'C:\\' });

function completionFrame(token: string, operationId: string, success: boolean, exitCode: number | null, cwd: string) {
  return `\x1eTB1:${token}:${Buffer.from(operationId).toString('base64')}:${success ? '1' : '0'}:${exitCode ?? 'N'}:${Buffer.from(cwd).toString('base64')}\x1f`;
}

function fakePowerShell() {
  let data: (s: string) => void = () => {};
  let exit: (e: { exitCode: number }) => void = () => {};
  const writes: string[] = [];
  let first = true;
  const pty = {
    onData(fn: typeof data) { data = fn; return { dispose() { data = () => {}; } }; },
    onExit(fn: typeof exit) { exit = fn; return { dispose() { exit = () => {}; } }; },
    write(command: string) {
      writes.push(command);
      if (!first) return;
      first = false;
      const halves = [...command.matchAll(/'([a-f0-9]{24})'/g)].map(m => m[1]);
      assert.equal(halves.length >= 2, true);
      queueMicrotask(() => data(`TBREADY:${halves[0]}${halves[1]}:${Buffer.from(psIdentity).toString('base64')}:END`));
    },
    kill() { exit({ exitCode: 0 }); }
  } as unknown as IPty;
  return { pty, writes, emit: (s: string) => data(s), exit: (code = 0) => exit({ exitCode: code }) };
}

function tokenFromWire(wire: string) {
  const halves = [...wire.matchAll(/'([a-f0-9]{24})'/g)].map(m => m[1]);
  assert.equal(halves.length >= 2, true);
  return halves[0]! + halves[1]!;
}

test('command framers encode payloads and do not echo the completion token contiguously', () => {
  for (const framer of [new BashCommandFramer(), new PowerShellCommandFramer()]) {
    const command = "printf 'marker-like \\x1eTB1 text'";
    const framed = framer.frame(command, 'op_test');
    assert.equal(framed.wire.includes(command), false);
    assert.equal(framed.wire.includes(framed.completionToken), false);
    assert.equal(framed.completionToken.length, 48);
  }
});

test('bash framer reserves a persistent control descriptor before payload execution', () => {
  const wire = new BashCommandFramer().frame('exec >/dev/null', 'op_test').wire;
  assert.match(wire, /exec \{__tb_fd\}>&1/);
  assert.match(wire, />&\$__tb_fd/);
  assert.equal(wire.includes('exec {__tb_fd}>&-'), false);
});

test('completion detector handles every chunk split and preserves marker-like normal output', () => {
  const token = 'a'.repeat(48);
  const frame = completionFrame(token, 'op_split', false, 42, '/tmp');
  for (let split = 0; split <= frame.length; split++) {
    const detector = new CompletionDetector();
    detector.arm(token);
    const a = detector.accept('normal TB1:not-a-frame\n' + frame.slice(0, split));
    const b = detector.accept(frame.slice(split));
    assert.equal(a.output + b.output, 'normal TB1:not-a-frame\n');
    const c = a.completion ?? b.completion;
    assert.deepEqual(c, { operationId: 'op_split', success: false, exitCode: 42, cwd: '/tmp' });
  }
});

test('completion detector fails closed on an oversized matching frame', () => {
  const token = 'b'.repeat(48);
  const detector = new CompletionDetector();
  detector.arm(token);
  assert.throws(() => detector.accept(`\x1eTB1:${token}:` + 'x'.repeat(17000)), { code: 'SESSION_PROTOCOL_ERROR' });
});

test('step timeout remains active, rejects concurrent step, and delayed completion is readable', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id);
  manager.read(session.sessionId);
  const first = await manager.step(session.sessionId, 'Start-Sleep -Seconds 3', 1);
  assert.equal(first.state, 'running');
  assert.throws(() => manager.step(session.sessionId, 'Write-Output second', 1), { code: 'SESSION_BUSY' });
  const active = manager.read(session.sessionId).activeStep!;
  const wire = f.writes.at(-1)!;
  const token = tokenFromWire(wire);
  f.emit('late output\n');
  const frame = completionFrame(token, active.operationId, false, 1, 'C:\\work');
  f.emit(frame.slice(0, 7));
  f.emit(frame.slice(7));
  const read = manager.read(session.sessionId);
  assert.equal(read.stepState, 'ready');
  assert.equal(read.output, 'late output\n');
  assert.deepEqual(read.completion && { success: read.completion.success, exitCode: read.completion.exitCode, cwd: read.completion.cwd },
    { success: false, exitCode: 1, cwd: 'C:\\work' });
  manager.close(session.sessionId);
});

test('interactive write modes are PTY input and do not create ActiveStep', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id);
  manager.write(session.sessionId, { mode: 'line', data: 'print(2 + 3)' });
  manager.write(session.sessionId, { mode: 'key', key: 'CTRL_C' });
  manager.write(session.sessionId, { mode: 'key', key: 'CTRL_D' });
  manager.write(session.sessionId, { mode: 'key', key: 'UP' });
  assert.deepEqual(f.writes.slice(-4), ['print(2 + 3)\r', '\x03', '\x04', '\x1b[A']);
  assert.equal(manager.read(session.sessionId).activeStep, undefined);
  manager.close(session.sessionId);
});

test('multiple sessions keep output and ActiveStep state independent', async () => {
  const f1 = fakePowerShell(), f2 = fakePowerShell(), f3 = fakePowerShell();
  const queue = [f1.pty, f2.pty, f3.pty];
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => queue.shift()!, checkHost() {}, maxSessions: 3 });
  const a = await manager.open(ps.id), b = await manager.open(ps.id), c = await manager.open(ps.id);
  manager.read(a.sessionId); manager.read(b.sessionId); manager.read(c.sessionId);
  const pa = manager.step(a.sessionId, 'long-running', 1);
  f2.emit('B only\n'); f3.emit('C only\n');
  assert.equal((await pa).state, 'running');
  assert.equal(manager.read(b.sessionId).output, 'B only\n');
  assert.equal(manager.read(c.sessionId).output, 'C only\n');
  assert.equal(manager.read(b.sessionId).activeStep, undefined);
  assert.ok(manager.read(a.sessionId).activeStep);
  manager.close(a.sessionId); manager.close(b.sessionId); manager.close(c.sessionId);
});

test('close wins over late completion and shell exit never revives a terminal session', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id);
  const pending = manager.step(session.sessionId, 'long-running', 1000);
  const active = manager.read(session.sessionId).activeStep!;
  const token = tokenFromWire(f.writes.at(-1)!);
  const closed = manager.close(session.sessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal((await pending).state, 'closed');
  f.emit(completionFrame(token, active.operationId, true, 0, 'C:\\late'));
  f.exit(0);
  assert.equal(manager.read(session.sessionId).state, 'CLOSED');
});

test('Ctrl+C before completion keeps transaction active until a valid frame arrives', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id); manager.read(session.sessionId);
  const pending = manager.step(session.sessionId, 'long-running', 1000);
  const active = manager.read(session.sessionId).activeStep!;
  const token = tokenFromWire(f.writes.at(-1)!);
  manager.write(session.sessionId, { mode: 'key', key: 'CTRL_C' });
  assert.ok(manager.read(session.sessionId).activeStep);
  f.emit(completionFrame(token, active.operationId, false, null, 'C:\\'));
  const result = await pending;
  assert.equal(result.state, 'ready');
  assert.equal(result.success, false);
  manager.close(session.sessionId);
});

test('completion before Ctrl+C and completion before close cannot be overwritten by later input/lifecycle', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id); manager.read(session.sessionId);
  const pending = manager.step(session.sessionId, 'quick', 1000);
  const active = manager.read(session.sessionId).activeStep!;
  const token = tokenFromWire(f.writes.at(-1)!);
  f.emit(completionFrame(token, active.operationId, true, null, 'C:\\done'));
  const result = await pending;
  assert.equal(result.state, 'ready');
  manager.write(session.sessionId, { mode: 'key', key: 'CTRL_C' });
  assert.equal(manager.read(session.sessionId).state, 'READY');
  assert.equal(manager.close(session.sessionId).state, 'CLOSED');
  assert.equal(manager.read(session.sessionId).state, 'CLOSED');
});

test('PTY exit while a step is active resolves the waiter as exited and late frames cannot revive it', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id); manager.read(session.sessionId);
  const pending = manager.step(session.sessionId, 'exit-like', 1000);
  const active = manager.read(session.sessionId).activeStep!;
  const token = tokenFromWire(f.writes.at(-1)!);
  f.exit(7);
  const result = await pending;
  assert.equal(result.state, 'exited');
  assert.equal(manager.read(session.sessionId).state, 'EXITED');
  f.emit(completionFrame(token, active.operationId, true, 0, 'C:\\late'));
  assert.equal(manager.read(session.sessionId).state, 'EXITED');
  manager.close(session.sessionId);
});

test('delayed success is retained for terminal_read after step wait timeout', async () => {
  const f = fakePowerShell();
  const manager = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const session = await manager.open(ps.id); manager.read(session.sessionId);
  const first = await manager.step(session.sessionId, 'later-success', 1);
  assert.equal(first.state, 'running');
  const active = manager.read(session.sessionId).activeStep!;
  const token = tokenFromWire(f.writes.at(-1)!);
  f.emit('more\n');
  f.emit(completionFrame(token, active.operationId, true, null, 'C:\\later'));
  const read = manager.read(session.sessionId);
  assert.equal(read.output, 'more\n');
  assert.equal(read.completion?.success, true);
  assert.equal(read.completion?.exitCode, null);
  manager.close(session.sessionId);
});
