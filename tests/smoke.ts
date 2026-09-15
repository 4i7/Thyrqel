import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { SessionManager, ProfileRegistry, type Profile } from '../src/main.js';

const profiles = JSON.parse(readFileSync(process.argv[2] ?? 'profiles.local.json', 'utf8')) as Profile[];
const manager = new SessionManager(new ProfileRegistry(profiles));
async function waitOutput(id: string, expected: string) {
  const deadline = Date.now() + 10000;
  let text = '';
  while (Date.now() < deadline) {
    const read = manager.read(id);
    text += read.output;
    assert.equal(read.truncated, false);
    // Tokens are split in input, so the echoed command cannot satisfy this check.
    if (text.includes(expected)) return;
    if (read.state !== 'READY') throw new Error(`Unexpected ${read.state}`);
    await delay(30);
  }
  throw new Error(`Output missing: ${expected}; observed ${JSON.stringify(text)}`);
}
try {
  await assert.rejects(manager.open('invalid'), { code: 'INVALID_PROFILE' });
  assert.throws(() => manager.read('invalid'), { code: 'INVALID_SESSION' });
  console.log('PASS invalid profile / session');
  for (const profile of profiles) {
    const s = await manager.open(profile.id);
    console.log(`PASS ${profile.id} readiness ${JSON.stringify(s.identity)}`);
    manager.read(s.sessionId);
    const ps = profile.platform === 'windows';
    manager.write(s.sessionId, ps ? "Write-Output ('TB_PS_'+'OK')\r" : "printf '%s%s\\n' 'TB_KALI_' 'OK'\r");
    await waitOutput(s.sessionId, ps ? 'TB_PS_OK' : 'TB_KALI_OK');
    console.log(`PASS ${profile.id} basic I/O`);
    manager.write(s.sessionId, ps ? "Set-Location $env:TEMP; Write-Output ('TB_CD_'+'SET')\r" : "cd /tmp; printf '%s%s\\n' 'TB_CD_' 'SET'\r");
    await waitOutput(s.sessionId, 'TB_CD_SET');
    manager.write(s.sessionId, ps ? "Write-Output ('TB_PERSIST_'+ ((Get-Location).Path -eq $env:TEMP))\r" : "printf 'TB_PERSIST_%s\\n' \"$PWD\"\r");
    await waitOutput(s.sessionId, ps ? 'TB_PERSIST_True' : 'TB_PERSIST_/tmp');
    console.log(`PASS ${profile.id} persistent cwd (separate writes)`);
    assert.equal(manager.close(s.sessionId).state, 'CLOSED');
    assert.equal(manager.close(s.sessionId).state, 'CLOSED');
    assert.throws(() => manager.write(s.sessionId, 'x'), { code: 'SESSION_NOT_READY' });
    manager.forget(s.sessionId);
    console.log(`PASS ${profile.id} close / double close`);
    const exiting = await manager.open(profile.id);
    manager.write(exiting.sessionId, 'exit\r');
    const deadline = Date.now() + 10000;
    while (manager.read(exiting.sessionId).state === 'READY' && Date.now() < deadline) await delay(50);
    assert.equal(manager.read(exiting.sessionId).state, 'EXITED');
    manager.close(exiting.sessionId);
    manager.forget(exiting.sessionId);
    console.log(`PASS ${profile.id} shell exit`);
  }
} finally { manager.shutdown(); }
