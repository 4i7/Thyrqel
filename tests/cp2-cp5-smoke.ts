import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { SessionManager, ProfileRegistry, type Profile } from '../src/main.js';

const profiles = JSON.parse(readFileSync(process.argv[2] ?? 'profiles.local.json', 'utf8')) as Profile[];
const registry = new ProfileRegistry(profiles);
const manager = new SessionManager(registry);
const ps = profiles.find(p => p.id === 'windows-pwsh');
const kali = profiles.find(p => p.id === 'wsl-kali');
if (!ps || !kali) throw new Error('CP-2..CP-5 smoke requires windows-pwsh and wsl-kali profiles');

async function waitForOutput(id: string, needle: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    const read = manager.read(id);
    output += read.output;
    assert.equal(read.truncated, false);
    if (output.includes(needle)) return output;
    if (!['READY'].includes(read.state)) throw new Error(`session ${id} became ${read.state}`);
    await delay(25);
  }
  throw new Error(`output missing ${JSON.stringify(needle)}; got ${JSON.stringify(output)}`);
}

async function waitForCompletion(id: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    const read = manager.read(id);
    output += read.output;
    if (read.completion) return { ...read.completion, output };
    if (read.state !== 'READY') return { completion: null, state: read.state, output };
    await delay(25);
  }
  throw new Error(`completion timed out for ${id}`);
}

