import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SessionManager, ProfileRegistry, type Profile } from '../src/main.js';

const profiles = JSON.parse(readFileSync(process.argv[2] ?? 'profiles.local.json', 'utf8')) as Profile[];
const registry = new ProfileRegistry(profiles);
const manager = new SessionManager(registry);
const ps = profiles.find(p => p.id === 'windows-pwsh');
const kali = profiles.find(p => p.id === 'wsl-kali');
if (!ps || !kali) throw new Error('CP-2 framing regression smoke requires windows-pwsh and wsl-kali profiles');

async function expectReady(id: string, command: string, success: boolean, exitCode: number | null, contains?: string) {
  const result = await manager.step(id, command, 5000);
  assert.equal(result.state, 'ready', command);
  assert.equal(result.success, success, command);
  assert.equal(result.exitCode, exitCode, command);
  assert.equal(result.truncated, false, command);
  if (contains) assert.match(result.output, new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(manager.read(id).activeStep, undefined, `ActiveStep leaked after ${command}`);
  return result;
}

try {
  {
    const s = await manager.open('windows-pwsh');
    manager.read(s.sessionId);

    await expectReady(s.sessionId, '$ErrorActionPreference="Stop"', true, null);
    await expectReady(s.sessionId, 'throw "TB_STOP_FAILURE"', false, null, 'TB_STOP_FAILURE');
    await expectReady(s.sessionId, 'Write-Output TB_ERRORACTION_RECOVERED', true, null, 'TB_ERRORACTION_RECOVERED');

    const psSetup = [
      "$__tb_token='user-token'", "$__tb_payload='user-payload'", "$__tb_before_error='user-before-error'",
      "$__tb_before_native='user-before-native'", "$__tb_native_sentinel='user-sentinel'", "$__tb_terminating='user-terminating'",
      "$__tb_script='user-script'", "$__tb_after_native='user-after-native'", "$__tb_new_errors='user-new-errors'",
      "$__tb_native_observed='user-native-observed'", "$__tb_exit='user-exit'", "$__tb_ok='user-ok'",
      "$__tb_cwd_b64='user-cwd'", "$__tb_ok_text='user-ok-text'", "$__tb_body='user-body'", "$__tb_len='user-len'"
    ].join('; ');
    await expectReady(s.sessionId, psSetup, true, null);
    const psProbe = "Write-Output ([string]::Join('|', @($__tb_token,$__tb_payload,$__tb_before_error,$__tb_before_native,$__tb_native_sentinel,$__tb_terminating,$__tb_script,$__tb_after_native,$__tb_new_errors,$__tb_native_observed,$__tb_exit,$__tb_ok,$__tb_cwd_b64,$__tb_ok_text,$__tb_body,$__tb_len)))";
    const psExpected = 'user-token|user-payload|user-before-error|user-before-native|user-sentinel|user-terminating|user-script|user-after-native|user-new-errors|user-native-observed|user-exit|user-ok|user-cwd|user-ok-text|user-body|user-len';
    await expectReady(s.sessionId, psProbe, true, null, psExpected);
    await expectReady(s.sessionId, '$ErrorActionPreference="Continue"', true, null);
    console.log('PASS CP-2 PowerShell ErrorActionPreference recovery/private bookkeeping');
    manager.close(s.sessionId); manager.forget(s.sessionId);
  }

  {
    const s = await manager.open('wsl-kali');
    manager.read(s.sessionId);
    const bashSetup = [
      "__tb_fd='user-fd'", "__tb_token='user-token'", "__tb_payload='user-payload'", "__tb_status='user-status'",
      "__tb_cwd='user-cwd'", "__tb_cwd_b64='user-cwd-b64'", "__tb_ok='user-ok'", "__tb_body='user-body'",
      "__tb_len='user-len'", "__tb_int_trap='user-trap'"
    ].join('; ');
    await expectReady(s.sessionId, bashSetup, true, 0);
    await expectReady(s.sessionId, 'exec >/dev/null', true, 0);
    await expectReady(s.sessionId, 'true', true, 0);
    const bashProbe = "printf '%s\\n' \"$__tb_fd|$__tb_token|$__tb_payload|$__tb_status|$__tb_cwd|$__tb_cwd_b64|$__tb_ok|$__tb_body|$__tb_len|$__tb_int_trap\" >&2";
    const bashExpected = 'user-fd|user-token|user-payload|user-status|user-cwd|user-cwd-b64|user-ok|user-body|user-len|user-trap';
    await expectReady(s.sessionId, bashProbe, true, 0, bashExpected);
    console.log('PASS CP-2 Bash fixed-name collision/control-FD recovery');
    manager.close(s.sessionId); manager.forget(s.sessionId);
  }
} finally {
  manager.shutdown();
}
