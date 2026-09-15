import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IPty } from 'node-pty';
import { OutputRing } from '../src/session/output-ring.js';
import { Readiness } from '../src/session/readiness.js';
import { SessionManager } from '../src/session/manager.js';
import { ProfileRegistry, launch } from '../src/profiles.js';
import type { Profile } from '../src/types.js';

const ps: Profile = { id: 'windows-pwsh', platform: 'windows', shellDialect: 'powershell', command: 'pwsh.exe' };
const kali: Profile = { id: 'wsl-kali', platform: 'wsl2', shellDialect: 'bash', distro: 'kali-linux', user: 'tester', shell: '/bin/bash', initialDirectory: '~' };
const frame = (r: Readiness, value: string) => `TBREADY:${r.nonce}:${Buffer.from(value).toString('base64')}:END`;
const psValue = JSON.stringify({ shell: 'powershell', version: '7.6.5', edition: 'Core', cwd: 'C:\\' });

test('ring eviction counts UTF-8 bytes, preserves code points, drains incrementally', () => {
  const ring = new OutputRing(5);
  ring.append('a日😀');
  assert.deepEqual(ring.read(), { output: '😀', truncated: true, dropped_bytes: 4 });
  assert.deepEqual(ring.read(), { output: '', truncated: false, dropped_bytes: 0 });
  for (let i = 0; i < 100; i++) ring.append('abc');
  assert.deepEqual(ring.read(), { output: 'bcabc', truncated: true, dropped_bytes: 295 });
});
test('readiness accepts every split and rejects input echo', () => {
  const length = frame(new Readiness(ps), psValue).length;
  for (let split = 0; split < length; split++) {
    const r: Readiness = new Readiness(ps);
    assert.equal(r.accept(r.command), undefined);
    const value = frame(r, psValue);
    const at = Math.min(split, value.length - 1);
    assert.equal(r.accept(value.slice(0, at)), undefined);
    assert.equal(r.accept(value.slice(at))?.version, '7.6.5');
  }
});
test('output preserves Unicode surrogate pairs across onData chunks', () => {
  const ring = new OutputRing(4);
  ring.append('\uD83D');
  assert.equal(ring.read().output, '');
  ring.append('\uDE00');
  assert.equal(ring.read().output, '😀');
  ring.append('\uD83D');
  ring.finish();
  assert.equal(ring.read().output, '\uFFFD');
});
test('WSL verifies non-root user, executable, interactive flag and initial directory', () => {
  const good = ['1000', 'tester', '/usr/bin/bash', '/bin/bash', 'himBHs', '/home/tester', '/home/tester'];
  const r = new Readiness(kali);
  assert.equal(r.accept(frame(r, good.join('\n') + '\n'))?.uid, 1000);
  for (const [index, value] of [[0, '0'], [1, 'wrong'], [2, '/bin/zsh'], [3, 'sh'], [4, 'hB'], [5, '/tmp']] as const) {
    const changed = [...good]; changed[index] = value;
    const probe = new Readiness(kali);
    assert.throws(() => probe.accept(frame(probe, changed.join('\n'))), { code: 'PROFILE_IDENTITY_MISMATCH' });
  }
});
test('profile registry rejects root and fixes explicit WSL argv', () => {
  assert.throws(() => new ProfileRegistry([{ ...kali, user: 'root' }]), { code: 'INVALID_PROFILE' });
  assert.deepEqual(launch(kali).args, ['-d', 'kali-linux', '--user', 'tester', '--cd', '~', '--exec', '/bin/bash', '-i']);
});

function fake(mode: 'success' | 'timeout' | 'exit' | 'bad') {
  let data: (s: string) => void = () => {};
  let exit: (e: { exitCode: number }) => void = () => {};
  let kills = 0;
  const pty = {
    onData: (fn: typeof data) => { data = fn; return { dispose() { data = () => {}; } }; },
    onExit: (fn: typeof exit) => { exit = fn; return { dispose() { exit = () => {}; } }; },
    write(command: string) {
      const halves = [...command.matchAll(/'([a-f0-9]{24})'/g)].map(m => m[1]);
      if (halves.length !== 2) return;
      queueMicrotask(() => {
        if (mode === 'exit') exit({ exitCode: 1 });
        else if (mode !== 'timeout') data(`TBREADY:${halves.join('')}:${Buffer.from(mode === 'bad' ? '{}' : psValue).toString('base64')}:END`);
      });
    },
    kill() { kills++; exit({ exitCode: 0 }); }
  } as unknown as IPty;
  return { pty, emit: (s: string) => data(s), exit: () => exit({ exitCode: 0 }), kills: () => kills };
}
test('manager lifecycle, exit, late events and invalid handles', async () => {
  const f = fake('success');
  const m = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  await assert.rejects(m.open('missing'), { code: 'INVALID_PROFILE' });
  assert.throws(() => m.read('old'), { code: 'INVALID_SESSION' });
  const s = await m.open('windows-pwsh');
  assert.equal(s.state, 'ready');
  m.read(s.sessionId);
  f.emit('hello');
  assert.equal(m.read(s.sessionId).output, 'hello');
  f.exit();
  assert.equal(m.read(s.sessionId).state, 'EXITED');
  assert.throws(() => m.write(s.sessionId, 'x'), { code: 'SESSION_NOT_READY' });
  assert.equal(m.close(s.sessionId).state, 'CLOSED');
  assert.equal(m.close(s.sessionId).state, 'CLOSED');
  f.emit('late'); f.exit();
  assert.equal(m.read(s.sessionId).state, 'CLOSED');
  m.forget(s.sessionId);
  assert.throws(() => m.read(s.sessionId), { code: 'INVALID_SESSION' });
  m.shutdown();
  await assert.rejects(m.open('windows-pwsh'), { code: 'SESSION_NOT_READY' });
});
test('startup timeout, early exit and identity mismatch kill unpublished PTY', async () => {
  for (const mode of ['timeout', 'exit', 'bad'] as const) {
    const f = fake(mode);
    const m = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {}, readinessTimeoutMs: 10 });
    await assert.rejects(m.open(ps.id), { code: mode === 'bad' ? 'PROFILE_IDENTITY_MISMATCH' : 'PROFILE_START_FAILED' });
    assert.equal(f.kills(), 1);
    m.shutdown();
  }
});
test('shutdown rejects pending open and closed state wins over synchronous exit', async () => {
  const f = fake('timeout');
  const m = new SessionManager(new ProfileRegistry([ps]), { spawn: () => f.pty, checkHost() {} });
  const opening = m.open(ps.id);
  m.shutdown();
  await assert.rejects(opening, { code: 'PROFILE_START_FAILED' });
  assert.equal(f.kills(), 1);
});
test('retained sessions are bounded, then explicitly reclaimable', async () => {
  const m = new SessionManager(new ProfileRegistry([ps]), { spawn: () => fake('success').pty, checkHost() {}, maxSessions: 1 });
  const first = await m.open(ps.id);
  await assert.rejects(m.open(ps.id), { code: 'SESSION_LIMIT' });
  assert.throws(() => m.forget(first.sessionId), { code: 'SESSION_NOT_READY' });
  m.close(first.sessionId);
  await assert.rejects(m.open(ps.id), { code: 'SESSION_LIMIT' });
  m.forget(first.sessionId);
  await m.open(ps.id);
  m.shutdown();
});