async function expectReady(id: string, command: string, success: boolean, exitCode: number | null, contains?: string) {
  const result = await manager.step(id, command, 5000);
  assert.equal(result.state, 'ready');
  assert.equal(result.success, success);
  assert.equal(result.exitCode, exitCode);
  if (contains) assert.match(result.output, new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return result;
}

try {
  {
    const s = await manager.open('windows-pwsh');
    manager.read(s.sessionId);
    await expectReady(s.sessionId, 'Write-Output OK', true, null, 'OK');
    await expectReady(s.sessionId, 'Get-Item C:\\does-not-exist', false, null);
    await expectReady(s.sessionId, 'cmd /c exit 42', false, 42);
    await expectReady(s.sessionId, 'throw "x"', false, null);
    await expectReady(s.sessionId, '$false', true, null, 'False');
    await expectReady(s.sessionId, 'Get-Item C:\\does-not-exist; Write-Output STILL_OK', false, null, 'STILL_OK');
    await expectReady(s.sessionId, 'Get-Item C:\\does-not-exist | Out-String', false, null);
    await expectReady(s.sessionId, '[Console]::Out.Write("`e[31mANSI_OK`e[0m`n")', true, null, 'ANSI_OK');
    await expectReady(s.sessionId, '$TB_VAR="var"; $env:TB_ENV="env"; function TB-Fn { "fn" }; Set-Location $env:TEMP', true, null);
    const persisted = await expectReady(s.sessionId, 'Write-Output "$TB_VAR,$env:TB_ENV,$(TB-Fn),$((Get-Location).Path)"', true, null);
    assert.match(persisted.output, /var,env,fn,/);
    console.log('PASS CP-2 PowerShell framing/result/persistent state');
    manager.close(s.sessionId); manager.forget(s.sessionId);
  }

  {
    const s = await manager.open('wsl-kali');
    manager.read(s.sessionId);
    await expectReady(s.sessionId, 'echo test', true, 0, 'test');
    await expectReady(s.sessionId, 'false', false, 1);
    await expectReady(s.sessionId, 'cd /tmp', true, 0);
    const pwd = await expectReady(s.sessionId, 'pwd', true, 0, '/tmp');
    assert.match(pwd.output, /\/tmp/);
    await expectReady(s.sessionId, "printf '%s\\n' \"a'b\"", true, 0, "a'b");
    await expectReady(s.sessionId, "printf 'x\\n' | grep x", true, 0, 'x');
    await expectReady(s.sessionId, "printf 'redir\\n' >/tmp/tb_cp2_redir; cat /tmp/tb_cp2_redir", true, 0, 'redir');
    await expectReady(s.sessionId, "printf 'one\\n'\nprintf 'two\\n'", true, 0, 'two');
    await expectReady(s.sessionId, "cat <<'TBEOF'\nheredoc-ok\nTBEOF", true, 0, 'heredoc-ok');
    await expectReady(s.sessionId, 'if true; then echo compound-ok; fi', true, 0, 'compound-ok');
    await expectReady(s.sessionId, 'x=$(printf substitution-ok); echo "$x"', true, 0, 'substitution-ok');
    await expectReady(s.sessionId, "printf 'TB1:not-the-token:00000004:fake\\nnormal-output\\n'", true, 0, 'normal-output');
    await expectReady(s.sessionId, "printf '\\033[31mANSI_OK\\033[0m\\n'", true, 0, 'ANSI_OK');
    await expectReady(s.sessionId, 'exec >/dev/null', true, 0);
    await expectReady(s.sessionId, 'true', true, 0);
    console.log('PASS CP-2 Bash framing/control descriptor');
    manager.close(s.sessionId); manager.forget(s.sessionId);
  }

  {
    const s = await manager.open('wsl-kali'); manager.read(s.sessionId);
    const launch = await manager.step(s.sessionId, 'python3', 150);
    assert.equal(launch.state, 'running');
    assert.throws(() => manager.step(s.sessionId, 'echo must-not-dispatch', 1), { code: 'SESSION_BUSY' });
    manager.write(s.sessionId, { mode: 'line', data: 'print(2 + 3)' });
    await waitForOutput(s.sessionId, '5');
    manager.write(s.sessionId, { mode: 'key', key: 'CTRL_D' });
    const done = await waitForCompletion(s.sessionId);
    assert.equal('success' in done ? done.success : undefined, true);
    console.log('PASS CP-3 Python REPL / Ctrl+D / SESSION_BUSY');
    manager.close(s.sessionId); manager.forget(s.sessionId);
  }

  {
    const s = await manager.open('wsl-kali'); manager.read(s.sessionId);
    const running = await manager.step(s.sessionId, "python3 -c \"import time; print('TB_LONG_RUNNING', flush=True); time.sleep(30)\"", 150);
    assert.equal(running.state, 'running');
    await waitForOutput(s.sessionId, 'TB_LONG_RUNNING');
    manager.write(s.sessionId, { mode: 'key', key: 'CTRL_C' });
    const interrupted = await waitForCompletion(s.sessionId);
    assert.ok('success' in interrupted && interrupted.success === false);
    console.log('PASS CP-4 long-running / Ctrl+C');
    manager.close(s.sessionId); manager.forget(s.sessionId);
  }

  {
    const a = await manager.open('wsl-kali');
    const b = await manager.open('wsl-kali');
    const c = await manager.open('windows-pwsh');
    manager.read(a.sessionId); manager.read(b.sessionId); manager.read(c.sessionId);
    await expectReady(a.sessionId, 'cd /tmp', true, 0);
    await expectReady(b.sessionId, 'cd ~', true, 0);
    const long = await manager.step(a.sessionId, 'sleep 2; echo A_DONE', 50);
    assert.equal(long.state, 'running');
    const bPwd = await expectReady(b.sessionId, 'pwd', true, 0);
    const cOut = await expectReady(c.sessionId, 'Write-Output C_ONLY', true, null, 'C_ONLY');
    assert.doesNotMatch(bPwd.output, /C_ONLY/);
    assert.match(cOut.output, /C_ONLY/);
    assert.equal(manager.read(b.sessionId).activeStep, undefined);
    assert.ok(manager.read(a.sessionId).activeStep);
    const aDone = await waitForCompletion(a.sessionId, 5000);
    assert.ok('success' in aDone && aDone.success === true);
    console.log('PASS CP-5 multiple sessions / independent state');
    for (const s of [a, b, c]) { manager.close(s.sessionId); manager.forget(s.sessionId); }
  }
} finally {
  manager.shutdown();
}
